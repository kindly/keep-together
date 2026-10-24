//! Gift contracts (`convex/giving/contracts.ts`, `projection.ts`). A gift
//! is its own aggregate, split in two slices so voiding never conflicts
//! with an edit: `giving.gift` (what was given, `gift_version`) and
//! `giving.status` (`status_version`). Both rebuild the allocation
//! projection. Gifts are never deleted (rule 3: a mistake is void).
//!
//! A gift is editable whatever its status, void included: nothing is
//! locked yet. The claim lock that comes with Gift Aid claims must gate
//! BOTH contracts' applies (so every restore path is covered too), not
//! just the save route, or un-void plus a restore could change a claimed
//! gift's amount.

use std::collections::HashSet;

use contracts::{
    ChildRow, Command, Contract, ContractError, OrgTx, ProjectionTx, Source, WriteTx, reconcile,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sources::{describe, mark_used};

use crate::rules::prepare_gift;
use crate::types::{AllocationRow, GiftPayload, Method, Status, StatusPayload};

pub const TABLE: &str = "gifts";
/// The projection both contracts rebuild.
pub const ALLOCATION_INDEX: &str = "gift_allocation_index";

impl ChildRow for AllocationRow {
    fn id(&self) -> &str {
        self.key.as_deref().unwrap_or("")
    }
}

/// The `giving.gift` slice as stored, plus what no payload carries: who
/// entered it and when (set on create, preserved by every save and
/// restore), and whether this command is a restore. Only the payload is
/// serialised (a stale refusal's `current`).
#[derive(Clone, Debug, Serialize)]
pub struct GiftState {
    #[serde(flatten)]
    pub gift: GiftPayload,
    #[serde(skip)]
    entered_by: Option<i64>,
    #[serde(skip)]
    entered_at: i64,
    #[serde(skip)]
    restoring: bool,
}

pub(crate) fn load_allocations(conn: &Connection, id: &str) -> rusqlite::Result<Vec<AllocationRow>> {
    conn.prepare_cached(
        "SELECT id, source_code_id, amount FROM gift_allocations
         WHERE gift_id = ?1 ORDER BY position",
    )?
    .query_map([id], |r| {
        Ok(AllocationRow {
            key: Some(r.get(0)?),
            source_code_id: r.get(1)?,
            amount: r.get(2)?,
        })
    })?
    .collect()
}

fn load_gift(conn: &Connection, id: &str) -> rusqlite::Result<Option<GiftState>> {
    let Some(mut state) = conn
        .prepare_cached(
            "SELECT contact_id, received_on, amount, method, reference, entered_by, entered_at
             FROM gifts WHERE id = ?1",
        )?
        .query_row([id], |r| {
            Ok(GiftState {
                gift: GiftPayload {
                    contact_id: r.get(0)?,
                    received_on: r.get(1)?,
                    amount: r.get(2)?,
                    method: Method::parse(&r.get::<_, String>(3)?),
                    reference: r.get(4)?,
                    allocations: vec![],
                    client_key: None,
                },
                entered_by: r.get(5)?,
                entered_at: r.get(6)?,
                restoring: false,
            })
        })
        .optional()?
    else {
        return Ok(None);
    };
    state.gift.allocations = load_allocations(conn, id)?;
    Ok(Some(state))
}

/// What was given: donor, date, amount, method, card reference and the
/// split across source codes. `contactId` is fixed at create (g3q2).
/// A create whose `clientKey` is already on a gift is `Duplicate` with
/// that gift's id, as `contacts.details` does: the command already ran.
pub struct Gift;
pub static GIFT: Gift = Gift;

/// Check the codes the gift brings in: each must be a version of this
/// organisation and not archived (out of date is fine), and its first use
/// marks it used. Codes the gift already carries are kept as they are,
/// even once archived, as `contacts.acquisition` does; a restore may
/// bring one back (it was assigned before, so it is already marked).
fn check_new_codes(
    tx: &WriteTx,
    next: &GiftState,
    held: &HashSet<&str>,
) -> Result<(), ContractError> {
    let mut seen = HashSet::new();
    for a in &next.gift.allocations {
        let id = a.source_code_id.as_str();
        if held.contains(id) || !seen.insert(id) {
            continue;
        }
        let Some(code) = describe(tx, id)? else {
            return Err(ContractError::rejected(
                "unknown_source_code",
                "The source code must be a full code (category, detail and version)",
            ));
        };
        if !next.restoring {
            if !code.is_active {
                return Err(ContractError::rejected(
                    "archived_source_code",
                    format!("{} is archived: choose another", code.code),
                ));
            }
            mark_used(tx, id, false)?;
        }
    }
    Ok(())
}

impl Contract for Gift {
    const NAME: &'static str = "giving.gift";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "gift_version";
    const PROJECTIONS: &'static [&'static str] = &[ALLOCATION_INDEX];
    type Payload = GiftPayload;
    type State = GiftState;

    fn prepare(&self, payload: GiftPayload) -> Result<GiftPayload, ContractError> {
        prepare_gift(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<GiftState, ContractError> {
        load_gift(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&GiftState>,
        p: &GiftPayload,
        command: &Command,
    ) -> Result<GiftState, ContractError> {
        let Some(current) = current else {
            return Ok(GiftState {
                gift: p.clone(),
                entered_by: command.actor,
                entered_at: command.at,
                restoring: false,
            });
        };
        if p.contact_id != current.gift.contact_id {
            return Err(ContractError::rejected(
                "contact_change",
                "A gift’s donor can’t change: void it and record it again",
            ));
        }
        Ok(GiftState {
            gift: GiftPayload {
                client_key: None,
                ..p.clone()
            },
            restoring: command.source == Source::Restore,
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&GiftState>,
        next: &GiftState,
    ) -> Result<(), ContractError> {
        let g = &next.gift;
        let Some(before) = before else {
            if let Some(key) = g.client_key.as_deref() {
                let existing: Option<String> = tx
                    .prepare_cached("SELECT id FROM gifts WHERE client_key = ?1")?
                    .query_row([key], |r| r.get(0))
                    .optional()?;
                if let Some(id) = existing {
                    return Err(ContractError::Duplicate { id });
                }
            }
            if contacts::donors::kind_of(tx, &g.contact_id)?.is_none() {
                return Err(ContractError::rejected("unknown_contact", "Contact must exist"));
            }
            check_new_codes(tx, next, &HashSet::new())?;
            tx.prepare_cached(
                "INSERT INTO gifts (id, contact_id, received_on, amount, method, reference,
                     status, entered_by, entered_at, client_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'completed', ?7, ?8, ?9)",
            )?
            .execute(params![
                id,
                g.contact_id,
                g.received_on,
                g.amount,
                g.method.as_str(),
                g.reference,
                next.entered_by,
                next.entered_at,
                g.client_key
            ])?;
            return write_allocations(tx, id, &[], &g.allocations);
        };
        let held: HashSet<&str> = before
            .gift
            .allocations
            .iter()
            .map(|a| a.source_code_id.as_str())
            .collect();
        check_new_codes(tx, next, &held)?;
        // `contact_id`, `status`, `entered_*` and `client_key` aren't this
        // slice's (or are create-only): never touched.
        tx.prepare_cached(
            "UPDATE gifts SET received_on = ?2, amount = ?3, method = ?4, reference = ?5
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            g.received_on,
            g.amount,
            g.method.as_str(),
            g.reference
        ])?;
        write_allocations(tx, id, &before.gift.allocations, &g.allocations)
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        Ok(project_allocations(tx, id)?)
    }
}

/// Reconcile the gift's allocation rows by key. A key another gift holds
/// is refused (the insert would otherwise hit the primary key).
fn write_allocations(
    tx: &WriteTx,
    id: &str,
    before: &[AllocationRow],
    next: &[AllocationRow],
) -> Result<(), ContractError> {
    let rows = reconcile("allocations", before, next)?;
    let mut owner = tx.prepare_cached("SELECT gift_id FROM gift_allocations WHERE id = ?1")?;
    for a in &rows.added {
        let held: Option<String> = owner.query_row([a.id()], |r| r.get(0)).optional()?;
        if held.is_some_and(|g| g != id) {
            return Err(ContractError::rejected(
                "child_ownership",
                format!("allocation {} belongs to another gift", a.id()),
            ));
        }
    }
    let mut delete = tx.prepare_cached("DELETE FROM gift_allocations WHERE id = ?1")?;
    for a in &rows.removed {
        delete.execute([a.id()])?;
    }
    let mut upsert = tx.prepare_cached(
        "INSERT INTO gift_allocations (id, gift_id, position, source_code_id, amount)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET position = excluded.position,
             source_code_id = excluded.source_code_id, amount = excluded.amount",
    )?;
    for (i, a) in next.iter().enumerate() {
        upsert.execute(params![a.id(), id, i as i64, a.source_code_id, a.amount])?;
    }
    Ok(())
}

/// The allocation projection: one row per allocation of a gift, carrying
/// what reports range over (code, detail, category, date, status,
/// contact), rebuilt from the gift in the same transaction by both
/// contracts' `project` hook, its only writer. Detail and category are
/// copies that stay right because a part's parent never changes.
fn project_allocations(tx: &Connection, id: &str) -> rusqlite::Result<()> {
    tx.prepare_cached("DELETE FROM gift_allocation_index WHERE gift_id = ?1")?
        .execute([id])?;
    tx.prepare_cached(
        "INSERT INTO gift_allocation_index (allocation_id, gift_id, contact_id, source_code_id,
             detail_id, category_id, received_on, amount, status)
         SELECT a.id, g.id, g.contact_id, a.source_code_id, d.id, d.parent_id, g.received_on,
                a.amount, g.status
         FROM gift_allocations a
         JOIN gifts g ON g.id = a.gift_id
         JOIN source_codes v ON v.id = a.source_code_id
         JOIN source_codes d ON d.id = v.parent_id
         WHERE a.gift_id = ?1",
    )?
    .execute([id])?;
    Ok(())
}

// ── status ─────────────────────────────────────────────────────────────────

/// Completed or void. A void gift is kept and counts for nothing.
pub struct GiftStatus;
pub static STATUS: GiftStatus = GiftStatus;

pub(crate) fn load_status(conn: &Connection, id: &str) -> rusqlite::Result<Option<Status>> {
    conn.prepare_cached("SELECT status FROM gifts WHERE id = ?1")?
        .query_row([id], |r| Ok(Status::parse(&r.get::<_, String>(0)?)))
        .optional()
}

impl Contract for GiftStatus {
    const NAME: &'static str = "giving.status";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "status_version";
    const PROJECTIONS: &'static [&'static str] = &[ALLOCATION_INDEX];
    type Payload = StatusPayload;
    type State = StatusPayload;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<StatusPayload, ContractError> {
        let status = load_status(tx.read(), id)?.ok_or(ContractError::NotFound)?;
        Ok(StatusPayload { status })
    }

    fn apply(
        &self,
        current: Option<&StatusPayload>,
        p: &StatusPayload,
        _: &Command,
    ) -> Result<StatusPayload, ContractError> {
        if current.is_none() {
            return Err(ContractError::rejected(
                "no_root",
                "giving.status targets an existing gift",
            ));
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&StatusPayload>,
        next: &StatusPayload,
    ) -> Result<(), ContractError> {
        tx.prepare_cached("UPDATE gifts SET status = ?2 WHERE id = ?1")?
            .execute(params![id, next.status.as_str()])?;
        Ok(())
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        Ok(project_allocations(tx, id)?)
    }
}
