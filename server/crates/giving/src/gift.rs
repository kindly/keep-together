//! Gift contracts (`convex/giving/contracts.ts`, `projection.ts`). A gift
//! is its own aggregate, split in two slices so voiding never conflicts
//! with an edit: `giving.gift` (what was given, `gift_version`) and
//! `giving.status` (`status_version`). Both rebuild the allocation
//! projection. Gifts are never deleted (rule 3: a mistake is void).
//!
//! A gift is editable whatever its status, void included, until a Gift
//! Aid claim takes it (`giving.claimLock`, the third slice, its own
//! counter `claim_lock_version`). Then BOTH other contracts' applies
//! refuse what the claim relies on, so every restore path is covered
//! too, not just the routes: `giving.gift` refuses a new amount or date
//! (the donor never changes), and `giving.status` needs a reason to void
//! and refuses an un-void (`claimed_gift`, `void_reason_required`).

use std::collections::HashSet;

use contracts::{
    ChildRow, Command, Contract, ContractError, OrgTx, ProjectionTx, Source, WriteTx, reconcile,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sources::{describe, mark_used};

use crate::rules::{prepare_gift, prepare_status};
use crate::types::{AllocationRow, ClaimLockPayload, GiftPayload, Method, Status, StatusPayload};

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
/// restore), and whether this command is a restore or the system's (a
/// Direct Debit payment). Only the payload is serialised (a stale
/// refusal's `current`).
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
    /// `giving.claimLock`'s: the Gift Aid claim that holds it.
    #[serde(skip)]
    claim_id: Option<String>,
    #[serde(skip)]
    system: bool,
}

pub(crate) fn load_allocations(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Vec<AllocationRow>> {
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
            "SELECT contact_id, received_on, amount, method, reference, entered_by, entered_at,
                    claim_id
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
                claim_id: r.get(7)?,
                system: false,
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
/// bring one back (it was assigned before, so it is already marked). A
/// Direct Debit payment's gift (the system's) takes its regular gift's
/// code even once archived: the code was checked when the regular gift
/// was set up, and the money came in all the same.
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
            if !code.is_active && !next.system {
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
        let system = command.source == Source::System;
        let Some(current) = current else {
            if p.method == Method::DirectDebit && !system {
                return Err(ContractError::rejected(
                    "direct_debit_by_hand",
                    "Direct Debit gifts are recorded when GoCardless confirms the payment",
                ));
            }
            return Ok(GiftState {
                gift: p.clone(),
                entered_by: command.actor,
                entered_at: command.at,
                restoring: false,
                claim_id: None,
                system,
            });
        };
        if p.contact_id != current.gift.contact_id {
            return Err(ContractError::rejected(
                "contact_change",
                "A gift’s donor can’t change: void it and record it again",
            ));
        }
        if current.claim_id.is_some()
            && (p.amount != current.gift.amount || p.received_on != current.gift.received_on)
        {
            return Err(ContractError::rejected(
                "claimed_gift",
                "This gift is in a Gift Aid claim: its amount and date can’t change. \
                 If it was wrong, void it with a reason and record it again",
            ));
        }
        // What GoCardless collected is fixed: the split across codes is
        // the only thing to correct on a Direct Debit gift (void it if it
        // shouldn't count).
        let (was, now) = (&current.gift, p);
        let dd = was.method == Method::DirectDebit || now.method == Method::DirectDebit;
        if dd
            && (was.method != now.method
                || was.amount != now.amount
                || was.received_on != now.received_on
                || was.reference != now.reference)
        {
            return Err(ContractError::rejected(
                "direct_debit_fixed",
                "A Direct Debit gift’s method, amount, date and payment are GoCardless’s",
            ));
        }
        Ok(GiftState {
            gift: GiftPayload {
                client_key: None,
                ..p.clone()
            },
            restoring: command.source == Source::Restore,
            system,
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
            if g.method == Method::DirectDebit
                && let Some(payment) = g.reference.as_deref()
            {
                let existing: Option<String> = tx
                    .prepare_cached(
                        "SELECT id FROM gifts WHERE method = 'direct_debit' AND reference = ?1
                             AND status = 'completed'",
                    )?
                    .query_row([payment], |r| r.get(0))
                    .optional()?;
                if let Some(id) = existing {
                    return Err(ContractError::Duplicate { id });
                }
            }
            if contacts::donors::kind_of(tx, &g.contact_id)?.is_none() {
                return Err(ContractError::rejected(
                    "unknown_contact",
                    "Contact must exist",
                ));
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

/// Completed or void, and why it was voided. A void gift is kept and
/// counts for nothing. A claimed gift (`claim_id`) needs a reason to
/// void, and its void is final: HMRC is repaid through an adjustment.
pub struct GiftStatus;
pub static STATUS: GiftStatus = GiftStatus;

/// The `giving.status` slice as stored, plus what isn't this slice's
/// (never serialised): the claim that holds the gift, and whether it is a
/// Direct Debit payment GoCardless says was not collected after all
/// (charged back, failed late, cancelled): such a gift only the system
/// may un-void, when the money comes back
/// ([`crate::regular::record_payment`]).
#[derive(Clone, Debug, Serialize)]
pub struct StatusState {
    #[serde(flatten)]
    pub status: StatusPayload,
    #[serde(skip)]
    claim_id: Option<String>,
    #[serde(skip)]
    returned: bool,
}

fn load_status_state(conn: &Connection, id: &str) -> rusqlite::Result<Option<StatusState>> {
    conn.prepare_cached("SELECT status, void_reason, claim_id FROM gifts WHERE id = ?1")?
        .query_row([id], |r| {
            Ok(StatusState {
                status: StatusPayload {
                    status: Status::parse(&r.get::<_, String>(0)?),
                    reason: r.get(1)?,
                },
                claim_id: r.get(2)?,
                returned: false,
            })
        })
        .optional()
}

impl Contract for GiftStatus {
    const NAME: &'static str = "giving.status";
    /// v2: `reason`.
    const VERSION: u32 = 2;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "status_version";
    const PROJECTIONS: &'static [&'static str] = &[ALLOCATION_INDEX];
    type Payload = StatusPayload;
    type State = StatusState;

    fn prepare(&self, p: StatusPayload) -> Result<StatusPayload, ContractError> {
        prepare_status(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<StatusState, ContractError> {
        let conn = tx.read();
        let mut state = load_status_state(conn, id)?.ok_or(ContractError::NotFound)?;
        state.returned = conn
            .prepare_cached(
                "SELECT 1 FROM direct_debit_payments
                 WHERE gift_id = ?1 AND status IN ('charged_back', 'failed', 'cancelled')",
            )?
            .exists([id])?;
        Ok(state)
    }

    fn apply(
        &self,
        current: Option<&StatusState>,
        p: &StatusPayload,
        command: &Command,
    ) -> Result<StatusState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giving.status targets an existing gift",
            ));
        };
        if current.returned && p.status == Status::Completed && command.source != Source::System {
            return Err(ContractError::rejected(
                "direct_debit_returned",
                "GoCardless says this payment wasn’t collected: it can’t count as a gift",
            ));
        }
        if current.claim_id.is_some() {
            match (current.status.status, p.status) {
                (Status::Completed, Status::Void) if p.reason.is_none() => {
                    return Err(ContractError::rejected(
                        "void_reason_required",
                        "This gift is in a Gift Aid claim: say why it is void. \
                         The next claim pays the tax back to HMRC",
                    ));
                }
                (Status::Void, Status::Completed) => {
                    return Err(ContractError::rejected(
                        "claimed_gift",
                        "This gift was voided after it was claimed for Gift Aid, \
                         so it can’t be un-voided: record it again",
                    ));
                }
                _ => {}
            }
        }
        Ok(StatusState {
            status: StatusPayload {
                status: p.status,
                // Un-voiding clears the reason.
                reason: match p.status {
                    Status::Void => p.reason.clone(),
                    Status::Completed => None,
                },
            },
            claim_id: current.claim_id.clone(),
            returned: current.returned,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&StatusState>,
        next: &StatusState,
    ) -> Result<(), ContractError> {
        tx.prepare_cached("UPDATE gifts SET status = ?2, void_reason = ?3 WHERE id = ?1")?
            .execute(params![id, next.status.status.as_str(), next.status.reason])?;
        Ok(())
    }

    /// v1 had no reason: the same JSON reads as v2.
    fn upcast(&self, from: u32, payload: serde_json::Value) -> Option<serde_json::Value> {
        (from == 1).then_some(payload)
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        Ok(project_allocations(tx, id)?)
    }
}

// ── claim lock ─────────────────────────────────────────────────────────────

/// The Gift Aid claim a gift is in. Only Gift Aid's claim commands run it
/// (through [`crate::lock_for_claim`] / [`crate::release_from_claim`]), in
/// the claim's own transaction; a restore is refused, since the claim,
/// not the gift's history, says whether the gift is claimed.
pub struct ClaimLock;
pub static CLAIM_LOCK: ClaimLock = ClaimLock;

/// The lock as stored, plus the gift's status (a void gift can't be
/// claimed). Only the payload is serialised.
#[derive(Clone, Debug, Serialize)]
pub struct ClaimLockState {
    #[serde(flatten)]
    pub lock: ClaimLockPayload,
    #[serde(skip)]
    status: Status,
}

impl Contract for ClaimLock {
    const NAME: &'static str = "giving.claimLock";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "claim_lock_version";
    type Payload = ClaimLockPayload;
    type State = ClaimLockState;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<ClaimLockState, ContractError> {
        tx.read()
            .prepare_cached("SELECT claim_id, status FROM gifts WHERE id = ?1")?
            .query_row([id], |r| {
                Ok(ClaimLockState {
                    lock: ClaimLockPayload {
                        claim_id: r.get(0)?,
                    },
                    status: Status::parse(&r.get::<_, String>(1)?),
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&ClaimLockState>,
        p: &ClaimLockPayload,
        command: &Command,
    ) -> Result<ClaimLockState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giving.claimLock targets an existing gift",
            ));
        };
        if command.source == Source::Restore {
            return Err(ContractError::rejected(
                "not_restorable",
                "Only its Gift Aid claim says whether a gift is claimed",
            ));
        }
        match (&current.lock.claim_id, &p.claim_id) {
            (Some(held), Some(next)) if held != next => {
                return Err(ContractError::rejected(
                    "already_claimed",
                    "This gift is already in another Gift Aid claim",
                ));
            }
            (None, Some(_)) if current.status == Status::Void => {
                return Err(ContractError::rejected(
                    "void_gift",
                    "A void gift can’t be claimed",
                ));
            }
            _ => {}
        }
        Ok(ClaimLockState {
            lock: p.clone(),
            status: current.status,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&ClaimLockState>,
        next: &ClaimLockState,
    ) -> Result<(), ContractError> {
        tx.prepare_cached("UPDATE gifts SET claim_id = ?2 WHERE id = ?1")?
            .execute(params![id, next.lock.claim_id])?;
        Ok(())
    }
}
