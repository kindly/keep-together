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

pub use gift::{CLAIM_LOCK, GIFT, STATUS};
pub use queries::{
    BY_CONTACT_LIMIT, HISTORY_PAGE_LIMIT, RECENT_LIMIT, by_contact, get, history, my_recent,
};
pub use rules::{ALLOCATION_LIMIT, CLIENT_KEY_MAX, PENCE_MAX, format_pence};
pub use types::{ClaimLockPayload, GiftPayload, Status, StatusPayload};

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

/// Gift Aid claims (org schema step 16): a gift's void reason, the claim
/// that holds it (`giving.claimLock`, its own counter) and the two
/// indexes a claim's eligibility reads: unclaimed completed gifts by
/// date, and claimed gifts voided since (adjustments). No foreign key to
/// the claim: Gift Aid's claim lines carry that, and it is giftaid's
/// table.
pub const MIGRATION_CLAIM_LOCK: &str = "
ALTER TABLE gifts ADD COLUMN void_reason TEXT;
ALTER TABLE gifts ADD COLUMN claim_id TEXT;
ALTER TABLE gifts ADD COLUMN claim_lock_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX gifts_unclaimed ON gifts (received_on)
    WHERE claim_id IS NULL AND status = 'completed';
CREATE INDEX gifts_claimed_void ON gifts (claim_id)
    WHERE claim_id IS NOT NULL AND status = 'void';
";

/// Every contract restore may meet in an org file's gift history.
/// `giving.claimLock` is here for its upcasters; its apply refuses a
/// restore. There is no whole-gift restore yet: when one is added
/// (`contracts::restore_entity_to`), exclude `giving.claimLock`, or a
/// moment when a since-deleted claim held the gift aborts the restore
/// (review L3).
pub static REGISTRY: LazyLock<Registry> =
    LazyLock::new(|| Registry::new(&[&GIFT, &STATUS, &CLAIM_LOCK]));

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
            reason: None,
        },
        Exec::update(&id, Some(0), source).in_group(group),
    )?;
    Ok(id)
}

/// Void or un-void. Re-sending the current status is a no-op that answers
/// the counter as it is. `reason`: why it is void (needed when the gift
/// is in a Gift Aid claim).
pub fn set_status(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    status: Status,
    reason: Option<String>,
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
        StatusPayload { status, reason },
        Exec::update(id, Some(expected), source),
    )
}

/// A Gift Aid claim takes the gift (`giving.claimLock`), in the claim's
/// command group. Refused if another claim holds it or it is void.
pub fn lock_for_claim(
    ctx: &Ctx,
    gift_id: &str,
    claim_id: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &CLAIM_LOCK,
        ClaimLockPayload {
            claim_id: Some(claim_id.to_owned()),
        },
        Exec::update(gift_id, None, source).in_group(group),
    )
}

/// The claim lets the gift go (a draft deleted, a claim rejected). A gift
/// another claim holds is left alone and refused.
pub fn release_from_claim(
    ctx: &Ctx,
    gift_id: &str,
    claim_id: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<Executed, ContractError> {
    let held: Option<Option<String>> = ctx
        .tx
        .read()
        .prepare_cached("SELECT claim_id FROM gifts WHERE id = ?1")?
        .query_row([gift_id], |r| r.get(0))
        .optional()?;
    match held {
        None => Err(ContractError::NotFound),
        Some(Some(c)) if c == claim_id => execute(
            ctx,
            &CLAIM_LOCK,
            ClaimLockPayload { claim_id: None },
            Exec::update(gift_id, None, source).in_group(group),
        ),
        Some(_) => Err(ContractError::rejected(
            "not_in_claim",
            "The gift isn't in this claim",
        )),
    }
}

/// A gift as a Gift Aid claim's eligibility reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimableGift {
    pub id: String,
    pub contact_id: String,
    pub received_on: String,
    pub amount: i64,
}

/// Completed gifts no claim holds, received `from` ..= `to` (ISO dates),
/// oldest first. One indexed range read (`gifts_unclaimed`).
pub fn unclaimed_between(
    conn: &Connection,
    from: &str,
    to: &str,
) -> rusqlite::Result<Vec<ClaimableGift>> {
    conn.prepare_cached(
        "SELECT id, contact_id, received_on, amount FROM gifts INDEXED BY gifts_unclaimed
         WHERE claim_id IS NULL AND status = 'completed' AND received_on BETWEEN ?1 AND ?2
         ORDER BY received_on, seq",
    )?
    .query_map([from, to], |r| {
        Ok(ClaimableGift {
            id: r.get(0)?,
            contact_id: r.get(1)?,
            received_on: r.get(2)?,
            amount: r.get(3)?,
        })
    })?
    .collect()
}

/// Unclaimed completed gifts received before `before`: how many, for
/// "too old to claim".
pub fn unclaimed_before(conn: &Connection, before: &str) -> rusqlite::Result<i64> {
    conn.prepare_cached(
        "SELECT count(*) FROM gifts INDEXED BY gifts_unclaimed
         WHERE claim_id IS NULL AND status = 'completed' AND received_on < ?1",
    )?
    .query_row([before], |r| r.get(0))
}

/// A claimed gift voided since: the claim that holds it and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoidedClaimedGift {
    pub id: String,
    pub claim_id: String,
    pub void_reason: Option<String>,
}

/// The void gifts `claim_id` holds (`gifts_claimed_void`, one claim's
/// range).
pub fn voided_in_claim(
    conn: &Connection,
    claim_id: &str,
) -> rusqlite::Result<Vec<VoidedClaimedGift>> {
    conn.prepare_cached(
        "SELECT id, claim_id, void_reason FROM gifts INDEXED BY gifts_claimed_void
         WHERE claim_id = ?1 AND status = 'void' ORDER BY seq",
    )?
    .query_map([claim_id], |r| {
        Ok(VoidedClaimedGift {
            id: r.get(0)?,
            claim_id: r.get(1)?,
            void_reason: r.get(2)?,
        })
    })?
    .collect()
}

/// Every void gift a claim still holds (`gifts_claimed_void`).
pub fn voided_in_claims(conn: &Connection) -> rusqlite::Result<Vec<VoidedClaimedGift>> {
    conn.prepare_cached(
        "SELECT id, claim_id, void_reason FROM gifts INDEXED BY gifts_claimed_void
         WHERE claim_id IS NOT NULL AND status = 'void' ORDER BY seq",
    )?
    .query_map([], |r| {
        Ok(VoidedClaimedGift {
            id: r.get(0)?,
            claim_id: r.get(1)?,
            void_reason: r.get(2)?,
        })
    })?
    .collect()
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
