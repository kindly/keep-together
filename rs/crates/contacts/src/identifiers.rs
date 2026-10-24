//! External identifiers (Convex `contacts.identifiers` and
//! `contacts.identifierType`): a contact's ids in other systems, each of an
//! identifier type the organisation defines.
//!
//!   contacts.identifiers    → the contact's rows (identifiers_version)
//!   contacts.identifierType → name, isActive (save_version)
//!
//! A row's type and value are its identity, immutable per key. A (type,
//! value) pair belongs to at most one contact (a unique index backs the
//! contract's check). Types are never deleted: archive = `isActive: false`,
//! out of the picker, its rows kept and still found.

use std::collections::{HashMap, HashSet};

use contracts::{
    ChildRow, Command, Contract, ContractError, OrgTx, Problem, ProjectionTx, WriteTx,
    is_client_id, mint_ids, reconcile,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::projection::{SEARCH_TABLE, rebuild_search};
use crate::slices::{check_ownership, no_root, position_of, remove_rows, set_positions};
use crate::types::FormProblem;

/// The most identifier types an organisation holds, archived ones included
/// (never deleted), so a list of them never truncates.
pub const IDENTIFIER_TYPE_LIMIT: i64 = 200;

/// The most identifier rows one list search reads (any type, one value).
pub const IDENTIFIER_LOOKUP_LIMIT: usize = 50;

// ── wire types ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentifierRow {
    /// Omitted = a new row; the contract mints it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    /// Identity: immutable per key.
    pub type_id: String,
    /// Identity: immutable per key. Trimmed; shown as typed.
    pub value: String,
}

/// `contacts.identifiers`: the contact's rows, in the order entered.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ContactIdentifiers")]
pub struct Identifiers {
    pub identifiers: Vec<IdentifierRow>,
}

/// A row as the contact view shows it: with its type's name, and whether
/// that type is still active ('?' and false when it can't be found).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentifierView {
    pub key: String,
    pub type_id: String,
    pub value: String,
    pub type_name: String,
    pub type_active: bool,
}

/// `contacts.identifierType`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentifierTypePayload {
    pub name: String,
    pub is_active: bool,
}

/// `GET identifier-types`: one type.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentifierType {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    #[ts(type = "number")]
    pub save_version: i64,
}

/// `POST identifier-types`: create (no `id`) or rename / archive /
/// reactivate one (`id` + `expected`).
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SaveIdentifierType {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected: Option<i64>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: IdentifierTypePayload,
}

// ── rules (pure) ───────────────────────────────────────────────────────────

/// The matching form of an identifier value: trimmed, case-insensitive
/// (`m123` and `M123` are the same id).
pub fn normalise_identifier(value: &str) -> String {
    value.trim().to_lowercase()
}

/// The uniqueness form of an identifier type's name (already tidied).
pub fn normalise_list_name(name: &str) -> String {
    name.to_lowercase()
}

/// Trimmed, inner whitespace runs collapsed.
fn tidy_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Keyed rows (keys minted), values trimmed and never blank, a (type,
/// value) pair at most once. Several values of one type are fine.
pub fn prepare_identifiers(mut p: Identifiers) -> Result<Identifiers, ContractError> {
    if p.identifiers.len() > crate::rules::MAX_CHILD_ROWS {
        return Err(ContractError::invalid(
            "identifiers",
            format!("At most {} entries", crate::rules::MAX_CHILD_ROWS),
        ));
    }
    for r in &mut p.identifiers {
        let t = r.value.trim();
        if t.len() != r.value.len() {
            r.value = t.to_owned();
        }
    }
    mint_ids(&mut p.identifiers, |r| &mut r.key);
    let mut keys = HashSet::new();
    let mut pairs = HashSet::new();
    for r in &p.identifiers {
        let key = r.key.as_deref().unwrap_or("");
        if !is_client_id(key) {
            return Err(ContractError::invalid(
                "identifiers",
                "Row keys are 32 lower-case hex characters",
            ));
        }
        if !keys.insert(key) {
            return Err(ContractError::invalid("identifiers", "Duplicate row key"));
        }
        if r.value.is_empty() {
            return Err(ContractError::invalid(
                "identifiers",
                "An identifier needs a value",
            ));
        }
        if !pairs.insert((r.type_id.as_str(), normalise_identifier(&r.value))) {
            return Err(ContractError::invalid(
                "identifiers",
                "Duplicate identifier",
            ));
        }
    }
    Ok(p)
}

pub fn prepare_identifier_type(
    mut p: IdentifierTypePayload,
) -> Result<IdentifierTypePayload, ContractError> {
    p.name = tidy_name(&p.name);
    if p.name.is_empty() {
        return Err(ContractError::Invalid(vec![Problem::new(
            "name",
            "An identifier type needs a name",
        )]));
    }
    Ok(p)
}

// ── reads ──────────────────────────────────────────────────────────────────

pub(crate) fn load_identifiers(conn: &Connection, id: &str) -> rusqlite::Result<Identifiers> {
    let identifiers = conn
        .prepare_cached(
            "SELECT id, type_id, value FROM contact_identifiers
             WHERE contact_id = ?1 ORDER BY position",
        )?
        .query_map([id], |r| {
            Ok(IdentifierRow {
                key: Some(r.get(0)?),
                type_id: r.get(1)?,
                value: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Identifiers { identifiers })
}

/// The contact's rows named by their types, in the order entered.
pub(crate) fn identifier_views(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Vec<IdentifierView>> {
    conn.prepare_cached(
        "SELECT i.id, i.type_id, i.value, t.name, t.is_active
         FROM contact_identifiers i LEFT JOIN identifier_types t ON t.id = i.type_id
         WHERE i.contact_id = ?1 ORDER BY i.position",
    )?
    .query_map([id], |r| {
        Ok(IdentifierView {
            key: r.get(0)?,
            type_id: r.get(1)?,
            value: r.get(2)?,
            type_name: r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "?".into()),
            type_active: r.get::<_, Option<bool>>(4)?.unwrap_or(false),
        })
    })?
    .collect()
}

/// The organisation's identifier types, alphabetical; archived ones only
/// when asked (the settings page). Never truncated: the contract caps them.
pub fn identifier_types(
    conn: &Connection,
    include_inactive: bool,
) -> rusqlite::Result<Vec<IdentifierType>> {
    conn.prepare_cached(
        "SELECT id, name, is_active, save_version FROM identifier_types
         WHERE ?1 OR is_active ORDER BY name_normalized",
    )?
    .query_map([include_inactive], |r| {
        Ok(IdentifierType {
            id: r.get(0)?,
            name: r.get(1)?,
            is_active: r.get(2)?,
            save_version: r.get(3)?,
        })
    })?
    .collect()
}

/// For imports: the contact holding this identifier (archived contacts and
/// types included), or None. Trimmed and case-insensitive.
pub fn find_by_identifier(
    conn: &Connection,
    type_id: &str,
    value: &str,
) -> rusqlite::Result<Option<String>> {
    let normalized = normalise_identifier(value);
    if normalized.is_empty() {
        return Ok(None);
    }
    conn.prepare_cached(
        "SELECT contact_id FROM contact_identifiers WHERE value_normalized = ?1 AND type_id = ?2",
    )?
    .query_row(params![normalized, type_id], |r| r.get(0))
    .optional()
}

/// Contacts holding an identifier equal to `value`, of any type (the list
/// search's exact match), at most IDENTIFIER_LOOKUP_LIMIT rows read.
pub(crate) fn contacts_with_identifier(
    conn: &Connection,
    value: &str,
) -> rusqlite::Result<Vec<String>> {
    let normalized = normalise_identifier(value);
    if normalized.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = conn
        .prepare_cached(&format!(
            "SELECT contact_id FROM contact_identifiers WHERE value_normalized = ?1
             ORDER BY rowid LIMIT {IDENTIFIER_LOOKUP_LIMIT}"
        ))?
        .query_map([normalized], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut seen = HashSet::new();
    Ok(ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect())
}

/// Why a row new to the contact can't go on it: its type unknown or (on a
/// save) archived, or its pair held by another contact. `(key, reason,
/// message, holder)`, in row order.
struct Refusal {
    key: String,
    reason: &'static str,
    message: String,
    holder: Option<String>,
}

fn refusals(
    conn: &Connection,
    contact_id: &str,
    held: &[IdentifierRow],
    rows: &[IdentifierRow],
    restoring: bool,
) -> rusqlite::Result<Vec<Refusal>> {
    let kept: HashSet<&str> = held.iter().filter_map(|r| r.key.as_deref()).collect();
    let mut types: HashMap<&str, Option<bool>> = HashMap::new();
    let mut type_stmt =
        conn.prepare_cached("SELECT is_active FROM identifier_types WHERE id = ?1")?;
    let mut clash_stmt = conn.prepare_cached(
        "SELECT c.id, c.display_name FROM contact_identifiers i JOIN contacts c ON c.id = i.contact_id
         WHERE i.value_normalized = ?1 AND i.type_id = ?2 AND i.contact_id != ?3",
    )?;
    let mut out = Vec::new();
    for r in rows {
        let key = r.key.clone().unwrap_or_default();
        if kept.contains(key.as_str()) {
            continue;
        }
        let active = match types.get(r.type_id.as_str()) {
            Some(a) => *a,
            None => {
                let a = type_stmt
                    .query_row([&r.type_id], |row| row.get::<_, bool>(0))
                    .optional()?;
                types.insert(&r.type_id, a);
                a
            }
        };
        match active {
            None => {
                out.push(Refusal {
                    key,
                    reason: "unknown_identifier_type",
                    message: "Identifier type must exist and be active".into(),
                    holder: None,
                });
                continue;
            }
            Some(false) if !restoring => {
                out.push(Refusal {
                    key,
                    reason: "unknown_identifier_type",
                    message: "That type has been archived: choose another".into(),
                    holder: None,
                });
                continue;
            }
            _ => {}
        }
        let clash: Option<(String, String)> = clash_stmt
            .query_row(
                params![normalise_identifier(&r.value), r.type_id, contact_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((holder, name)) = clash {
            out.push(Refusal {
                key,
                reason: "duplicate_identifier",
                message: format!("{} is already used by {name}", r.value),
                holder: Some(holder),
            });
        }
    }
    Ok(out)
}

/// The form's pre-check (Convex `saveForm`): each row refused (a type
/// archived mid-edit, a pair another contact holds) as a problem on its
/// row, naming the holder, so the other slices still save.
pub fn identifier_problems(
    conn: &Connection,
    contact_id: &str,
    rows: &[IdentifierRow],
) -> rusqlite::Result<Vec<FormProblem>> {
    let held = load_identifiers(conn, contact_id)?;
    Ok(refusals(conn, contact_id, &held.identifiers, rows, false)?
        .into_iter()
        .map(|r| FormProblem {
            field: "identifiers".into(),
            message: r.message,
            key: Some(r.key),
            contact_id: r.holder,
        })
        .collect())
}

// ── contracts ──────────────────────────────────────────────────────────────

pub struct ContactIdentifiers;
pub struct ContactIdentifierType;
pub static IDENTIFIERS: ContactIdentifiers = ContactIdentifiers;
pub static IDENTIFIER_TYPE: ContactIdentifierType = ContactIdentifierType;

impl ChildRow for IdentifierRow {
    fn id(&self) -> &str {
        self.key.as_deref().unwrap_or("")
    }
    /// The value; the type is checked alongside (`write`).
    fn identity(&self) -> Option<&str> {
        Some(&self.value)
    }
}

/// `contacts.identifiers` as stored, plus whether a restore is running
/// (not serialised: a stale refusal's `current` is `{identifiers}`).
#[derive(Clone, Debug, Serialize)]
pub struct IdentifierState {
    pub identifiers: Vec<IdentifierRow>,
    #[serde(skip)]
    restoring: bool,
}

impl Contract for ContactIdentifiers {
    const NAME: &'static str = "contacts.identifiers";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contacts";
    const COUNTER: &'static str = "identifiers_version";
    const PROJECTIONS: &'static [&'static str] = &[SEARCH_TABLE];
    type Payload = Identifiers;
    type State = IdentifierState;

    fn prepare(&self, payload: Identifiers) -> Result<Identifiers, ContractError> {
        prepare_identifiers(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<IdentifierState, ContractError> {
        Ok(IdentifierState {
            identifiers: load_identifiers(tx.read(), id)?.identifiers,
            restoring: false,
        })
    }

    fn apply(
        &self,
        current: Option<&IdentifierState>,
        p: &Identifiers,
        command: &Command,
    ) -> Result<IdentifierState, ContractError> {
        current.ok_or_else(|| no_root(Self::NAME))?;
        Ok(IdentifierState {
            identifiers: p.identifiers.clone(),
            restoring: command.source == contracts::Source::Restore,
        })
    }

    /// Only active types can be newly added (a restore may re-add an
    /// archived one); a kept row keeps its type whatever happened to it.
    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&IdentifierState>,
        next: &IdentifierState,
    ) -> Result<(), ContractError> {
        let before = before.ok_or_else(|| no_root(Self::NAME))?;
        let rows = reconcile("identifiers", &before.identifiers, &next.identifiers)?;
        let types: HashMap<&str, &str> = before
            .identifiers
            .iter()
            .map(|r| (r.id(), r.type_id.as_str()))
            .collect();
        if let Some(r) = rows
            .changed
            .iter()
            .find(|r| types.get(r.id()).is_some_and(|t| *t != r.type_id))
        {
            return Err(ContractError::rejected(
                "identity_immutable",
                format!("identifiers {}: remove the row and add a new one", r.id()),
            ));
        }
        check_ownership(tx, "contact_identifiers", id, &rows.added)?;
        if let Some(r) = refusals(
            tx,
            id,
            &before.identifiers,
            &next.identifiers,
            next.restoring,
        )?
        .into_iter()
        .next()
        {
            return Err(ContractError::rejected(r.reason, r.message));
        }
        // Removed first: a pair removed and re-added under a new key in
        // one save must not meet itself in the unique index.
        remove_rows(tx, "contact_identifiers", &rows.removed)?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO contact_identifiers (id, contact_id, position, type_id, value, value_normalized)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for r in &rows.added {
            insert.execute(params![
                r.id(),
                id,
                position_of(&next.identifiers, r.id()),
                r.type_id,
                r.value,
                normalise_identifier(&r.value)
            ])?;
        }
        set_positions(tx, "contact_identifiers", &next.identifiers)?;
        Ok(())
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        Ok(rebuild_search(tx, id)?)
    }
}

impl Contract for ContactIdentifierType {
    const NAME: &'static str = "contacts.identifierType";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "identifier_types";
    const COUNTER: &'static str = "save_version";
    type Payload = IdentifierTypePayload;
    type State = IdentifierTypePayload;

    fn prepare(&self, p: IdentifierTypePayload) -> Result<IdentifierTypePayload, ContractError> {
        prepare_identifier_type(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<IdentifierTypePayload, ContractError> {
        Ok(tx.read().query_row(
            "SELECT name, is_active FROM identifier_types WHERE id = ?1",
            [id],
            |r| {
                Ok(IdentifierTypePayload {
                    name: r.get(0)?,
                    is_active: r.get(1)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        _: Option<&IdentifierTypePayload>,
        p: &IdentifierTypePayload,
        _: &Command,
    ) -> Result<IdentifierTypePayload, ContractError> {
        Ok(p.clone())
    }

    /// Names unique case-insensitively; at most IDENTIFIER_TYPE_LIMIT,
    /// archived ones included. Renaming keeps every row (they hold the id).
    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&IdentifierTypePayload>,
        next: &IdentifierTypePayload,
    ) -> Result<(), ContractError> {
        let normalized = normalise_list_name(&next.name);
        let clash: Option<String> = tx
            .query_row(
                "SELECT name FROM identifier_types WHERE name_normalized = ?1 AND id != ?2",
                params![normalized, id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(name) = clash {
            return Err(ContractError::rejected(
                "duplicate_identifier_type_name",
                format!("An identifier type called {name} exists"),
            ));
        }
        if before.is_some() {
            tx.execute(
                "UPDATE identifier_types SET name = ?2, name_normalized = ?3, is_active = ?4
                 WHERE id = ?1",
                params![id, next.name, normalized, next.is_active],
            )?;
            return Ok(());
        }
        let count: i64 = tx.query_row("SELECT count(*) FROM identifier_types", [], |r| r.get(0))?;
        if count >= IDENTIFIER_TYPE_LIMIT {
            return Err(ContractError::rejected(
                "identifier_type_limit",
                format!(
                    "A group can have at most {IDENTIFIER_TYPE_LIMIT} identifier types, archived ones included"
                ),
            ));
        }
        tx.execute(
            "INSERT INTO identifier_types (id, name, name_normalized, is_active) VALUES (?1, ?2, ?3, ?4)",
            params![id, next.name, normalized, next.is_active],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_mints_keys_and_trims_values() {
        let p = prepare_identifiers(Identifiers {
            identifiers: vec![IdentifierRow {
                key: None,
                type_id: "t".into(),
                value: "  M123 ".into(),
            }],
        })
        .unwrap();
        assert_eq!(p.identifiers[0].value, "M123");
        assert!(is_client_id(p.identifiers[0].key.as_deref().unwrap()));
    }

    #[test]
    fn a_pair_twice_or_a_blank_value_is_invalid() {
        let row = |v: &str| IdentifierRow {
            key: None,
            type_id: "t".into(),
            value: v.into(),
        };
        for rows in [vec![row("m1"), row("M1 ")], vec![row("  ")]] {
            assert!(matches!(
                prepare_identifiers(Identifiers { identifiers: rows }),
                Err(ContractError::Invalid(_))
            ));
        }
        // Several values of one type are fine.
        assert!(
            prepare_identifiers(Identifiers {
                identifiers: vec![row("m1"), row("m2")]
            })
            .is_ok()
        );
    }

    #[test]
    fn type_names_are_tidied_and_required() {
        let p = prepare_identifier_type(IdentifierTypePayload {
            name: "  Member   no ".into(),
            is_active: true,
        })
        .unwrap();
        assert_eq!(p.name, "Member no");
        assert!(
            prepare_identifier_type(IdentifierTypePayload {
                name: "  ".into(),
                is_active: true
            })
            .is_err()
        );
    }
}
