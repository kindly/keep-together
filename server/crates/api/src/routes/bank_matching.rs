//! `/api/t/{slug}/bank/…`: matching statement lines (plan
//! `bank-transfers.sv` step 4, ADR 0027). Each command spans banking and
//! giving, so it lives here: one transaction, one named command group,
//! and `banking.lineMatch` last, against the line's `matchVersion`, so a
//! line someone matched meanwhile is `409 stale` and nothing of the
//! command is kept. Statement lines show every payer into the account,
//! so viewers get `403` on all of these (g1q9); staff and admins match.
//!
//! - **gifts from a line** (g1q6): one gift per part, for an existing
//!   contact or a new one typed inline, each dated the line's posted date
//!   and made from it (`fromLine`: amount, date and reference locked).
//!   The parts and any remainder add up to the line exactly or it is
//!   `422`; a remainder is not a donation and needs a note. The code is
//!   the part's, else the contact's acquisition code, else the account's
//!   default (g2q6).
//! - **matched to gifts entered by hand**: they're linked to the line
//!   (`giving.line`); the same sum rule.
//! - **matched to a paying-in batch**: `giving::bank::match_batch` (its
//!   cheques clear). A difference against the slip is shown, not forced.
//! - **not a donation**, with a note.
//! - **unmatch**: the batch's line is undone (its cheques pend again),
//!   gifts made from the line are voided (a claimed one is an adjustment
//!   in the next claim) and hand-entered ones only unlinked.
//! - **accept ticked**: each line in its own transaction, so a line
//!   matched meanwhile answers `409 stale` for itself and the rest apply.
//! - **rules**: not-a-donation rules, listed, created and deleted (kept
//!   inactive).
//!
//! Suggestions are read with the lines, computed then (never stored).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use banking::matching::{self, LineView, MatchState, RulePayload, RuleRow};
use banking::{LINE_MATCH, LineMatchPayload, Proposal, RULE, Suggestion};
use contacts::donors::{add_first_email, create_contact};
use contacts::types::Details;
use contracts::{
    CommandGroup, ContractError, Ctx, Exec, Executed, Problem, Source, command_group, execute,
};
use giving::types::{AllocationRow, GiftPayload, Method, Status};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use store::Role;
use ts_rs::TS;

use super::Params;
use super::gifts::DonorRef;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/bank/accounts/{id}/lines", get(lines))
        .route("/bank/lines/{id}", get(line_detail))
        .route("/bank/lines/{id}/gifts", post(gifts_from_line))
        .route("/bank/lines/{id}/match-gifts", post(match_gifts))
        .route("/bank/lines/{id}/match-batch", post(match_batch))
        .route("/bank/lines/{id}/not-donation", post(not_donation))
        .route("/bank/lines/{id}/unmatch", post(unmatch))
        .route("/bank/accept", post(accept))
        .route("/bank/rules", get(list_rules).post(create_rule))
        .route("/bank/rules/{id}/delete", post(delete_rule))
}

fn require_staff(t: &Tenant) -> Result<(), ApiError> {
    if t.role < Role::Staff {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

// ── reads ──────────────────────────────────────────────────────────────────

/// A line with its ranked suggestions (none once it isn't unmatched).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankLineRow")]
pub struct LineRow {
    #[serde(flatten)]
    #[ts(flatten)]
    pub line: LineView,
    pub suggestions: Vec<Suggestion>,
}

/// `GET bank/accounts/{id}/lines?state`: an account's lines in `state`
/// (default `unmatched`), oldest first, at most 200, each with its
/// suggestions.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankLinesQuery")]
pub struct LinesQuery {
    #[serde(default)]
    #[ts(optional)]
    pub state: Option<MatchState>,
}

async fn lines(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<LinesQuery>,
) -> Result<Json<Vec<LineRow>>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| {
        banking::account::account(r, &id)?.ok_or(ApiError::NotFound)?;
        let mut out = Vec::new();
        for line in matching::lines(r, &id, q.state.unwrap_or(MatchState::Unmatched))? {
            out.push(LineRow {
                suggestions: banking::suggest(r, &line)?,
                line,
            });
        }
        Ok(out)
    })
    .await
    .map(Json)
}

/// A gift on a line, as the line's page shows it.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankLineGift")]
pub struct LineGift {
    pub id: String,
    pub contact_id: String,
    pub contact_name: Option<String>,
    pub received_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub status: Status,
    /// Made from the line (else entered by hand and matched to it).
    pub from_line: bool,
}

/// `GET bank/lines/{id}`: the line, what it is matched to, and its
/// suggestions. Every write here answers it, read in the same
/// transaction (never optimistic).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankLineDetail")]
pub struct LineDetail {
    pub line: LineView,
    pub gifts: Vec<LineGift>,
    pub batch_id: Option<String>,
    pub suggestions: Vec<Suggestion>,
}

fn detail(conn: &Connection, id: &str) -> Result<LineDetail, ApiError> {
    let line = matching::line(conn, id)?.ok_or(ApiError::NotFound)?;
    let mut gifts = Vec::new();
    for g in giving::bank::gifts_on_line(conn, id)? {
        gifts.push(LineGift {
            contact_name: contacts::donors::name_of(conn, &g.contact_id)?.map(|(n, _)| n),
            id: g.id,
            contact_id: g.contact_id,
            received_on: g.received_on,
            amount: g.amount,
            status: g.status,
            from_line: g.from_line,
        });
    }
    Ok(LineDetail {
        batch_id: giving::bank::batch_for_line(conn, id)?,
        suggestions: banking::suggest(conn, &line)?,
        gifts,
        line,
    })
}

async fn line_detail(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<LineDetail>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| detail(r, &id)).await.map(Json)
}

// ── the commands ───────────────────────────────────────────────────────────

/// `409 stale` for a line whose `matchVersion` isn't `expected`, with
/// its match as it is now (the form merges it and retries).
fn stale(line: &LineView) -> ContractError {
    ContractError::Stale {
        contract: "banking.lineMatch",
        counter: line.match_version,
        current: serde_json::to_value(LineMatchPayload {
            state: line.state,
            note: line.note.clone(),
        })
        .unwrap_or_default(),
    }
}

/// The line as of `expected`: `stale` first if it moved since (someone
/// matched it meanwhile), then refused unless it is unmatched (a matched
/// one is unmatched first).
fn unmatched_line(conn: &Connection, id: &str, expected: i64) -> Result<LineView, ContractError> {
    let line = matching::line(conn, id)?.ok_or(ContractError::NotFound)?;
    if line.match_version != expected {
        return Err(stale(&line));
    }
    if line.state != MatchState::Unmatched {
        return Err(ContractError::rejected(
            "line_matched",
            "This line is already matched: unmatch it first",
        ));
    }
    Ok(line)
}

fn line_group(ctx: &Ctx, what: &str, line: &LineView) -> Result<CommandGroup, ContractError> {
    command_group(
        ctx,
        &format!(
            "{what}: statement line {} on {}",
            giving::format_pence(line.amount),
            line.posted_on
        ),
    )
}

/// The rest of a line that isn't a donation (a raffle ticket, a refund).
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankRemainder")]
pub struct Remainder {
    #[ts(type = "number")]
    pub amount: i64,
    pub note: String,
}

/// Refuse amounts that don't add up to the line exactly (rule 7: pence
/// summed as integers, checked so an overflow is "doesn't add up").
fn check_sum(
    line: &LineView,
    parts: &[i64],
    remainder: Option<&Remainder>,
    field: &str,
) -> Result<(), ContractError> {
    let mut problems = Vec::new();
    if parts.iter().min().is_some_and(|a| *a <= 0) {
        problems.push(Problem::new(field, "Each part must be over £0"));
    }
    if let Some(r) = remainder {
        if r.amount <= 0 {
            problems.push(Problem::new("remainder", "The rest must be over £0"));
        }
        if r.note.trim().is_empty() {
            problems.push(Problem::new(
                "remainder",
                "Say what the rest was: it isn't a donation",
            ));
        }
    }
    let total = parts
        .iter()
        .chain(remainder.map(|r| &r.amount))
        .try_fold(0i64, |sum, a| sum.checked_add(*a));
    if problems.is_empty() && total != Some(line.amount) {
        problems.push(Problem::new(
            field,
            format!(
                "The parts must add up to the line’s {} exactly",
                giving::format_pence(line.amount)
            ),
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// The line marked matched, last, against `expected`.
fn mark(
    ctx: &Ctx,
    line: &str,
    expected: i64,
    state: MatchState,
    note: Option<String>,
    source: Source,
    group: &CommandGroup,
) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &LINE_MATCH,
        LineMatchPayload { state, note },
        Exec::update(line, Some(expected), source).in_group(group),
    )
}

/// One gift of a line split (g1q6).
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankGiftPart")]
pub struct GiftPart {
    /// An existing contact's id, or a new contact typed on the match form.
    pub contact: DonorRef,
    #[ts(type = "number")]
    pub amount: i64,
    /// Omitted: the contact's acquisition code, else the account's default.
    #[serde(default)]
    #[ts(optional)]
    pub source_code_id: Option<String>,
}

/// `POST bank/lines/{id}/gifts {expected, parts, remainder?}`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankGiftsFromLine")]
pub struct GiftsFromLine {
    /// The line's `matchVersion`.
    #[ts(type = "number")]
    pub expected: i64,
    pub parts: Vec<GiftPart>,
    #[serde(default)]
    #[ts(optional)]
    pub remainder: Option<Remainder>,
}

/// Most parts one line is split into.
pub const PARTS_MAX: usize = 20;

/// Gifts made from a line: see the module doc. Answers their ids.
pub fn gifts_from(
    ctx: &Ctx,
    line_id: &str,
    req: GiftsFromLine,
    source: Source,
) -> Result<Vec<String>, ContractError> {
    let line = unmatched_line(ctx.tx.read(), line_id, req.expected)?;
    if req.parts.is_empty() || req.parts.len() > PARTS_MAX {
        return Err(ContractError::invalid(
            "parts",
            format!("Between 1 and {PARTS_MAX} gifts"),
        ));
    }
    let amounts: Vec<i64> = req.parts.iter().map(|p| p.amount).collect();
    check_sum(&line, &amounts, req.remainder.as_ref(), "parts")?;
    let default_code = banking::account::account(ctx.tx.read(), &line.account_id)?
        .and_then(|a| a.payload.default_source_code_id);
    let group = line_group(ctx, "gifts", &line)?;
    let mut made = Vec::new();
    for (i, part) in req.parts.into_iter().enumerate() {
        let field = format!("parts[{i}].sourceCodeId");
        let (contact_id, code) = match part.contact {
            DonorRef::Existing(id) => {
                if contacts::donors::kind_of(ctx.tx.read(), &id)?.is_none() {
                    return Err(ContractError::rejected(
                        "unknown_contact",
                        "Contact must exist",
                    ));
                }
                let code = part
                    .source_code_id
                    .or(contacts::acquisition::acquisition_of(ctx.tx.read(), &id)?
                        .map(|c| c.version_id))
                    .or(default_code.clone())
                    .ok_or_else(|| ContractError::invalid(&field, "Pick a source code"))?;
                (id, code)
            }
            DonorRef::New(new) => {
                let code = part
                    .source_code_id
                    .or(default_code.clone())
                    .ok_or_else(|| ContractError::invalid(&field, "Pick a source code"))?;
                let created = create_contact(
                    ctx,
                    Details {
                        client_key: None,
                        kind: new.kind,
                        title: String::new(),
                        first_name: new.first_name,
                        last_name: new.last_name,
                        nickname: String::new(),
                        name: new.name,
                        birth_date: None,
                        is_deceased: false,
                        deceased_date: None,
                    },
                    Some(code.clone()),
                    source,
                    &group,
                )?;
                if let Some(email) = new
                    .email
                    .as_deref()
                    .map(str::trim)
                    .filter(|e| !e.is_empty())
                {
                    add_first_email(ctx, &created.id, email, source, &group)?;
                }
                (created.id, code)
            }
        };
        made.push(giving::create_gift(
            ctx,
            GiftPayload {
                contact_id,
                received_on: line.posted_on.clone(),
                amount: part.amount,
                method: Method::BankTransfer,
                reference: Some(line.reference.clone()).filter(|r| !r.trim().is_empty()),
                allocations: vec![AllocationRow {
                    key: None,
                    source_code_id: code,
                    amount: part.amount,
                }],
                client_key: None,
                origin: None,
                from_line: Some(line.id.clone()),
                paying_in_batch_id: None,
            },
            source,
            Some(&group),
        )?);
    }
    mark(
        ctx,
        &line.id,
        req.expected,
        MatchState::Matched,
        req.remainder.map(|r| r.note),
        source,
        &group,
    )?;
    Ok(made)
}

async fn gifts_from_line(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<GiftsFromLine>,
) -> Result<Json<LineDetail>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        gifts_from(ctx, &id, req, Source::Ui)?;
        detail(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// `POST bank/lines/{id}/match-gifts {expected, giftIds, remainder?}`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankMatchGifts")]
pub struct MatchGifts {
    #[ts(type = "number")]
    pub expected: i64,
    pub gift_ids: Vec<String>,
    #[serde(default)]
    #[ts(optional)]
    pub remainder: Option<Remainder>,
}

/// The line matched to transfers entered by hand: each linked
/// (`giving.line`, which refuses anything but a bank transfer that isn't
/// void), adding up to the line with any remainder.
pub fn match_to_gifts(
    ctx: &Ctx,
    line_id: &str,
    req: MatchGifts,
    source: Source,
) -> Result<(), ContractError> {
    let line = unmatched_line(ctx.tx.read(), line_id, req.expected)?;
    if req.gift_ids.is_empty() || req.gift_ids.len() > PARTS_MAX {
        return Err(ContractError::invalid(
            "giftIds",
            format!("Between 1 and {PARTS_MAX} gifts"),
        ));
    }
    // (gift, its `lineVersion`, its amount)
    let mut gifts: Vec<(String, i64, i64)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in &req.gift_ids {
        if !seen.insert(id) {
            return Err(ContractError::invalid("giftIds", "A gift is named twice"));
        }
        let g = giving::get(ctx.tx.read(), id)?
            .ok_or(ContractError::NotFound)?
            .gift;
        if g.status != Status::Completed {
            return Err(ContractError::rejected(
                "not_received",
                "Only a received transfer is matched to a line",
            ));
        }
        gifts.push((id.clone(), g.line_version, g.amount));
    }
    let amounts: Vec<i64> = gifts.iter().map(|(_, _, a)| *a).collect();
    check_sum(&line, &amounts, req.remainder.as_ref(), "giftIds")?;
    let group = line_group(ctx, "match gifts", &line)?;
    for (gift, version, _) in gifts {
        giving::bank::set_line(ctx, &gift, version, Some(&line.id), source, &group)?;
    }
    mark(
        ctx,
        &line.id,
        req.expected,
        MatchState::Matched,
        req.remainder.map(|r| r.note),
        source,
        &group,
    )?;
    Ok(())
}

async fn match_gifts(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<MatchGifts>,
) -> Result<Json<LineDetail>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        match_to_gifts(ctx, &id, req, Source::Ui)?;
        detail(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// `POST bank/lines/{id}/match-batch {expected, batchId, batchLineVersion,
/// note?}`: `batchLineVersion` is the batch's `lineVersion`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankMatchBatch")]
pub struct MatchBatch {
    #[ts(type = "number")]
    pub expected: i64,
    pub batch_id: String,
    #[ts(type = "number")]
    pub batch_line_version: i64,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
}

pub fn match_to_batch(
    ctx: &Ctx,
    line_id: &str,
    req: MatchBatch,
    source: Source,
) -> Result<(), ContractError> {
    let line = unmatched_line(ctx.tx.read(), line_id, req.expected)?;
    let group = line_group(ctx, "match paying-in batch", &line)?;
    giving::bank::match_batch(
        ctx,
        &req.batch_id,
        req.batch_line_version,
        &line.id,
        source,
        &group,
    )?;
    mark(
        ctx,
        &line.id,
        req.expected,
        MatchState::Matched,
        req.note,
        source,
        &group,
    )?;
    Ok(())
}

async fn match_batch(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<MatchBatch>,
) -> Result<Json<LineDetail>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        match_to_batch(ctx, &id, req, Source::Ui)?;
        detail(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// `POST bank/lines/{id}/not-donation {expected, note}`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankNotDonation")]
pub struct NotDonation {
    #[ts(type = "number")]
    pub expected: i64,
    pub note: String,
}

pub fn mark_not_donation(
    ctx: &Ctx,
    line_id: &str,
    req: NotDonation,
    source: Source,
) -> Result<(), ContractError> {
    let line = unmatched_line(ctx.tx.read(), line_id, req.expected)?;
    let group = line_group(ctx, "not a donation", &line)?;
    mark(
        ctx,
        &line.id,
        req.expected,
        MatchState::NotDonation,
        Some(req.note),
        source,
        &group,
    )?;
    Ok(())
}

async fn not_donation(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<NotDonation>,
) -> Result<Json<LineDetail>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        mark_not_donation(ctx, &id, req, Source::Ui)?;
        detail(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// `POST bank/lines/{id}/unmatch {expected}`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankUnmatch")]
pub struct Unmatch {
    #[ts(type = "number")]
    pub expected: i64,
}

/// Undo a line's match (ADR 0027 decision 4): see the module doc. A line
/// already unmatched is a no-op that answers its counter.
pub fn unmatch_line(
    ctx: &Ctx,
    line_id: &str,
    req: Unmatch,
    source: Source,
) -> Result<Executed, ContractError> {
    let line = matching::line(ctx.tx.read(), line_id)?.ok_or(ContractError::NotFound)?;
    if line.match_version != req.expected {
        return Err(stale(&line));
    }
    if line.state == MatchState::Unmatched {
        return Ok(Executed {
            id: line.id,
            counter: line.match_version,
        });
    }
    let group = line_group(ctx, "unmatch", &line)?;
    if let Some(batch) = giving::bank::batch_for_line(ctx.tx.read(), &line.id)? {
        let version = giving::bank::get_batch(ctx.tx.read(), &batch)?
            .ok_or(ContractError::NotFound)?
            .line_version;
        giving::bank::unmatch_batch(ctx, &batch, version, source, &group)?;
    }
    giving::bank::release_line(
        ctx,
        &line.id,
        giving::bank::LINE_UNMATCHED_REASON,
        source,
        &group,
    )?;
    mark(
        ctx,
        &line.id,
        req.expected,
        MatchState::Unmatched,
        None,
        source,
        &group,
    )
}

async fn unmatch(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<Unmatch>,
) -> Result<Json<LineDetail>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        unmatch_line(ctx, &id, req, Source::Ui)?;
        detail(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// The group a gift's void runs in when the gift is on a statement line
/// ("void gift: frees statement line £9 on …"). Refused when the line
/// holds other gifts too (`line_split`): voiding one part of a split would
/// leave the line short with nothing saying why, and its payers wrong, so
/// the line is unmatched instead, which voids or unlinks every part.
pub fn void_group(ctx: &Ctx, gift_id: &str, line_id: &str) -> Result<CommandGroup, ContractError> {
    let conn = ctx.tx.read();
    let line = matching::line(conn, line_id)?.ok_or(ContractError::NotFound)?;
    if giving::bank::gifts_on_line(conn, line_id)?
        .iter()
        .filter(|g| g.id != gift_id)
        .count()
        > 0
    {
        return Err(ContractError::rejected(
            "line_split",
            "This gift is one part of a statement line’s split: unmatch the line instead",
        ));
    }
    line_group(ctx, "void gift, frees", &line)
}

/// After the only gift on `line_id` is voided (and so off the line), in
/// that void's `group`: the line is unmatched again, its note cleared, so
/// it is matched afresh (and its payers rebuilt).
pub fn free_emptied_line(
    ctx: &Ctx,
    line_id: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<(), ContractError> {
    let conn = ctx.tx.read();
    let Some(line) = matching::line(conn, line_id)? else {
        return Ok(());
    };
    if line.state == MatchState::Unmatched
        || !giving::bank::gifts_on_line(conn, line_id)?.is_empty()
        || giving::bank::batch_for_line(conn, line_id)?.is_some()
    {
        return Ok(());
    }
    execute(
        ctx,
        &LINE_MATCH,
        LineMatchPayload {
            state: MatchState::Unmatched,
            note: None,
        },
        Exec::update(line_id, None, source).in_group(group),
    )?;
    Ok(())
}

// ── accept ticked ──────────────────────────────────────────────────────────

/// One ticked suggestion: its line, the line's `matchVersion` as read, and
/// what it proposes.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankAcceptItem")]
pub struct AcceptItem {
    pub line_id: String,
    #[ts(type = "number")]
    pub expected: i64,
    pub proposal: Proposal,
}

/// `POST bank/accept {items}`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankAccept")]
pub struct Accept {
    pub items: Vec<AcceptItem>,
}

/// One line's outcome: `200` with the line as committed, or the error it
/// would have answered alone (`409 stale` when someone matched it
/// meanwhile).
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankAccepted")]
pub struct Accepted {
    pub line_id: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<LineDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<ApiError>,
}

/// Most lines one accept takes.
pub const ACCEPT_MAX: usize = 200;

/// Apply one ticked suggestion through the same command as by hand. A
/// line whose `matchVersion` moved since it was read is `stale` first,
/// whatever else would refuse it (it was matched meanwhile).
pub fn apply(ctx: &Ctx, item: AcceptItem, source: Source) -> Result<(), ContractError> {
    let line = matching::line(ctx.tx.read(), &item.line_id)?.ok_or(ContractError::NotFound)?;
    if line.match_version != item.expected {
        return Err(stale(&line));
    }
    match item.proposal {
        Proposal::NewGift { contact_id } => {
            gifts_from(
                ctx,
                &item.line_id,
                GiftsFromLine {
                    expected: item.expected,
                    parts: vec![GiftPart {
                        contact: DonorRef::Existing(contact_id),
                        amount: line.amount,
                        source_code_id: None,
                    }],
                    remainder: None,
                },
                source,
            )?;
        }
        Proposal::ExistingGifts { gift_ids } => match_to_gifts(
            ctx,
            &item.line_id,
            MatchGifts {
                expected: item.expected,
                gift_ids,
                remainder: None,
            },
            source,
        )?,
        Proposal::NotDonation { note, .. } => mark_not_donation(
            ctx,
            &item.line_id,
            NotDonation {
                expected: item.expected,
                note,
            },
            source,
        )?,
    }
    Ok(())
}

/// "Accept ticked" (g1q5): only the lines ticked, each in its own
/// transaction (so one line matched meanwhile is `409 stale` alone, and
/// the others still apply), in the order sent.
async fn accept(
    Extension(t): Extension<Tenant>,
    Body(req): Body<Accept>,
) -> Result<Json<Vec<Accepted>>, ApiError> {
    require_staff(&t)?;
    if req.items.len() > ACCEPT_MAX {
        return Err(ApiError::Invalid {
            problems: vec![Problem::new(
                "items",
                format!("At most {ACCEPT_MAX} lines at once"),
            )],
        });
    }
    let mut out = Vec::with_capacity(req.items.len());
    for item in req.items {
        let line_id = item.line_id.clone();
        let done = t
            .write(move |ctx| {
                let id = item.line_id.clone();
                apply(ctx, item, Source::Ui)?;
                detail(ctx.tx.read(), &id)
            })
            .await;
        out.push(match done {
            Ok(line) => Accepted {
                line_id,
                status: 200,
                line: Some(line),
                error: None,
            },
            Err(e) => Accepted {
                line_id,
                status: e.status().as_u16(),
                line: None,
                error: Some(e),
            },
        });
    }
    Ok(Json(out))
}

// ── rules ──────────────────────────────────────────────────────────────────

/// `GET bank/rules?accountId`: the active rules (with `accountId`, that
/// account's and every account's).
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankRulesQuery")]
pub struct RulesQuery {
    #[serde(default)]
    #[ts(optional)]
    pub account_id: Option<String>,
}

async fn list_rules(
    Extension(t): Extension<Tenant>,
    Params(q): Params<RulesQuery>,
) -> Result<Json<Vec<RuleRow>>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| Ok(matching::rules(r, q.account_id.as_deref())?))
        .await
        .map(Json)
}

/// `POST bank/rules {accountId?, field, contains, note?}` → the rule.
async fn create_rule(
    Extension(t): Extension<Tenant>,
    Body(p): Body<RulePayload>,
) -> Result<Json<RuleRow>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        let id = execute(
            ctx,
            &RULE,
            RulePayload { active: true, ..p },
            Exec::create(Source::Ui),
        )?
        .id;
        matching::rule(ctx.tx.read(), &id)?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

/// `POST bank/rules/{id}/delete {expected}`: kept, inactive.
async fn delete_rule(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<Unmatch>,
) -> Result<Json<Executed>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        let current = matching::rule(ctx.tx.read(), &id)?.ok_or(ApiError::NotFound)?;
        Ok(execute(
            ctx,
            &RULE,
            RulePayload {
                active: false,
                ..current.rule
            },
            Exec::update(&id, Some(req.expected), Source::Ui),
        )?)
    })
    .await
    .map(Json)
}
