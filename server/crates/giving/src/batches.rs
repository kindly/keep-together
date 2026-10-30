//! Reading paying-in batches for their pages (bank transfers 6b): the
//! list and a batch's gifts. The batches themselves, and matching them to
//! a statement line, are `bank`'s.

use rusqlite::{Connection, params};
use serde::Serialize;
use ts_rs::TS;

use crate::RECEIVED;
use crate::bank::get_batch;
use crate::types::{BatchStatus, Method, PayingInBatchRow, RecentGift, Status};

/// What a batch's paid-in total (`giftsTotal`: every gift on the slip
/// that isn't void, as the bank credited it) is made of: what has been
/// received ([`RECEIVED`]), and the cheques still pending and bounced. A
/// bounced cheque stays on the slip: the bank credited it with the rest,
/// and its return is a debit of its own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "PayingInBatchFigures")]
pub struct BatchFigures {
    #[ts(type = "number")]
    pub received_total: i64,
    #[ts(type = "number")]
    pub pending_count: i64,
    #[ts(type = "number")]
    pub pending_total: i64,
    #[ts(type = "number")]
    pub bounced_count: i64,
    #[ts(type = "number")]
    pub bounced_total: i64,
}

pub fn batch_figures(conn: &Connection, batch_id: &str) -> rusqlite::Result<BatchFigures> {
    let received_total = conn
        .prepare_cached(&format!(
            "SELECT coalesce(sum(amount), 0) FROM gifts
             WHERE paying_in_batch_id = ?1 AND {RECEIVED}"
        ))?
        .query_row([batch_id], |r| r.get(0))?;
    let mut by_status = conn.prepare_cached(
        "SELECT count(*), coalesce(sum(amount), 0) FROM gifts
         WHERE paying_in_batch_id = ?1 AND method = 'cheque' AND status = ?2
         /* any status: the batch's cheques in one status */",
    )?;
    let (pending_count, pending_total) =
        by_status.query_row(params![batch_id, Status::Pending.as_str()], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    let (bounced_count, bounced_total) =
        by_status.query_row(params![batch_id, Status::Failed.as_str()], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    Ok(BatchFigures {
        received_total,
        pending_count,
        pending_total,
        bounced_count,
        bounced_total,
    })
}

/// Most batches a list shows: every open one, then the newest closed.
pub const BATCH_LIST_LIMIT: i64 = 200;
/// Most gifts a batch's page lists (one paying-in slip).
pub const BATCH_GIFTS_LIMIT: i64 = 500;

/// Batches, open ones first, each newest first; with `status`, only
/// those.
pub fn batches(
    conn: &Connection,
    status: Option<BatchStatus>,
) -> rusqlite::Result<Vec<PayingInBatchRow>> {
    let ids: Vec<String> = conn
        .prepare_cached(
            "SELECT id FROM paying_in_batches WHERE ?1 IS NULL OR status = ?1
             ORDER BY status = 'closed', seq DESC LIMIT ?2",
        )?
        .query_map(
            params![status.map(BatchStatus::as_str), BATCH_LIST_LIMIT],
            |r| r.get(0),
        )?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.extend(get_batch(conn, &id)?);
    }
    Ok(out)
}

/// The gifts recorded into a batch, in entry order, each marked with its
/// status (a pending cheque, a bounced one, a void).
pub fn gifts_in_batch(conn: &Connection, batch_id: &str) -> rusqlite::Result<Vec<RecentGift>> {
    let rows: Vec<RecentGift> = conn
        .prepare_cached(
            "SELECT id, entered_at, contact_id, amount, received_on, method, status
             FROM gifts WHERE paying_in_batch_id = ?1 ORDER BY seq LIMIT ?2
             /* any status: the list marks each */",
        )?
        .query_map(params![batch_id, BATCH_GIFTS_LIMIT], |r| {
            Ok(RecentGift {
                id: r.get(0)?,
                entered_at: r.get(1)?,
                contact_id: r.get(2)?,
                contact_name: String::new(),
                amount: r.get(3)?,
                received_on: r.get(4)?,
                method: Method::parse(&r.get::<_, String>(5)?),
                status: Status::parse(&r.get::<_, String>(6)?),
                // Cash and cheques only: never a transfer.
                not_on_a_statement: false,
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
