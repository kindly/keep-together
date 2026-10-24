//! Gift reads (`convex/giving/queries.ts`): the Donations menu's recent
//! gifts, a contact's gifts panel, one gift, and its history. Viewers may
//! read them all.

use std::collections::HashMap;

use contracts::{ContractError, Source};
use rusqlite::{Connection, params};
use serde::Serialize;
use sources::CodeDescription;
use ts_rs::TS;

use crate::gift::load_allocations;
use crate::types::{AllocationView, GiftDonor, GiftPage, GiftRow, GiftView, Method, RecentGift, Status};

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
    fn describe(&mut self, conn: &Connection, id: &str) -> rusqlite::Result<Option<&CodeDescription>> {
        if !self.0.contains_key(id) {
            let found = sources::describe(conn, id)?;
            self.0.insert(id.to_owned(), found);
        }
        Ok(self.0[id].as_ref())
    }
}

const GIFT_COLUMNS: &str = "id, contact_id, received_on, amount, method, reference, status, \
     entered_by, entered_at, gift_version, status_version, seq";

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
            entered_by: r.get(7)?,
            entered_at: r.get(8)?,
            gift_version: r.get(9)?,
            status_version: r.get(10)?,
        },
        r.get(11)?,
    ))
}

/// Fill a row's allocations, each with its code as it reads now.
fn describe_allocations(conn: &Connection, codes: &mut Codes, row: &mut GiftRow) -> rusqlite::Result<()> {
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
        .then(|| rows.last().map(|(g, seq)| format!("{}|{seq}", g.received_on)))
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
    let contact = contacts::donors::name_of(conn, &gift.contact_id)?.map(|(display_name, kind)| GiftDonor {
        id: gift.contact_id.clone(),
        display_name,
        kind,
    });
    Ok(Some(GiftView { gift, contact }))
}

// ── history ────────────────────────────────────────────────────────────────
//
// A stand-in for B1's entity-generic `contracts::history::page` (moments
// on the server), with the same JSON shape; replaced by it once B1 merges.

/// One entry of the gift's history: revisions of one command group
/// collapse into one moment naming the slices (`gift`, `status`).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftMoment {
    /// The command group (`g<id>`), or the revision when it had none (`r<id>`).
    pub key: String,
    /// The moment's newest revision.
    #[ts(type = "number")]
    pub revision_id: i64,
    /// ms since the epoch, of the newest revision.
    #[ts(type = "number")]
    pub at: i64,
    #[ts(type = "number | null")]
    pub actor: Option<i64>,
    pub source: Source,
    pub group_name: Option<String>,
    /// The slices it touched, newest first.
    pub slices: Vec<String>,
    pub restored: bool,
}

/// `GET gifts/{id}/history?before&limit`: newest first.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftMomentPage {
    pub moments: Vec<GiftMoment>,
    /// Pass as `before` for the next older page; null at the start. A
    /// group cut by the boundary ends this page and starts the next: the
    /// client joins the halves (same `key`, adjacent).
    #[ts(type = "number | null")]
    pub next_before: Option<i64>,
}

/// The slice a giving contract stands for, as history names it.
fn slice_label(contract: &str) -> String {
    contract.strip_prefix("giving.").unwrap_or(contract).to_owned()
}

/// A gift's history as moments, a page of at most HISTORY_PAGE_LIMIT
/// revisions older than revision `before`.
pub fn history(
    conn: &Connection,
    id: &str,
    before: Option<i64>,
    limit: usize,
) -> Result<GiftMomentPage, ContractError> {
    let limit = limit.clamp(1, HISTORY_PAGE_LIMIT);
    struct Row {
        id: i64,
        contract: String,
        actor: Option<i64>,
        source: Source,
        group: Option<i64>,
        group_name: Option<String>,
        restored: bool,
        at: i64,
    }
    let rows: Vec<Row> = conn
        .prepare_cached(
            "SELECT id, contract, actor, source, group_id, group_name, restored_from, at
             FROM revisions WHERE entity = 'gifts' AND entity_id = ?1 AND id < ?2
             ORDER BY id DESC LIMIT ?3",
        )?
        .query_map(
            params![id, before.unwrap_or(i64::MAX), limit as i64 + 1],
            |r| {
                let source: String = r.get(3)?;
                Ok(Row {
                    id: r.get(0)?,
                    contract: r.get(1)?,
                    actor: r.get(2)?,
                    source: serde_json::from_value(serde_json::Value::String(source))
                        .unwrap_or(Source::System),
                    group: r.get(4)?,
                    group_name: r.get(5)?,
                    restored: r.get::<_, Option<i64>>(6)?.is_some(),
                    at: r.get(7)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    let more = rows.len() > limit;
    let rows = &rows[..rows.len().min(limit)];
    let mut moments: Vec<GiftMoment> = Vec::new();
    for r in rows {
        let key = match r.group {
            Some(g) => format!("g{g}"),
            None => format!("r{}", r.id),
        };
        let slice = slice_label(&r.contract);
        if let Some(m) = moments.iter_mut().find(|m| m.key == key) {
            if !m.slices.contains(&slice) {
                m.slices.push(slice);
            }
            continue;
        }
        moments.push(GiftMoment {
            key,
            revision_id: r.id,
            at: r.at,
            actor: r.actor,
            source: r.source,
            group_name: r.group.and(r.group_name.clone()),
            slices: vec![slice],
            restored: r.restored,
        });
    }
    Ok(GiftMomentPage {
        moments,
        next_before: more.then(|| rows.last().map(|r| r.id)).flatten(),
    })
}
