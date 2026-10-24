//! Dropdown field definitions (Convex `contacts/fields.ts`, cut to what the
//! spike needs): two aggregates, each its own contract and counter.
//!
//!   contacts.field       → label, appliesTo, isActive (save_version)
//!   contacts.fieldOption → fieldId (fixed), label, position, isActive
//!
//! A contact's values are rows of `contact_field_values (contact, field,
//! option)` rather than Convex's numbered slots, so there is no field
//! limit and no slot to free; retire and delete aren't in the spike.

use contracts::{Command, Contract, ContractError, OrgTx, Problem, WriteTx};
use rusqlite::{Connection, OptionalExtension, params};

use crate::types::{FieldDefinition, FieldOptionPayload, FieldOptionView, FieldPayload, Kind};

/// The longest a field's or an option's label can be.
pub const FIELD_LABEL_MAX: usize = 60;
/// The most options a field can hold, archived ones included.
pub const FIELD_OPTION_LIMIT: i64 = 100;

pub struct ContactField;
pub struct ContactFieldOption;
pub static FIELD: ContactField = ContactField;
pub static FIELD_OPTION: ContactFieldOption = ContactFieldOption;

/// Labels compare case-insensitively.
fn normalise_label(label: &str) -> String {
    label.to_lowercase()
}

fn tidy(label: &str) -> String {
    label.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn label_problem(label: &str, what: &str) -> Option<Problem> {
    if label.is_empty() {
        return Some(Problem::new("label", format!("{what} needs a label")));
    }
    if label.chars().count() > FIELD_LABEL_MAX {
        return Some(Problem::new(
            "label",
            format!("At most {FIELD_LABEL_MAX} characters"),
        ));
    }
    None
}

pub(crate) struct FieldRow {
    pub id: String,
    pub label: String,
    pub applies_to: Vec<Kind>,
    pub is_active: bool,
}

pub(crate) struct OptionRow {
    pub id: String,
    pub field_id: String,
    pub label: String,
    pub is_active: bool,
    pub used: bool,
}

fn applies_to(json: &str) -> Vec<Kind> {
    serde_json::from_str(json).unwrap_or_default()
}

pub(crate) fn field_row(conn: &Connection, id: &str) -> rusqlite::Result<Option<FieldRow>> {
    conn.prepare_cached(
        "SELECT id, label, applies_to, is_active FROM contact_fields WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(FieldRow {
            id: r.get(0)?,
            label: r.get(1)?,
            applies_to: applies_to(&r.get::<_, String>(2)?),
            is_active: r.get(3)?,
        })
    })
    .optional()
}

pub(crate) fn option_row(conn: &Connection, id: &str) -> rusqlite::Result<Option<OptionRow>> {
    conn.prepare_cached(
        "SELECT id, field_id, label, is_active, used FROM contact_field_options WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(OptionRow {
            id: r.get(0)?,
            field_id: r.get(1)?,
            label: r.get(2)?,
            is_active: r.get(3)?,
            used: r.get(4)?,
        })
    })
    .optional()
}

impl Contract for ContactField {
    const NAME: &'static str = "contacts.field";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_fields";
    const COUNTER: &'static str = "save_version";
    type Payload = FieldPayload;
    type State = FieldPayload;

    /// Label tidied and required; `appliesTo` de-duplicated into the
    /// form's order and never empty.
    fn prepare(&self, mut p: FieldPayload) -> Result<FieldPayload, ContractError> {
        p.label = tidy(&p.label);
        p.applies_to = Kind::ALL
            .into_iter()
            .filter(|k| p.applies_to.contains(k))
            .collect();
        let mut problems: Vec<Problem> = label_problem(&p.label, "A field").into_iter().collect();
        if p.applies_to.is_empty() {
            problems.push(Problem::new(
                "appliesTo",
                "A field applies to at least one kind of contact",
            ));
        }
        if problems.is_empty() {
            Ok(p)
        } else {
            Err(ContractError::Invalid(problems))
        }
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<FieldPayload, ContractError> {
        Ok(tx.read().query_row(
            "SELECT label, applies_to, is_active FROM contact_fields WHERE id = ?1",
            [id],
            |r| {
                Ok(FieldPayload {
                    label: r.get(0)?,
                    applies_to: applies_to(&r.get::<_, String>(1)?),
                    is_active: r.get(2)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        _: Option<&FieldPayload>,
        p: &FieldPayload,
        _: &Command,
    ) -> Result<FieldPayload, ContractError> {
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&FieldPayload>,
        next: &FieldPayload,
    ) -> Result<(), ContractError> {
        let normalized = normalise_label(&next.label);
        let clash: Option<String> = tx
            .query_row(
                "SELECT label FROM contact_fields WHERE label_normalized = ?1 AND id != ?2",
                params![normalized, id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(label) = clash {
            return Err(ContractError::rejected(
                "duplicate_field_label",
                format!("{label} already exists"),
            ));
        }
        let kinds = serde_json::to_string(&next.applies_to)?;
        if before.is_some() {
            tx.execute(
                "UPDATE contact_fields SET label = ?2, label_normalized = ?3, applies_to = ?4,
                     is_active = ?5
                 WHERE id = ?1",
                params![id, next.label, normalized, kinds, next.is_active],
            )?;
        } else {
            let count: i64 =
                tx.query_row("SELECT count(*) FROM contact_fields", [], |r| r.get(0))?;
            if count >= MAX_FIELDS {
                return Err(ContractError::rejected(
                    "field_limit",
                    format!("An organisation has at most {MAX_FIELDS} fields"),
                ));
            }
            tx.execute(
                "INSERT INTO contact_fields (id, label, label_normalized, applies_to, is_active)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, next.label, normalized, kinds, next.is_active],
            )?;
        }
        Ok(())
    }
}

/// The most dropdown fields one organisation defines (L6).
pub const MAX_FIELDS: i64 = 200;

impl Contract for ContactFieldOption {
    const NAME: &'static str = "contacts.fieldOption";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_field_options";
    const COUNTER: &'static str = "save_version";
    type Payload = FieldOptionPayload;
    type State = FieldOptionPayload;

    fn prepare(&self, mut p: FieldOptionPayload) -> Result<FieldOptionPayload, ContractError> {
        p.label = tidy(&p.label);
        match label_problem(&p.label, "An option") {
            Some(problem) => Err(ContractError::Invalid(vec![problem])),
            None => Ok(p),
        }
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<FieldOptionPayload, ContractError> {
        Ok(tx.read().query_row(
            "SELECT field_id, label, position, is_active FROM contact_field_options WHERE id = ?1",
            [id],
            |r| {
                Ok(FieldOptionPayload {
                    field_id: r.get(0)?,
                    label: r.get(1)?,
                    position: r.get(2)?,
                    is_active: r.get(3)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        current: Option<&FieldOptionPayload>,
        p: &FieldOptionPayload,
        _: &Command,
    ) -> Result<FieldOptionPayload, ContractError> {
        if current.is_some_and(|c| c.field_id != p.field_id) {
            return Err(ContractError::rejected(
                "field_fixed",
                "An option belongs to its field for good",
            ));
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&FieldOptionPayload>,
        next: &FieldOptionPayload,
    ) -> Result<(), ContractError> {
        let Some(field) = field_row(tx, &next.field_id)? else {
            return Err(ContractError::rejected(
                "unknown_field",
                "The field must exist",
            ));
        };
        let normalized = normalise_label(&next.label);
        let clash: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM contact_field_options
                 WHERE field_id = ?1 AND label_normalized = ?2 AND id != ?3)",
            params![next.field_id, normalized, id],
            |r| r.get(0),
        )?;
        if clash {
            return Err(ContractError::rejected(
                "duplicate_option_label",
                format!("{} already has {}", field.label, next.label),
            ));
        }
        if before.is_some() {
            // `used` is system-owned: never touched here.
            tx.execute(
                "UPDATE contact_field_options SET label = ?2, label_normalized = ?3,
                     position = ?4, is_active = ?5
                 WHERE id = ?1",
                params![id, next.label, normalized, next.position, next.is_active],
            )?;
            return Ok(());
        }
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM contact_field_options WHERE field_id = ?1",
            [&next.field_id],
            |r| r.get(0),
        )?;
        if count >= FIELD_OPTION_LIMIT {
            return Err(ContractError::rejected(
                "option_limit",
                format!("A field can have at most {FIELD_OPTION_LIMIT} options"),
            ));
        }
        tx.execute(
            "INSERT INTO contact_field_options
                 (id, field_id, label, label_normalized, position, is_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                next.field_id,
                next.label,
                normalized,
                next.position,
                next.is_active
            ],
        )?;
        Ok(())
    }
}

/// Every field with its options in the admin's order (archived included),
/// fields in creation order. Two queries.
pub fn definitions(conn: &Connection) -> rusqlite::Result<Vec<FieldDefinition>> {
    let mut fields: Vec<FieldDefinition> = conn
        .prepare_cached(
            "SELECT id, label, applies_to, is_active, save_version FROM contact_fields
             ORDER BY rowid",
        )?
        .query_map([], |r| {
            Ok(FieldDefinition {
                id: r.get(0)?,
                label: r.get(1)?,
                applies_to: applies_to(&r.get::<_, String>(2)?),
                is_active: r.get(3)?,
                save_version: r.get(4)?,
                options: vec![],
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let options = conn
        .prepare_cached(
            "SELECT id, field_id, label, position, is_active, used, save_version
             FROM contact_field_options ORDER BY field_id, position, rowid",
        )?
        .query_map([], |r| {
            Ok(FieldOptionView {
                id: r.get(0)?,
                field_id: r.get(1)?,
                label: r.get(2)?,
                position: r.get(3)?,
                is_active: r.get(4)?,
                used: r.get(5)?,
                save_version: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for o in options {
        if let Some(f) = fields.iter_mut().find(|f| f.id == o.field_id) {
            f.options.push(o);
        }
    }
    Ok(fields)
}
