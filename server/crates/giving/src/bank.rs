//! Bank transfers on the giving side (ADR 0027): the statement line a
//! gift is on, paying-in batches, and the schema step that adds them.
//!
//! - A gift **made from** a statement line carries it from its create
//!   (`giving.gift`'s `fromLine`, `bank_line_made`): its amount, date and
//!   reference are the line's, and voiding it frees the line for good.
//! - A transfer **entered by hand** is `completed` at once and is "not on
//!   a statement yet" ([`not_on_a_statement`], derived) until a line is
//!   matched to it: `giving.line` ([`LINE`], counter `line_version`) links
//!   it, and unlinks it again when the line is unmatched or the gift is
//!   voided.
//! - **Paying-in batches** (`giving.payingInBatch`, [`PAYING_IN_BATCH`],
//!   counter `version`) hold cash and cheques paid in on one slip. Their
//!   line is a slice of its own (`giving.batchLine`, [`BATCH_LINE`],
//!   counter `line_version`), moved only by [`match_batch`] and
//!   [`unmatch_batch`]: a cheque is `pending` until its batch is matched
//!   to the slip's statement line, and back to `pending` if that is
//!   undone.
//!
//! A statement line holds gifts or one batch, never both. The statement
//! side (accounts, imports, lines) is `banking`'s, which depends on this
//! crate, so the few checks here that name its tables read them directly.

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx,
    execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::RECEIVED;
use crate::gift::{STATUS, TABLE};
use crate::rules::prepare_batch;
use crate::types::{
    BatchLinePayload, BatchStatus, LinePayload, Method, PayingInBatchPayload, PayingInBatchRow,
    Status, StatusPayload,
};

/// Org schema step 21 (ADR 0027, plan `factory/plans/bank-transfers.sv`).
/// It spans two modules: the statement side is `banking`'s (accounts,
/// imports, lines, payers, rules), the batches and the gifts `giving`'s.
/// It is held here, below `banking` (which depends on this crate), so
/// both crates' tests migrate with it; `api::schema` runs it.
///
/// - `bank_lines` is the outside record, as `direct_debit_payments` is
///   for GoCardless: credits only (`amount > 0`), its content written
///   once by the import; `dedupe_key` + `occurrence` find the same line
///   in an overlapping file (most UK CSVs carry no id), `bank_id` too
///   when the format has one. `match_state`, `match_note` and
///   `match_version` are `banking.lineMatch`'s slice; the gifts a line
///   became point at it (`gifts.bank_line_id`), and a batch matched to it
///   says so (`paying_in_batches.line_id`, `giving.batchLine`'s slice, so
///   a batch is matched when it is closed and names its line): one link
///   each way, never both.
/// - `bank_payers` is derived (`banking.lineMatch`'s projection): no
///   counter. A contact's rows go on erasure (rule 3).
/// - `gifts` is rebuilt (SQLite can't widen the method's CHECK in place)
///   with every column and index it has by step 20, plus its line
///   (`bank_line_id`, whether it was made from it, `bank_line_made`, and
///   the `giving.line` counter, `line_version`) and its paying-in batch.
///   A gift has one origin: a provider, or a statement line, or staff
///   (ADR 0025 decision 1, ADR 0027). Only a bank transfer is on a line,
///   and only cash or a cheque is in a batch.
pub const MIGRATION: &str = "
CREATE TABLE bank_accounts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    sort_code TEXT NOT NULL DEFAULT '',
    account_last4 TEXT NOT NULL DEFAULT '',
    default_source_code_id TEXT REFERENCES source_codes (id),
    csv_mapping TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE bank_imports (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    file_name TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('csv', 'ofx', 'qif')),
    preset TEXT,
    first_date TEXT,
    last_date TEXT,
    new_lines INTEGER NOT NULL DEFAULT 0 CHECK (new_lines >= 0),
    duplicate_lines INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_lines >= 0),
    imported_by INTEGER,
    imported_at INTEGER NOT NULL,
    -- `banking.import`'s counter: create-only, but a contract all the same.
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX bank_imports_by_account ON bank_imports (account_id, seq);

CREATE TABLE bank_lines (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    import_id TEXT NOT NULL REFERENCES bank_imports (id),
    posted_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    payer TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    narrative TEXT NOT NULL DEFAULT '',
    bank_id TEXT,
    dedupe_key TEXT NOT NULL,
    occurrence INTEGER NOT NULL CHECK (occurrence >= 1),
    match_state TEXT NOT NULL DEFAULT 'unmatched'
        CHECK (match_state IN ('unmatched', 'matched', 'not_donation')),
    match_note TEXT,
    matched_by INTEGER,
    matched_at INTEGER,
    match_version INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, dedupe_key, occurrence)
) STRICT;
CREATE UNIQUE INDEX bank_lines_by_bank_id ON bank_lines (account_id, bank_id)
    WHERE bank_id IS NOT NULL;
CREATE INDEX bank_lines_by_state ON bank_lines (account_id, match_state, posted_on);
CREATE INDEX bank_lines_by_import ON bank_lines (import_id, seq);

CREATE TABLE bank_payers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    payer_key TEXT NOT NULL,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    payer TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    last_line_id TEXT REFERENCES bank_lines (id),
    matched_at INTEGER NOT NULL,
    UNIQUE (account_id, payer_key, contact_id)
) STRICT;
CREATE INDEX bank_payers_by_contact ON bank_payers (contact_id);

CREATE TABLE bank_rules (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT REFERENCES bank_accounts (id),
    field TEXT NOT NULL CHECK (field IN ('narrative', 'payer', 'reference')),
    contains TEXT NOT NULL CHECK (contains <> ''),
    action TEXT NOT NULL DEFAULT 'not_donation' CHECK (action IN ('not_donation')),
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE paying_in_batches (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    slip_number TEXT NOT NULL DEFAULT '',
    banked_on TEXT,
    total INTEGER CHECK (total IS NULL OR total >= 0),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    line_id TEXT UNIQUE REFERENCES bank_lines (id),
    opened_by INTEGER,
    opened_at INTEGER NOT NULL,
    closed_by INTEGER,
    closed_at INTEGER,
    version INTEGER NOT NULL DEFAULT 0,
    -- `giving.batchLine`'s counter: matched = closed and naming its line.
    line_version INTEGER NOT NULL DEFAULT 0,
    CHECK (line_id IS NULL OR status = 'closed'),
    CHECK (status = 'open' OR total IS NOT NULL)
) STRICT;
CREATE INDEX paying_in_batches_by_account ON paying_in_batches (account_id, status, seq);

ALTER TABLE regular_gifts ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct_debit'
    CHECK (kind IN ('direct_debit', 'standing_order'));

CREATE TABLE gifts_widen AS SELECT * FROM gifts;
DROP TABLE gifts;
CREATE TABLE gifts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    received_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL
        CHECK (method IN ('cash', 'card', 'direct_debit', 'bank_transfer', 'cheque')),
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed',
        'cancelled', 'refunded', 'charged_back', 'void')),
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    client_key TEXT UNIQUE,
    gift_version INTEGER NOT NULL DEFAULT 0,
    status_version INTEGER NOT NULL DEFAULT 0,
    void_reason TEXT,
    claim_id TEXT,
    claim_lock_version INTEGER NOT NULL DEFAULT 0,
    provider TEXT CHECK (provider IN ('gocardless', 'stripe')),
    provider_payment_id TEXT CHECK (provider_payment_id IS NULL OR provider IS NOT NULL),
    regular_gift_id TEXT REFERENCES regular_gifts (id),
    scheduled_on TEXT,
    bank_line_id TEXT REFERENCES bank_lines (id)
        CHECK (bank_line_id IS NULL OR provider IS NULL),
    bank_line_made INTEGER NOT NULL DEFAULT 0 CHECK (bank_line_made IN (0, 1)),
    line_version INTEGER NOT NULL DEFAULT 0,
    paying_in_batch_id TEXT REFERENCES paying_in_batches (id),
    CHECK (bank_line_made = 0 OR bank_line_id IS NOT NULL),
    CHECK (bank_line_id IS NULL OR method = 'bank_transfer'),
    CHECK (paying_in_batch_id IS NULL OR method IN ('cash', 'cheque'))
) STRICT;
INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, reference, status,
    entered_by, entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version, provider, provider_payment_id, regular_gift_id, scheduled_on)
SELECT seq, id, contact_id, received_on, amount, method, reference, status, entered_by,
    entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version, provider, provider_payment_id, regular_gift_id, scheduled_on
FROM gifts_widen;
DROP TABLE gifts_widen;
CREATE INDEX gifts_by_contact ON gifts (contact_id, received_on, seq);
CREATE INDEX gifts_by_entered_by ON gifts (entered_by, seq);
CREATE INDEX gifts_unclaimed ON gifts (received_on)
    WHERE claim_id IS NULL AND status = 'completed';
CREATE INDEX gifts_claimed_uncounted ON gifts (claim_id)
    WHERE claim_id IS NOT NULL AND status <> 'completed';
CREATE UNIQUE INDEX gifts_by_provider_payment ON gifts (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
CREATE INDEX gifts_by_regular_gift ON gifts (regular_gift_id, received_on)
    WHERE regular_gift_id IS NOT NULL;
CREATE INDEX gifts_by_scheduled ON gifts (regular_gift_id, scheduled_on)
    WHERE scheduled_on IS NOT NULL;
CREATE INDEX gifts_by_bank_line ON gifts (bank_line_id) WHERE bank_line_id IS NOT NULL;
CREATE INDEX gifts_by_paying_in_batch ON gifts (paying_in_batch_id, seq)
    WHERE paying_in_batch_id IS NOT NULL;
CREATE INDEX gifts_not_on_a_statement ON gifts (received_on)
    WHERE method = 'bank_transfer' AND bank_line_id IS NULL AND status = 'completed';
";

/// Why a cheque went back to pending: its batch's statement line was
/// unmatched. A claimed one goes into the next claim as an adjustment.
pub const BATCH_UNMATCHED_REASON: &str = "Its paying-in batch was unmatched from the statement";
/// Why a gift made from a statement line was voided by the line's unmatch.
pub const LINE_UNMATCHED_REASON: &str = "Its statement line was unmatched";

/// A bank transfer entered by hand, received, that no statement line is
/// matched to yet: "not on a statement yet" (ADR 0027 decision 4). Derived
/// from the gift, never stored; the partial index
/// `gifts_not_on_a_statement` is on the same words.
pub fn not_on_a_statement(method: Method, status: Status, bank_line_id: Option<&str>) -> bool {
    method == Method::BankTransfer && status.is_received() && bank_line_id.is_none()
}

/// Refuse a line that a paying-in batch is matched to: a line holds gifts
/// or a batch, never both.
pub(crate) fn check_line_free_of_batches(
    conn: &Connection,
    line_id: &str,
) -> Result<(), ContractError> {
    let held: Option<String> = conn
        .prepare_cached("SELECT id FROM paying_in_batches WHERE line_id = ?1")?
        .query_row([line_id], |r| r.get(0))
        .optional()?;
    match held {
        Some(_) => Err(ContractError::rejected(
            "line_taken",
            "This statement line is matched to a paying-in batch",
        )),
        None => Ok(()),
    }
}

/// The bank account a statement line is on, or `None` for no such line.
fn line_account(conn: &Connection, line_id: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT account_id FROM bank_lines WHERE id = ?1")?
        .query_row([line_id], |r| r.get(0))
        .optional()
}

/// Refuse a line id that isn't a statement line (rather than meet the
/// foreign key).
pub(crate) fn check_line_exists(conn: &Connection, line_id: &str) -> Result<(), ContractError> {
    match line_account(conn, line_id)? {
        Some(_) => Ok(()),
        None => Err(ContractError::rejected(
            "unknown_line",
            "The statement line must exist",
        )),
    }
}

/// Refuse a line that gifts are on (void ones have freed it), `except`
/// one gift.
fn check_line_free_of_gifts(
    conn: &Connection,
    line_id: &str,
    except: Option<&str>,
) -> Result<(), ContractError> {
    let held: Option<String> = conn
        .prepare_cached(
            "SELECT id FROM gifts WHERE bank_line_id = ?1 AND status <> 'void'
                 AND id IS NOT ?2
             /* any status: a void gift has freed its line */ LIMIT 1",
        )?
        .query_row(params![line_id, except], |r| r.get(0))
        .optional()?;
    match held {
        Some(_) => Err(ContractError::rejected(
            "line_taken",
            "This statement line is matched to gifts",
        )),
        None => Ok(()),
    }
}

/// Refuse a gift into a batch that isn't open (or isn't one).
pub(crate) fn check_batch_open(conn: &Connection, batch_id: &str) -> Result<(), ContractError> {
    let status: Option<String> = conn
        .prepare_cached("SELECT status FROM paying_in_batches WHERE id = ?1")?
        .query_row([batch_id], |r| r.get(0))
        .optional()?;
    match status.as_deref().map(BatchStatus::parse) {
        None => Err(ContractError::rejected(
            "unknown_batch",
            "The paying-in batch must exist",
        )),
        Some(BatchStatus::Open) => Ok(()),
        Some(_) => Err(ContractError::rejected(
            "batch_closed",
            "This paying-in batch is closed: reopen it to add a gift",
        )),
    }
}

// ── giving.line ────────────────────────────────────────────────────────────

/// The statement line a gift entered by hand is matched to (ADR 0027
/// decision 4). A restore relinks only a line no batch and no other gift
/// holds now. Voiding the gift unlinks it ([`crate::set_status`]). Only a
/// bank transfer that isn't void is linked; one line
/// at a time (unmatch, then match again). A gift made from a line is
/// refused: its line is its for good.
pub struct Line;
pub static LINE: Line = Line;

/// The `giving.line` slice as stored, plus what decides whether it may
/// change (never serialised).
#[derive(Clone, Debug, Serialize)]
pub struct LineState {
    #[serde(flatten)]
    pub line: LinePayload,
    #[serde(skip)]
    made: bool,
    #[serde(skip)]
    method: Method,
    #[serde(skip)]
    status: Status,
    #[serde(skip)]
    restoring: bool,
}

impl Contract for Line {
    const NAME: &'static str = "giving.line";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "line_version";
    type Payload = LinePayload;
    type State = LineState;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<LineState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT bank_line_id, bank_line_made, method, status FROM gifts
                 WHERE id = ?1 /* any status: one gift */",
            )?
            .query_row([id], |r| {
                Ok(LineState {
                    line: LinePayload { line_id: r.get(0)? },
                    made: r.get(1)?,
                    method: Method::parse(&r.get::<_, String>(2)?),
                    status: Status::parse(&r.get::<_, String>(3)?),
                    restoring: false,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&LineState>,
        p: &LinePayload,
        command: &Command,
    ) -> Result<LineState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giving.line targets an existing gift",
            ));
        };
        if current.made {
            return Err(ContractError::rejected(
                "line_made",
                "This gift was made from its statement line: void it to free the line",
            ));
        }
        match (&current.line.line_id, &p.line_id) {
            (Some(held), Some(next)) if held != next => {
                return Err(ContractError::rejected(
                    "line_linked",
                    "This gift is already matched to another statement line: unmatch it first",
                ));
            }
            (_, Some(_)) if current.method != Method::BankTransfer => {
                return Err(ContractError::rejected(
                    "line_method",
                    "Only a bank transfer is matched to a statement line",
                ));
            }
            (None, Some(_)) if current.status == Status::Void => {
                return Err(ContractError::rejected(
                    "void_gift",
                    "A void gift can’t be matched to a statement line",
                ));
            }
            _ => {}
        }
        Ok(LineState {
            line: p.clone(),
            restoring: command.source == Source::Restore,
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&LineState>,
        next: &LineState,
    ) -> Result<(), ContractError> {
        if let Some(line) = &next.line.line_id
            && before.and_then(|b| b.line.line_id.as_ref()) != Some(line)
        {
            check_line_exists(tx, line)?;
            check_line_free_of_batches(tx, line)?;
            // A restore relinks only a line nothing else has taken since
            // (matching by hand may put several gifts on one line; a
            // restore doesn't know what was matched since).
            if next.restoring {
                check_line_free_of_gifts(tx, line, Some(id))?;
            }
        }
        tx.prepare_cached("UPDATE gifts SET bank_line_id = ?2 WHERE id = ?1")?
            .execute(params![id, next.line.line_id])?;
        Ok(())
    }
}

/// Match a gift entered by hand to a statement line, or (`None`) unlink
/// it, under `group`. Re-sending the line it has is a no-op that answers
/// the counter as it is.
pub fn set_line(
    ctx: &Ctx,
    gift_id: &str,
    expected: i64,
    line_id: Option<&str>,
    source: Source,
    group: &CommandGroup,
) -> Result<Executed, ContractError> {
    let current = LINE.load(ctx.tx, gift_id)?;
    if current.line.line_id.as_deref() == line_id {
        let counter = ctx
            .tx
            .read()
            .prepare_cached(
                "SELECT line_version FROM gifts WHERE id = ?1 /* any status: one gift */",
            )?
            .query_row([gift_id], |r| r.get(0))?;
        return Ok(Executed {
            id: gift_id.to_owned(),
            counter,
        });
    }
    execute(
        ctx,
        &LINE,
        LinePayload {
            line_id: line_id.map(str::to_owned),
        },
        Exec::update(gift_id, Some(expected), source).in_group(group),
    )
}

/// A statement line is unmatched (ADR 0027 decision 4), the giving side,
/// under `group`: the gifts made from it are voided (with `reason`, so a
/// claimed one goes into the next claim as an adjustment), and the gifts
/// entered by hand only lose the link, going back to "not on a statement
/// yet". Answers the gifts it changed, in entry order.
pub fn release_line(
    ctx: &Ctx,
    line_id: &str,
    reason: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<Vec<String>, ContractError> {
    let gifts: Vec<(String, bool, i64, i64)> = ctx
        .tx
        .read()
        .prepare_cached(
            "SELECT id, bank_line_made, status_version, line_version FROM gifts
             WHERE bank_line_id = ?1 AND status <> 'void'
             /* any status: every gift still on the line */ ORDER BY seq",
        )?
        .query_map([line_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut changed = Vec::with_capacity(gifts.len());
    for (id, made, status_version, line_version) in gifts {
        if made {
            execute(
                ctx,
                &STATUS,
                StatusPayload {
                    status: Status::Void,
                    reason: Some(reason.to_owned()),
                },
                Exec::update(&id, Some(status_version), source).in_group(group),
            )?;
        } else {
            execute(
                ctx,
                &LINE,
                LinePayload { line_id: None },
                Exec::update(&id, Some(line_version), source).in_group(group),
            )?;
        }
        changed.push(id);
    }
    Ok(changed)
}

/// A gift a statement line holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineGift {
    pub id: String,
    pub contact_id: String,
    pub received_on: String,
    pub amount: i64,
    pub status: Status,
    /// Made from the line (else entered by hand and matched to it).
    pub from_line: bool,
}

/// The gifts on a statement line, in entry order: every one that isn't
/// void (a void one has freed the line). One indexed read.
pub fn gifts_on_line(conn: &Connection, line_id: &str) -> rusqlite::Result<Vec<LineGift>> {
    conn.prepare_cached(
        "SELECT id, contact_id, received_on, amount, status, bank_line_made FROM gifts
         WHERE bank_line_id = ?1 AND status <> 'void'
         /* any status: what holds the line */ ORDER BY seq",
    )?
    .query_map([line_id], |r| {
        Ok(LineGift {
            id: r.get(0)?,
            contact_id: r.get(1)?,
            received_on: r.get(2)?,
            amount: r.get(3)?,
            status: Status::parse(&r.get::<_, String>(4)?),
            from_line: r.get(5)?,
        })
    })?
    .collect()
}

/// A bank transfer that is waiting for its statement line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferGift {
    pub id: String,
    pub contact_id: String,
    pub received_on: String,
    pub amount: i64,
}

/// The transfers entered by hand and received `from` ..= `to` (ISO dates)
/// that are not on a statement yet, oldest first: what matching looks for
/// a line to (`gifts_not_on_a_statement`, one indexed range read).
pub fn transfers_not_on_a_statement(
    conn: &Connection,
    from: &str,
    to: &str,
) -> rusqlite::Result<Vec<TransferGift>> {
    conn.prepare_cached(&format!(
        "SELECT id, contact_id, received_on, amount FROM gifts INDEXED BY gifts_not_on_a_statement
         WHERE method = 'bank_transfer' AND bank_line_id IS NULL AND {RECEIVED}
             AND received_on BETWEEN ?1 AND ?2
         ORDER BY received_on, seq"
    ))?
    .query_map([from, to], |r| {
        Ok(TransferGift {
            id: r.get(0)?,
            contact_id: r.get(1)?,
            received_on: r.get(2)?,
            amount: r.get(3)?,
        })
    })?
    .collect()
}

// ── giving.payingInBatch ───────────────────────────────────────────────────

pub const BATCH_TABLE: &str = "paying_in_batches";

/// A paying-in batch (ADR 0027 decision 6). It opens empty on a bank
/// account; staff record its cash and cheques into it while it is open,
/// then close it with the slip's total and the date it was paid in (and
/// may reopen it). Its statement line is another slice,
/// `giving.batchLine` ([`BATCH_LINE`]): a batch is matched when it is
/// closed and names its line, and while it does, this slice changes
/// nothing (`batch_matched`). The account never changes.
pub struct PayingInBatch;
pub static PAYING_IN_BATCH: PayingInBatch = PayingInBatch;

/// The batch as stored, plus who opened and closed it and when (set by
/// the commands, never by a payload) and the line `giving.batchLine`
/// holds. Only the payload is serialised.
#[derive(Clone, Debug, Serialize)]
pub struct BatchState {
    #[serde(flatten)]
    pub batch: PayingInBatchPayload,
    #[serde(skip)]
    opened_by: Option<i64>,
    #[serde(skip)]
    opened_at: i64,
    #[serde(skip)]
    closed_by: Option<i64>,
    #[serde(skip)]
    closed_at: Option<i64>,
    #[serde(skip)]
    line_id: Option<String>,
}

const BATCH_COLUMNS: &str = "account_id, slip_number, banked_on, total, status, \
     opened_by, opened_at, closed_by, closed_at, line_id";

fn batch_state(r: &rusqlite::Row, at: usize) -> rusqlite::Result<BatchState> {
    Ok(BatchState {
        batch: PayingInBatchPayload {
            account_id: r.get(at)?,
            slip_number: r.get(at + 1)?,
            banked_on: r.get(at + 2)?,
            total: r.get(at + 3)?,
            status: BatchStatus::parse(&r.get::<_, String>(at + 4)?),
        },
        opened_by: r.get(at + 5)?,
        opened_at: r.get(at + 6)?,
        closed_by: r.get(at + 7)?,
        closed_at: r.get(at + 8)?,
        line_id: r.get(at + 9)?,
    })
}

fn load_batch(conn: &Connection, id: &str) -> rusqlite::Result<Option<BatchState>> {
    conn.prepare_cached(&format!(
        "SELECT {BATCH_COLUMNS} FROM paying_in_batches WHERE id = ?1"
    ))?
    .query_row([id], |r| batch_state(r, 0))
    .optional()
}

impl Contract for PayingInBatch {
    const NAME: &'static str = "giving.payingInBatch";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = BATCH_TABLE;
    const COUNTER: &'static str = "version";
    type Payload = PayingInBatchPayload;
    type State = BatchState;

    fn prepare(&self, p: PayingInBatchPayload) -> Result<PayingInBatchPayload, ContractError> {
        prepare_batch(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<BatchState, ContractError> {
        load_batch(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&BatchState>,
        p: &PayingInBatchPayload,
        command: &Command,
    ) -> Result<BatchState, ContractError> {
        let Some(current) = current else {
            if p.status != BatchStatus::Open {
                return Err(ContractError::rejected(
                    "batch_not_open",
                    "A paying-in batch opens empty: close it once its gifts are in",
                ));
            }
            return Ok(BatchState {
                batch: p.clone(),
                opened_by: command.actor,
                opened_at: command.at,
                closed_by: None,
                closed_at: None,
                line_id: None,
            });
        };
        let was = &current.batch;
        if p.account_id != was.account_id {
            return Err(ContractError::rejected(
                "account_fixed",
                "A paying-in batch’s bank account can’t change: open another batch",
            ));
        }
        // Matched: only its line's unmatch changes it (a restore included).
        if current.line_id.is_some() && p != was {
            return Err(ContractError::rejected(
                "batch_matched",
                "This batch is matched to a statement line: unmatch it to change it",
            ));
        }
        let (closed_by, closed_at) = match (was.status, p.status) {
            (_, BatchStatus::Open) => (None, None),
            (BatchStatus::Open, _) => (command.actor, Some(command.at)),
            _ => (current.closed_by, current.closed_at),
        };
        Ok(BatchState {
            batch: p.clone(),
            closed_by,
            closed_at,
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&BatchState>,
        next: &BatchState,
    ) -> Result<(), ContractError> {
        let b = &next.batch;
        if before.is_none() {
            let account: Option<i64> = tx
                .prepare_cached("SELECT 1 FROM bank_accounts WHERE id = ?1")?
                .query_row([&b.account_id], |r| r.get(0))
                .optional()?;
            if account.is_none() {
                return Err(ContractError::rejected(
                    "unknown_account",
                    "The bank account must exist",
                ));
            }
            tx.prepare_cached(
                "INSERT INTO paying_in_batches (id, account_id, slip_number, banked_on, total,
                     status, opened_by, opened_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?
            .execute(params![
                id,
                b.account_id,
                b.slip_number,
                b.banked_on,
                b.total,
                b.status.as_str(),
                next.opened_by,
                next.opened_at
            ])?;
            return Ok(());
        }
        tx.prepare_cached(
            "UPDATE paying_in_batches SET slip_number = ?2, banked_on = ?3, total = ?4,
                 status = ?5, closed_by = ?6, closed_at = ?7
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            b.slip_number,
            b.banked_on,
            b.total,
            b.status.as_str(),
            next.closed_by,
            next.closed_at
        ])?;
        Ok(())
    }
}

// ── giving.batchLine ───────────────────────────────────────────────────────

/// The statement line a closed paying-in batch is matched to (counter
/// `line_version`): its own slice so that no batch save can match or
/// unmatch it. Run only by [`match_batch`] and [`unmatch_batch`], which
/// clear the batch's cheques and pend them again in the same command
/// group; a restore is refused, since the cheques wouldn't follow. The
/// line must be on the batch's own account and hold no gifts and no
/// other batch. Crate-private, so nothing outside `giving` can run it
/// without its cheques.
pub(crate) struct BatchLine;
pub(crate) static BATCH_LINE: BatchLine = BatchLine;

/// The `giving.batchLine` slice as stored, plus what decides whether it
/// may change (never serialised).
#[derive(Clone, Debug, Serialize)]
pub(crate) struct BatchLineState {
    #[serde(flatten)]
    pub line: BatchLinePayload,
    #[serde(skip)]
    status: BatchStatus,
    #[serde(skip)]
    account_id: String,
}

impl Contract for BatchLine {
    const NAME: &'static str = "giving.batchLine";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = BATCH_TABLE;
    const COUNTER: &'static str = "line_version";
    type Payload = BatchLinePayload;
    type State = BatchLineState;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<BatchLineState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT line_id, status, account_id FROM paying_in_batches WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok(BatchLineState {
                    line: BatchLinePayload { line_id: r.get(0)? },
                    status: BatchStatus::parse(&r.get::<_, String>(1)?),
                    account_id: r.get(2)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&BatchLineState>,
        p: &BatchLinePayload,
        command: &Command,
    ) -> Result<BatchLineState, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giving.batchLine targets an existing paying-in batch",
            ));
        };
        if command.source == Source::Restore {
            return Err(ContractError::rejected(
                "not_restorable",
                "Only matching its statement line matches or unmatches a paying-in batch",
            ));
        }
        match (&current.line.line_id, &p.line_id) {
            (None, Some(_)) if current.status != BatchStatus::Closed => {
                return Err(ContractError::rejected(
                    "close_first",
                    "Close the batch with the slip’s total before matching it",
                ));
            }
            (Some(held), Some(next)) if held != next => {
                return Err(ContractError::rejected(
                    "batch_matched",
                    "This batch is matched to another statement line: unmatch it first",
                ));
            }
            _ => {}
        }
        Ok(BatchLineState {
            line: p.clone(),
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&BatchLineState>,
        next: &BatchLineState,
    ) -> Result<(), ContractError> {
        if let Some(line) = &next.line.line_id
            && before.and_then(|b| b.line.line_id.as_ref()) != Some(line)
        {
            check_line_exists(tx, line)?;
            if line_account(tx, line)?.as_deref() != Some(next.account_id.as_str()) {
                return Err(ContractError::rejected(
                    "line_account",
                    "This statement line is on another bank account than the batch",
                ));
            }
            check_line_free_of_gifts(tx, line, None)?;
            check_line_free_of_batches(tx, line)?;
        }
        tx.prepare_cached("UPDATE paying_in_batches SET line_id = ?2 WHERE id = ?1")?
            .execute(params![id, next.line.line_id])?;
        Ok(())
    }
}

/// The cheques in a batch with `status`, as `(id, status counter)`.
fn cheques_in(
    conn: &Connection,
    batch_id: &str,
    status: Status,
) -> rusqlite::Result<Vec<(String, i64)>> {
    conn.prepare_cached(
        "SELECT id, status_version FROM gifts
         WHERE paying_in_batch_id = ?1 AND method = 'cheque' AND status = ?2
         /* any status: the batch's cheques in one status */ ORDER BY seq",
    )?
    .query_map(params![batch_id, status.as_str()], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })?
    .collect()
}

/// Match a closed batch to its statement line (`expected`: the batch's
/// `lineVersion`), under `group`: the batch names the line, and its
/// pending cheques clear (`completed`). A difference between the slip's
/// total and the line is the caller's to show, never forced here.
pub fn match_batch(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    line_id: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<Executed, ContractError> {
    let done = execute(
        ctx,
        &BATCH_LINE,
        BatchLinePayload {
            line_id: Some(line_id.to_owned()),
        },
        Exec::update(id, Some(expected), source).in_group(group),
    )?;
    for (gift, counter) in cheques_in(ctx.tx.read(), id, Status::Pending)? {
        execute(
            ctx,
            &STATUS,
            StatusPayload {
                status: Status::Completed,
                reason: None,
            },
            Exec::update(&gift, Some(counter), source).in_group(group),
        )?;
    }
    Ok(done)
}

/// Undo [`match_batch`] (`expected`: the batch's `lineVersion`), under
/// `group`: the batch is closed with no line again, and its cleared
/// cheques go back to `pending` (with [`BATCH_UNMATCHED_REASON`], so a
/// claimed one goes into the next claim as an adjustment). A bounced
/// cheque stays failed.
pub fn unmatch_batch(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    source: Source,
    group: &CommandGroup,
) -> Result<Executed, ContractError> {
    let done = execute(
        ctx,
        &BATCH_LINE,
        BatchLinePayload { line_id: None },
        Exec::update(id, Some(expected), source).in_group(group),
    )?;
    for (gift, counter) in cheques_in(ctx.tx.read(), id, Status::Completed)? {
        execute(
            ctx,
            &STATUS,
            StatusPayload {
                status: Status::Pending,
                reason: Some(BATCH_UNMATCHED_REASON.to_owned()),
            },
            Exec::update(&gift, Some(counter), source).in_group(group),
        )?;
    }
    Ok(done)
}

/// One batch with what its gifts add up to, or `None`.
pub fn get_batch(conn: &Connection, id: &str) -> rusqlite::Result<Option<PayingInBatchRow>> {
    conn.prepare_cached(&format!(
        "SELECT b.id, b.version, b.line_version, {BATCH_COLUMNS},
             (SELECT count(*) FROM gifts g WHERE g.paying_in_batch_id = b.id
                 AND g.status <> 'void' /* any status: a slip holds its cheques before they clear */),
             (SELECT coalesce(sum(g.amount), 0) FROM gifts g WHERE g.paying_in_batch_id = b.id
                 AND g.status <> 'void' /* any status: a slip holds its cheques before they clear */)
         FROM paying_in_batches b WHERE b.id = ?1"
    ))?
    .query_row([id], |r| {
        let state = batch_state(r, 3)?;
        Ok(PayingInBatchRow {
            id: r.get(0)?,
            version: r.get(1)?,
            line_version: r.get(2)?,
            batch: state.batch,
            line_id: state.line_id,
            opened_by: state.opened_by,
            opened_at: state.opened_at,
            closed_by: state.closed_by,
            closed_at: state.closed_at,
            gift_count: r.get(13)?,
            gifts_total: r.get(14)?,
        })
    })
    .optional()
}

/// The batch a statement line is matched to, if any.
pub fn batch_for_line(conn: &Connection, line_id: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT id FROM paying_in_batches WHERE line_id = ?1")?
        .query_row([line_id], |r| r.get(0))
        .optional()
}
