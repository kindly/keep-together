//! History and restore: revisions are re-executed as new commands, through
//! the upcaster chain. Nothing is rewound.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::{
    CommandGroup, ContractError, Ctx, Exec, Executed, Registry, Source, Target, command_group,
    source_from_db, upcast,
};

/// One executed command, as history shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Revision {
    #[ts(type = "number")]
    pub id: i64,
    pub contract: String,
    pub version: u32,
    #[ts(type = "number")]
    pub counter: i64,
    /// The prepared payload at `version` (not upcast).
    #[ts(type = "unknown")]
    pub payload: Value,
    #[ts(type = "number | null")]
    pub actor: Option<i64>,
    pub source: Source,
    #[ts(type = "number | null")]
    pub group: Option<i64>,
    pub group_name: Option<String>,
    #[ts(type = "number | null")]
    pub restored_from: Option<i64>,
    /// ms since the epoch.
    #[ts(type = "number")]
    pub at: i64,
}

const REVISION_COLUMNS: &str = "id, entity_id, contract, version, counter, payload, actor, \
     source, group_id, group_name, restored_from, at";

struct Row {
    entity_id: String,
    revision: Revision,
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    let payload: String = r.get(5)?;
    Ok(Row {
        entity_id: r.get(1)?,
        revision: Revision {
            id: r.get(0)?,
            contract: r.get(2)?,
            version: r.get(3)?,
            counter: r.get(4)?,
            payload: serde_json::from_str(&payload).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, e.into())
            })?,
            actor: r.get(6)?,
            source: source_from_db(&r.get::<_, String>(7)?),
            group: r.get(8)?,
            group_name: r.get(9)?,
            restored_from: r.get(10)?,
            at: r.get(11)?,
        },
    })
}

/// An entity's revisions, newest first.
pub fn history(
    conn: &Connection,
    entity: &str,
    entity_id: &str,
    limit: usize,
) -> Result<Vec<Revision>, ContractError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {REVISION_COLUMNS} FROM revisions WHERE entity = ?1 AND entity_id = ?2
         ORDER BY id DESC LIMIT ?3"
    ))?;
    let rows = stmt.query_map(params![entity, entity_id, limit as i64], row)?;
    Ok(rows
        .map(|r| r.map(|r| r.revision))
        .collect::<rusqlite::Result<_>>()?)
}

fn revision(conn: &Connection, id: i64) -> Result<Option<Row>, ContractError> {
    Ok(conn
        .query_row(
            &format!("SELECT {REVISION_COLUMNS} FROM revisions WHERE id = ?1"),
            [id],
            row,
        )
        .optional()?)
}

/// Re-execute a stored revision as a new command. The revision's declared
/// version decides migration, never the payload's shape.
pub fn restore(
    ctx: &Ctx,
    registry: &Registry,
    revision_id: i64,
    group: Option<&CommandGroup>,
) -> Result<Executed, ContractError> {
    let Row {
        entity_id,
        revision,
    } = self::revision(ctx.tx, revision_id)?.ok_or(ContractError::NotFound)?;
    let contract = registry
        .get(&revision.contract)
        .ok_or_else(|| ContractError::UnknownContract(revision.contract.clone()))?;
    let payload = upcast(contract, revision.payload, revision.version)?;
    contract.execute_value(
        ctx,
        payload,
        Exec {
            target: Target::Update(&entity_id),
            expected: None,
            source: Source::Restore,
            group,
            restored_from: Some(revision.id),
        },
    )
}

/// Order-independent view of a payload for change detection: object keys
/// sorted, nulls dropped, lists of objects with an `id` sorted by id.
pub fn canonical(payload: &Value) -> String {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Array(items) => {
                let mut items: Vec<Value> = items.iter().map(sort).collect();
                if !items.is_empty() && items.iter().all(|i| i.get("id").is_some()) {
                    items.sort_by_key(|i| i["id"].to_string());
                }
                Value::Array(items)
            }
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    if !map[k].is_null() {
                        out.insert(k.clone(), sort(&map[k]));
                    }
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    // serde_json's map keeps insertion order only with `preserve_order`;
    // sorting by hand makes the output the same either way.
    serde_json::to_string(&sort(payload)).unwrap_or_default()
}

/// Restore a whole aggregate to its state at `at` (ms). Contracts are
/// full-state, so no replay: re-execute the latest revision of each
/// contract at or before `at`, skipping slices already in that state and
/// any `exclude`d contract, in one named command group. Returns the
/// contracts restored (in the order they ran).
pub fn restore_entity_to(
    ctx: &Ctx,
    registry: &Registry,
    entity: &str,
    entity_id: &str,
    at: i64,
    exclude: &[&str],
    label: Option<&str>,
) -> Result<Vec<String>, ContractError> {
    let exclude: HashSet<&str> = exclude.iter().copied().collect();
    let latest: Vec<(String, i64)> = {
        let mut stmt = ctx.tx.prepare(
            "SELECT contract, max(id) FROM revisions WHERE entity = ?1 AND entity_id = ?2
             GROUP BY contract",
        )?;
        stmt.query_map(params![entity, entity_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    // Compared at the code's version: a v1 and a v2 payload of the same
    // state are the same state.
    let state = |r: &Revision| -> String {
        match registry.get(&r.contract) {
            Some(c) if r.version <= c.version() => upcast(c, r.payload.clone(), r.version)
                .map(|p| canonical(&p))
                .unwrap_or_else(|_| canonical(&r.payload)),
            _ => canonical(&r.payload),
        }
    };

    let mut to_restore = Vec::new();
    for (contract, latest_id) in latest {
        if exclude.contains(contract.as_str()) {
            continue;
        }
        let target: Option<i64> = ctx
            .tx
            .query_row(
                "SELECT max(id) FROM revisions
                 WHERE entity = ?1 AND entity_id = ?2 AND contract = ?3 AND at <= ?4",
                params![entity, entity_id, contract, at],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(target) = target else { continue };
        if target == latest_id {
            continue;
        }
        let (Some(t), Some(l)) = (revision(ctx.tx, target)?, revision(ctx.tx, latest_id)?) else {
            continue;
        };
        if state(&t.revision) != state(&l.revision) {
            to_restore.push(t.revision);
        }
    }
    if to_restore.is_empty() {
        return Ok(vec![]);
    }
    to_restore.sort_by_key(|r| r.id);
    let label = label
        .map(str::to_owned)
        .unwrap_or_else(|| format!("restore to {at}"));
    let group = command_group(ctx, &label)?;
    let mut restored = Vec::new();
    for r in to_restore {
        restore(ctx, registry, r.id, Some(&group))?;
        restored.push(r.contract);
    }
    Ok(restored)
}
