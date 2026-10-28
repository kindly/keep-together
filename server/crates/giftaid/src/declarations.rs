//! Gift Aid declarations (`convex/giftaid/declarations.ts`): one
//! `gift_aid_declarations` root per declaration, a dated chain per contact
//! (rule 1). Four contracts partition it:
//!
//! ```text
//!   giftaid.declaration        — what was declared (scope, date, method,
//!                                wording, gift); create-only, never
//!                                edited. The create also sets the
//!                                snapshot, which is then …
//!   giftaid.declarationDetails — … the name and home address it was made
//!                                under: completed or corrected later
//!   giftaid.cancellation       — from when it no longer applies (the
//!                                donor withdrew from a date)
//!   giftaid.void               — it was recorded in error and never
//!                                applied; create-only
//! ```
//!
//! A mistake in what was declared is still void + record again: those
//! fields decide coverage. The snapshot doesn't, so it is editable.
//!
//! Coverage is derived from the chain at read time ([`crate::rules`]) and
//! never stored on a gift. Other modules use [`coverage`] and
//! [`current_declaration`], never the table; this module reads gifts only
//! through giving's `describe_gift`.

use contracts::{Command, Contract, ContractError, DynContract, OrgTx, WriteTx, upcast};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use crate::rules::{
    DECLARATION_LIMIT, GiftRef, Window, covering_declaration, covers, current_of,
    prepare_cancellation, prepare_declaration, prepare_details, prepare_void, uk_date,
};
use crate::types::{
    CancellationPayload, Declaration, DeclarationPayload, DeclarationSummary, DetailsChange,
    DetailsEdit, DetailsHistory, DetailsPayload, Method, Scope, VoidPayload,
};

pub const TABLE: &str = "gift_aid_declarations";

impl Window for Declaration {
    fn scope(&self) -> Scope {
        self.payload.scope
    }
    fn made_on(&self) -> &str {
        &self.payload.made_on
    }
    fn gift_id(&self) -> Option<&str> {
        self.payload.gift_id.as_deref()
    }
    fn cancelled_from(&self) -> Option<&str> {
        self.cancelled_from.as_deref()
    }
    fn voided(&self) -> bool {
        self.voided_at.is_some()
    }
}

const COLUMNS: &str = "id, contact_id, scope, gift_id, made_on, method, wording_version, \
     first_name, last_name, address_line1, postcode, cancelled_from, cancellation_note, \
     void_reason, voided_at, voided_by, entered_by, entered_at, declaration_version, \
     cancellation_version, void_version, details_version";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Declaration> {
    Ok(Declaration {
        id: r.get(0)?,
        payload: DeclarationPayload {
            contact_id: r.get(1)?,
            scope: Scope::parse(&r.get::<_, String>(2)?),
            gift_id: r.get(3)?,
            made_on: r.get(4)?,
            method: Method::parse(&r.get::<_, String>(5)?),
            wording_version: r.get(6)?,
            first_name: r.get(7)?,
            last_name: r.get(8)?,
            address_line1: r.get(9)?,
            postcode: r.get(10)?,
        },
        cancelled_from: r.get(11)?,
        cancellation_note: r.get(12)?,
        void_reason: r.get(13)?,
        voided_at: r.get(14)?,
        voided_by: r.get(15)?,
        entered_by: r.get(16)?,
        entered_at: r.get(17)?,
        declaration_version: r.get(18)?,
        cancellation_version: r.get(19)?,
        void_version: r.get(20)?,
        details_version: r.get(21)?,
    })
}

/// One declaration, or `None`.
pub fn load(conn: &Connection, id: &str) -> rusqlite::Result<Option<Declaration>> {
    conn.prepare_cached(&format!("SELECT {COLUMNS} FROM {TABLE} WHERE id = ?1"))?
        .query_row([id], row)
        .optional()
}

/// A contact's declarations, oldest first by date made. One indexed read
/// of at most DECLARATION_LIMIT rows, which the contract enforces.
pub fn chain(conn: &Connection, contact_id: &str) -> rusqlite::Result<Vec<Declaration>> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM {TABLE} WHERE contact_id = ?1
         ORDER BY made_on, rowid LIMIT {DECLARATION_LIMIT}"
    ))?
    .query_map([contact_id], row)?
    .collect()
}

fn summary(d: &Declaration) -> DeclarationSummary {
    DeclarationSummary {
        id: d.id.clone(),
        scope: d.payload.scope,
        method: d.payload.method,
        made_on: d.payload.made_on.clone(),
        cancelled_from: d.cancelled_from.clone(),
    }
}

/// The declaration covering a gift by `contact_id` dated `date`, or
/// `None`. Pass the gift's id so a "this gift only" declaration can match
/// it; a gift not yet saved can only be covered by an enduring one.
/// Whether the declaration's method and snapshot are enough for a claim
/// is the claim step's question, not this one.
pub fn coverage(
    conn: &Connection,
    contact_id: &str,
    date: &str,
    gift_id: Option<&str>,
) -> rusqlite::Result<Option<DeclarationSummary>> {
    let chain = chain(conn, contact_id)?;
    Ok(covering_declaration(&chain, GiftRef { date, gift_id }).map(summary))
}

/// The enduring declaration in force on `today` (the caller's date), or
/// `None`. The gift form shows "✓ covered" instead of the tick when there
/// is one (g2q6).
pub fn current_declaration(
    conn: &Connection,
    contact_id: &str,
    today: &str,
) -> rusqlite::Result<Option<DeclarationSummary>> {
    let chain = chain(conn, contact_id)?;
    Ok(current_of(&chain, today).map(summary))
}

// ── giftaid.declaration ────────────────────────────────────────────────────

/// A declaration as made, plus who entered it and when (the command's,
/// set once; not serialised).
#[derive(Clone, Debug, Serialize)]
pub struct DeclarationState {
    #[serde(flatten)]
    pub payload: DeclarationPayload,
    #[serde(skip)]
    entered_by: Option<i64>,
    #[serde(skip)]
    entered_at: i64,
}

/// A declaration as made. Refused for anyone but an individual (HMRC
/// 3.6.7: not in a company's or joint names); when made after today (UK
/// time, at the command's time); when the gift it names isn't this
/// contact's or is void; and for a "this gift only" declaration whose gift
/// already has one. Never updated: a declaration recorded in error is
/// voided, a donor withdrawing is a cancellation, so restore of a
/// revision is refused too. Its snapshot fields are set here and changed
/// only by [`DetailsContract`].
pub struct DeclarationContract;
pub static DECLARATION: DeclarationContract = DeclarationContract;

impl Contract for DeclarationContract {
    const NAME: &'static str = "giftaid.declaration";
    // v2: any scope may name the gift it was made with (covered whatever
    // its date); v1 named one only for `thisGift`. Same shape.
    const VERSION: u32 = 2;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "declaration_version";
    type Payload = DeclarationPayload;
    type State = DeclarationState;

    fn prepare(&self, p: DeclarationPayload) -> Result<DeclarationPayload, ContractError> {
        prepare_declaration(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<DeclarationState, ContractError> {
        let d = load(tx.read(), id)?.ok_or(ContractError::NotFound)?;
        Ok(DeclarationState {
            payload: d.payload,
            entered_by: d.entered_by,
            entered_at: d.entered_at,
        })
    }

    fn apply(
        &self,
        current: Option<&DeclarationState>,
        p: &DeclarationPayload,
        command: &Command,
    ) -> Result<DeclarationState, ContractError> {
        if current.is_some() {
            return Err(ContractError::rejected(
                "immutable",
                "A declaration can’t be changed: void it as made in error, then record a new one",
            ));
        }
        if p.made_on > uk_date(command.at) {
            return Err(ContractError::invalid(
                "madeOn",
                "A declaration can’t be made in the future",
            ));
        }
        Ok(DeclarationState {
            payload: p.clone(),
            entered_by: command.actor,
            entered_at: command.at,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&DeclarationState>,
        next: &DeclarationState,
    ) -> Result<(), ContractError> {
        let p = &next.payload;
        match contacts::donors::kind_of(tx, &p.contact_id)? {
            None => {
                return Err(ContractError::rejected(
                    "unknown_contact",
                    "Contact must exist",
                ));
            }
            Some(contacts::types::Kind::Individual) => {}
            Some(_) => {
                return Err(ContractError::rejected(
                    "not_individual",
                    "Only a person can make a Gift Aid declaration",
                ));
            }
        }
        let held = chain(tx, &p.contact_id)?;
        if let Some(gift_id) = p.gift_id.as_deref() {
            let gift = giving::describe_gift(tx, gift_id)?
                .filter(|g| g.contact_id == p.contact_id)
                .ok_or_else(|| {
                    ContractError::rejected(
                        "unknown_gift",
                        "A declaration can only name one of this contact’s gifts",
                    )
                })?;
            if gift.status == giving::Status::Void {
                return Err(ContractError::rejected(
                    "void_gift",
                    "A void gift can’t have a Gift Aid declaration",
                ));
            }
            let at = GiftRef {
                date: &gift.received_on,
                gift_id: Some(gift_id),
            };
            if p.scope == Scope::ThisGift
                && held
                    .iter()
                    .any(|d| d.payload.scope == Scope::ThisGift && covers(d, at))
            {
                return Err(ContractError::rejected(
                    "duplicate_gift_declaration",
                    "This gift already has a “this gift only” declaration",
                ));
            }
        }
        if held.len() >= DECLARATION_LIMIT {
            return Err(ContractError::rejected(
                "declaration_limit",
                format!("A contact can have at most {DECLARATION_LIMIT} declarations"),
            ));
        }
        tx.prepare_cached(
            "INSERT INTO gift_aid_declarations (id, contact_id, scope, gift_id, made_on, method,
                 wording_version, first_name, last_name, address_line1, postcode, entered_by,
                 entered_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?
        .execute(params![
            id,
            p.contact_id,
            p.scope.as_str(),
            p.gift_id,
            p.made_on,
            p.method.as_str(),
            p.wording_version,
            p.first_name,
            p.last_name,
            p.address_line1,
            p.postcode,
            next.entered_by,
            next.entered_at
        ])?;
        Ok(())
    }

    fn upcast(&self, from: u32, payload: Value) -> Option<Value> {
        // v1 → v2: the same shape; only what `contributionId` may mean widened.
        (from == 1).then_some(payload)
    }
}

// ── giftaid.cancellation ───────────────────────────────────────────────────

/// The cancellation slice, plus whether the declaration is voided (not
/// serialised: a stale refusal's `current` is just the slice).
#[derive(Clone, Debug, Serialize)]
pub struct CancellationState {
    #[serde(flatten)]
    pub payload: CancellationPayload,
    #[serde(skip)]
    voided: bool,
    #[serde(skip)]
    claimed: Vec<crate::claims::ClaimedUnder>,
}

/// When the declaration stops applying: gifts on or after
/// `cancelledFrom` aren't covered by it (3.8.2). Clearing it undoes a
/// cancellation recorded by mistake. Refused on a voided declaration:
/// there is nothing left to cancel; and from on or before the date of a
/// completed gift a live Gift Aid claim claims under it
/// (`claimed_declaration`).
pub struct CancellationContract;
pub static CANCELLATION: CancellationContract = CancellationContract;

impl Contract for CancellationContract {
    const NAME: &'static str = "giftaid.cancellation";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "cancellation_version";
    type Payload = CancellationPayload;
    type State = CancellationState;

    fn prepare(&self, p: CancellationPayload) -> Result<CancellationPayload, ContractError> {
        prepare_cancellation(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<CancellationState, ContractError> {
        let d = load(tx.read(), id)?.ok_or(ContractError::NotFound)?;
        Ok(CancellationState {
            payload: CancellationPayload {
                cancelled_from: d.cancelled_from,
                note: d.cancellation_note,
            },
            voided: d.voided_at.is_some(),
            claimed: crate::claims::claimed_under(tx.read(), id)?,
        })
    }

    fn apply(
        &self,
        current: Option<&CancellationState>,
        p: &CancellationPayload,
        _: &Command,
    ) -> Result<CancellationState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giftaid.cancellation targets an existing declaration",
            ));
        };
        if current.voided {
            return Err(ContractError::rejected(
                "voided",
                "This declaration was made in error and voided",
            ));
        }
        // A gift HMRC is claimed for under it stays covered (rule 1 with
        // rule 4): no cancellation from on or before its date.
        if let Some(from) = p.cancelled_from.as_deref()
            && let Some(c) = current
                .claimed
                .iter()
                .find(|c| c.received_on.as_str() >= from)
        {
            return Err(c.refusal());
        }
        Ok(CancellationState {
            payload: p.clone(),
            voided: false,
            claimed: current.claimed.clone(),
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&CancellationState>,
        next: &CancellationState,
    ) -> Result<(), ContractError> {
        tx.prepare_cached(
            "UPDATE gift_aid_declarations SET cancelled_from = ?2, cancellation_note = ?3
             WHERE id = ?1",
        )?
        .execute(params![id, next.payload.cancelled_from, next.payload.note])?;
        Ok(())
    }
}

// ── giftaid.void ───────────────────────────────────────────────────────────

/// The void slice: the reason, and who and when (the command's).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidState {
    pub reason: Option<String>,
    #[serde(skip)]
    voided_at: Option<i64>,
    #[serde(skip)]
    voided_by: Option<i64>,
    #[serde(skip)]
    claimed: Vec<crate::claims::ClaimedUnder>,
}

/// "Made in error": the declaration was recorded by mistake (wrong
/// contact, never made) and never applied to any gift, past or future;
/// coverage ignores it everywhere. Unlike a cancellation it has no date.
/// Create-only: refused on a declaration already voided, so restore can't
/// undo it either (a new declaration is the way back). Refused while a
/// completed gift in a live Gift Aid claim is claimed under it
/// (`claimed_declaration`): void that gift (the next claim pays HMRC
/// back) or let the claim go first.
pub struct VoidContract;
pub static VOID: VoidContract = VoidContract;

impl Contract for VoidContract {
    const NAME: &'static str = "giftaid.void";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "void_version";
    type Payload = VoidPayload;
    type State = VoidState;

    fn prepare(&self, p: VoidPayload) -> Result<VoidPayload, ContractError> {
        prepare_void(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<VoidState, ContractError> {
        let d = load(tx.read(), id)?.ok_or(ContractError::NotFound)?;
        Ok(VoidState {
            reason: d.void_reason,
            voided_at: d.voided_at,
            voided_by: d.voided_by,
            claimed: crate::claims::claimed_under(tx.read(), id)?,
        })
    }

    fn apply(
        &self,
        current: Option<&VoidState>,
        p: &VoidPayload,
        command: &Command,
    ) -> Result<VoidState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giftaid.void targets an existing declaration",
            ));
        };
        if current.voided_at.is_some() {
            return Err(ContractError::rejected(
                "immutable",
                "This declaration is already voided",
            ));
        }
        if let Some(c) = current.claimed.first() {
            return Err(c.refusal());
        }
        Ok(VoidState {
            reason: Some(p.reason.clone()),
            voided_at: Some(command.at),
            voided_by: command.actor,
            claimed: vec![],
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&VoidState>,
        next: &VoidState,
    ) -> Result<(), ContractError> {
        tx.prepare_cached(
            "UPDATE gift_aid_declarations SET void_reason = ?2, voided_at = ?3, voided_by = ?4
             WHERE id = ?1",
        )?
        .execute(params![id, next.reason, next.voided_at, next.voided_by])?;
        Ok(())
    }
}

// ── giftaid.declarationDetails ─────────────────────────────────────────────

/// The details slice, plus whether the declaration is voided (not
/// serialised: a stale refusal's `current` is just the slice).
#[derive(Clone, Debug, Serialize)]
pub struct DetailsState {
    #[serde(flatten)]
    pub payload: DetailsPayload,
    #[serde(skip)]
    voided: bool,
}

/// The snapshot of the donor's name and home address, completed or
/// corrected after the declaration was saved (staff ticked Gift Aid
/// before they had the address; a typo). Any field may change, blanks
/// included (they warn). Refused on a voided declaration: it never
/// applied, so there is nothing to fix. A cancelled one may change: its
/// window before the cancellation still backs claims.
pub struct DetailsContract;
pub static DETAILS: DetailsContract = DetailsContract;

impl Contract for DetailsContract {
    const NAME: &'static str = "giftaid.declarationDetails";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "details_version";
    type Payload = DetailsPayload;
    type State = DetailsState;

    fn prepare(&self, p: DetailsPayload) -> Result<DetailsPayload, ContractError> {
        prepare_details(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<DetailsState, ContractError> {
        let d = load(tx.read(), id)?.ok_or(ContractError::NotFound)?;
        Ok(DetailsState {
            payload: d.payload.details(),
            voided: d.voided_at.is_some(),
        })
    }

    fn apply(
        &self,
        current: Option<&DetailsState>,
        p: &DetailsPayload,
        _: &Command,
    ) -> Result<DetailsState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giftaid.declarationDetails targets an existing declaration",
            ));
        };
        if current.voided {
            return Err(ContractError::rejected(
                "voided",
                "This declaration was made in error and voided",
            ));
        }
        Ok(DetailsState {
            payload: p.clone(),
            voided: false,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&DetailsState>,
        next: &DetailsState,
    ) -> Result<(), ContractError> {
        let p = &next.payload;
        tx.prepare_cached(
            "UPDATE gift_aid_declarations
             SET first_name = ?2, last_name = ?3, address_line1 = ?4, postcode = ?5
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            p.first_name,
            p.last_name,
            p.address_line1,
            p.postcode
        ])?;
        Ok(())
    }
}

/// The most snapshot changes one history read lists.
pub const DETAILS_HISTORY_LIMIT: usize = 100;

/// The snapshot in a revision's payload, read at the code's version of
/// its contract (the upcaster chain restore uses): both contracts carry
/// the four fields under the same names at their current versions.
fn snapshot_of(
    contract: &dyn DynContract,
    version: u32,
    payload: &str,
) -> Result<DetailsPayload, ContractError> {
    let payload = upcast(contract, serde_json::from_str(payload)?, version)?;
    Ok(serde_json::from_value(payload)?)
}

/// A declaration's snapshot changes, newest first: each
/// `giftaid.declarationDetails` revision against the one before it (the
/// first against the snapshot the declaration was made with), with who
/// and when. A save that changed nothing isn't listed. `None` for an
/// unknown declaration.
pub fn details_history(
    conn: &Connection,
    id: &str,
) -> Result<Option<DetailsHistory>, ContractError> {
    if load(conn, id)?.is_none() {
        return Ok(None);
    }
    // The newest LIMIT + 1 details revisions, and the declaration's own
    // (one, at create): the baseline when every details one is read.
    let rows: Vec<(i64, u32, String, Option<i64>, String, i64)> = conn
        .prepare_cached(
            "SELECT id, version, payload, actor, source, at FROM revisions
             WHERE entity = ?1 AND entity_id = ?2 AND contract = ?3
             ORDER BY id DESC LIMIT ?4",
        )?
        .query_map(
            params![
                TABLE,
                id,
                DetailsContract::NAME,
                DETAILS_HISTORY_LIMIT as i64 + 1
            ],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    let more = rows.len() > DETAILS_HISTORY_LIMIT;
    let baseline: Option<DetailsPayload> = if more {
        // The oldest row read is only the baseline of the one after it.
        None
    } else {
        conn.prepare_cached(
            "SELECT version, payload FROM revisions
             WHERE entity = ?1 AND entity_id = ?2 AND contract = ?3
             ORDER BY id LIMIT 1",
        )?
        .query_row(params![TABLE, id, DeclarationContract::NAME], |r| {
            Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?))
        })
        .optional()?
        .map(|(version, payload)| snapshot_of(&DECLARATION, version, &payload))
        .transpose()?
    };
    let mut snapshots = rows
        .iter()
        .map(|(_, version, payload, ..)| snapshot_of(&DETAILS, *version, payload))
        .collect::<Result<Vec<_>, _>>()?;
    snapshots.extend(baseline);
    let edits = rows
        .iter()
        .take(DETAILS_HISTORY_LIMIT)
        .enumerate()
        .filter_map(|(i, (revision_id, _, _, actor, source, at))| {
            let before = snapshots.get(i + 1)?;
            let changes = diff(before, &snapshots[i]);
            (!changes.is_empty()).then(|| DetailsEdit {
                revision_id: *revision_id,
                at: *at,
                actor: *actor,
                source: contracts::Source::parse(source),
                changes,
            })
        })
        .collect();
    Ok(Some(DetailsHistory { edits, more }))
}

fn diff(before: &DetailsPayload, after: &DetailsPayload) -> Vec<DetailsChange> {
    [
        ("firstName", &before.first_name, &after.first_name),
        ("lastName", &before.last_name, &after.last_name),
        ("addressLine1", &before.address_line1, &after.address_line1),
        ("postcode", &before.postcode, &after.postcode),
    ]
    .into_iter()
    .filter(|(_, from, to)| from != to)
    .map(|(field, from, to)| DetailsChange {
        field: field.into(),
        from: from.clone(),
        to: to.clone(),
    })
    .collect()
}
