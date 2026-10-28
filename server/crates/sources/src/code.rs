//! Source codes (plan: factory/plans/source-codes.sv). One `source_codes`
//! row per part: a category, a detail under it, a version under that. A
//! version's id IS the source code: contacts and gifts store that id, and
//! everything else is derived from it here.
//!
//! The full code (`Street-Wesser-001`) is never stored: a rename at any
//! time would otherwise rewrite every row under the part. [`describe`]
//! joins it in one query; the tree and the picker resolve every code in
//! one pass over the organisation's rows (at most SOURCE_CODE_LIMIT).
//!
//! Other modules use [`describe`] and [`mark_used`], never the table.

use std::collections::HashMap;

use contracts::{Command, Contract, ContractError, OrgTx, WriteTx};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::rules::{
    Dates, Level, SOURCE_CODE_LIMIT, child_level, code_matches, date_status, effective_dates,
    join_code, normalise_name, picker_order, prepare_source_code,
};
use crate::types::{CodeDescription, FilterOption, Part, Picker, PickerEntry, SourceCodePayload};

/// A part of a source code: name, description, dates, archived or not.
/// Create takes the parent (`parentId`), which fixes the level for good.
/// Names are unique among siblings case-insensitively and carry no
/// hyphen, so a full code is unique per organisation. Only details and
/// versions have dates. `used` is system-owned ([`mark_used`]): created
/// false and never touched here, so every save and restore preserves it.
///
/// Creating a detail also creates its first version: that is
/// [`crate::create_part`]'s command group, not this contract, which
/// writes only its own row.
pub struct SourceCode;
pub static CODE: SourceCode = SourceCode;

pub const TABLE: &str = "source_codes";

/// The parent and level a part has, or would have under `parent_id`.
fn level_under(conn: &Connection, parent_id: Option<&str>) -> Result<Level, ContractError> {
    let parent = match parent_id {
        None => None,
        Some(id) => Some(part_level(conn, id)?.ok_or_else(|| {
            ContractError::rejected("unknown_parent", "The parent code must exist")
        })?),
    };
    child_level(parent)
        .ok_or_else(|| ContractError::rejected("too_deep", "A version has no parts under it"))
}

fn part_level(conn: &Connection, id: &str) -> rusqlite::Result<Option<Level>> {
    conn.prepare_cached("SELECT level FROM source_codes WHERE id = ?1")?
        .query_row([id], |r| r.get::<_, String>(0))
        .optional()
        .map(|l| l.and_then(|l| Level::parse(&l)))
}

pub(crate) fn load_part(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<SourceCodePayload>> {
    conn.prepare_cached(
        "SELECT parent_id, name, description, start_date, end_date, is_active
         FROM source_codes WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(SourceCodePayload {
            parent_id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            start_date: r.get(3)?,
            end_date: r.get(4)?,
            is_active: r.get(5)?,
        })
    })
    .optional()
}

impl Contract for SourceCode {
    const NAME: &'static str = "sources.code";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "save_version";
    type Payload = SourceCodePayload;
    type State = SourceCodePayload;

    fn prepare(&self, payload: SourceCodePayload) -> Result<SourceCodePayload, ContractError> {
        prepare_source_code(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<SourceCodePayload, ContractError> {
        load_part(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&SourceCodePayload>,
        p: &SourceCodePayload,
        _: &Command,
    ) -> Result<SourceCodePayload, ContractError> {
        let Some(current) = current else {
            return Ok(p.clone());
        };
        if p.parent_id.is_some() && p.parent_id != current.parent_id {
            return Err(ContractError::rejected(
                "parent_fixed",
                "A part stays under its parent for good",
            ));
        }
        Ok(SourceCodePayload {
            parent_id: current.parent_id.clone(),
            ..p.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&SourceCodePayload>,
        next: &SourceCodePayload,
    ) -> Result<(), ContractError> {
        let level = match before {
            Some(_) => part_level(tx, id)?.ok_or(ContractError::NotFound)?,
            None => level_under(tx, next.parent_id.as_deref())?,
        };
        if level == Level::Category && (next.start_date.is_some() || next.end_date.is_some()) {
            return Err(ContractError::invalid(
                "startDate",
                "Only details and versions have dates",
            ));
        }
        let normalized = normalise_name(&next.name);
        let clash: Option<String> = tx
            .prepare_cached(
                "SELECT name FROM source_codes
                 WHERE parent_id IS ?1 AND name_normalized = ?2 AND id != ?3",
            )?
            .query_row(params![next.parent_id, normalized, id], |r| r.get(0))
            .optional()?;
        if let Some(name) = clash {
            return Err(ContractError::rejected(
                "duplicate_source_name",
                format!("{name} already exists here"),
            ));
        }
        if before.is_some() {
            // `used` and the parent are not this slice's: never touched.
            tx.prepare_cached(
                "UPDATE source_codes SET name = ?2, name_normalized = ?3, description = ?4,
                     start_date = ?5, end_date = ?6, is_active = ?7
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                next.name,
                normalized,
                next.description,
                next.start_date,
                next.end_date,
                next.is_active
            ])?;
            return Ok(());
        }
        let held: i64 = tx.query_row("SELECT count(*) FROM source_codes", [], |r| r.get(0))?;
        if held >= SOURCE_CODE_LIMIT {
            return Err(ContractError::rejected(
                "source_code_limit",
                format!(
                    "An organisation can have at most {SOURCE_CODE_LIMIT} source code parts, archived ones included"
                ),
            ));
        }
        tx.prepare_cached(
            "INSERT INTO source_codes (id, parent_id, level, name, name_normalized, description,
                 start_date, end_date, is_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?
        .execute(params![
            id,
            next.parent_id,
            level.as_str(),
            next.name,
            normalized,
            next.description,
            next.start_date,
            next.end_date,
            next.is_active
        ])?;
        Ok(())
    }
}

// ── delete ─────────────────────────────────────────────────────────────────

/// Deleting a part that has never been used, with everything under it.
/// A `used` marker anywhere below is also on this part ([`mark_used`]
/// marks both parents), so an unmarked part has only unmarked parts under
/// it; the check covers them anyway. Once used, a part can only be
/// archived: history still names it.
///
/// There is no root left to carry a counter, so the deletion is its own
/// entity: one `source_code_deletions` row per deleted part (keyed by the
/// part's id, holding how many rows went), created through this contract.
/// That keeps the one write path, and gives the delete a revision (who,
/// when) and an event, so open trees refetch. Its `expected` is the
/// part's `sources.code` counter; a mismatch is that contract's stale.
/// The parts' own revisions stay as history. Not restorable.
pub struct SourceCodeDeletion;
pub static DELETION: SourceCodeDeletion = SourceCodeDeletion;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionPayload {
    pub expected: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeletionState {
    expected: i64,
}

impl Contract for SourceCodeDeletion {
    const NAME: &'static str = "sources.delete";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "source_code_deletions";
    const COUNTER: &'static str = "delete_version";
    type Payload = DeletionPayload;
    type State = DeletionState;

    fn load(&self, _: &OrgTx, _: &str) -> Result<DeletionState, ContractError> {
        Ok(DeletionState { expected: -1 })
    }

    fn apply(
        &self,
        current: Option<&DeletionState>,
        p: &DeletionPayload,
        _: &Command,
    ) -> Result<DeletionState, ContractError> {
        if current.is_some() {
            return Err(ContractError::rejected(
                "not_restorable",
                "A deleted source code can't be brought back",
            ));
        }
        Ok(DeletionState {
            expected: p.expected,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&DeletionState>,
        next: &DeletionState,
    ) -> Result<(), ContractError> {
        let counter: i64 = tx
            .query_row(
                "SELECT save_version FROM source_codes WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(ContractError::NotFound)?;
        if counter != next.expected {
            return Err(ContractError::Stale {
                contract: SourceCode::NAME,
                counter,
                current: serde_json::to_value(load_part(tx, id)?)?,
            });
        }
        // At most two levels below: a category's details, then their
        // versions. Children first, for the parent references.
        let doomed: Vec<(String, bool)> = tx
            .prepare_cached(
                "WITH RECURSIVE under (id, depth) AS (
                     SELECT ?1, 0
                     UNION ALL
                     SELECT s.id, u.depth + 1 FROM source_codes s JOIN under u ON s.parent_id = u.id
                 )
                 SELECT s.id, s.used FROM under u JOIN source_codes s ON s.id = u.id
                 ORDER BY u.depth DESC",
            )?
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        if doomed.iter().any(|(_, used)| *used) {
            return Err(ContractError::rejected(
                "used",
                "This code has been used, so it can only be archived",
            ));
        }
        let mut delete = tx.prepare_cached("DELETE FROM source_codes WHERE id = ?1")?;
        for (part, _) in &doomed {
            delete.execute([part])?;
        }
        tx.execute(
            "INSERT INTO source_code_deletions (id, deleted) VALUES (?1, ?2)",
            params![id, doomed.len() as i64],
        )?;
        Ok(())
    }
}

/// How many parts a deletion took.
pub fn deleted_count(conn: &Connection, id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT deleted FROM source_code_deletions WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
}

// ── one code, by its version id ────────────────────────────────────────────

/// The code a version id stands for, read now (renames show everywhere at
/// once). `None` for a missing id or a part that isn't a version. One
/// query: the version and its two parents.
pub fn describe(conn: &Connection, version_id: &str) -> rusqlite::Result<Option<CodeDescription>> {
    conn.prepare_cached(
        "SELECT v.name, v.is_active, v.start_date, v.end_date,
                d.id, d.name, d.is_active, d.start_date, d.end_date,
                c.id, c.name, c.is_active
         FROM source_codes v
         JOIN source_codes d ON d.id = v.parent_id
         JOIN source_codes c ON c.id = d.parent_id
         WHERE v.id = ?1 AND v.level = 'version'",
    )?
    .query_row([version_id], |r| {
        let version_name: String = r.get(0)?;
        let detail_name: String = r.get(5)?;
        let category_name: String = r.get(10)?;
        let dates = effective_dates(
            &Dates {
                start_date: r.get(2)?,
                end_date: r.get(3)?,
            },
            &Dates {
                start_date: r.get(7)?,
                end_date: r.get(8)?,
            },
        );
        Ok(CodeDescription {
            code: join_code(&[&category_name, &detail_name, &version_name]),
            version_id: version_id.to_owned(),
            detail_id: r.get(4)?,
            category_id: r.get(9)?,
            is_active: r.get::<_, bool>(1)? && r.get::<_, bool>(6)? && r.get::<_, bool>(11)?,
            version_name,
            detail_name,
            category_name,
            start_date: dates.start_date,
            end_date: dates.end_date,
        })
    })
    .optional()
}

/// Check a code can be assigned and set its `used` marker: on the
/// version, its detail and its category, each only if not yet set (after
/// the first use, a read-only check, so a popular code is no write hot
/// spot). Never cleared. Runs inside the assigning contract's `write`
/// (a contact's acquisition, a gift): system-owned, so no revision of its
/// own and no list-manager check (staff assigning a code needn't manage
/// the list). Idempotent.
///
/// `invalid` (field `sourceCode`) unless `version_id` is a version that
/// is not archived and not under an archived parent. Out of date is fine:
/// dates guide, never block. `allow_archived` is for restore, which may
/// put back a code archived since.
pub fn mark_used(
    tx: &WriteTx,
    version_id: &str,
    allow_archived: bool,
) -> Result<CodeDescription, ContractError> {
    let Some(code) = describe(tx, version_id)? else {
        return Err(ContractError::invalid(
            "sourceCode",
            "Pick a full source code (a version)",
        ));
    };
    if !allow_archived && !code.is_active {
        return Err(ContractError::invalid(
            "sourceCode",
            "That source code is archived",
        ));
    }
    tx.prepare_cached("UPDATE source_codes SET used = 1 WHERE id IN (?1, ?2, ?3) AND used = 0")?
        .execute(params![code.version_id, code.detail_id, code.category_id])?;
    Ok(code)
}

// ── every code, one pass ───────────────────────────────────────────────────

/// A part with its full code and visibility resolved.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub part: Part,
    /// Its category; its detail (itself, for those levels).
    pub category_id: String,
    pub detail_id: Option<String>,
}

/// The organisation's parts in tree order (each category by name, then
/// its details by name, each followed by its versions by name), with full
/// codes and visibility resolved. One read of at most SOURCE_CODE_LIMIT
/// rows.
pub fn resolve_all(conn: &Connection) -> rusqlite::Result<Vec<Resolved>> {
    let rows: Vec<(Part, String)> = conn
        .prepare_cached(
            "SELECT id, level, parent_id, name, description, start_date, end_date, is_active,
                    used, save_version, name_normalized
             FROM source_codes LIMIT ?1",
        )?
        .query_map([SOURCE_CODE_LIMIT], |r| {
            Ok((
                Part {
                    id: r.get(0)?,
                    level: Level::parse(&r.get::<_, String>(1)?).unwrap_or(Level::Version),
                    parent_id: r.get(2)?,
                    name: r.get(3)?,
                    code: String::new(),
                    description: r.get(4)?,
                    start_date: r.get(5)?,
                    end_date: r.get(6)?,
                    is_active: r.get(7)?,
                    visible: false,
                    used: r.get(8)?,
                    save_version: r.get(9)?,
                },
                r.get(10)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut children: HashMap<Option<String>, Vec<(Part, String)>> = HashMap::new();
    for (part, key) in rows {
        children
            .entry(part.parent_id.clone())
            .or_default()
            .push((part, key));
    }
    for list in children.values_mut() {
        list.sort_by(|a, b| a.1.cmp(&b.1));
    }
    struct Above<'a> {
        names: Vec<&'a str>,
        visible: bool,
        ids: Vec<&'a str>,
    }
    fn walk<'a>(
        children: &'a HashMap<Option<String>, Vec<(Part, String)>>,
        parent: Option<&'a str>,
        above: &Above<'a>,
        out: &mut Vec<Resolved>,
    ) {
        for (row, _) in children
            .get(&parent.map(str::to_owned))
            .into_iter()
            .flatten()
        {
            let mut names = above.names.clone();
            names.push(&row.name);
            let mut ids = above.ids.clone();
            ids.push(&row.id);
            let visible = above.visible && row.is_active;
            out.push(Resolved {
                part: Part {
                    code: join_code(&names),
                    visible,
                    ..row.clone()
                },
                category_id: ids[0].to_owned(),
                detail_id: ids.get(1).map(|s| (*s).to_owned()),
            });
            walk(
                children,
                Some(&row.id),
                &Above {
                    names,
                    visible,
                    ids,
                },
                out,
            );
        }
    }
    let mut out = Vec::new();
    walk(
        &children,
        None,
        &Above {
            names: vec![],
            visible: true,
            ids: vec![],
        },
        &mut out,
    );
    Ok(out)
}

/// Every part in tree order, archived ones included, for the Settings
/// tab: its full code, whether it shows in the picker, `used` (delete or
/// only archive) and the counter a save needs.
pub fn tree(conn: &Connection) -> rusqlite::Result<Vec<Part>> {
    Ok(resolve_all(conn)?.into_iter().map(|r| r.part).collect())
}

/// Every part in tree order with only what the contacts list's source
/// filter shows. Archived parts are included (contacts keep codes
/// archived since).
pub fn filter_options(conn: &Connection) -> rusqlite::Result<Vec<FilterOption>> {
    Ok(resolve_all(conn)?
        .into_iter()
        .map(|r| FilterOption {
            id: r.part.id,
            level: r.part.level,
            parent_id: r.part.parent_id,
            name: r.part.name,
            is_active: r.part.is_active,
        })
        .collect())
}

/// The most codes one picker call returns.
pub const PICKER_LIMIT: usize = 50;

/// The assignable codes: visible versions, with their date status on
/// `today`.
pub fn picker_entries(parts: &[Resolved], today: &str) -> Vec<PickerEntry> {
    let by_id: HashMap<&str, &Part> = parts
        .iter()
        .map(|p| (p.part.id.as_str(), &p.part))
        .collect();
    parts
        .iter()
        .filter(|p| p.part.level == Level::Version && p.part.visible)
        .filter_map(|p| {
            let detail = by_id.get(p.part.parent_id.as_deref()?)?;
            let dates = effective_dates(
                &Dates {
                    start_date: p.part.start_date.clone(),
                    end_date: p.part.end_date.clone(),
                },
                &Dates {
                    start_date: detail.start_date.clone(),
                    end_date: detail.end_date.clone(),
                },
            );
            Some(PickerEntry {
                version_id: p.part.id.clone(),
                code: p.part.code.clone(),
                description: p.part.description.clone().or(detail.description.clone()),
                status: date_status(&dates, today),
                start_date: dates.start_date,
                end_date: dates.end_date,
            })
        })
        .collect()
}

/// Assignable codes matching `search` anywhere in the full code, any
/// case: versions only, none archived or under an archived parent. In
/// date first, then not started, then ended (dates guide, never block),
/// by code within each. `today` is the caller's date.
pub fn picker(conn: &Connection, today: &str, search: &str) -> rusqlite::Result<Picker> {
    Ok(picker_result(&resolve_all(conn)?, today, search))
}

/// [`picker`]'s answer from the resolved parts: no reads of its own.
pub fn picker_result(parts: &[Resolved], today: &str, search: &str) -> Picker {
    let mut matches: Vec<PickerEntry> = picker_entries(parts, today)
        .into_iter()
        .filter(|e| code_matches(&e.code, search))
        .collect();
    matches.sort_by(|a, b| picker_order((a.status, &a.code), (b.status, &b.code)));
    let truncated = matches.len() > PICKER_LIMIT;
    matches.truncate(PICKER_LIMIT);
    Picker {
        codes: matches,
        truncated,
    }
}
