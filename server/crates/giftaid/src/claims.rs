//! Gift Aid claims (rule 4: a real financial record, not a field). One
//! `gift_aid_claims` root per claim, its donations as
//! `gift_aid_claim_lines` and the tax it gives back as
//! `gift_aid_claim_adjustments`. Two contracts partition it:
//!
//! ```text
//!   giftaid.claim        — the claim as made: its period, every line
//!                          (gift, declaration, the donor as sent) and
//!                          adjustment, and the totals. Create-only.
//!   giftaid.claimStatus  — draft → ready → submitted → paid, or rejected;
//!                          a draft deleted. The facts each step records
//!                          (date submitted and HMRC's reference, amount
//!                          and date paid, why rejected), and whether the
//!                          claim's lines still hold their gifts (`live`).
//! ```
//!
//! **A gift is in at most one live claim**, by the schema: a partial
//! unique index on the lines' `gift_id` where `live = 1` (and likewise
//! for adjustments). The create inserts its rows live; only
//! `giftaid.claimStatus` sets `live = 0` (deleted, rejected). The gift
//! itself is locked by giving's `giving.claimLock` in the same command
//! group, so the gift's own contracts refuse what the claim relies on.
//!
//! Neither contract can be restored: a claim moves only forward, as HMRC
//! saw it.

use std::collections::{HashMap, HashSet};

use contacts::donors::{ClaimDonor, claim_donor, name_of};
use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx,
    command_group, execute, mint_ids,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::claim_rules::{
    DonorFacts, REJECTED_REASON_MAX, SCHEDULE_ROW_LIMIT, claimable_from, donor_line,
    no_declaration, reclaim,
};
use crate::claim_types::{
    ClaimAdjustment, ClaimLine, ClaimPayload, ClaimPreview, ClaimStatus, ClaimStatusPayload,
    ClaimSummary, ClaimTotals, ClaimView, CreateClaim, ExcludedGift,
};
use crate::declarations::chain;
use crate::rules::{GiftRef, covering_declaration, is_iso_date, uk_date, uk_date_label};
use crate::types::Declaration;

pub const TABLE: &str = "gift_aid_claims";

/// Org schema step 15: claims, their lines and adjustments, the
/// claim-number sequence, and the HMRC details row ([`crate::hmrc`]; one
/// at most). Money is INTEGER pence.
pub const MIGRATION: &str = "
CREATE TABLE gift_aid_claim_number_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next INTEGER NOT NULL
) STRICT;
CREATE TABLE gift_aid_claims (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'submitted', 'paid', 'rejected', 'deleted')),
    period_end TEXT NOT NULL,
    earliest_date TEXT NOT NULL,
    line_count INTEGER NOT NULL,
    donations_amount INTEGER NOT NULL,
    reclaim_amount INTEGER NOT NULL,
    adjustment_amount INTEGER NOT NULL,
    submitted_on TEXT,
    hmrc_reference TEXT,
    paid_on TEXT,
    paid_amount INTEGER,
    rejected_reason TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    claim_version INTEGER NOT NULL DEFAULT 0,
    status_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX gift_aid_claims_by_number ON gift_aid_claims (number);

CREATE TABLE gift_aid_claim_lines (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES gift_aid_claims (id),
    position INTEGER NOT NULL,
    gift_id TEXT NOT NULL REFERENCES gifts (id),
    declaration_id TEXT NOT NULL REFERENCES gift_aid_declarations (id),
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    title TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    house TEXT NOT NULL,
    postcode TEXT NOT NULL,
    overseas INTEGER NOT NULL CHECK (overseas IN (0, 1)),
    received_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    reclaim_amount INTEGER NOT NULL CHECK (reclaim_amount >= 0),
    live INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0, 1))
) STRICT;
CREATE INDEX gift_aid_claim_lines_by_claim ON gift_aid_claim_lines (claim_id, position);
CREATE UNIQUE INDEX gift_aid_claim_lines_one_live_per_gift ON gift_aid_claim_lines (gift_id)
    WHERE live = 1;

CREATE TABLE gift_aid_claim_adjustments (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES gift_aid_claims (id),
    position INTEGER NOT NULL,
    gift_id TEXT NOT NULL REFERENCES gifts (id),
    original_claim_id TEXT NOT NULL REFERENCES gift_aid_claims (id),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    reason TEXT NOT NULL,
    live INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0, 1))
) STRICT;
CREATE INDEX gift_aid_claim_adjustments_by_claim ON gift_aid_claim_adjustments (claim_id, position);
CREATE INDEX gift_aid_claim_adjustments_by_original
    ON gift_aid_claim_adjustments (original_claim_id) WHERE live = 1;
CREATE UNIQUE INDEX gift_aid_claim_adjustments_one_live_per_gift
    ON gift_aid_claim_adjustments (gift_id) WHERE live = 1;

CREATE TABLE gift_aid_hmrc_details (
    id TEXT PRIMARY KEY,
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
    hmrc_reference TEXT NOT NULL,
    regulator TEXT CHECK (regulator IN ('ccew', 'ccni', 'oscr', 'none')),
    regulator_number TEXT NOT NULL,
    official_title TEXT NOT NULL,
    official_first_name TEXT NOT NULL,
    official_last_name TEXT NOT NULL,
    official_postcode TEXT NOT NULL,
    official_phone TEXT NOT NULL,
    details_version INTEGER NOT NULL DEFAULT 0
) STRICT;
";

pub const HMRC_REFERENCE_FIELD_MAX: usize = 100;

fn totals_of(lines: &[ClaimLine], adjustments: &[ClaimAdjustment]) -> ClaimTotals {
    let reclaim: i64 = lines.iter().map(|l| l.reclaim).sum();
    let adjustment: i64 = adjustments.iter().map(|a| a.amount).sum();
    ClaimTotals {
        lines: lines.len() as i64,
        donations: lines.iter().map(|l| l.amount).sum(),
        reclaim,
        adjustment,
        net: reclaim - adjustment,
    }
}

/// How many claims `lines` eligible gifts make.
pub fn claims_for(lines: usize) -> i64 {
    lines.div_ceil(SCHEDULE_ROW_LIMIT) as i64
}

// ── reads ──────────────────────────────────────────────────────────────────

const SUMMARY_COLUMNS: &str = "id, number, status, period_end, earliest_date, line_count, \
     donations_amount, reclaim_amount, adjustment_amount, submitted_on, hmrc_reference, paid_on, \
     paid_amount, rejected_reason, created_by, created_at, status_version";

fn summary_row(r: &rusqlite::Row) -> rusqlite::Result<ClaimSummary> {
    let reclaim: i64 = r.get(7)?;
    let adjustment: i64 = r.get(8)?;
    Ok(ClaimSummary {
        id: r.get(0)?,
        number: r.get(1)?,
        status: ClaimStatus::parse(&r.get::<_, String>(2)?),
        period_end: r.get(3)?,
        earliest_date: r.get(4)?,
        totals: ClaimTotals {
            lines: r.get(5)?,
            donations: r.get(6)?,
            reclaim,
            adjustment,
            net: reclaim - adjustment,
        },
        submitted_on: r.get(9)?,
        hmrc_reference: r.get(10)?,
        paid_on: r.get(11)?,
        paid_amount: r.get(12)?,
        rejected_reason: r.get(13)?,
        created_by: r.get(14)?,
        created_at: r.get(15)?,
        status_version: r.get(16)?,
    })
}

/// One claim's summary, deleted ones included, or `None`.
pub fn summary(conn: &Connection, id: &str) -> rusqlite::Result<Option<ClaimSummary>> {
    conn.prepare_cached(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM {TABLE} WHERE id = ?1"
    ))?
    .query_row([id], summary_row)
    .optional()
}

/// Every claim but deleted drafts, newest first.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<ClaimSummary>> {
    conn.prepare_cached(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM {TABLE} WHERE status != 'deleted' ORDER BY number DESC"
    ))?
    .query_map([], summary_row)?
    .collect()
}

/// A claim whose schedule and XML may be downloaded: ready or later
/// (the step that says it may go to HMRC, after which it can't be
/// deleted). A draft is refused (`claim_draft`); an unknown or deleted
/// claim is `NotFound`.
pub fn downloadable(conn: &Connection, id: &str) -> Result<ClaimSummary, ContractError> {
    let claim = summary(conn, id)?
        .filter(|c| c.status != ClaimStatus::Deleted)
        .ok_or(ContractError::NotFound)?;
    if claim.status == ClaimStatus::Draft {
        return Err(ContractError::rejected(
            "claim_draft",
            "Mark the claim ready before downloading it for HMRC",
        ));
    }
    Ok(claim)
}

/// A claim's lines in the order sent.
pub fn lines(conn: &Connection, claim_id: &str) -> rusqlite::Result<Vec<ClaimLine>> {
    conn.prepare_cached(
        "SELECT id, gift_id, declaration_id, contact_id, title, first_name, last_name, house,
                postcode, overseas, received_on, amount, reclaim_amount
         FROM gift_aid_claim_lines WHERE claim_id = ?1 ORDER BY position",
    )?
    .query_map([claim_id], |r| {
        Ok(ClaimLine {
            key: Some(r.get(0)?),
            gift_id: r.get(1)?,
            declaration_id: r.get(2)?,
            contact_id: r.get(3)?,
            title: r.get(4)?,
            first_name: r.get(5)?,
            last_name: r.get(6)?,
            house: r.get(7)?,
            postcode: r.get(8)?,
            overseas: r.get(9)?,
            received_on: r.get(10)?,
            amount: r.get(11)?,
            reclaim: r.get(12)?,
        })
    })?
    .collect()
}

/// A claim's adjustments in order.
pub fn adjustments(conn: &Connection, claim_id: &str) -> rusqlite::Result<Vec<ClaimAdjustment>> {
    conn.prepare_cached(
        "SELECT id, gift_id, original_claim_id, amount, reason
         FROM gift_aid_claim_adjustments WHERE claim_id = ?1 ORDER BY position",
    )?
    .query_map([claim_id], |r| {
        Ok(ClaimAdjustment {
            key: Some(r.get(0)?),
            gift_id: r.get(1)?,
            original_claim_id: r.get(2)?,
            amount: r.get(3)?,
            reason: r.get(4)?,
        })
    })?
    .collect()
}

/// The claim's gifts voided since it was made.
fn voided_gifts(conn: &Connection, claim_id: &str) -> rusqlite::Result<Vec<String>> {
    Ok(giving::voided_in_claim(conn, claim_id)?
        .into_iter()
        .map(|v| v.id)
        .collect())
}

/// `GET giftaid/claims/{id}`: `None` for an unknown or deleted claim.
pub fn view(conn: &Connection, id: &str) -> rusqlite::Result<Option<ClaimView>> {
    let Some(claim) = summary(conn, id)?.filter(|c| c.status != ClaimStatus::Deleted) else {
        return Ok(None);
    };
    Ok(Some(ClaimView {
        lines: lines(conn, id)?,
        adjustments: adjustments(conn, id)?,
        voided_gifts: voided_gifts(conn, id)?,
        claim,
    }))
}

/// A completed gift a live claim claims under a declaration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimedUnder {
    pub received_on: String,
    pub claim_number: i64,
}

impl ClaimedUnder {
    /// Why the declaration can't stop covering it.
    pub fn refusal(&self) -> ContractError {
        ContractError::rejected(
            "claimed_declaration",
            format!(
                "This declaration covers a gift of {} in Gift Aid claim {}: void that gift \
                 (the next claim pays HMRC back), or let the claim go, first",
                uk_date_label(&self.received_on),
                self.claim_number
            ),
        )
    }
}

/// The completed gifts live claims claim under declaration `id`, oldest
/// first. A voided one is left out: the next claim pays it back.
pub fn claimed_under(conn: &Connection, id: &str) -> rusqlite::Result<Vec<ClaimedUnder>> {
    let rows: Vec<(String, String, i64)> = conn
        .prepare_cached(
            "SELECT l.gift_id, l.received_on, c.number FROM gift_aid_claim_lines l
             JOIN gift_aid_claims c ON c.id = l.claim_id
             WHERE l.declaration_id = ?1 AND l.live = 1 ORDER BY l.received_on",
        )?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for (gift, received_on, claim_number) in rows {
        if giving::describe_gift(conn, &gift)?
            .is_some_and(|g| g.status == giving::Status::Completed)
        {
            out.push(ClaimedUnder {
                received_on,
                claim_number,
            });
        }
    }
    Ok(out)
}

// ── eligibility ────────────────────────────────────────────────────────────

/// What eligibility knows about one donor, read once per contact.
struct Donor {
    facts: Option<ClaimDonor>,
    chain: Vec<Declaration>,
}

/// Every gift a claim made on `today` up to `period_end` would take, and
/// every one it would leave out with its reasons; the adjustments it
/// would carry. Eligible: completed (not void), not already in a live
/// claim, received within the last 4 years ([`claimable_from`]) and on
/// or before `period_end`, covered by a declaration on its date (the
/// dated chain, [`covering_declaration`]), from a person with a first
/// and last name, a house name or number and a UK postcode (or an
/// address outside the UK). Void and older gifts aren't listed.
pub fn preview(conn: &Connection, period_end: &str, today: &str) -> rusqlite::Result<ClaimPreview> {
    let from = claimable_from(today);
    let gifts = if from.as_str() <= period_end {
        giving::unclaimed_between(conn, &from, period_end)?
    } else {
        vec![]
    };
    let mut donors: HashMap<String, Donor> = HashMap::new();
    let mut lines = Vec::new();
    let mut excluded = Vec::new();
    for g in gifts {
        if !donors.contains_key(&g.contact_id) {
            let donor = Donor {
                facts: claim_donor(conn, &g.contact_id)?,
                chain: chain(conn, &g.contact_id)?,
            };
            donors.insert(g.contact_id.clone(), donor);
        }
        let donor = &donors[&g.contact_id];
        let Some(facts) = donor.facts.as_ref() else {
            continue;
        };
        let line = donor_line(DonorFacts {
            kind: facts.kind,
            title: &facts.title,
            first_name: &facts.first_name,
            last_name: &facts.last_name,
            line1: &facts.line1,
            town: &facts.town,
            postcode: &facts.postcode,
            country: &facts.country,
        });
        let covering = covering_declaration(
            &donor.chain,
            GiftRef {
                date: &g.received_on,
                gift_id: Some(&g.id),
            },
        );
        let reasons = match (&line, covering) {
            (Ok(_), Some(_)) => vec![],
            (Ok(_), None) => vec![no_declaration(&g.received_on)],
            // A person: every reason; anyone else: that it isn't a person.
            (Err(r), _) if facts.kind != contacts::types::Kind::Individual => r.clone(),
            (Err(r), covering) => {
                let mut r = r.clone();
                if covering.is_none() {
                    r.insert(0, no_declaration(&g.received_on));
                }
                r
            }
        };
        match (line, covering) {
            (Ok(d), Some(decl)) if reasons.is_empty() => lines.push(ClaimLine {
                key: None,
                gift_id: g.id,
                declaration_id: decl.id.clone(),
                contact_id: g.contact_id,
                title: d.title,
                first_name: d.first_name,
                last_name: d.last_name,
                house: d.house,
                postcode: d.postcode,
                overseas: d.overseas,
                received_on: g.received_on,
                amount: g.amount,
                reclaim: reclaim(g.amount),
            }),
            _ => excluded.push(ExcludedGift {
                contact_name: name_of(conn, &g.contact_id)?
                    .map(|(name, _)| name)
                    .unwrap_or_default(),
                gift_id: g.id,
                contact_id: g.contact_id,
                received_on: g.received_on,
                amount: g.amount,
                reasons,
            }),
        }
    }
    let adjustments = due_adjustments(conn)?;
    let totals = totals_of(&lines, &adjustments);
    let too_old = giving::unclaimed_before(conn, &from)?;
    Ok(ClaimPreview {
        period_end: period_end.to_owned(),
        today: today.to_owned(),
        claimable_from: from,
        claims: claims_for(lines.len()),
        too_old,
        lines,
        adjustments,
        excluded,
        totals,
    })
}

/// Gifts claimed by a claim that may have gone to HMRC (ready, submitted
/// or paid), voided since and not yet paid back: each the tax its line
/// claimed, and why it was voided. A gift voided out of a draft isn't
/// here: it holds the draft back instead ([`set_claim_status`]).
fn due_adjustments(conn: &Connection) -> rusqlite::Result<Vec<ClaimAdjustment>> {
    // Gifts already paid back, and each claim's status: one read each,
    // not two per voided gift (review L6).
    let repaid: HashSet<String> = conn
        .prepare_cached("SELECT gift_id FROM gift_aid_claim_adjustments WHERE live = 1")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut sent: HashMap<String, bool> = HashMap::new();
    let mut out = Vec::new();
    for v in giving::voided_in_claims(conn)? {
        if repaid.contains(&v.id) {
            continue;
        }
        if !sent.contains_key(&v.claim_id) {
            let s = summary(conn, &v.claim_id)?.is_some_and(|c| {
                matches!(
                    c.status,
                    ClaimStatus::Ready | ClaimStatus::Submitted | ClaimStatus::Paid
                )
            });
            sent.insert(v.claim_id.clone(), s);
        }
        if !sent[&v.claim_id] {
            continue;
        }
        let claimed: Option<i64> = conn
            .prepare_cached(
                "SELECT reclaim_amount FROM gift_aid_claim_lines
                 WHERE gift_id = ?1 AND claim_id = ?2 AND live = 1",
            )?
            .query_row(params![v.id, v.claim_id], |r| r.get(0))
            .optional()?;
        if let Some(amount) = claimed {
            out.push(ClaimAdjustment {
                key: None,
                gift_id: v.id,
                original_claim_id: v.claim_id,
                amount,
                reason: v.void_reason.unwrap_or_else(|| "Voided".into()),
            });
        }
    }
    Ok(out)
}

fn invalid_date(field: &str) -> ContractError {
    ContractError::invalid(field, "Enter a date (YYYY-MM-DD)")
}

/// "New claim": every gift eligible now ([`preview`]) up to
/// `periodEnd`, frozen into draft claims of at most 1,000 lines each
/// (oldest gifts first, numbered in turn; the adjustments on the first),
/// each gift locked to its claim, all in one command group. `periodEnd`
/// may not be after today (UK). Refused when nothing is eligible, and
/// when the preview the caller saw (`expectedLines`,
/// `expectedDonations`, `expectedAdjustment`) no longer matches. The new claims' ids, in order.
pub fn create_claim(
    ctx: &Ctx,
    req: CreateClaim,
    source: Source,
) -> Result<Vec<String>, ContractError> {
    let period_end = req.period_end.trim();
    if !is_iso_date(period_end) {
        return Err(invalid_date("periodEnd"));
    }
    let today = uk_date(ctx.at);
    if period_end > today.as_str() {
        return Err(ContractError::invalid(
            "periodEnd",
            "A claim can't end after today",
        ));
    }
    let p = preview(ctx.tx.read(), period_end, &today)?;
    if req.expected_lines.is_some_and(|n| n != p.totals.lines)
        || req
            .expected_donations
            .is_some_and(|n| n != p.totals.donations)
        || req
            .expected_adjustment
            .is_some_and(|n| n != p.totals.adjustment)
    {
        return Err(ContractError::rejected(
            "preview_changed",
            "The eligible gifts changed since the preview: check it again",
        ));
    }
    if p.lines.is_empty() {
        return Err(ContractError::rejected(
            "nothing_to_claim",
            "No gift can be claimed up to that date",
        ));
    }
    let group = command_group(
        ctx,
        &format!("Gift Aid claim to {}", uk_date_label(period_end)),
    )?;
    let mut adjustments = Some(p.adjustments);
    let mut ids = Vec::new();
    for chunk in p.lines.chunks(SCHEDULE_ROW_LIMIT) {
        let id = execute(
            ctx,
            &CLAIM,
            ClaimPayload {
                period_end: period_end.to_owned(),
                lines: chunk.to_vec(),
                adjustments: adjustments.take().unwrap_or_default(),
            },
            Exec::create(source).in_group(&group),
        )?
        .id;
        for line in lines(ctx.tx.read(), &id)? {
            giving::lock_for_claim(ctx, &line.gift_id, &id, source, &group)?;
        }
        ids.push(id);
    }
    Ok(ids)
}

/// One step of a claim's life ([`ClaimStatusContract`]): ready,
/// submitted, paid, rejected, or a draft deleted. Ready is refused while
/// a gift of the draft was voided since it was made (delete the draft
/// and claim again); after that a voided gift is paid back by the next
/// claim. Rejected is refused while a later *draft* pays back one of its
/// gifts (delete that draft first); once the later claim is ready or
/// later it may be with HMRC, so its adjustment stands and this claim
/// can still be rejected (HMRC then owes that tax back: tell them). Deleting or rejecting lets every gift go, so the next claim
/// can take them.
pub fn set_claim_status(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    payload: ClaimStatusPayload,
    source: Source,
) -> Result<Executed, ContractError> {
    let conn = ctx.tx.read();
    let claim = summary(conn, id)?
        .filter(|c| c.status != ClaimStatus::Deleted)
        .ok_or(ContractError::NotFound)?;
    match payload.status {
        // A draft has never been downloaded: a gift voided out of it
        // holds it back. From ready on, the claim may be with HMRC, so
        // it goes on and the next claim pays the gift back.
        ClaimStatus::Ready => {
            let voided = voided_gifts(conn, id)?;
            if !voided.is_empty() {
                return Err(ContractError::rejected(
                    "voided_gifts",
                    format!(
                        "{} of this claim's gifts {} voided since it was made: \
                         delete the draft and make a new claim",
                        voided.len(),
                        if voided.len() == 1 { "was" } else { "were" }
                    ),
                ));
            }
        }
        ClaimStatus::Rejected => {
            let later: Option<i64> = conn
                .prepare_cached(
                    "SELECT c.number FROM gift_aid_claim_adjustments a
                     JOIN gift_aid_claims c ON c.id = a.claim_id
                     WHERE a.original_claim_id = ?1 AND a.live = 1 AND c.status = 'draft'
                     LIMIT 1",
                )?
                .query_row([id], |r| r.get(0))
                .optional()?;
            if let Some(number) = later {
                return Err(ContractError::rejected(
                    "adjusted_later",
                    format!("Draft claim {number} pays back gifts of this one: delete it first"),
                ));
            }
        }
        _ => {}
    }
    let group = command_group(
        ctx,
        &format!(
            "Gift Aid claim {} {}",
            claim.number,
            payload.status.as_str()
        ),
    )?;
    let releases = !payload.status.is_live();
    let done = execute(
        ctx,
        &CLAIM_STATUS,
        payload,
        Exec::update(id, Some(expected), source).in_group(&group),
    )?;
    if releases {
        release_gifts(ctx, id, source, &group)?;
    }
    Ok(done)
}

fn release_gifts(
    ctx: &Ctx,
    id: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<(), ContractError> {
    for line in lines(ctx.tx.read(), id)? {
        giving::release_from_claim(ctx, &line.gift_id, id, source, group)?;
    }
    Ok(())
}

// ── giftaid.claim ──────────────────────────────────────────────────────────

/// The claim as made, plus who made it and when (the command's).
#[derive(Clone, Debug, Serialize)]
pub struct ClaimState {
    #[serde(flatten)]
    pub payload: ClaimPayload,
    #[serde(skip)]
    created_by: Option<i64>,
    #[serde(skip)]
    created_at: i64,
}

/// The claim as made, frozen: its lines and adjustments are what was
/// eligible when it was made, never edited (a mistake is a deleted draft
/// or a rejected claim, then a new one), never restored.
pub struct ClaimContract;
pub static CLAIM: ClaimContract = ClaimContract;

fn prepare_claim(mut p: ClaimPayload) -> Result<ClaimPayload, ContractError> {
    if !is_iso_date(&p.period_end) {
        return Err(invalid_date("periodEnd"));
    }
    if p.lines.is_empty() {
        return Err(ContractError::invalid("lines", "A claim needs a gift"));
    }
    if p.lines.len() > SCHEDULE_ROW_LIMIT {
        return Err(ContractError::invalid(
            "lines",
            format!("A claim holds at most {SCHEDULE_ROW_LIMIT} gifts"),
        ));
    }
    for l in &p.lines {
        if l.amount <= 0 || l.reclaim != reclaim(l.amount) || !is_iso_date(&l.received_on) {
            return Err(ContractError::invalid(
                "lines",
                format!("Line for gift {} doesn't add up", l.gift_id),
            ));
        }
    }
    if p.adjustments.iter().any(|a| a.amount < 0) {
        return Err(ContractError::invalid(
            "adjustments",
            "An adjustment can't be negative",
        ));
    }
    mint_ids(&mut p.lines, |l| &mut l.key);
    mint_ids(&mut p.adjustments, |a| &mut a.key);
    Ok(p)
}

impl Contract for ClaimContract {
    const NAME: &'static str = "giftaid.claim";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "claim_version";
    type Payload = ClaimPayload;
    type State = ClaimState;

    fn prepare(&self, p: ClaimPayload) -> Result<ClaimPayload, ContractError> {
        prepare_claim(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<ClaimState, ContractError> {
        let conn = tx.read();
        let (period_end, created_by, created_at) = conn
            .prepare_cached(
                "SELECT period_end, created_by, created_at FROM gift_aid_claims WHERE id = ?1",
            )?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?
            .ok_or(ContractError::NotFound)?;
        Ok(ClaimState {
            payload: ClaimPayload {
                period_end,
                lines: lines(conn, id)?,
                adjustments: adjustments(conn, id)?,
            },
            created_by,
            created_at,
        })
    }

    fn apply(
        &self,
        current: Option<&ClaimState>,
        p: &ClaimPayload,
        command: &Command,
    ) -> Result<ClaimState, ContractError> {
        if current.is_some() {
            return Err(ContractError::rejected(
                "immutable",
                "A claim's gifts can't change: delete the draft and make a new claim",
            ));
        }
        if p.period_end > uk_date(command.at) {
            return Err(ContractError::invalid(
                "periodEnd",
                "A claim can't end after today",
            ));
        }
        Ok(ClaimState {
            payload: p.clone(),
            created_by: command.actor,
            created_at: command.at,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&ClaimState>,
        next: &ClaimState,
    ) -> Result<(), ContractError> {
        let p = &next.payload;
        for l in &p.lines {
            let gift = giving::describe_gift(tx, &l.gift_id)?;
            if !gift.is_some_and(|g| {
                g.contact_id == l.contact_id
                    && g.received_on == l.received_on
                    && g.status == giving::Status::Completed
            }) {
                return Err(ContractError::rejected(
                    "unknown_gift",
                    format!("Gift {} isn't a completed gift of that donor", l.gift_id),
                ));
            }
        }
        let totals = totals_of(&p.lines, &p.adjustments);
        let earliest = p
            .lines
            .iter()
            .map(|l| l.received_on.as_str())
            .min()
            .unwrap_or(&p.period_end);
        let number = tx.take_sequence("gift_aid_claim_number_sequence", 1)?;
        tx.prepare_cached(
            "INSERT INTO gift_aid_claims (id, number, period_end, earliest_date, line_count,
                 donations_amount, reclaim_amount, adjustment_amount, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?
        .execute(params![
            id,
            number,
            p.period_end,
            earliest,
            totals.lines,
            totals.donations,
            totals.reclaim,
            totals.adjustment,
            next.created_by,
            next.created_at
        ])?;
        let mut line = tx.prepare_cached(
            "INSERT INTO gift_aid_claim_lines (id, claim_id, position, gift_id, declaration_id,
                 contact_id, title, first_name, last_name, house, postcode, overseas,
                 received_on, amount, reclaim_amount)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for (i, l) in p.lines.iter().enumerate() {
            line.execute(params![
                l.key,
                id,
                i as i64,
                l.gift_id,
                l.declaration_id,
                l.contact_id,
                l.title,
                l.first_name,
                l.last_name,
                l.house,
                l.postcode,
                l.overseas,
                l.received_on,
                l.amount,
                l.reclaim
            ])
            .map_err(|e| one_live_claim(e, &l.gift_id))?;
        }
        let mut adjustment = tx.prepare_cached(
            "INSERT INTO gift_aid_claim_adjustments (id, claim_id, position, gift_id,
                 original_claim_id, amount, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (i, a) in p.adjustments.iter().enumerate() {
            adjustment
                .execute(params![
                    a.key,
                    id,
                    i as i64,
                    a.gift_id,
                    a.original_claim_id,
                    a.amount,
                    a.reason
                ])
                .map_err(|e| one_live_claim(e, &a.gift_id))?;
        }
        Ok(())
    }
}

/// The schema's "one live claim per gift" refusing a row, as a refusal.
fn one_live_claim(e: rusqlite::Error, gift_id: &str) -> ContractError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            ContractError::rejected(
                "already_claimed",
                format!("Gift {gift_id} is already in a live claim"),
            )
        }
        _ => ContractError::Sqlite(e),
    }
}

// ── giftaid.claimStatus ────────────────────────────────────────────────────

/// Trimmed; blank is none.
fn clean(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// Each step carries what it records and nothing else: `submitted` a
/// date (and HMRC's reference, optional, ≤ 100), `paid` a date and an
/// amount (pence, ≥ 0), `rejected` a reason (≤ 1000).
fn prepare_status(p: ClaimStatusPayload) -> Result<ClaimStatusPayload, ContractError> {
    let mut out = ClaimStatusPayload {
        status: p.status,
        submitted_on: None,
        hmrc_reference: None,
        paid_on: None,
        paid_amount: None,
        reason: None,
    };
    match p.status {
        ClaimStatus::Submitted => {
            let on = clean(&p.submitted_on).ok_or_else(|| invalid_date("submittedOn"))?;
            if !is_iso_date(&on) {
                return Err(invalid_date("submittedOn"));
            }
            out.submitted_on = Some(on);
            out.hmrc_reference = clean(&p.hmrc_reference);
            if out
                .hmrc_reference
                .as_ref()
                .is_some_and(|r| r.chars().count() > HMRC_REFERENCE_FIELD_MAX)
            {
                return Err(ContractError::invalid(
                    "hmrcReference",
                    format!("At most {HMRC_REFERENCE_FIELD_MAX} characters"),
                ));
            }
        }
        ClaimStatus::Paid => {
            let on = clean(&p.paid_on).ok_or_else(|| invalid_date("paidOn"))?;
            if !is_iso_date(&on) {
                return Err(invalid_date("paidOn"));
            }
            out.paid_on = Some(on);
            match p.paid_amount {
                Some(a) if (0..=giving::PENCE_MAX).contains(&a) => out.paid_amount = Some(a),
                _ => {
                    return Err(ContractError::invalid(
                        "paidAmount",
                        "Enter the amount HMRC paid",
                    ));
                }
            }
        }
        ClaimStatus::Rejected => {
            let reason = clean(&p.reason)
                .ok_or_else(|| ContractError::invalid("reason", "Say why it was rejected"))?;
            if reason.chars().count() > REJECTED_REASON_MAX {
                return Err(ContractError::invalid(
                    "reason",
                    format!("At most {REJECTED_REASON_MAX} characters"),
                ));
            }
            out.reason = Some(reason);
        }
        ClaimStatus::Draft | ClaimStatus::Ready | ClaimStatus::Deleted => {}
    }
    Ok(out)
}

/// The claim's status and every step's facts so far.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimStatusState {
    pub status: ClaimStatus,
    pub submitted_on: Option<String>,
    pub hmrc_reference: Option<String>,
    pub paid_on: Option<String>,
    pub paid_amount: Option<i64>,
    pub rejected_reason: Option<String>,
}

/// The claim's life: `draft → ready → submitted → paid`; `rejected` from
/// ready or submitted; `deleted` from draft. Forward only: no other move,
/// no restore. A date may not be after today (UK), nor paid before
/// submitted. Deleted and rejected set the claim's lines and adjustments
/// not live, so their gifts can be claimed (and paid back) again.
pub struct ClaimStatusContract;
pub static CLAIM_STATUS: ClaimStatusContract = ClaimStatusContract;

impl Contract for ClaimStatusContract {
    const NAME: &'static str = "giftaid.claimStatus";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "status_version";
    type Payload = ClaimStatusPayload;
    type State = ClaimStatusState;

    fn prepare(&self, p: ClaimStatusPayload) -> Result<ClaimStatusPayload, ContractError> {
        prepare_status(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<ClaimStatusState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT status, submitted_on, hmrc_reference, paid_on, paid_amount,
                        rejected_reason
                 FROM gift_aid_claims WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok(ClaimStatusState {
                    status: ClaimStatus::parse(&r.get::<_, String>(0)?),
                    submitted_on: r.get(1)?,
                    hmrc_reference: r.get(2)?,
                    paid_on: r.get(3)?,
                    paid_amount: r.get(4)?,
                    rejected_reason: r.get(5)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&ClaimStatusState>,
        p: &ClaimStatusPayload,
        command: &Command,
    ) -> Result<ClaimStatusState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giftaid.claimStatus targets an existing claim",
            ));
        };
        if command.source == Source::Restore {
            return Err(ContractError::rejected(
                "not_restorable",
                "A claim's status only moves forward",
            ));
        }
        use ClaimStatus::*;
        let allowed = matches!(
            (current.status, p.status),
            (Draft, Ready)
                | (Draft, Deleted)
                | (Ready, Submitted)
                | (Ready, Rejected)
                | (Submitted, Paid)
                | (Submitted, Rejected)
        );
        if !allowed {
            return Err(ContractError::rejected(
                "claim_status",
                format!(
                    "A {} claim can't be marked {}",
                    current.status.as_str(),
                    p.status.as_str()
                ),
            ));
        }
        let today = uk_date(command.at);
        let mut next = current.clone();
        next.status = p.status;
        if let Some(on) = &p.submitted_on {
            if on.as_str() > today.as_str() {
                return Err(ContractError::invalid(
                    "submittedOn",
                    "It can't be submitted after today",
                ));
            }
            next.submitted_on = Some(on.clone());
            next.hmrc_reference = p.hmrc_reference.clone();
        }
        if let Some(on) = &p.paid_on {
            if on.as_str() > today.as_str() {
                return Err(ContractError::invalid(
                    "paidOn",
                    "It can't be paid after today",
                ));
            }
            if current.submitted_on.as_ref().is_some_and(|s| on < s) {
                return Err(ContractError::invalid(
                    "paidOn",
                    "It can't be paid before it was submitted",
                ));
            }
            next.paid_on = Some(on.clone());
            next.paid_amount = p.paid_amount;
        }
        if p.reason.is_some() {
            next.rejected_reason = p.reason.clone();
        }
        Ok(next)
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&ClaimStatusState>,
        next: &ClaimStatusState,
    ) -> Result<(), ContractError> {
        tx.prepare_cached(
            "UPDATE gift_aid_claims SET status = ?2, submitted_on = ?3, hmrc_reference = ?4,
                 paid_on = ?5, paid_amount = ?6, rejected_reason = ?7
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            next.status.as_str(),
            next.submitted_on,
            next.hmrc_reference,
            next.paid_on,
            next.paid_amount,
            next.rejected_reason
        ])?;
        if !next.status.is_live() {
            tx.prepare_cached("UPDATE gift_aid_claim_lines SET live = 0 WHERE claim_id = ?1")?
                .execute([id])?;
            tx.prepare_cached(
                "UPDATE gift_aid_claim_adjustments SET live = 0 WHERE claim_id = ?1",
            )?
            .execute([id])?;
        }
        Ok(())
    }
}
