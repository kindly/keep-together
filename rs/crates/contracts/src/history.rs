//! An entity's history as moments, a page at a time (Convex
//! `contacts/history.ts`): revisions sharing a command group collapse into
//! one moment listing the slices it touched. Entity-generic: a contact's
//! panel and a gift's read the same pages; each module says how its
//! contracts read to staff ([`SliceLabel`]).

use rusqlite::{Connection, params};
use serde::Serialize;
use ts_rs::TS;

use crate::{ContractError, Source, source_from_db};

/// The most revisions one page reads.
pub const MOMENTS_PAGE_LIMIT: usize = 50;

/// One entry of the history panel.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Moment {
    /// The command group (`g<id>`), or the revision when it had none
    /// (`r<id>`).
    pub key: String,
    /// The moment's newest revision.
    #[ts(type = "number")]
    pub revision_id: i64,
    /// ms since the epoch, of the newest revision: "Restore to here".
    #[ts(type = "number")]
    pub at: i64,
    #[ts(type = "number | null")]
    pub actor: Option<i64>,
    pub source: Source,
    pub group_name: Option<String>,
    /// The slices it touched, as staff read them, newest first.
    pub slices: Vec<String>,
    pub restored: bool,
    /// Every revision in it is of a retired contract: history only, so
    /// the panel offers no restore to it.
    pub retired: bool,
}

/// `GET …/history?before&limit`: newest first.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MomentPage {
    pub moments: Vec<Moment>,
    /// Pass as `before` for the next older page; null at the start. A
    /// group cut by the boundary ends this page and starts the next: the
    /// client joins the halves (same `key`, adjacent).
    #[ts(type = "number | null")]
    pub next_before: Option<i64>,
}

/// How a module names a contract's slice, and whether it is retired
/// (its revisions stay as history, read-only).
pub trait SliceLabel {
    fn label(&self, contract: &str) -> String;
    fn retired(&self, contract: &str) -> bool;
}

/// One page of `entity_id`'s moments: up to `limit` revisions (capped at
/// [`MOMENTS_PAGE_LIMIT`]) older than revision `before`, newest first.
pub fn page(
    conn: &Connection,
    entity: &str,
    entity_id: &str,
    before: Option<i64>,
    limit: usize,
    labels: &dyn SliceLabel,
) -> Result<MomentPage, ContractError> {
    let limit = limit.clamp(1, MOMENTS_PAGE_LIMIT);
    let mut stmt = conn.prepare_cached(
        "SELECT id, contract, actor, source, group_id, group_name, restored_from, at
         FROM revisions WHERE entity = ?1 AND entity_id = ?2 AND id < ?3
         ORDER BY id DESC LIMIT ?4",
    )?;
    let rows = stmt
        .query_map(
            params![
                entity,
                entity_id,
                before.unwrap_or(i64::MAX),
                limit as i64 + 1
            ],
            |r| {
                Ok(Row {
                    id: r.get(0)?,
                    contract: r.get(1)?,
                    actor: r.get(2)?,
                    source: source_from_db(&r.get::<_, String>(3)?),
                    group: r.get(4)?,
                    group_name: r.get(5)?,
                    restored: r.get::<_, Option<i64>>(6)?.is_some(),
                    at: r.get(7)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > limit;
    let rows = &rows[..rows.len().min(limit)];
    Ok(MomentPage {
        moments: to_moments(rows, labels),
        next_before: more.then(|| rows.last().map(|r| r.id)).flatten(),
    })
}

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

fn to_moments(rows: &[Row], labels: &dyn SliceLabel) -> Vec<Moment> {
    let mut moments: Vec<Moment> = Vec::new();
    for r in rows {
        let key = match r.group {
            Some(g) => format!("g{g}"),
            None => format!("r{}", r.id),
        };
        let slice = labels.label(&r.contract);
        let retired = labels.retired(&r.contract);
        if let Some(m) = moments.iter_mut().find(|m| m.key == key) {
            if !m.slices.contains(&slice) {
                m.slices.push(slice);
            }
            m.retired &= retired;
            continue;
        }
        moments.push(Moment {
            key,
            revision_id: r.id,
            at: r.at,
            actor: r.actor,
            source: r.source,
            group_name: r.group.and(r.group_name.clone()),
            slices: vec![slice],
            restored: r.restored,
            retired,
        });
    }
    moments
}

/// Pages of moments, newest first, as one list: a group cut by a page
/// boundary ends one page and starts the next, so the two halves join.
pub fn join_moments(moments: impl IntoIterator<Item = Moment>) -> Vec<Moment> {
    let mut out: Vec<Moment> = Vec::new();
    for m in moments {
        match out.last_mut() {
            Some(last) if last.key == m.key => {
                for s in m.slices {
                    if !last.slices.contains(&s) {
                        last.slices.push(s);
                    }
                }
                last.retired &= m.retired;
            }
            _ => out.push(m),
        }
    }
    out
}
