//! Gifts, their allocations across source codes, void and un-void: the
//! Rust counterpart of `convex/giving/`. A domain crate: depends on
//! `contracts`, `contacts` and `sources` through their public functions,
//! never on `store` or `platform`; it can't name an organisation. Money is
//! INTEGER pence (rule 7). Gifts are never deleted (rule 3).
//!
//! Other modules read a gift only through [`describe_gift`].

pub mod gift;
pub mod queries;
pub mod rules;
pub mod types;

use std::sync::LazyLock;

use contracts::{
    CommandGroup, ContractError, Ctx, Exec, Executed, Registry, Source, command_group, execute,
};
use rusqlite::{Connection, OptionalExtension};

pub use gift::{GIFT, STATUS};
pub use queries::{
    BY_CONTACT_LIMIT, HISTORY_PAGE_LIMIT, RECENT_LIMIT, by_contact, get, history, my_recent,
};
pub use rules::{ALLOCATION_LIMIT, CLIENT_KEY_MAX, PENCE_MAX, format_pence};
pub use types::{GiftPayload, Status, StatusPayload};

/// The org-schema step this crate owns, after `sources::MIGRATION` and
/// the contacts tables. `seq` is entry order ("my recent gifts", newest
/// entered first); `id` is the API's UUIDv7. `gift_allocations` are the
/// `giving.gift` slice's child rows; `gift_allocation_index` is the
/// projection both contracts rebuild (no counter, no revisions), indexed
/// for income by code, detail or category over dates.
pub const MIGRATION: &str = "
CREATE TABLE gifts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    received_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card')),
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'void')),
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    client_key TEXT UNIQUE,
    gift_version INTEGER NOT NULL DEFAULT 0,
    status_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX gifts_by_contact ON gifts (contact_id, received_on, seq);
CREATE INDEX gifts_by_entered_by ON gifts (entered_by, seq);

CREATE TABLE gift_allocations (
    id TEXT PRIMARY KEY,
    gift_id TEXT NOT NULL REFERENCES gifts (id),
    position INTEGER NOT NULL,
    source_code_id TEXT NOT NULL REFERENCES source_codes (id),
    amount INTEGER NOT NULL CHECK (amount > 0)
) STRICT;
CREATE INDEX gift_allocations_by_gift ON gift_allocations (gift_id, position);

CREATE TABLE gift_allocation_index (
    allocation_id TEXT PRIMARY KEY,
    gift_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_code_id TEXT NOT NULL,
    detail_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    received_on TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL
) STRICT;
CREATE INDEX gift_allocation_index_by_gift ON gift_allocation_index (gift_id);
CREATE INDEX gift_allocation_index_by_code ON gift_allocation_index (source_code_id, received_on);
CREATE INDEX gift_allocation_index_by_detail ON gift_allocation_index (detail_id, received_on);
CREATE INDEX gift_allocation_index_by_category ON gift_allocation_index (category_id, received_on);
CREATE INDEX gift_allocation_index_by_code_contact ON gift_allocation_index (source_code_id, contact_id);
";

/// Every contract restore may meet in an org file's gift history.
pub static REGISTRY: LazyLock<Registry> = LazyLock::new(|| Registry::new(&[&GIFT, &STATUS]));

/// The command group's name for a new gift, with the code as it reads now
/// (history keeps it through renames): "gift £20 cash, Street-Wesser-001".
pub fn gift_group_name(conn: &Connection, p: &GiftPayload) -> rusqlite::Result<String> {
    let mut named = Vec::new();
    for a in &p.allocations {
        if let Some(code) = sources::describe(conn, &a.source_code_id)? {
            named.push(code.code);
        }
    }
    let head = format!("gift {} {}", format_pence(p.amount), p.method.as_str());
    Ok(if named.is_empty() {
        head
    } else {
        format!("{head}, {}", named.join(", "))
    })
}

/// Record a gift in the caller's transaction: `giving.gift`, then
/// `giving.status` (completed), so status history starts with the gift.
/// Runs under `group`, or one of its own named by [`gift_group_name`]. A
/// `clientKey` already on a gift is `Duplicate`. A refusal fails the
/// caller's whole command.
pub fn create_gift(
    ctx: &Ctx,
    payload: GiftPayload,
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<String, ContractError> {
    let own;
    let group = match group {
        Some(g) => g,
        None => {
            own = command_group(ctx, &gift_group_name(ctx.tx.read(), &payload)?)?;
            &own
        }
    };
    let id = execute(ctx, &GIFT, payload, Exec::create(source).in_group(group))?.id;
    execute(
        ctx,
        &STATUS,
        StatusPayload {
            status: Status::Completed,
        },
        Exec::update(&id, Some(0), source).in_group(group),
    )?;
    Ok(id)
}

/// Void or un-void. Re-sending the current status is a no-op that answers
/// the counter as it is.
pub fn set_status(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    status: Status,
    source: Source,
) -> Result<Executed, ContractError> {
    let current: Option<(String, i64)> = ctx
        .tx
        .read()
        .query_row(
            "SELECT status, status_version FROM gifts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((held, counter)) = current else {
        return Err(ContractError::NotFound);
    };
    if Status::parse(&held) == status {
        return Ok(Executed {
            id: id.to_owned(),
            counter,
        });
    }
    execute(
        ctx,
        &STATUS,
        StatusPayload { status },
        Exec::update(id, Some(expected), source),
    )
}

/// A gift's donor, date and status (Gift Aid's "this gift only" check),
/// or `None` for an unknown id. One read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GiftFacts {
    pub contact_id: String,
    pub received_on: String,
    pub status: Status,
}

pub fn describe_gift(conn: &Connection, id: &str) -> rusqlite::Result<Option<GiftFacts>> {
    conn.prepare_cached("SELECT contact_id, received_on, status FROM gifts WHERE id = ?1")?
        .query_row([id], |r| {
            Ok(GiftFacts {
                contact_id: r.get(0)?,
                received_on: r.get(1)?,
                status: Status::parse(&r.get::<_, String>(2)?),
            })
        })
        .optional()
}

/// The gift a form's `clientKey` already saved, or `None`.
pub fn by_client_key(conn: &Connection, client_key: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT id FROM gifts WHERE client_key = ?1")?
        .query_row([client_key], |r| r.get(0))
        .optional()
}
