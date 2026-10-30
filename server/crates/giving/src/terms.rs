//! A regular gift's terms as a dated chain (ADR 0026,
//! `factory/plans/regular-gift-terms.sv`): `regular_gift_terms`, one row
//! per change, each in force from the first payment it governs, with its
//! split across source codes (`regular_gift_term_allocations`, child rows
//! with ids, oldest money first). Nothing is overwritten: a change adds a
//! row. The pure rules are [`crate::terms_rules`].
//!
//! Three slices of a row, no field shared:
//! - `giving.regularGiftTerms` (`terms_version`): the terms, split, note
//!   and whether staff withdrew it. Staff edit or withdraw a row only
//!   while it is `scheduled`; once the system has started sending it, it
//!   is history (`term_sent`), restores included.
//! - `giving.regularGiftTermSync` (`sync_version`): the system's: `state`
//!   (`scheduled → sending → sent → applied`), the GoCardless subscription
//!   it runs under, when it was sent, and `applies_from` (the payment it
//!   really starts on, if it missed its intended one). Never restored.
//! - `giving.regularGiftTermCode` (`code_version`): the code credited
//!   with the change, editable at any state, so a change made in
//!   GoCardless can be coded later and a wrong code fixed.
//!
//! The chain reads `applies_from` when set, else `effective_from`.

use std::collections::HashSet;

use contracts::{
    ChildRow, Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem,
    Source, WriteTx, command_group, execute, mint_ids, reconcile,
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::regular::{Frequency, Kind, RegularStatus};
use crate::rules::{ALLOCATION_LIMIT, PENCE_MAX, format_pence, is_iso_date};
use crate::terms_rules::{self, ChangeKind, Share, Terms};

pub const TABLE: &str = "regular_gift_terms";
pub const ALLOCATIONS: &str = "regular_gift_term_allocations";

/// The longest note kept on a change.
pub const NOTE_MAX: usize = 1000;
/// The note on a change GoCardless told us of that we didn't send.
pub const CHANGED_IN_GOCARDLESS: &str = "changed in GoCardless";
/// GoCardless allows this many amount changes on one subscription; the
/// next makes a new subscription.
pub const AMENDMENT_LIMIT: i64 = 10;
/// A scheduled change is sent this many days before it takes effect:
/// after the payment before it was created, before its own is.
pub const SEND_AHEAD_DAYS: i64 = 14;

/// One layer of a row's split: pence to a source code (a version).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TermAllocationRow {
    /// The row's id (32 hex); minted when missing.
    #[serde(default)]
    #[ts(optional)]
    pub key: Option<String>,
    pub source_code_id: String,
    #[ts(type = "number")]
    pub amount: i64,
}

impl ChildRow for TermAllocationRow {
    fn id(&self) -> &str {
        self.key.as_deref().unwrap_or("")
    }
}

/// Who started a row: set-up (or adoption), staff, or GoCardless (a
/// change made in its dashboard). Fixed at create.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "TermOrigin")]
pub enum Origin {
    Setup,
    #[default]
    Staff,
    Gocardless,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Setup => "setup",
            Origin::Staff => "staff",
            Origin::Gocardless => "gocardless",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "setup" => Origin::Setup,
            "gocardless" => Origin::Gocardless,
            _ => Origin::Staff,
        }
    }
}

/// Where a row stands with GoCardless (the system's).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "TermSyncState")]
pub enum SyncState {
    /// Held here until it falls due.
    #[default]
    Scheduled,
    /// The job has taken it and is telling GoCardless.
    Sending,
    /// GoCardless has it.
    Sent,
    /// GoCardless confirmed it (its `amended` event, or a payment at the
    /// new terms).
    Applied,
}

impl SyncState {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncState::Scheduled => "scheduled",
            SyncState::Sending => "sending",
            SyncState::Sent => "sent",
            SyncState::Applied => "applied",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "sending" => SyncState::Sending,
            "sent" => SyncState::Sent,
            "applied" => SyncState::Applied,
            _ => SyncState::Scheduled,
        }
    }
}

// ── giving.regularGiftTerms ────────────────────────────────────────────────

/// One row's terms, as staff (or the system) give them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TermsPayload {
    /// Fixed at create.
    pub regular_gift_id: String,
    /// ISO date: the scheduled date of the first payment it governs.
    pub effective_from: String,
    /// Pence, over 0.
    #[ts(type = "number")]
    pub amount: i64,
    pub frequency: Frequency,
    /// 1–28.
    pub day_of_month: u8,
    /// Yearly only: 1–12.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub month: Option<u8>,
    /// The split by code, oldest money first; sums to `amount`.
    pub allocations: Vec<TermAllocationRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    /// Staff took it back before it was sent.
    #[serde(default)]
    pub withdrawn: bool,
    /// Who started it (create only; a save keeps the row's own).
    #[serde(default)]
    pub origin: Origin,
}

/// Refuse terms that can't be stored: the amount, day and month as a set
/// up gift's, a date that isn't one, a split that is empty, too long, not
/// positive or not summing to the amount. Mints missing allocation keys;
/// a blank note is none.
pub fn prepare_terms_row(mut p: TermsPayload) -> Result<TermsPayload, ContractError> {
    let mut problems = Vec::new();
    p.effective_from = p.effective_from.trim().to_owned();
    p.note = p
        .note
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty());
    if p.note
        .as_ref()
        .is_some_and(|n| n.chars().count() > NOTE_MAX)
    {
        problems.push(Problem::new(
            "note",
            format!("At most {NOTE_MAX} characters"),
        ));
    }
    crate::regular::schedule_problems(
        p.amount,
        p.frequency,
        p.day_of_month,
        p.month,
        &mut problems,
    );
    if !is_iso_date(&p.effective_from) {
        problems.push(Problem::new("effectiveFrom", "Dates are YYYY-MM-DD"));
    }
    if p.allocations.is_empty() {
        problems.push(Problem::new("allocations", "Pick a source code"));
    } else if p.allocations.len() > ALLOCATION_LIMIT {
        problems.push(Problem::new(
            "allocations",
            format!("At most {ALLOCATION_LIMIT} source codes"),
        ));
    }
    mint_ids(&mut p.allocations, |a| &mut a.key);
    let keys: HashSet<_> = p.allocations.iter().map(|a| &a.key).collect();
    if keys.len() != p.allocations.len() {
        problems.push(Problem::new("allocations", "Duplicate row key"));
    }
    if p.allocations
        .iter()
        .any(|a| a.amount <= 0 || a.amount > PENCE_MAX)
    {
        problems.push(Problem::new("allocations", "Each share must be over £0"));
    } else {
        let total = p
            .allocations
            .iter()
            .try_fold(0i64, |sum, a| sum.checked_add(a.amount));
        if !p.allocations.is_empty() && total != Some(p.amount) {
            problems.push(Problem::new(
                "allocations",
                "The shares must add up to the amount",
            ));
        }
    }
    if problems.is_empty() {
        Ok(p)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// The `giving.regularGiftTerms` slice as stored, plus what isn't this
/// slice's (never serialised): who entered it and when, the sync state,
/// whether the regular gift has ended, and how this command runs.
#[derive(Clone, Debug, Serialize)]
pub struct TermsState {
    #[serde(flatten)]
    pub terms: TermsPayload,
    #[serde(skip)]
    entered_by: Option<i64>,
    #[serde(skip)]
    entered_at: i64,
    #[serde(skip)]
    sync: SyncState,
    #[serde(skip)]
    gift_ended: bool,
    #[serde(skip)]
    restoring: bool,
    #[serde(skip)]
    system: bool,
}

fn load_allocations(conn: &Connection, id: &str) -> rusqlite::Result<Vec<TermAllocationRow>> {
    conn.prepare_cached(
        "SELECT id, source_code_id, amount FROM regular_gift_term_allocations
         WHERE term_id = ?1 ORDER BY position",
    )?
    .query_map([id], |r| {
        Ok(TermAllocationRow {
            key: Some(r.get(0)?),
            source_code_id: r.get(1)?,
            amount: r.get(2)?,
        })
    })?
    .collect()
}

fn load_terms(conn: &Connection, id: &str) -> rusqlite::Result<Option<TermsState>> {
    let Some(mut state) = conn
        .prepare_cached(
            "SELECT t.regular_gift_id, t.effective_from, t.amount, t.frequency, t.day_of_month,
                 t.month, t.note, t.withdrawn, t.origin, t.entered_by, t.entered_at, t.state,
                 g.status
             FROM regular_gift_terms t JOIN regular_gifts g ON g.id = t.regular_gift_id
             WHERE t.id = ?1",
        )?
        .query_row([id], |r| {
            Ok(TermsState {
                terms: TermsPayload {
                    regular_gift_id: r.get(0)?,
                    effective_from: r.get(1)?,
                    amount: r.get(2)?,
                    frequency: Frequency::parse(&r.get::<_, String>(3)?),
                    day_of_month: r.get(4)?,
                    month: r.get(5)?,
                    allocations: vec![],
                    note: r.get(6)?,
                    withdrawn: r.get(7)?,
                    origin: Origin::parse(&r.get::<_, String>(8)?),
                },
                entered_by: r.get(9)?,
                entered_at: r.get(10)?,
                sync: SyncState::parse(&r.get::<_, String>(11)?),
                gift_ended: RegularStatus::parse(&r.get::<_, String>(12)?).is_ended(),
                restoring: false,
                system: false,
            })
        })
        .optional()?
    else {
        return Ok(None);
    };
    state.terms.allocations = load_allocations(conn, id)?;
    Ok(Some(state))
}

pub struct RegularGiftTerms;
pub static REGULAR_GIFT_TERMS: RegularGiftTerms = RegularGiftTerms;

impl Contract for RegularGiftTerms {
    const NAME: &'static str = "giving.regularGiftTerms";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "terms_version";
    type Payload = TermsPayload;
    type State = TermsState;

    fn prepare(&self, p: TermsPayload) -> Result<TermsPayload, ContractError> {
        prepare_terms_row(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<TermsState, ContractError> {
        load_terms(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&TermsState>,
        p: &TermsPayload,
        command: &Command,
    ) -> Result<TermsState, ContractError> {
        let system = command.source == Source::System;
        let restoring = command.source == Source::Restore;
        let Some(current) = current else {
            if p.withdrawn {
                return Err(ContractError::invalid(
                    "withdrawn",
                    "A new change can't start withdrawn",
                ));
            }
            if p.origin != Origin::Staff && !system {
                return Err(ContractError::rejected(
                    "origin",
                    "Only the system records a set-up or GoCardless's change",
                ));
            }
            return Ok(TermsState {
                terms: p.clone(),
                entered_by: command.actor,
                entered_at: command.at,
                sync: SyncState::Scheduled,
                gift_ended: false,
                restoring: false,
                system,
            });
        };
        if p.regular_gift_id != current.terms.regular_gift_id {
            return Err(ContractError::rejected(
                "identity_immutable",
                "A change belongs to its regular gift",
            ));
        }
        if current.sync != SyncState::Scheduled {
            return Err(ContractError::rejected(
                "term_sent",
                "This change has gone to GoCardless: it can’t be edited or withdrawn now",
            ));
        }
        if current.terms.withdrawn && !restoring && !system {
            return Err(ContractError::rejected(
                "term_withdrawn",
                "This change was withdrawn: enter it again",
            ));
        }
        if current.gift_ended && !p.withdrawn {
            return Err(ContractError::rejected(
                "regular_gift_ended",
                "This regular gift has ended",
            ));
        }
        Ok(TermsState {
            terms: TermsPayload {
                origin: current.terms.origin,
                ..p.clone()
            },
            restoring,
            system,
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&TermsState>,
        next: &TermsState,
    ) -> Result<(), ContractError> {
        let t = &next.terms;
        if t.frequency == Frequency::Quarterly
            && crate::regular::kind_of(tx, &t.regular_gift_id)? == Some(Kind::DirectDebit)
        {
            return Err(ContractError::rejected(
                "quarterly_direct_debit",
                "A Direct Debit is monthly or yearly: only a standing order can be quarterly",
            ));
        }
        let status: Option<String> = tx
            .prepare_cached("SELECT status FROM regular_gifts WHERE id = ?1")?
            .query_row([&t.regular_gift_id], |r| r.get(0))
            .optional()?;
        let Some(status) = status else {
            return Err(ContractError::rejected(
                "unknown_regular_gift",
                "The regular gift must exist",
            ));
        };
        if !t.withdrawn {
            if RegularStatus::parse(&status).is_ended() && !next.system {
                return Err(ContractError::rejected(
                    "regular_gift_ended",
                    "This regular gift has ended",
                ));
            }
            // Staff's changes come after what GoCardless already has, and
            // two live rows never start on the same day.
            if !next.system {
                let last_sent: Option<String> = tx
                    .prepare_cached(
                        "SELECT max(coalesce(applies_from, effective_from)) FROM regular_gift_terms
                         WHERE regular_gift_id = ?1 AND id <> ?2 AND withdrawn = 0
                           AND state <> 'scheduled'",
                    )?
                    .query_row(params![t.regular_gift_id, id], |r| r.get(0))?;
                if last_sent
                    .as_deref()
                    .is_some_and(|last| t.effective_from.as_str() <= last)
                {
                    return Err(ContractError::rejected(
                        "term_too_early",
                        format!(
                            "A change takes effect after {}, the last change GoCardless has",
                            last_sent.unwrap_or_default()
                        ),
                    ));
                }
            }
            let clash: bool = tx
                .prepare_cached(
                    "SELECT 1 FROM regular_gift_terms
                     WHERE regular_gift_id = ?1 AND id <> ?2 AND withdrawn = 0
                       AND coalesce(applies_from, effective_from) = ?3",
                )?
                .exists(params![t.regular_gift_id, id, t.effective_from])?;
            if clash {
                return Err(ContractError::rejected(
                    "term_clash",
                    format!("Another change already starts on {}", t.effective_from),
                ));
            }
        }
        let held: HashSet<&str> = before
            .map(|b| {
                b.terms
                    .allocations
                    .iter()
                    .map(|a| a.source_code_id.as_str())
                    .collect()
            })
            .unwrap_or_default();
        check_codes(
            tx,
            t.allocations.iter().map(|a| a.source_code_id.as_str()),
            &held,
            next.restoring,
            next.system,
        )?;
        match before {
            None => {
                tx.prepare_cached(
                    "INSERT INTO regular_gift_terms (id, regular_gift_id, effective_from, amount,
                         frequency, day_of_month, month, note, withdrawn, origin, entered_by,
                         entered_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                )?
                .execute(params![
                    id,
                    t.regular_gift_id,
                    t.effective_from,
                    t.amount,
                    t.frequency.as_str(),
                    t.day_of_month,
                    t.month,
                    t.note,
                    t.withdrawn,
                    t.origin.as_str(),
                    next.entered_by,
                    next.entered_at
                ])?;
            }
            Some(_) => {
                tx.prepare_cached(
                    "UPDATE regular_gift_terms SET effective_from = ?2, amount = ?3, frequency = ?4,
                         day_of_month = ?5, month = ?6, note = ?7, withdrawn = ?8
                     WHERE id = ?1",
                )?
                .execute(params![
                    id,
                    t.effective_from,
                    t.amount,
                    t.frequency.as_str(),
                    t.day_of_month,
                    t.month,
                    t.note,
                    t.withdrawn
                ])?;
            }
        }
        write_allocations(
            tx,
            id,
            before
                .map(|b| b.terms.allocations.as_slice())
                .unwrap_or(&[]),
            &t.allocations,
        )
    }
}

/// Check the codes a row brings in: each a version of this organisation;
/// a new one not archived (the system's may be: the money came all the
/// same) and marked used. Codes already held are kept as they are.
fn check_codes<'a>(
    tx: &WriteTx,
    codes: impl Iterator<Item = &'a str>,
    held: &HashSet<&str>,
    restoring: bool,
    system: bool,
) -> Result<(), ContractError> {
    let mut seen = HashSet::new();
    for id in codes {
        if held.contains(id) || !seen.insert(id) {
            continue;
        }
        let Some(code) = sources::describe(tx, id)? else {
            return Err(ContractError::rejected(
                "unknown_source_code",
                "The source code must be a full code (category, detail and version)",
            ));
        };
        if !restoring {
            if !code.is_active && !system {
                return Err(ContractError::rejected(
                    "archived_source_code",
                    format!("{} is archived: choose another", code.code),
                ));
            }
            sources::mark_used(tx, id, false)?;
        }
    }
    Ok(())
}

fn write_allocations(
    tx: &WriteTx,
    id: &str,
    before: &[TermAllocationRow],
    next: &[TermAllocationRow],
) -> Result<(), ContractError> {
    let rows = reconcile("allocations", before, next)?;
    let mut owner =
        tx.prepare_cached("SELECT term_id FROM regular_gift_term_allocations WHERE id = ?1")?;
    for a in &rows.added {
        let held: Option<String> = owner.query_row([a.id()], |r| r.get(0)).optional()?;
        if held.is_some_and(|t| t != id) {
            return Err(ContractError::rejected(
                "child_ownership",
                format!("allocation {} belongs to another change", a.id()),
            ));
        }
    }
    let mut delete =
        tx.prepare_cached("DELETE FROM regular_gift_term_allocations WHERE id = ?1")?;
    for a in &rows.removed {
        delete.execute([a.id()])?;
    }
    let mut upsert = tx.prepare_cached(
        "INSERT INTO regular_gift_term_allocations (id, term_id, position, source_code_id, amount)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET position = excluded.position,
             source_code_id = excluded.source_code_id, amount = excluded.amount",
    )?;
    for (i, a) in next.iter().enumerate() {
        upsert.execute(params![a.id(), id, i as i64, a.source_code_id, a.amount])?;
    }
    Ok(())
}

// ── giving.regularGiftTermSync ─────────────────────────────────────────────

/// Where a row stands at GoCardless: the system's alone.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncPayload {
    pub state: SyncState,
    /// The GoCardless subscription it runs under.
    pub subscription_id: Option<String>,
    /// When the system started sending it (ms).
    #[ts(type = "number | null")]
    pub sent_at: Option<i64>,
    /// The payment it really starts on (ISO), when it missed the one it
    /// was meant for.
    pub applies_from: Option<String>,
    /// Why GoCardless refused it for good (it went back to `scheduled`
    /// for staff to edit or withdraw), and the `termsVersion` it was
    /// refused at: the job tries again only once the row is edited.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub error_terms_version: Option<i64>,
}

/// The slice as stored, plus whether staff withdrew the row.
#[derive(Clone, Debug, Serialize)]
pub struct SyncSliceState {
    #[serde(flatten)]
    pub sync: SyncPayload,
    #[serde(skip)]
    withdrawn: bool,
}

pub struct RegularGiftTermSync;
pub static REGULAR_GIFT_TERM_SYNC: RegularGiftTermSync = RegularGiftTermSync;

impl Contract for RegularGiftTermSync {
    const NAME: &'static str = "giving.regularGiftTermSync";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "sync_version";
    type Payload = SyncPayload;
    type State = SyncSliceState;

    fn prepare(&self, p: SyncPayload) -> Result<SyncPayload, ContractError> {
        if p.applies_from.as_deref().is_some_and(|d| !is_iso_date(d)) {
            return Err(ContractError::invalid(
                "appliesFrom",
                "Dates are YYYY-MM-DD",
            ));
        }
        Ok(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<SyncSliceState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT state, subscription_id, sent_at, applies_from, withdrawn, sync_error,
                     sync_error_terms_version
                 FROM regular_gift_terms WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok(SyncSliceState {
                    sync: SyncPayload {
                        state: SyncState::parse(&r.get::<_, String>(0)?),
                        subscription_id: r.get(1)?,
                        sent_at: r.get(2)?,
                        applies_from: r.get(3)?,
                        error: r.get(5)?,
                        error_terms_version: r.get(6)?,
                    },
                    withdrawn: r.get(4)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&SyncSliceState>,
        p: &SyncPayload,
        command: &Command,
    ) -> Result<SyncSliceState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giving.regularGiftTermSync targets an existing change",
            ));
        };
        if command.source != Source::System {
            return Err(ContractError::rejected(
                "not_restorable",
                "Only the system says where a change stands with GoCardless",
            ));
        }
        if current.withdrawn && p.state != current.sync.state {
            return Err(ContractError::rejected(
                "term_withdrawn",
                "This change was withdrawn",
            ));
        }
        Ok(SyncSliceState {
            sync: p.clone(),
            withdrawn: current.withdrawn,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&SyncSliceState>,
        next: &SyncSliceState,
    ) -> Result<(), ContractError> {
        let s = &next.sync;
        tx.prepare_cached(
            "UPDATE regular_gift_terms SET state = ?2, subscription_id = ?3, sent_at = ?4,
                 applies_from = ?5, sync_error = ?6, sync_error_terms_version = ?7
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            s.state.as_str(),
            s.subscription_id,
            s.sent_at,
            s.applies_from,
            s.error,
            s.error_terms_version
        ])?;
        Ok(())
    }
}

// ── giving.regularGiftTermCode ─────────────────────────────────────────────

/// The code credited with the change (a version), or none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CodePayload {
    pub change_code_id: Option<String>,
}

/// The slice as stored, plus how this command runs.
#[derive(Clone, Debug, Serialize)]
pub struct CodeState {
    #[serde(flatten)]
    pub code: CodePayload,
    #[serde(skip)]
    restoring: bool,
}

pub struct RegularGiftTermCode;
pub static REGULAR_GIFT_TERM_CODE: RegularGiftTermCode = RegularGiftTermCode;

impl Contract for RegularGiftTermCode {
    const NAME: &'static str = "giving.regularGiftTermCode";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "code_version";
    type Payload = CodePayload;
    type State = CodeState;

    fn prepare(&self, mut p: CodePayload) -> Result<CodePayload, ContractError> {
        p.change_code_id = p.change_code_id.filter(|c| !c.trim().is_empty());
        Ok(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<CodeState, ContractError> {
        tx.read()
            .prepare_cached("SELECT change_code_id FROM regular_gift_terms WHERE id = ?1")?
            .query_row([id], |r| {
                Ok(CodeState {
                    code: CodePayload {
                        change_code_id: r.get(0)?,
                    },
                    restoring: false,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&CodeState>,
        p: &CodePayload,
        command: &Command,
    ) -> Result<CodeState, ContractError> {
        if current.is_none() {
            return Err(ContractError::rejected(
                "no_root",
                "giving.regularGiftTermCode targets an existing change",
            ));
        }
        Ok(CodeState {
            code: p.clone(),
            restoring: command.source == Source::Restore,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&CodeState>,
        next: &CodeState,
    ) -> Result<(), ContractError> {
        let held: HashSet<&str> = before
            .and_then(|b| b.code.change_code_id.as_deref())
            .into_iter()
            .collect();
        check_codes(
            tx,
            next.code.change_code_id.as_deref().into_iter(),
            &held,
            next.restoring,
            false,
        )?;
        tx.prepare_cached("UPDATE regular_gift_terms SET change_code_id = ?2 WHERE id = ?1")?
            .execute(params![id, next.code.change_code_id])?;
        Ok(())
    }
}

// ── reads ──────────────────────────────────────────────────────────────────

/// Where a row stands, as staff see it: the sync state, or `withdrawn`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "TermStatus")]
pub enum TermStatus {
    Scheduled,
    Sending,
    Sent,
    Applied,
    Withdrawn,
}

/// One layer of a row's split as the card shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TermAllocationView {
    pub key: String,
    pub source_code_id: String,
    /// The code as it reads now.
    pub source_code: Option<String>,
    #[ts(type = "number")]
    pub amount: i64,
}

/// One row of the chain, with what it changed from the live row before.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TermView {
    pub id: String,
    pub regular_gift_id: String,
    /// What staff chose (or the set-up's, or GoCardless's next payment).
    pub effective_from: String,
    /// Set when the change missed its intended payment: the one it starts
    /// on instead.
    pub applies_from: Option<String>,
    /// `appliesFrom`, else `effectiveFrom`: what the chain reads.
    pub effective_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub frequency: Frequency,
    pub day_of_month: u8,
    pub month: Option<u8>,
    pub allocations: Vec<TermAllocationView>,
    pub note: Option<String>,
    pub origin: Origin,
    pub status: TermStatus,
    pub subscription_id: Option<String>,
    #[ts(type = "number | null")]
    pub sent_at: Option<i64>,
    /// Why GoCardless refused it for good, if it did: edit or withdraw it.
    pub sync_error: Option<String>,
    pub change_code_id: Option<String>,
    pub change_code: Option<String>,
    /// From the live row before (withdrawn rows: from the row before them
    /// all the same).
    pub change_kind: ChangeKind,
    /// A change GoCardless told us of, not yet credited to a code.
    pub uncoded: bool,
    #[ts(type = "number | null")]
    pub entered_by: Option<i64>,
    #[ts(type = "number")]
    pub entered_at: i64,
    #[ts(type = "number")]
    pub terms_version: i64,
    #[ts(type = "number")]
    pub sync_version: i64,
    #[ts(type = "number")]
    pub code_version: i64,
}

impl TermView {
    pub fn is_live(&self) -> bool {
        self.status != TermStatus::Withdrawn
    }

    /// The split as the rules read it.
    pub fn split(&self) -> Vec<Share> {
        self.allocations
            .iter()
            .map(|a| Share::new(&a.source_code_id, a.amount))
            .collect()
    }

    pub fn rules(&self) -> Terms {
        Terms {
            effective_on: self.effective_on.clone(),
            amount: self.amount,
            frequency: self.frequency,
            day_of_month: self.day_of_month,
            month: self.month,
            split: self.split(),
        }
    }
}

const VIEW_COLUMNS: &str = "id, regular_gift_id, effective_from, applies_from, amount, frequency, \
     day_of_month, month, note, origin, state, withdrawn, subscription_id, sent_at, \
     change_code_id, entered_by, entered_at, terms_version, sync_version, code_version, \
     sync_error";

fn view_row(r: &Row) -> rusqlite::Result<TermView> {
    let effective_from: String = r.get(2)?;
    let applies_from: Option<String> = r.get(3)?;
    let withdrawn: bool = r.get(11)?;
    let status = if withdrawn {
        TermStatus::Withdrawn
    } else {
        match SyncState::parse(&r.get::<_, String>(10)?) {
            SyncState::Scheduled => TermStatus::Scheduled,
            SyncState::Sending => TermStatus::Sending,
            SyncState::Sent => TermStatus::Sent,
            SyncState::Applied => TermStatus::Applied,
        }
    };
    let origin = Origin::parse(&r.get::<_, String>(9)?);
    let change_code_id: Option<String> = r.get(14)?;
    Ok(TermView {
        id: r.get(0)?,
        regular_gift_id: r.get(1)?,
        effective_on: applies_from
            .clone()
            .unwrap_or_else(|| effective_from.clone()),
        effective_from,
        applies_from,
        amount: r.get(4)?,
        frequency: Frequency::parse(&r.get::<_, String>(5)?),
        day_of_month: r.get(6)?,
        month: r.get(7)?,
        allocations: vec![],
        note: r.get(8)?,
        origin,
        status,
        subscription_id: r.get(12)?,
        sent_at: r.get(13)?,
        sync_error: r.get(20)?,
        uncoded: origin == Origin::Gocardless && change_code_id.is_none() && !withdrawn,
        change_code_id,
        change_code: None,
        change_kind: ChangeKind::Unchanged,
        entered_by: r.get(15)?,
        entered_at: r.get(16)?,
        terms_version: r.get(17)?,
        sync_version: r.get(18)?,
        code_version: r.get(19)?,
    })
}

/// A regular gift's chain, every row withdrawn included, in effective
/// order (then entry order), each with its split and change kind.
pub fn chain(conn: &Connection, regular_gift_id: &str) -> rusqlite::Result<Vec<TermView>> {
    let mut rows: Vec<TermView> = conn
        .prepare_cached(&format!(
            "SELECT {VIEW_COLUMNS} FROM regular_gift_terms WHERE regular_gift_id = ?1
             ORDER BY coalesce(applies_from, effective_from), seq"
        ))?
        .query_map([regular_gift_id], view_row)?
        .collect::<rusqlite::Result<_>>()?;
    let mut previous: Option<Terms> = None;
    for row in &mut rows {
        row.allocations = load_allocations(conn, &row.id)?
            .into_iter()
            .map(|a| {
                Ok(TermAllocationView {
                    key: a.key.unwrap_or_default(),
                    source_code: sources::describe(conn, &a.source_code_id)?.map(|c| c.code),
                    source_code_id: a.source_code_id,
                    amount: a.amount,
                })
            })
            .collect::<rusqlite::Result<_>>()?;
        row.change_code = match &row.change_code_id {
            Some(id) => sources::describe(conn, id)?.map(|c| c.code),
            None => None,
        };
        let terms = row.rules();
        row.change_kind = terms_rules::change_kind(previous.as_ref(), &terms);
        if row.is_live() {
            previous = Some(terms);
        }
    }
    Ok(rows)
}

/// The live rows of a chain, as the rules read them.
pub fn live_rules(chain: &[TermView]) -> Vec<Terms> {
    chain
        .iter()
        .filter(|t| t.is_live())
        .map(TermView::rules)
        .collect()
}

/// The live row in force on `date` (ISO), if any.
pub fn in_force<'a>(chain: &'a [TermView], date: &str) -> Option<&'a TermView> {
    chain
        .iter()
        .filter(|t| t.is_live())
        .rev()
        .find(|t| t.effective_on.as_str() <= date)
}

/// The row GoCardless runs now: the last live row that isn't scheduled
/// any more (row 1 at least, once set up).
pub fn current_at_provider(chain: &[TermView]) -> Option<&TermView> {
    chain
        .iter()
        .rfind(|t| t.is_live() && t.status != TermStatus::Scheduled)
        .or_else(|| chain.iter().find(|t| t.is_live()))
}

/// One row by id: its regular gift and view, or `None`.
pub fn get_term(conn: &Connection, id: &str) -> rusqlite::Result<Option<TermView>> {
    let regular: Option<String> = conn
        .prepare_cached("SELECT regular_gift_id FROM regular_gift_terms WHERE id = ?1")?
        .query_row([id], |r| r.get(0))
        .optional()?;
    let Some(regular) = regular else {
        return Ok(None);
    };
    Ok(chain(conn, &regular)?.into_iter().find(|t| t.id == id))
}

/// Amount changes GoCardless has had on subscription `sb`: the rows that
/// run under it whose amount differs from the row before (a change of
/// split alone sends nothing).
pub fn amendments(conn: &Connection, sb: &str) -> rusqlite::Result<i64> {
    let amounts: Vec<i64> = conn
        .prepare_cached(
            "SELECT amount FROM regular_gift_terms
             WHERE subscription_id = ?1 AND withdrawn = 0 AND state <> 'scheduled'
             ORDER BY coalesce(applies_from, effective_from), seq",
        )?
        .query_map([sb], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(amounts.windows(2).filter(|w| w[0] != w[1]).count() as i64)
}

/// The regular gift a subscription belongs to, now or before: its
/// current one, or one a row of its chain ran under (a subscription
/// replaced by a new frequency or day).
pub fn regular_gift_of_subscription(
    conn: &Connection,
    sb: &str,
) -> rusqlite::Result<Option<String>> {
    let now: Option<String> = conn
        .prepare_cached("SELECT id FROM regular_gifts WHERE subscription_id = ?1")?
        .query_row([sb], |r| r.get(0))
        .optional()?;
    if now.is_some() {
        return Ok(now);
    }
    conn.prepare_cached(
        "SELECT regular_gift_id FROM regular_gift_terms INDEXED BY regular_gift_terms_by_subscription
         WHERE subscription_id = ?1 LIMIT 1",
    )?
    .query_row([sb], |r| r.get(0))
    .optional()
}

/// A scheduled row whose time has come (or one the job took and must
/// finish): what the sync job reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DueTerm {
    pub term_id: String,
    pub regular_gift_id: String,
    /// Taken already: the job is finishing it.
    pub sending: bool,
}

/// Rows to send on `today` (ISO): scheduled, live, of a regular gift that
/// hasn't ended, taking effect within [`SEND_AHEAD_DAYS`], not refused
/// for good at their present terms; and every row the job started
/// sending and didn't finish, whatever became of its gift (the job
/// finishes or undoes what it began).
pub fn due(conn: &Connection, today: &str) -> rusqlite::Result<Vec<DueTerm>> {
    let horizon = terms_rules::add_days(today, SEND_AHEAD_DAYS).unwrap_or_else(|| today.into());
    conn.prepare_cached(
        "SELECT t.id, t.regular_gift_id, t.state = 'sending' FROM regular_gift_terms t
         JOIN regular_gifts g ON g.id = t.regular_gift_id
         WHERE t.withdrawn = 0
           AND ((t.state = 'scheduled' AND g.status IN ('pending', 'active')
                 AND coalesce(t.applies_from, t.effective_from) <= ?1
                 AND t.sync_error_terms_version IS NOT t.terms_version)
                OR t.state = 'sending')
         ORDER BY t.regular_gift_id, coalesce(t.applies_from, t.effective_from), t.seq",
    )?
    .query_map([horizon], |r| {
        Ok(DueTerm {
            term_id: r.get(0)?,
            regular_gift_id: r.get(1)?,
            sending: r.get(2)?,
        })
    })?
    .collect()
}

// ── commands ───────────────────────────────────────────────────────────────

/// The first row of a new regular gift (set-up, or a subscription staff
/// adopted): one code for the whole amount, in force from
/// `effective_from`, already at GoCardless (`applied`), under `group`.
#[allow(clippy::too_many_arguments)]
pub fn create_first_row(
    ctx: &Ctx,
    regular_gift_id: &str,
    effective_from: &str,
    amount: i64,
    frequency: Frequency,
    day_of_month: u8,
    month: Option<u8>,
    source_code_id: &str,
    subscription_id: Option<String>,
    group: &CommandGroup,
) -> Result<String, ContractError> {
    let id = execute(
        ctx,
        &REGULAR_GIFT_TERMS,
        TermsPayload {
            regular_gift_id: regular_gift_id.to_owned(),
            effective_from: effective_from.to_owned(),
            amount,
            frequency,
            day_of_month,
            month,
            allocations: vec![TermAllocationRow {
                key: None,
                source_code_id: source_code_id.to_owned(),
                amount,
            }],
            note: None,
            withdrawn: false,
            origin: Origin::Setup,
        },
        Exec::create(Source::System).in_group(group),
    )?
    .id;
    execute(
        ctx,
        &REGULAR_GIFT_TERM_SYNC,
        SyncPayload {
            state: SyncState::Applied,
            subscription_id,
            sent_at: None,
            applies_from: None,
            error: None,
            error_terms_version: None,
        },
        Exec::update(&id, Some(0), Source::System).in_group(group),
    )?;
    Ok(id)
}

/// A change staff enter: a new total (and, if it changes, the schedule)
/// from a date; the split is worked out from the row before unless
/// given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TermChange {
    /// ISO date: the first payment at the new terms (pick from the
    /// regular gift's `upcoming` dates).
    pub effective_from: String,
    #[ts(type = "number")]
    pub amount: i64,
    /// Default: the row before's.
    #[serde(default)]
    #[ts(optional)]
    pub frequency: Option<Frequency>,
    #[serde(default)]
    #[ts(optional)]
    pub day_of_month: Option<u8>,
    #[serde(default)]
    #[ts(optional)]
    pub month: Option<u8>,
    /// The code credited with the change: required on an upgrade, where
    /// the difference goes to it.
    #[serde(default)]
    #[ts(optional)]
    pub change_code_id: Option<String>,
    /// The whole split ("Edit split"); default: the row before's, moved
    /// by the upgrade or downgrade (newest money first).
    #[serde(default)]
    #[ts(optional)]
    pub allocations: Option<Vec<TermAllocationRow>>,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
}

/// The payload a change makes, from the live row before its date
/// (`except`: the row being edited, left out). Refuses an upgrade with no
/// code, and a new frequency with no split (a split never divides).
fn change_payload(
    conn: &Connection,
    regular_gift_id: &str,
    change: &TermChange,
    except: Option<&str>,
    today: &str,
) -> Result<TermsPayload, ContractError> {
    if is_iso_date(&change.effective_from) && change.effective_from.as_str() <= today {
        return Err(ContractError::invalid(
            "effectiveFrom",
            "A change takes effect from a payment still to come",
        ));
    }
    let chain = chain(conn, regular_gift_id)?;
    let before = chain
        .iter()
        .filter(|t| t.is_live() && Some(t.id.as_str()) != except)
        .rev()
        .find(|t| t.effective_on.as_str() < change.effective_from.as_str())
        .or_else(|| chain.iter().find(|t| t.is_live()))
        .ok_or(ContractError::NotFound)?;
    let frequency = change.frequency.unwrap_or(before.frequency);
    let month = match frequency {
        Frequency::Monthly => None,
        Frequency::Yearly | Frequency::Quarterly => change.month.or(before.month),
    };
    let new = Terms {
        effective_on: change.effective_from.clone(),
        amount: change.amount,
        frequency,
        day_of_month: change.day_of_month.unwrap_or(before.day_of_month),
        month,
        split: vec![],
    };
    // The chain's two readings (a payment's split by date, expected by
    // month) agree only on the schedule's own dates.
    if is_iso_date(&change.effective_from)
        && !terms_rules::is_due_date(&new, &change.effective_from)
    {
        return Err(ContractError::invalid(
            "effectiveFrom",
            "Pick one of the payment dates: the new terms' day (or a few days after, \
             where a weekend or bank holiday moved it)",
        ));
    }
    let code = change.change_code_id.as_deref().filter(|c| !c.is_empty());
    let allocations = match &change.allocations {
        Some(rows) => rows.clone(),
        None if frequency != before.frequency && change.amount != before.amount => {
            return Err(ContractError::invalid(
                "allocations",
                "Give the split for the new frequency",
            ));
        }
        None => {
            let split = before.split();
            let moved = if change.amount > before.amount {
                let Some(code) = code else {
                    return Err(ContractError::invalid(
                        "changeCodeId",
                        "An upgrade needs the code that won it",
                    ));
                };
                terms_rules::upgrade_split(&split, change.amount, code)
            } else {
                terms_rules::downgrade_split(&split, change.amount.max(1))
            };
            moved
                .into_iter()
                .map(|s| TermAllocationRow {
                    key: None,
                    source_code_id: s.source_code_id,
                    amount: s.amount,
                })
                .collect()
        }
    };
    let kind = terms_rules::change_kind(Some(&before.rules()), &new);
    if kind == ChangeKind::Upgrade && code.is_none() {
        return Err(ContractError::invalid(
            "changeCodeId",
            "An upgrade needs the code that won it",
        ));
    }
    Ok(TermsPayload {
        regular_gift_id: regular_gift_id.to_owned(),
        effective_from: change.effective_from.clone(),
        amount: change.amount,
        frequency,
        day_of_month: new.day_of_month,
        month,
        allocations,
        note: change.note.clone(),
        withdrawn: false,
        origin: Origin::Staff,
    })
}

/// The command group's name for a change: "change regular gift to £12
/// monthly from 2026-12-05".
fn change_group_name(p: &TermsPayload) -> String {
    format!(
        "change regular gift to {} {} from {}",
        format_pence(p.amount),
        p.frequency.as_str(),
        p.effective_from
    )
}

/// Staff change regular gift `regular_gift_id`'s terms from a date:
/// a new row (scheduled) and its code, in one command group. Its id.
/// `id`: pre-generated (a form's), else fresh.
pub fn change_terms(
    ctx: &Ctx,
    regular_gift_id: &str,
    id: Option<&str>,
    change: TermChange,
    source: Source,
) -> Result<String, ContractError> {
    let conn = ctx.tx.read();
    if crate::regular::facts(conn, regular_gift_id)?.is_none() {
        return Err(ContractError::NotFound);
    }
    let today = terms_rules::date_of_ms(ctx.at);
    let payload = change_payload(conn, regular_gift_id, &change, None, &today)?;
    let group = command_group(ctx, &change_group_name(&payload))?;
    let exec = match id {
        Some(id) => Exec::create_with_id(id, source),
        None => Exec::create(source),
    };
    let id = execute(ctx, &REGULAR_GIFT_TERMS, payload, exec.in_group(&group))?.id;
    if change.change_code_id.is_some() {
        execute(
            ctx,
            &REGULAR_GIFT_TERM_CODE,
            CodePayload {
                change_code_id: change.change_code_id,
            },
            Exec::update(&id, Some(0), source).in_group(&group),
        )?;
    }
    Ok(id)
}

/// Staff edit a scheduled row (`expected`: its `termsVersion`), and its
/// code if the change names another (`code_expected`: its `codeVersion`,
/// needed then, so a code set meanwhile is a `409`, never overwritten),
/// in one command group.
pub fn edit_terms(
    ctx: &Ctx,
    term_id: &str,
    expected: i64,
    code_expected: Option<i64>,
    change: TermChange,
    source: Source,
) -> Result<Executed, ContractError> {
    let conn = ctx.tx.read();
    let current = get_term(conn, term_id)?.ok_or(ContractError::NotFound)?;
    let today = terms_rules::date_of_ms(ctx.at);
    let payload = change_payload(
        conn,
        &current.regular_gift_id,
        &change,
        Some(term_id),
        &today,
    )?;
    let new_code =
        change.change_code_id.is_some() && change.change_code_id != current.change_code_id;
    if new_code && code_expected.is_none() {
        return Err(ContractError::invalid(
            "codeExpected",
            "Say which code version you changed (codeVersion)",
        ));
    }
    let group = command_group(ctx, &change_group_name(&payload))?;
    let done = execute(
        ctx,
        &REGULAR_GIFT_TERMS,
        payload,
        Exec::update(term_id, Some(expected), source).in_group(&group),
    )?;
    if new_code {
        execute(
            ctx,
            &REGULAR_GIFT_TERM_CODE,
            CodePayload {
                change_code_id: change.change_code_id,
            },
            Exec::update(term_id, code_expected, source).in_group(&group),
        )?;
    }
    Ok(done)
}

/// Withdraw a scheduled row (`expected`: its `termsVersion`; `None` for
/// the system's own).
pub fn withdraw(
    ctx: &Ctx,
    term_id: &str,
    expected: Option<i64>,
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<Executed, ContractError> {
    let current = load_terms(ctx.tx.read(), term_id)?.ok_or(ContractError::NotFound)?;
    let exec = Exec::update(term_id, expected, source);
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(
        ctx,
        &REGULAR_GIFT_TERMS,
        TermsPayload {
            withdrawn: true,
            ..current.terms
        },
        exec,
    )
}

/// Every scheduled row of a regular gift that has ended is withdrawn
/// (the system's), under `group`.
pub fn withdraw_scheduled(
    ctx: &Ctx,
    regular_gift_id: &str,
    group: Option<&CommandGroup>,
) -> Result<usize, ContractError> {
    let ids: Vec<String> = ctx
        .tx
        .read()
        .prepare_cached(
            "SELECT id FROM regular_gift_terms
             WHERE regular_gift_id = ?1 AND state = 'scheduled' AND withdrawn = 0",
        )?
        .query_map([regular_gift_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &ids {
        withdraw(ctx, id, None, Source::System, group)?;
    }
    Ok(ids.len())
}

/// Staff set (or clear) the code credited with a change, at any state
/// (`expected`: its `codeVersion`).
pub fn set_code(
    ctx: &Ctx,
    term_id: &str,
    expected: i64,
    change_code_id: Option<String>,
    source: Source,
) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &REGULAR_GIFT_TERM_CODE,
        CodePayload { change_code_id },
        Exec::update(term_id, Some(expected), source),
    )
}

/// Change a row's sync slice with `change` unless that changes nothing
/// (the system's). `None` when nothing changed.
pub fn update_sync(
    ctx: &Ctx,
    term_id: &str,
    group: Option<&CommandGroup>,
    change: impl FnOnce(&mut SyncPayload),
) -> Result<Option<Executed>, ContractError> {
    let current = REGULAR_GIFT_TERM_SYNC.load(ctx.tx, term_id)?.sync;
    let mut next = current.clone();
    change(&mut next);
    if next == current {
        return Ok(None);
    }
    let exec = Exec::update(term_id, None, Source::System);
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(ctx, &REGULAR_GIFT_TERM_SYNC, next, exec).map(Some)
}

/// A change GoCardless told us of that we didn't send: subscription `sb`
/// of regular gift `regular_gift_id` now collects `amount`, from the
/// next payment (`from`, ISO). Recorded as a row (applied, uncoded, noted
/// "changed in GoCardless") with the difference on the newest layer.
/// Nothing if the chain already says so from then. Its id.
pub fn record_outside_change(
    ctx: &Ctx,
    regular_gift_id: &str,
    sb: &str,
    amount: i64,
    from: &str,
) -> Result<Option<String>, ContractError> {
    let conn = ctx.tx.read();
    let chain = chain(conn, regular_gift_id)?;
    let Some(before) = current_at_provider(&chain) else {
        return Err(ContractError::NotFound);
    };
    if before.amount == amount {
        return Ok(None);
    }
    // What we sent on this subscription before it, GoCardless had: the
    // change made in its dashboard came after (review M7). A row still
    // being sent is left to the job.
    for t in chain
        .iter()
        .filter(|t| t.status == TermStatus::Sent && t.subscription_id.as_deref() == Some(sb))
    {
        update_sync(ctx, &t.id, None, |s| s.state = SyncState::Applied)?;
    }
    let split = terms_rules::split_for_collected(&before.split(), amount);
    let latest = chain
        .iter()
        .filter(|t| t.is_live() && t.status != TermStatus::Scheduled)
        .map(|t| t.effective_on.as_str())
        .max()
        .unwrap_or("");
    // After everything GoCardless already has: never two rows on one day.
    let from = if from <= latest {
        terms_rules::add_days(latest, 1).unwrap_or_else(|| from.to_owned())
    } else {
        from.to_owned()
    };
    let group = command_group(
        ctx,
        &format!(
            "regular gift changed in GoCardless to {}",
            format_pence(amount)
        ),
    )?;
    let id = execute(
        ctx,
        &REGULAR_GIFT_TERMS,
        TermsPayload {
            regular_gift_id: regular_gift_id.to_owned(),
            effective_from: from,
            amount,
            frequency: before.frequency,
            day_of_month: before.day_of_month,
            month: before.month,
            allocations: split
                .into_iter()
                .map(|s| TermAllocationRow {
                    key: None,
                    source_code_id: s.source_code_id,
                    amount: s.amount,
                })
                .collect(),
            note: Some(CHANGED_IN_GOCARDLESS.into()),
            withdrawn: false,
            origin: Origin::Gocardless,
        },
        Exec::create(Source::System).in_group(&group),
    )?
    .id;
    execute(
        ctx,
        &REGULAR_GIFT_TERM_SYNC,
        SyncPayload {
            state: SyncState::Applied,
            subscription_id: Some(sb.to_owned()),
            sent_at: None,
            applies_from: None,
            error: None,
            error_terms_version: None,
        },
        Exec::update(&id, Some(0), Source::System).in_group(&group),
    )?;
    Ok(Some(id))
}

/// A payment of regular gift `regular_gift_id` scheduled on
/// `scheduled_on` for `amount`, first heard of: the rows GoCardless has
/// that it settles. A sent row due on or before it that the payment
/// collects is `applied`; one due on that very day that the payment
/// doesn't collect (it was created at the old terms) moves to the next
/// payment (`applies_from`), so the chain says what really happened.
pub fn on_payment(
    ctx: &Ctx,
    regular_gift_id: &str,
    scheduled_on: &str,
    amount: i64,
    group: Option<&CommandGroup>,
) -> Result<(), ContractError> {
    let chain = chain(ctx.tx.read(), regular_gift_id)?;
    for t in chain
        .iter()
        .filter(|t| matches!(t.status, TermStatus::Sending | TermStatus::Sent))
    {
        if t.effective_on.as_str() > scheduled_on {
            continue;
        }
        if t.amount == amount {
            update_sync(ctx, &t.id, group, |s| s.state = SyncState::Applied)?;
        } else if t.effective_on == scheduled_on
            && let Some(next) = terms_rules::next_due(&t.rules(), scheduled_on, 1).pop()
        {
            update_sync(ctx, &t.id, group, |s| s.applies_from = Some(next))?;
        }
    }
    Ok(())
}

/// The latest scheduled date of regular gift `id`'s payments on or after
/// `date` (one GoCardless already created), if any.
pub fn payment_on_or_after(
    conn: &Connection,
    regular_gift_id: &str,
    date: &str,
) -> rusqlite::Result<Option<(String, i64)>> {
    conn.prepare_cached(
        "SELECT scheduled_on, amount FROM direct_debit_payments
         WHERE regular_gift_id = ?1 AND scheduled_on >= ?2
         ORDER BY scheduled_on DESC, seq DESC LIMIT 1",
    )?
    .query_row(params![regular_gift_id, date], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()
}

/// Org schema step 20, the dated chain (ADR 0026), after Gift Aid's
/// declaration scans (19) and `giving::MIGRATION_UNIFIED` (18). Run
/// with foreign keys deferred (it rebuilds `regular_gifts`, which
/// payments, gifts and requests point at):
/// - `regular_gifts` loses its terms (amount, frequency, day, month,
///   code); `terms_version` becomes `setup_version`;
/// - `regular_gift_terms` and `regular_gift_term_allocations`, with one
///   applied row per regular gift from its old columns, in force from
///   its first payment's charge date or the day it was set up;
/// - `gifts.scheduled_on` (a regular gift's provider payments) and
///   `direct_debit_payments.scheduled_on`, from the charge date, and the
///   subscription a payment came from.
pub const MIGRATION: &str = "
CREATE TABLE regular_gifts_old AS SELECT * FROM regular_gifts;
DROP TABLE regular_gifts;
CREATE TABLE regular_gifts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'cancelled', 'failed')),
    ended_reason TEXT,
    ended_at INTEGER,
    billing_request_id TEXT UNIQUE,
    flow_url TEXT,
    flow_expires_at TEXT,
    mandate_id TEXT UNIQUE,
    subscription_id TEXT UNIQUE,
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    client_key TEXT UNIQUE,
    setup_version INTEGER NOT NULL DEFAULT 0,
    mandate_version INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO regular_gifts (seq, id, contact_id, status, ended_reason, ended_at,
    billing_request_id, flow_url, flow_expires_at, mandate_id, subscription_id, entered_by,
    entered_at, client_key, setup_version, mandate_version)
SELECT seq, id, contact_id, status, ended_reason, ended_at, billing_request_id, flow_url,
    flow_expires_at, mandate_id, subscription_id, entered_by, entered_at, client_key,
    terms_version, mandate_version
FROM regular_gifts_old;
CREATE INDEX regular_gifts_by_contact ON regular_gifts (contact_id, seq);

CREATE TABLE regular_gift_terms (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    regular_gift_id TEXT NOT NULL REFERENCES regular_gifts (id),
    effective_from TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly')),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
    month INTEGER CHECK (month BETWEEN 1 AND 12),
    note TEXT,
    withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
    origin TEXT NOT NULL DEFAULT 'staff' CHECK (origin IN ('setup', 'staff', 'gocardless')),
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    change_code_id TEXT REFERENCES source_codes (id),
    state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (state IN ('scheduled', 'sending', 'sent', 'applied')),
    subscription_id TEXT,
    sent_at INTEGER,
    applies_from TEXT,
    sync_error TEXT,
    sync_error_terms_version INTEGER,
    terms_version INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 0,
    code_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX regular_gift_terms_by_gift ON regular_gift_terms (regular_gift_id, effective_from);
CREATE INDEX regular_gift_terms_due ON regular_gift_terms (effective_from)
    WHERE state IN ('scheduled', 'sending');
CREATE INDEX regular_gift_terms_by_subscription ON regular_gift_terms (subscription_id)
    WHERE subscription_id IS NOT NULL;
CREATE TABLE regular_gift_term_allocations (
    id TEXT PRIMARY KEY,
    term_id TEXT NOT NULL REFERENCES regular_gift_terms (id),
    position INTEGER NOT NULL,
    source_code_id TEXT NOT NULL REFERENCES source_codes (id),
    amount INTEGER NOT NULL CHECK (amount > 0)
) STRICT;
CREATE INDEX regular_gift_term_allocations_by_term
    ON regular_gift_term_allocations (term_id, position);

ALTER TABLE direct_debit_payments ADD COLUMN scheduled_on TEXT;
ALTER TABLE direct_debit_payments ADD COLUMN subscription_id TEXT;
UPDATE direct_debit_payments SET scheduled_on = charge_date;
ALTER TABLE gifts ADD COLUMN scheduled_on TEXT;
UPDATE gifts SET scheduled_on = (SELECT p.charge_date FROM direct_debit_payments p
                                 WHERE p.gift_id = gifts.id)
WHERE regular_gift_id IS NOT NULL AND provider_payment_id IS NOT NULL;
CREATE INDEX gifts_by_scheduled ON gifts (regular_gift_id, scheduled_on)
    WHERE scheduled_on IS NOT NULL;
CREATE INDEX direct_debit_payments_by_subscription ON direct_debit_payments (subscription_id)
    WHERE subscription_id IS NOT NULL;

INSERT INTO regular_gift_terms (id, regular_gift_id, effective_from, amount, frequency,
    day_of_month, month, origin, entered_by, entered_at, state, subscription_id)
SELECT lower(hex(randomblob(16))), r.id,
    coalesce((SELECT min(p.charge_date) FROM direct_debit_payments p
              WHERE p.regular_gift_id = r.id),
             date(r.entered_at / 1000, 'unixepoch')),
    r.amount, r.frequency, r.day_of_month, r.month, 'setup', r.entered_by, r.entered_at,
    'applied', r.subscription_id
FROM regular_gifts_old r ORDER BY r.seq;
INSERT INTO regular_gift_term_allocations (id, term_id, position, source_code_id, amount)
SELECT lower(hex(randomblob(16))), t.id, 0, r.source_code_id, r.amount
FROM regular_gift_terms t JOIN regular_gifts_old r ON r.id = t.regular_gift_id;
DROP TABLE regular_gifts_old;
";
