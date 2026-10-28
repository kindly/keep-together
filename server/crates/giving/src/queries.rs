//! Gift reads (`convex/giving/queries.ts`): the Donations menu's recent
//! gifts, a contact's gifts panel, one gift, and its history. Viewers may
//! read them all.

use std::collections::HashMap;

use contracts::ContractError;
use contracts::history::{MomentPage, SliceLabel};
use rusqlite::{Connection, params};
use sources::CodeDescription;

use crate::gift::load_allocations;
use crate::types::{
    AllocationView, GiftDonor, GiftPage, GiftRow, GiftView, Method, RecentGift, Status,
};

/// Gifts in "my recent gifts" (the menu and the group home page).
pub const RECENT_LIMIT: usize = 10;
/// The most gifts one `by_contact` page holds.
pub const BY_CONTACT_LIMIT: usize = 50;
/// Revisions one `history` page reads at most (newest first).
pub const HISTORY_PAGE_LIMIT: usize = 10;

/// A code lookup for one read: each code is described once however many
/// rows share it.
#[derive(Default)]
struct Codes(HashMap<String, Option<CodeDescription>>);

impl Codes {
    fn describe(
        &mut self,
        conn: &Connection,
        id: &str,
    ) -> rusqlite::Result<Option<&CodeDescription>> {
        if !self.0.contains_key(id) {
            let found = sources::describe(conn, id)?;
            self.0.insert(id.to_owned(), found);
        }
        Ok(self.0[id].as_ref())
    }
}

const GIFT_COLUMNS: &str = "id, contact_id, received_on, amount, method, reference, status, \
     entered_by, entered_at, gift_version, status_version, seq, void_reason, claim_id";

fn gift_row(r: &rusqlite::Row) -> rusqlite::Result<(GiftRow, i64)> {
    Ok((
        GiftRow {
            id: r.get(0)?,
            contact_id: r.get(1)?,
            received_on: r.get(2)?,
            amount: r.get(3)?,
            method: Method::parse(&r.get::<_, String>(4)?),
            reference: r.get(5)?,
            allocations: vec![],
            status: Status::parse(&r.get::<_, String>(6)?),
            void_reason: r.get(12)?,
            claim_id: r.get(13)?,
            entered_by: r.get(7)?,
            entered_at: r.get(8)?,
            gift_version: r.get(9)?,
            status_version: r.get(10)?,
        },
        r.get(11)?,
    ))
}

/// Fill a row's allocations, each with its code as it reads now.
fn describe_allocations(
    conn: &Connection,
    codes: &mut Codes,
    row: &mut GiftRow,
) -> rusqlite::Result<()> {
    row.allocations = load_allocations(conn, &row.id)?
        .into_iter()
        .map(|a| {
            let code = codes.describe(conn, &a.source_code_id)?;
            Ok(AllocationView::new(
                a.key.unwrap_or_default(),
                a.source_code_id,
                a.amount,
                code,
            ))
        })
        .collect::<rusqlite::Result<_>>()?;
    Ok(())
}

/// The caller's last RECENT_LIMIT gifts, newest entered first, void ones
/// included (marked by `status`). Only gifts `user` entered.
pub fn my_recent(conn: &Connection, user: i64) -> rusqlite::Result<Vec<RecentGift>> {
    let rows: Vec<RecentGift> = conn
        .prepare_cached(
            "SELECT id, entered_at, contact_id, amount, received_on, method, status
             FROM gifts WHERE entered_by = ?1 ORDER BY seq DESC LIMIT ?2",
        )?
        .query_map(params![user, RECENT_LIMIT as i64], |r| {
            Ok(RecentGift {
                id: r.get(0)?,
                entered_at: r.get(1)?,
                contact_id: r.get(2)?,
                contact_name: String::new(),
                amount: r.get(3)?,
                received_on: r.get(4)?,
                method: Method::parse(&r.get::<_, String>(5)?),
                status: Status::parse(&r.get::<_, String>(6)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|mut g| {
            g.contact_name = contacts::donors::name_of(conn, &g.contact_id)?
                .map(|(name, _)| name)
                .unwrap_or_default();
            Ok(g)
        })
        .collect()
}

/// A page position: the last row's date and entry order.
fn parse_cursor(cursor: &str) -> Result<(String, i64), ContractError> {
    cursor
        .split_once('|')
        .and_then(|(date, seq)| Some((date.to_owned(), seq.parse().ok()?)))
        .ok_or_else(|| ContractError::invalid("cursor", "Not a cursor this list gave"))
}

/// A contact's gifts, newest date first (then newest entered), a page at
/// a time: keyset on `(received_on, seq)`, at most BY_CONTACT_LIMIT rows.
/// Each row carries its codes as they read now. An unknown contact has no
/// gifts.
pub fn by_contact(
    conn: &Connection,
    contact_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<GiftPage, ContractError> {
    let limit = limit.clamp(1, BY_CONTACT_LIMIT);
    let (date, seq) = match cursor.filter(|c| !c.is_empty()) {
        Some(c) => parse_cursor(c)?,
        None => ("9999-99-99".to_owned(), i64::MAX),
    };
    let mut rows: Vec<(GiftRow, i64)> = conn
        .prepare_cached(&format!(
            "SELECT {GIFT_COLUMNS} FROM gifts
             WHERE contact_id = ?1 AND (received_on, seq) < (?2, ?3)
             ORDER BY received_on DESC, seq DESC LIMIT ?4"
        ))?
        .query_map(params![contact_id, date, seq, limit as i64 + 1], gift_row)?
        .collect::<rusqlite::Result<_>>()?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = more
        .then(|| {
            rows.last()
                .map(|(g, seq)| format!("{}|{seq}", g.received_on))
        })
        .flatten();
    let mut codes = Codes::default();
    let rows = rows
        .into_iter()
        .map(|(mut g, _)| {
            describe_allocations(conn, &mut codes, &mut g)?;
            Ok(g)
        })
        .collect::<rusqlite::Result<_>>()?;
    Ok(GiftPage {
        rows,
        is_done: next_cursor.is_none(),
        next_cursor,
    })
}

/// One gift for its page: the gift, its donor's name and kind, and each
/// allocation's code. `None` for an unknown id.
pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<GiftView>> {
    let found = conn
        .prepare_cached(&format!("SELECT {GIFT_COLUMNS} FROM gifts WHERE id = ?1"))?
        .query_row([id], gift_row);
    let mut gift = match found {
        Ok((g, _)) => g,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e),
    };
    describe_allocations(conn, &mut Codes::default(), &mut gift)?;
    let contact =
        contacts::donors::name_of(conn, &gift.contact_id)?.map(|(display_name, kind)| GiftDonor {
            id: gift.contact_id.clone(),
            display_name,
            kind,
        });
    Ok(Some(GiftView { gift, contact }))
}

// ── history ────────────────────────────────────────────────────────────────

/// How a gift's history names its slices: `gift`, `status`, `claimLock`.
struct GiftSlices;

impl SliceLabel for GiftSlices {
    fn label(&self, contract: &str) -> String {
        contract
            .strip_prefix("giving.")
            .unwrap_or(contract)
            .to_owned()
    }

    fn retired(&self, _: &str) -> bool {
        false
    }
}

/// A gift's history as moments (revisions of one command group collapse
/// into one naming the slices), a page of at most HISTORY_PAGE_LIMIT
/// revisions older than revision `before`, newest first.
pub fn history(
    conn: &Connection,
    id: &str,
    before: Option<i64>,
    limit: usize,
) -> Result<MomentPage, ContractError> {
    contracts::history::page(
        conn,
        "gifts",
        id,
        before,
        limit.clamp(1, HISTORY_PAGE_LIMIT),
        &GiftSlices,
    )
}
