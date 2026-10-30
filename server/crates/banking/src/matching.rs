//! Matching statement lines (plan `bank-transfers.sv` step 4, ADR 0027
//! decisions 4 and 8): a line's match state, the payers it teaches us,
//! forgetting them, and not-a-donation rules.
//!
//! ```text
//!   banking.lineMatch    — a line's state (unmatched | matched |
//!                          not_donation), its note, who and when
//!                          (`match_version`). Projection: `bank_payers`
//!   banking.forgetPayers — a contact's remembered payers forgotten, at a
//!                          moment (`bank_payer_forgets.version`).
//!                          Projection: `bank_payers`
//!   banking.rule         — "narrative contains GOCARDLESS → not a
//!                          donation" (`bank_rules.version`)
//! ```
//!
//! What a line is matched *to* is giving's: the gifts on it
//! (`gifts.bank_line_id`) or its paying-in batch (`giving.batchLine`).
//! `banking.lineMatch` checks it agrees with them, in the same command
//! group as the giving commands that move them (the api's commands).
//!
//! `bank_payers` is derived from confirmed matches: for an account and a
//! payer key (the line's payer and reference), the contacts of the gifts
//! on its matched lines, skipping lines matched before the contact's
//! payers were forgotten. Both contracts rebuild it, so a rebuild never
//! brings a forgotten payer back, and a match after the forget teaches it
//! again.

use std::collections::BTreeMap;

use contracts::{
    Command, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem, ProjectionTx, Source,
    WriteTx, execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

/// Org schema step 22: a contact's remembered payers forgotten (erasure,
/// or staff removing them), `banking.forgetPayers`'s root. Its id is the
/// contact's. And the matched lines by payer key, which every rebuild of
/// `bank_payers` reads ([`PAYER_KEY_SQL`]).
pub const MIGRATION: &str = "
CREATE TABLE bank_payer_forgets (
    id TEXT PRIMARY KEY REFERENCES contacts (id),
    forgotten_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX bank_lines_matched_by_payer ON bank_lines
    (account_id, (lower(trim(payer)) || '|' || lower(trim(reference))))
    WHERE match_state = 'matched';
";

/// The payer key in SQL, the words of the index `bank_lines_matched_by_payer`.
const PAYER_KEY_SQL: &str = "(lower(trim(payer)) || '|' || lower(trim(reference)))";

/// Longest note on a line kept.
pub const NOTE_MAX: usize = 500;

/// A line's payer key: its payer and reference, trimmed of spaces and
/// lower-cased (ASCII, as SQLite's `lower` and `trim` do, so the index
/// agrees). `None` when both are blank: nothing to remember.
pub fn payer_key(payer: &str, reference: &str) -> Option<String> {
    let norm = |s: &str| s.trim_matches(' ').to_ascii_lowercase();
    let (p, r) = (norm(payer), norm(reference));
    (!p.is_empty() || !r.is_empty()).then(|| format!("{p}|{r}"))
}

// ── lines ──────────────────────────────────────────────────────────────────

/// Where a statement line stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "BankMatchState")]
pub enum MatchState {
    Unmatched,
    Matched,
    NotDonation,
}

impl MatchState {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchState::Unmatched => "unmatched",
            MatchState::Matched => "matched",
            MatchState::NotDonation => "not_donation",
        }
    }

    /// The stored word (a CHECK holds the column).
    pub fn parse(s: &str) -> Self {
        match s {
            "matched" => MatchState::Matched,
            "not_donation" => MatchState::NotDonation,
            _ => MatchState::Unmatched,
        }
    }
}

/// A statement line as matching reads it: its content (the bank's, never
/// edited) and its match state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankLine")]
pub struct LineView {
    pub id: String,
    pub account_id: String,
    pub import_id: String,
    /// When the money reached the bank (ISO): a gift made from it is dated so.
    pub posted_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub payer: String,
    pub reference: String,
    pub narrative: String,
    pub bank_id: Option<String>,
    pub state: MatchState,
    pub note: Option<String>,
    #[ts(type = "number | null")]
    pub matched_by: Option<i64>,
    #[ts(type = "number | null")]
    pub matched_at: Option<i64>,
    #[ts(type = "number")]
    pub match_version: i64,
}

const LINE_COLUMNS: &str = "id, account_id, import_id, posted_on, amount, payer, reference,
     narrative, bank_id, match_state, match_note, matched_by, matched_at, match_version";

fn line_view(r: &rusqlite::Row) -> rusqlite::Result<LineView> {
    Ok(LineView {
        id: r.get(0)?,
        account_id: r.get(1)?,
        import_id: r.get(2)?,
        posted_on: r.get(3)?,
        amount: r.get(4)?,
        payer: r.get(5)?,
        reference: r.get(6)?,
        narrative: r.get(7)?,
        bank_id: r.get(8)?,
        state: MatchState::parse(&r.get::<_, String>(9)?),
        note: r.get(10)?,
        matched_by: r.get(11)?,
        matched_at: r.get(12)?,
        match_version: r.get(13)?,
    })
}

/// One line, or `None`.
pub fn line(conn: &Connection, id: &str) -> rusqlite::Result<Option<LineView>> {
    conn.prepare_cached(&format!(
        "SELECT {LINE_COLUMNS} FROM bank_lines WHERE id = ?1"
    ))?
    .query_row([id], line_view)
    .optional()
}

/// The most lines one list holds.
pub const LINES_PAGE: i64 = 200;

/// An account's lines in `state`, oldest posted first (at most
/// [`LINES_PAGE`]; `bank_lines_by_state`).
pub fn lines(
    conn: &Connection,
    account_id: &str,
    state: MatchState,
) -> rusqlite::Result<Vec<LineView>> {
    conn.prepare_cached(&format!(
        "SELECT {LINE_COLUMNS} FROM bank_lines WHERE account_id = ?1 AND match_state = ?2
         ORDER BY posted_on, seq LIMIT {LINES_PAGE}"
    ))?
    .query_map(params![account_id, state.as_str()], line_view)?
    .collect()
}

// ── banking.lineMatch ──────────────────────────────────────────────────────

/// The `banking.lineMatch` slice: where the line stands and its note (why
/// it isn't a donation, or what the remainder of a split was).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankLineMatch")]
pub struct LineMatchPayload {
    pub state: MatchState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

/// A line's match state (ADR 0027 decision 1: the content is the
/// import's, this slice the matcher's). It agrees with giving at every
/// commit:
///
/// - `matched`: the line holds gifts (`gifts.bank_line_id`, not void) or
///   a paying-in batch. Its gifts add up to the line at most, and any
///   remainder needs a note (what it was: a raffle ticket, a refund);
/// - `not_donation`: a note, and nothing on the line;
/// - `unmatched`: nothing on the line, and no note.
///
/// Matched by and at are the command's, set when the state changes. A
/// restore is refused: the gifts and batch wouldn't follow.
pub struct LineMatch;
pub static LINE_MATCH: LineMatch = LineMatch;

/// The slice as stored, plus what checks it. Only the payload is
/// serialised (a stale refusal's `current`).
#[derive(Clone, Debug, Serialize)]
pub struct LineMatchState {
    #[serde(flatten)]
    pub matching: LineMatchPayload,
    #[serde(skip)]
    amount: i64,
    #[serde(skip)]
    matched_by: Option<i64>,
    #[serde(skip)]
    matched_at: Option<i64>,
}

pub const LINES: &str = "bank_lines";
pub const PAYERS: &str = "bank_payers";

impl Contract for LineMatch {
    const NAME: &'static str = "banking.lineMatch";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = LINES;
    const COUNTER: &'static str = "match_version";
    const PROJECTIONS: &'static [&'static str] = &[PAYERS];
    type Payload = LineMatchPayload;
    type State = LineMatchState;

    fn prepare(&self, mut p: LineMatchPayload) -> Result<LineMatchPayload, ContractError> {
        p.note = p
            .note
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        if p.note
            .as_deref()
            .is_some_and(|n| contacts::rules::too_long(n, NOTE_MAX))
        {
            return Err(ContractError::invalid(
                "note",
                format!("At most {NOTE_MAX} characters"),
            ));
        }
        match p.state {
            MatchState::NotDonation if p.note.is_none() => Err(ContractError::invalid(
                "note",
                "Say what it was: a grant, a refund, a payout",
            )),
            MatchState::Unmatched if p.note.is_some() => Ok(LineMatchPayload { note: None, ..p }),
            _ => Ok(p),
        }
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<LineMatchState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT match_state, match_note, amount, matched_by, matched_at
                 FROM bank_lines WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok(LineMatchState {
                    matching: LineMatchPayload {
                        state: MatchState::parse(&r.get::<_, String>(0)?),
                        note: r.get(1)?,
                    },
                    amount: r.get(2)?,
                    matched_by: r.get(3)?,
                    matched_at: r.get(4)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&LineMatchState>,
        p: &LineMatchPayload,
        command: &Command,
    ) -> Result<LineMatchState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "banking.lineMatch targets an imported line",
            ));
        };
        if command.source == Source::Restore {
            return Err(ContractError::rejected(
                "not_restorable",
                "A line's match is restored by matching it again",
            ));
        }
        let (matched_by, matched_at) = match p.state {
            MatchState::Unmatched => (None, None),
            s if s == current.matching.state => (current.matched_by, current.matched_at),
            _ => (command.actor, Some(command.at)),
        };
        Ok(LineMatchState {
            matching: p.clone(),
            matched_by,
            matched_at,
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&LineMatchState>,
        next: &LineMatchState,
    ) -> Result<(), ContractError> {
        let gifts = giving::bank::gifts_on_line(tx, id)?;
        let batch = giving::bank::batch_for_line(tx, id)?;
        let held = !gifts.is_empty() || batch.is_some();
        match next.matching.state {
            MatchState::Unmatched | MatchState::NotDonation if held => {
                return Err(ContractError::rejected(
                    "line_held",
                    "This line still holds gifts or a paying-in batch: unmatch them first",
                ));
            }
            MatchState::Matched if !held => {
                return Err(ContractError::rejected(
                    "nothing_matched",
                    "Match the line to gifts or a paying-in batch",
                ));
            }
            MatchState::Matched if batch.is_none() => {
                let sum: i64 = gifts.iter().map(|g| g.amount).sum();
                if sum > next.amount {
                    return Err(ContractError::rejected(
                        "over_line",
                        "The gifts add up to more than the line",
                    ));
                }
                if sum < next.amount && next.matching.note.is_none() {
                    return Err(ContractError::Invalid(vec![Problem::new(
                        "note",
                        "Say what the rest of the line was: it isn't a donation",
                    )]));
                }
            }
            _ => {}
        }
        tx.prepare_cached(
            "UPDATE bank_lines SET match_state = ?2, match_note = ?3, matched_by = ?4,
                 matched_at = ?5
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            next.matching.state.as_str(),
            next.matching.note,
            next.matched_by,
            next.matched_at
        ])?;
        Ok(())
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        let found: Option<(String, String, String)> = tx
            .prepare_cached("SELECT account_id, payer, reference FROM bank_lines WHERE id = ?1")?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        if let Some((account, payer, reference)) = found
            && let Some(key) = payer_key(&payer, &reference)
        {
            rebuild_payers(tx, &account, &key)?;
        }
        Ok(())
    }
}

/// A projection row's id: the same for the same account, key and contact
/// whenever it is rebuilt.
fn payer_row_id(account: &str, key: &str, contact: &str) -> String {
    let digest = Sha256::digest(format!("{account}\u{1f}{key}\u{1f}{contact}"));
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Rebuild `bank_payers` for one account and payer key from its matched
/// lines: each gift's contact on them, unless that contact's payers were
/// forgotten after the line was matched; the newest line gives the row
/// its payer, reference and moment.
fn rebuild_payers(tx: &Connection, account: &str, key: &str) -> rusqlite::Result<()> {
    tx.prepare_cached("DELETE FROM bank_payers WHERE account_id = ?1 AND payer_key = ?2")?
        .execute(params![account, key])?;
    let matched: Vec<(String, String, String, i64)> = tx
        .prepare_cached(&format!(
            "SELECT id, payer, reference, coalesce(matched_at, 0) FROM bank_lines
             INDEXED BY bank_lines_matched_by_payer
             WHERE account_id = ?1 AND {PAYER_KEY_SQL} = ?2 AND match_state = 'matched'
             ORDER BY matched_at, seq"
        ))?
        .query_map(params![account, key], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    // contact → (payer, reference, line, matched at): the newest wins.
    let mut rows: BTreeMap<String, (String, String, String, i64)> = BTreeMap::new();
    let mut forgotten =
        tx.prepare_cached("SELECT forgotten_at FROM bank_payer_forgets WHERE id = ?1")?;
    for (line, payer, reference, at) in matched {
        for gift in giving::bank::gifts_on_line(tx, &line)? {
            let forgot: Option<i64> = forgotten
                .query_row([&gift.contact_id], |r| r.get(0))
                .optional()?;
            if forgot.is_some_and(|f| f >= at) {
                continue;
            }
            rows.insert(
                gift.contact_id,
                (payer.clone(), reference.clone(), line.clone(), at),
            );
        }
    }
    let mut insert = tx.prepare_cached(
        "INSERT INTO bank_payers (id, account_id, payer_key, contact_id, payer, reference,
             last_line_id, matched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for (contact, (payer, reference, line, at)) in rows {
        insert.execute(params![
            payer_row_id(account, key, &contact),
            account,
            key,
            contact,
            payer,
            reference,
            line,
            at
        ])?;
    }
    Ok(())
}

/// A remembered payer: the contact a line's payer and reference were
/// matched to before, on this account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankPayer")]
pub struct Payer {
    pub account_id: String,
    pub contact_id: String,
    pub payer: String,
    pub reference: String,
    pub last_line_id: Option<String>,
    #[ts(type = "number")]
    pub matched_at: i64,
}

fn payer_row(r: &rusqlite::Row) -> rusqlite::Result<Payer> {
    Ok(Payer {
        account_id: r.get(0)?,
        contact_id: r.get(1)?,
        payer: r.get(2)?,
        reference: r.get(3)?,
        last_line_id: r.get(4)?,
        matched_at: r.get(5)?,
    })
}

/// The contacts this account's payer key was matched to before.
pub fn payers_for(conn: &Connection, account: &str, key: &str) -> rusqlite::Result<Vec<Payer>> {
    conn.prepare_cached(
        "SELECT account_id, contact_id, payer, reference, last_line_id, matched_at
         FROM bank_payers WHERE account_id = ?1 AND payer_key = ?2 ORDER BY matched_at DESC",
    )?
    .query_map(params![account, key], payer_row)?
    .collect()
}

/// The posted date of the latest line before `line` on its account with
/// the same payer key and amount, matched to gifts from `contact`: the
/// payment before this one, for "make this a standing order".
pub fn earlier_payment(
    conn: &Connection,
    line: &LineView,
    key: &str,
    contact: &str,
) -> rusqlite::Result<Option<String>> {
    let earlier: Vec<(String, String)> = conn
        .prepare_cached(&format!(
            "SELECT id, posted_on FROM bank_lines INDEXED BY bank_lines_matched_by_payer
             WHERE account_id = ?1 AND {PAYER_KEY_SQL} = ?2 AND match_state = 'matched'
                 AND amount = ?3 AND posted_on < ?4
             ORDER BY posted_on DESC, seq DESC LIMIT 10"
        ))?
        .query_map(
            params![line.account_id, key, line.amount, line.posted_on],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?
        .collect::<rusqlite::Result<_>>()?;
    for (id, posted_on) in earlier {
        if giving::bank::gifts_on_line(conn, &id)?
            .iter()
            .any(|g| g.contact_id == contact)
        {
            return Ok(Some(posted_on));
        }
    }
    Ok(None)
}

/// A contact's remembered payers, newest first (shown on the contact).
pub fn payers_of(conn: &Connection, contact_id: &str) -> rusqlite::Result<Vec<Payer>> {
    conn.prepare_cached(
        "SELECT account_id, contact_id, payer, reference, last_line_id, matched_at
         FROM bank_payers WHERE contact_id = ?1 ORDER BY matched_at DESC",
    )?
    .query_map([contact_id], payer_row)?
    .collect()
}

// ── banking.forgetPayers ───────────────────────────────────────────────────

/// A contact's remembered payers forgotten (g1q8: removable on the
/// contact, and gone with the contact on erasure, rule 3), at the
/// command's moment: the projection drops their rows, and no rebuild
/// brings back a line matched before it. A line matched afterwards is
/// remembered again. Its root's id is the contact's; a second forget
/// moves the moment on. A restore is refused (it would move it back).
pub struct ForgetPayers;
pub static FORGET_PAYERS: ForgetPayers = ForgetPayers;

/// `banking.forgetPayers`'s payload: nothing but the moment, which is the
/// command's.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgetPayersPayload {}

#[derive(Clone, Debug, Serialize)]
pub struct ForgetState {
    #[serde(skip)]
    forgotten_at: i64,
}

pub const FORGETS: &str = "bank_payer_forgets";

impl Contract for ForgetPayers {
    const NAME: &'static str = "banking.forgetPayers";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = FORGETS;
    const COUNTER: &'static str = "version";
    const PROJECTIONS: &'static [&'static str] = &[PAYERS];
    type Payload = ForgetPayersPayload;
    type State = ForgetState;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<ForgetState, ContractError> {
        tx.read()
            .prepare_cached("SELECT forgotten_at FROM bank_payer_forgets WHERE id = ?1")?
            .query_row([id], |r| {
                Ok(ForgetState {
                    forgotten_at: r.get(0)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        _: Option<&ForgetState>,
        _: &ForgetPayersPayload,
        command: &Command,
    ) -> Result<ForgetState, ContractError> {
        if command.source == Source::Restore {
            return Err(ContractError::rejected(
                "not_restorable",
                "Forgetting a contact's payers is never undone by a restore",
            ));
        }
        Ok(ForgetState {
            forgotten_at: command.at,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&ForgetState>,
        next: &ForgetState,
    ) -> Result<(), ContractError> {
        if before.is_none() {
            if contacts::donors::kind_of(tx, id)?.is_none() {
                return Err(ContractError::rejected(
                    "unknown_contact",
                    "Contact must exist",
                ));
            }
            tx.prepare_cached("INSERT INTO bank_payer_forgets (id, forgotten_at) VALUES (?1, ?2)")?
                .execute(params![id, next.forgotten_at])?;
        } else {
            tx.prepare_cached("UPDATE bank_payer_forgets SET forgotten_at = ?2 WHERE id = ?1")?
                .execute(params![id, next.forgotten_at])?;
        }
        Ok(())
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        tx.prepare_cached("DELETE FROM bank_payers WHERE contact_id = ?1")?
            .execute([id])?;
        Ok(())
    }
}

/// Forget a contact's remembered payers, on every account: erasure's
/// part (rule 3), and staff's "remove" on the contact. In the caller's
/// transaction, under `group` when given. Their gifts and the statement
/// lines stay as they are.
pub fn forget_payers(
    ctx: &Ctx,
    contact_id: &str,
    source: Source,
    group: Option<&contracts::CommandGroup>,
) -> Result<Executed, ContractError> {
    let exists: Option<i64> = ctx
        .tx
        .read()
        .prepare_cached("SELECT 1 FROM bank_payer_forgets WHERE id = ?1")?
        .query_row([contact_id], |r| r.get(0))
        .optional()?;
    let exec = match exists {
        Some(_) => Exec::update(contact_id, None, source),
        None => Exec::create_with_id(contact_id, source),
    };
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(ctx, &FORGET_PAYERS, ForgetPayersPayload {}, exec)
}

// ── banking.rule ───────────────────────────────────────────────────────────

/// Which part of a line a rule looks in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "BankRuleField")]
pub enum RuleField {
    Narrative,
    Payer,
    Reference,
}

impl RuleField {
    pub fn as_str(self) -> &'static str {
        match self {
            RuleField::Narrative => "narrative",
            RuleField::Payer => "payer",
            RuleField::Reference => "reference",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "payer" => RuleField::Payer,
            "reference" => RuleField::Reference,
            _ => RuleField::Narrative,
        }
    }

    /// The part of `line` this field names.
    pub fn of(self, line: &LineView) -> &str {
        match self {
            RuleField::Narrative => &line.narrative,
            RuleField::Payer => &line.payer,
            RuleField::Reference => &line.reference,
        }
    }
}

/// Longest text a rule looks for.
pub const CONTAINS_MAX: usize = 100;

/// The `banking.rule` contract (counter `version`): a line whose `field`
/// contains `contains` (ignoring case) is suggested as not a donation,
/// with `note`, on one account (or all, `accountId` none). Suggested, and
/// pre-ticked, never applied on its own (g1q5). Deleting one is saving it
/// inactive: it is kept for history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankRulePayload")]
pub struct RulePayload {
    #[serde(default)]
    pub account_id: Option<String>,
    pub field: RuleField,
    pub contains: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default = "yes")]
    pub active: bool,
}

fn yes() -> bool {
    true
}

pub struct Rule;
pub static RULE: Rule = Rule;

#[derive(Clone, Debug, Serialize)]
pub struct RuleState {
    #[serde(flatten)]
    pub rule: RulePayload,
    #[serde(skip)]
    created_by: Option<i64>,
    #[serde(skip)]
    created_at: i64,
}

pub const RULES: &str = "bank_rules";

impl Contract for Rule {
    const NAME: &'static str = "banking.rule";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = RULES;
    const COUNTER: &'static str = "version";
    type Payload = RulePayload;
    type State = RuleState;

    fn prepare(&self, mut p: RulePayload) -> Result<RulePayload, ContractError> {
        let mut problems = Vec::new();
        p.contains = p.contains.trim().to_owned();
        p.note = p
            .note
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        if p.contains.is_empty() {
            problems.push(Problem::new("contains", "Say what the line contains"));
        } else if contacts::rules::too_long(&p.contains, CONTAINS_MAX) {
            problems.push(Problem::new(
                "contains",
                format!("At most {CONTAINS_MAX} characters"),
            ));
        }
        if p.note
            .as_deref()
            .is_some_and(|n| contacts::rules::too_long(n, NOTE_MAX))
        {
            problems.push(Problem::new(
                "note",
                format!("At most {NOTE_MAX} characters"),
            ));
        }
        if problems.is_empty() {
            Ok(p)
        } else {
            Err(ContractError::Invalid(problems))
        }
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<RuleState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT account_id, field, contains, note, active, created_by, created_at
                 FROM bank_rules WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok(RuleState {
                    rule: RulePayload {
                        account_id: r.get(0)?,
                        field: RuleField::parse(&r.get::<_, String>(1)?),
                        contains: r.get(2)?,
                        note: r.get(3)?,
                        active: r.get(4)?,
                    },
                    created_by: r.get(5)?,
                    created_at: r.get(6)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&RuleState>,
        p: &RulePayload,
        command: &Command,
    ) -> Result<RuleState, ContractError> {
        Ok(match current {
            None => RuleState {
                rule: p.clone(),
                created_by: command.actor,
                created_at: command.at,
            },
            Some(c) => RuleState {
                rule: p.clone(),
                ..c.clone()
            },
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&RuleState>,
        next: &RuleState,
    ) -> Result<(), ContractError> {
        let r = &next.rule;
        if let Some(account) = &r.account_id
            && before.and_then(|b| b.rule.account_id.as_ref()) != Some(account)
            && crate::account::account(tx, account)?.is_none()
        {
            return Err(ContractError::rejected(
                "unknown_account",
                "The bank account must exist",
            ));
        }
        if before.is_none() {
            tx.prepare_cached(
                "INSERT INTO bank_rules (id, account_id, field, contains, note, active,
                     created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?
            .execute(params![
                id,
                r.account_id,
                r.field.as_str(),
                r.contains,
                r.note,
                r.active,
                next.created_by,
                next.created_at
            ])?;
        } else {
            tx.prepare_cached(
                "UPDATE bank_rules SET account_id = ?2, field = ?3, contains = ?4, note = ?5,
                     active = ?6
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                r.account_id,
                r.field.as_str(),
                r.contains,
                r.note,
                r.active
            ])?;
        }
        Ok(())
    }
}

/// A rule as listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankRule")]
pub struct RuleRow {
    pub id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub rule: RulePayload,
    #[ts(type = "number")]
    pub version: i64,
}

/// The active rules, oldest first; with `account`, those for it and for
/// every account.
pub fn rules(conn: &Connection, account: Option<&str>) -> rusqlite::Result<Vec<RuleRow>> {
    conn.prepare_cached(
        "SELECT id, account_id, field, contains, note, active, version FROM bank_rules
         WHERE active = 1 AND (?1 IS NULL OR account_id IS NULL OR account_id = ?1)
         ORDER BY seq",
    )?
    .query_map([account], |r| {
        Ok(RuleRow {
            id: r.get(0)?,
            rule: RulePayload {
                account_id: r.get(1)?,
                field: RuleField::parse(&r.get::<_, String>(2)?),
                contains: r.get(3)?,
                note: r.get(4)?,
                active: r.get(5)?,
            },
            version: r.get(6)?,
        })
    })?
    .collect()
}

/// One rule (active or not), or `None`.
pub fn rule(conn: &Connection, id: &str) -> rusqlite::Result<Option<RuleRow>> {
    conn.prepare_cached(
        "SELECT id, account_id, field, contains, note, active, version FROM bank_rules
         WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(RuleRow {
            id: r.get(0)?,
            rule: RulePayload {
                account_id: r.get(1)?,
                field: RuleField::parse(&r.get::<_, String>(2)?),
                contains: r.get(3)?,
                note: r.get(4)?,
                active: r.get(5)?,
            },
            version: r.get(6)?,
        })
    })
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payer_key_is_the_payer_and_reference_trimmed_and_lower_cased() {
        assert_eq!(
            payer_key("  A SMITH ", "100016").as_deref(),
            Some("a smith|100016")
        );
        assert_eq!(payer_key("", "REF").as_deref(), Some("|ref"));
        assert_eq!(payer_key(" ", ""), None);
    }

    #[test]
    fn a_payer_row_id_is_the_same_on_every_rebuild() {
        let a = payer_row_id("acc", "a smith|100016", "c1");
        assert_eq!(a, payer_row_id("acc", "a smith|100016", "c1"));
        assert_ne!(a, payer_row_id("acc", "a smith|100016", "c2"));
        assert_eq!(a.len(), 32);
    }
}
