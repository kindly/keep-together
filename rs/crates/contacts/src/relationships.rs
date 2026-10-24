//! Relationships between two contacts (Convex `contacts/relationships.ts`),
//! backend only: no page shows them yet.
//!
//!   contacts.relationshipType → labels, kinds, isActive (save_version)
//!   contacts.relationship     → both contacts, type, dates, … (save_version)
//!
//! A relationship spans two contacts, so it is its own aggregate rather
//! than a slice of either. Every new organisation starts with the UK types
//! ([`seed_new_org`]).

use contracts::{
    Command, Contract, ContractError, Ctx, Exec, OrgTx, Problem, Source, WriteTx, command_group,
    execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::slices::contact_kind;
use crate::types::Kind;

/// The most relationships one list reads in each direction.
pub const RELATIONSHIPS_LIMIT: usize = 200;

// ── wire types ─────────────────────────────────────────────────────────────

/// `contacts.relationshipType`. A kind left out = any kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelationshipTypePayload {
    /// "Employee of"
    #[serde(rename = "labelAB")]
    pub label_ab: String,
    /// "Employer of"
    #[serde(rename = "labelBA")]
    pub label_ba: String,
    #[serde(default, rename = "kindA", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind_a: Option<Kind>,
    #[serde(default, rename = "kindB", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind_b: Option<Kind>,
    pub is_active: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelationshipType {
    pub id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: RelationshipTypePayload,
    #[ts(type = "number")]
    pub save_version: i64,
}

/// `contacts.relationship`. Dates are ISO (YYYY-MM-DD), optional.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelationshipPayload {
    pub contact_a: String,
    pub contact_b: String,
    pub type_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub end_date: Option<String>,
    pub is_active: bool,
    pub description: String,
}

/// One of a contact's relationships, either direction, as seen from it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelationshipView {
    pub id: String,
    pub other_id: String,
    /// '?' when the other contact can't be found.
    pub other_name: String,
    /// The type's label read from this contact's side; null if the type
    /// is gone.
    pub label: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub is_active: bool,
    pub description: String,
    #[ts(type = "number")]
    pub save_version: i64,
}

/// `POST relationship-types`: create (no `id`) or save (`id` + `expected`).
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SaveRelationshipType {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected: Option<i64>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: RelationshipTypePayload,
}

/// `POST relationships`: create (no `id`) or save (`id` + `expected`).
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SaveRelationship {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected: Option<i64>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: RelationshipPayload,
}

// ── rules ──────────────────────────────────────────────────────────────────

fn trim(s: &mut String) {
    let t = s.trim();
    if t.len() != s.len() {
        *s = t.to_owned();
    }
}

pub fn prepare_relationship_type(
    mut p: RelationshipTypePayload,
) -> Result<RelationshipTypePayload, ContractError> {
    trim(&mut p.label_ab);
    trim(&mut p.label_ba);
    if p.label_ab.is_empty() || p.label_ba.is_empty() {
        return Err(ContractError::invalid(
            "labelAB",
            "Both labels are required",
        ));
    }
    crate::rules::width("labelAB", &p.label_ab, crate::rules::NAME_MAX)?;
    crate::rules::width("labelBA", &p.label_ba, crate::rules::NAME_MAX)?;
    Ok(p)
}

pub fn prepare_relationship(
    mut p: RelationshipPayload,
) -> Result<RelationshipPayload, ContractError> {
    trim(&mut p.description);
    for d in [&mut p.start_date, &mut p.end_date] {
        if d.as_deref().is_some_and(|v| v.trim().is_empty()) {
            *d = None;
        }
    }
    let mut problems = Vec::new();
    if crate::rules::too_long(&p.description, crate::rules::DESCRIPTION_MAX) {
        problems.push(Problem::new(
            "description",
            format!("At most {} characters", crate::rules::DESCRIPTION_MAX),
        ));
    }
    if p.contact_a == p.contact_b {
        problems.push(Problem::new(
            "contactB",
            "A relationship needs two different contacts",
        ));
    }
    if let (Some(start), Some(end)) = (&p.start_date, &p.end_date)
        && end < start
    {
        problems.push(Problem::new("endDate", "End date is before start date"));
    }
    if problems.is_empty() {
        Ok(p)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

// ── contracts ──────────────────────────────────────────────────────────────

pub struct ContactRelationshipType;
pub struct ContactRelationship;
pub static RELATIONSHIP_TYPE: ContactRelationshipType = ContactRelationshipType;
pub static RELATIONSHIP: ContactRelationship = ContactRelationship;

fn kind_column(k: Option<Kind>) -> Option<&'static str> {
    k.map(Kind::as_str)
}

fn type_row(r: &rusqlite::Row) -> rusqlite::Result<RelationshipTypePayload> {
    Ok(RelationshipTypePayload {
        label_ab: r.get(0)?,
        label_ba: r.get(1)?,
        kind_a: r.get::<_, Option<String>>(2)?.and_then(|k| Kind::parse(&k)),
        kind_b: r.get::<_, Option<String>>(3)?.and_then(|k| Kind::parse(&k)),
        is_active: r.get(4)?,
    })
}

fn relationship_type(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<RelationshipTypePayload>> {
    conn.prepare_cached(
        "SELECT label_ab, label_ba, kind_a, kind_b, is_active FROM relationship_types WHERE id = ?1",
    )?
    .query_row([id], type_row)
    .optional()
}

impl Contract for ContactRelationshipType {
    const NAME: &'static str = "contacts.relationshipType";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "relationship_types";
    const COUNTER: &'static str = "save_version";
    type Payload = RelationshipTypePayload;
    type State = RelationshipTypePayload;

    fn prepare(
        &self,
        p: RelationshipTypePayload,
    ) -> Result<RelationshipTypePayload, ContractError> {
        prepare_relationship_type(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<RelationshipTypePayload, ContractError> {
        relationship_type(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        _: Option<&RelationshipTypePayload>,
        p: &RelationshipTypePayload,
        _: &Command,
    ) -> Result<RelationshipTypePayload, ContractError> {
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&RelationshipTypePayload>,
        n: &RelationshipTypePayload,
    ) -> Result<(), ContractError> {
        let values = params![
            id,
            n.label_ab,
            n.label_ba,
            kind_column(n.kind_a),
            kind_column(n.kind_b),
            n.is_active
        ];
        if before.is_some() {
            tx.execute(
                "UPDATE relationship_types SET label_ab = ?2, label_ba = ?3, kind_a = ?4,
                     kind_b = ?5, is_active = ?6
                 WHERE id = ?1",
                values,
            )?;
        } else {
            tx.execute(
                "INSERT INTO relationship_types (id, label_ab, label_ba, kind_a, kind_b, is_active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                values,
            )?;
        }
        Ok(())
    }
}

impl Contract for ContactRelationship {
    const NAME: &'static str = "contacts.relationship";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "relationships";
    const COUNTER: &'static str = "save_version";
    type Payload = RelationshipPayload;
    type State = RelationshipPayload;

    fn prepare(&self, p: RelationshipPayload) -> Result<RelationshipPayload, ContractError> {
        prepare_relationship(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<RelationshipPayload, ContractError> {
        Ok(tx.read().query_row(
            "SELECT contact_a, contact_b, type_id, start_date, end_date, is_active, description
             FROM relationships WHERE id = ?1",
            [id],
            |r| {
                Ok(RelationshipPayload {
                    contact_a: r.get(0)?,
                    contact_b: r.get(1)?,
                    type_id: r.get(2)?,
                    start_date: r.get(3)?,
                    end_date: r.get(4)?,
                    is_active: r.get(5)?,
                    description: r.get(6)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        _: Option<&RelationshipPayload>,
        p: &RelationshipPayload,
        _: &Command,
    ) -> Result<RelationshipPayload, ContractError> {
        Ok(p.clone())
    }

    /// Both contacts exist, the type exists and is active, and each side's
    /// kind is the one the type asks for.
    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&RelationshipPayload>,
        n: &RelationshipPayload,
    ) -> Result<(), ContractError> {
        let (Some(a), Some(b)) = (
            contact_kind(tx, &n.contact_a)?,
            contact_kind(tx, &n.contact_b)?,
        ) else {
            return Err(ContractError::rejected(
                "unknown_contact",
                "Both contacts must exist",
            ));
        };
        let Some(t) = relationship_type(tx, &n.type_id)?.filter(|t| t.is_active) else {
            return Err(ContractError::rejected(
                "unknown_type",
                "Relationship type must exist and be active",
            ));
        };
        for (side, want, got) in [("A", t.kind_a, a), ("B", t.kind_b, b)] {
            if let Some(want) = want
                && want != got
            {
                return Err(ContractError::rejected(
                    "kind_mismatch",
                    format!("{}: contact {side} must be {}", t.label_ab, want.as_str()),
                ));
            }
        }
        let values = params![
            id,
            n.contact_a,
            n.contact_b,
            n.type_id,
            n.start_date,
            n.end_date,
            n.is_active,
            n.description
        ];
        if before.is_some() {
            tx.execute(
                "UPDATE relationships SET contact_a = ?2, contact_b = ?3, type_id = ?4,
                     start_date = ?5, end_date = ?6, is_active = ?7, description = ?8
                 WHERE id = ?1",
                values,
            )?;
        } else {
            tx.execute(
                "INSERT INTO relationships (id, contact_a, contact_b, type_id, start_date,
                     end_date, is_active, description)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                values,
            )?;
        }
        Ok(())
    }
}

// ── seed ───────────────────────────────────────────────────────────────────

/// The relationship types every new organisation starts with. Households
/// are dormant (nothing creates one), so none of theirs: when they return,
/// add `Member of household` / `Household member is` and `Head of
/// household for` / `Head of household is` (individual → household), and
/// backfill the organisations made meanwhile.
pub const UK_RELATIONSHIP_TYPES: &[(&str, &str, Kind, Kind)] = &[
    (
        "Employee of",
        "Employer of",
        Kind::Individual,
        Kind::Organization,
    ),
    (
        "Trustee of",
        "Has trustee",
        Kind::Individual,
        Kind::Organization,
    ),
    (
        "Spouse/partner of",
        "Spouse/partner of",
        Kind::Individual,
        Kind::Individual,
    ),
    ("Parent of", "Child of", Kind::Individual, Kind::Individual),
    (
        "Volunteer for",
        "Has volunteer",
        Kind::Individual,
        Kind::Organization,
    ),
];

/// A new organisation's contacts reference data: the UK relationship
/// types, under one command group. Idempotent: an organisation with any
/// relationship type is left alone. Returns how many it created.
pub fn seed_new_org(ctx: &Ctx) -> Result<usize, ContractError> {
    let any: bool = ctx.tx.read().query_row(
        "SELECT EXISTS (SELECT 1 FROM relationship_types)",
        [],
        |r| r.get(0),
    )?;
    if any {
        return Ok(0);
    }
    let group = command_group(ctx, "seed relationship types")?;
    for (ab, ba, a, b) in UK_RELATIONSHIP_TYPES {
        execute(
            ctx,
            &RELATIONSHIP_TYPE,
            RelationshipTypePayload {
                label_ab: (*ab).into(),
                label_ba: (*ba).into(),
                kind_a: Some(*a),
                kind_b: Some(*b),
                is_active: true,
            },
            Exec::create(Source::Seed).in_group(&group),
        )?;
    }
    Ok(UK_RELATIONSHIP_TYPES.len())
}

// ── reads ──────────────────────────────────────────────────────────────────

/// The organisation's relationship types, in creation order.
pub fn relationship_types(conn: &Connection) -> rusqlite::Result<Vec<RelationshipType>> {
    conn.prepare_cached(&format!(
        "SELECT label_ab, label_ba, kind_a, kind_b, is_active, id, save_version
         FROM relationship_types ORDER BY rowid LIMIT {RELATIONSHIPS_LIMIT}"
    ))?
    .query_map([], |r| {
        Ok(RelationshipType {
            payload: type_row(r)?,
            id: r.get(5)?,
            save_version: r.get(6)?,
        })
    })?
    .collect()
}

/// A contact's relationships, both directions, each with the other party's
/// name and the label as seen from this contact.
pub fn relationships_for(
    conn: &Connection,
    contact_id: &str,
) -> rusqlite::Result<Vec<RelationshipView>> {
    let mut out = Vec::new();
    for (mine, other, label) in [
        ("contact_a", "contact_b", "label_ab"),
        ("contact_b", "contact_a", "label_ba"),
    ] {
        let rows = conn
            .prepare_cached(&format!(
                "SELECT r.id, r.{other}, c.display_name, t.{label}, r.start_date, r.end_date,
                        r.is_active, r.description, r.save_version
                 FROM relationships r
                 LEFT JOIN contacts c ON c.id = r.{other}
                 LEFT JOIN relationship_types t ON t.id = r.type_id
                 WHERE r.{mine} = ?1 ORDER BY r.rowid LIMIT {RELATIONSHIPS_LIMIT}"
            ))?
            .query_map([contact_id], |r| {
                Ok(RelationshipView {
                    id: r.get(0)?,
                    other_id: r.get(1)?,
                    other_name: r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "?".into()),
                    label: r.get(3)?,
                    start_date: r.get(4)?,
                    end_date: r.get(5)?,
                    is_active: r.get(6)?,
                    description: r.get(7)?,
                    save_version: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        out.extend(rows);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(a: &str, b: &str) -> RelationshipPayload {
        RelationshipPayload {
            contact_a: a.into(),
            contact_b: b.into(),
            type_id: "t".into(),
            start_date: Some("".into()),
            end_date: None,
            is_active: true,
            description: " x ".into(),
        }
    }

    #[test]
    fn a_relationship_needs_two_contacts_and_dates_in_order() {
        let p = prepare_relationship(rel("a", "b")).unwrap();
        assert_eq!((p.start_date, p.description.as_str()), (None, "x"));
        assert!(prepare_relationship(rel("a", "a")).is_err());
        let backwards = RelationshipPayload {
            start_date: Some("2024-02-01".into()),
            end_date: Some("2024-01-01".into()),
            ..rel("a", "b")
        };
        assert!(prepare_relationship(backwards).is_err());
    }
}
