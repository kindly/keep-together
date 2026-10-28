//! Dropdown field definitions (Convex `contacts/fields.ts`). Aggregates,
//! each its own contract and counter:
//!
//!   contacts.field             → label, appliesTo, isActive (save_version)
//!   contacts.fieldOption       → fieldId (fixed), label, position, isActive
//!   contacts.fieldRetire       → live → retiring → retired (retire_version)
//!   contacts.fieldDelete       → a never-used field and its options, gone
//!   contacts.fieldOptionDelete → a never-used option, gone
//!
//! A contact's values are rows of `contact_field_values (contact, field,
//! option)` rather than Convex's numbered slots, so a retire frees nothing
//! but a place under [`MAX_FIELDS`]. System-owned, in no payload: an
//! option's `used` (set by `contacts.fields`) and a field's retire phase
//! (only `contacts.fieldRetire` writes it).
//!
//! Getting rid of things:
//!   - an option: deleted while unused, only archived after;
//!   - a field: archived (hidden, values kept), retired (every value
//!     cleared through `contacts.fields`, then marked retired; rows kept so
//!     history can name them), or deleted while none of its options was
//!     ever used.

use std::collections::{HashMap, HashSet};

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem, Source,
    WriteTx, command_group, execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::slices::{FIELD_VALUES, contact_kind, field_refusals, load_field_values};
use crate::types::{
    BulkSetField, BulkSetResult, FieldDefinition, FieldOptionPayload, FieldOptionView,
    FieldPayload, FieldRetirePayload, FieldValue, FieldValues, Kind, RetirePhase,
};

/// The longest a field's or an option's label can be.
pub const FIELD_LABEL_MAX: usize = 60;
/// The most options a field can hold, archived ones included.
pub const FIELD_OPTION_LIMIT: i64 = 100;
/// The most dropdown fields one organisation defines (L6); retired ones
/// don't count.
pub const MAX_FIELDS: i64 = 200;
/// The most contacts one bulk set changes (Convex `BULK_FIELD_LIMIT`).
pub const BULK_FIELD_LIMIT: usize = 1000;
/// Contacts one retire batch clears, each batch its own transaction.
pub const RETIRE_BATCH: usize = 500;

/// The org schema step after A2's (B1): a field's retire phase and its
/// counter, and the delete logs (a deleted row has no root left to carry
/// a counter, so each delete is a row of its own).
pub const MIGRATION_RETIRE: &str = "
ALTER TABLE contact_fields ADD COLUMN retiring INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contact_fields ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contact_fields ADD COLUMN retire_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE contact_field_deletions (
    id TEXT PRIMARY KEY,
    deleted INTEGER NOT NULL,
    delete_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE contact_field_option_deletions (
    id TEXT PRIMARY KEY,
    delete_version INTEGER NOT NULL DEFAULT 0
) STRICT;
";

pub struct ContactField;
pub struct ContactFieldOption;
pub struct ContactFieldRetire;
pub struct ContactFieldDeletion;
pub struct ContactFieldOptionDeletion;
pub static FIELD: ContactField = ContactField;
pub static FIELD_OPTION: ContactFieldOption = ContactFieldOption;
pub static FIELD_RETIRE: ContactFieldRetire = ContactFieldRetire;
pub static FIELD_DELETE: ContactFieldDeletion = ContactFieldDeletion;
pub static FIELD_OPTION_DELETE: ContactFieldOptionDeletion = ContactFieldOptionDeletion;

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
    pub retiring: bool,
    pub retired: bool,
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
        "SELECT id, label, applies_to, is_active, retiring, retired FROM contact_fields
         WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(FieldRow {
            id: r.get(0)?,
            label: r.get(1)?,
            applies_to: applies_to(&r.get::<_, String>(2)?),
            is_active: r.get(3)?,
            retiring: r.get(4)?,
            retired: r.get(5)?,
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

fn retiring_refusal(label: &str) -> ContractError {
    ContractError::rejected(
        "retiring_field",
        format!("{label} is being retired: finish the retire first"),
    )
}

// ── contacts.field ─────────────────────────────────────────────────────────

/// `contacts.field` as stored, plus the retire phase its checks need (not
/// serialised: a stale refusal's `current` is the payload).
#[derive(Clone, Debug, Serialize)]
pub struct FieldState {
    #[serde(flatten)]
    pub payload: FieldPayload,
    #[serde(skip)]
    retiring: bool,
    #[serde(skip)]
    retired: bool,
}

fn load_field(conn: &Connection, id: &str) -> Result<FieldState, ContractError> {
    Ok(conn.query_row(
        "SELECT label, applies_to, is_active, retiring, retired FROM contact_fields
         WHERE id = ?1",
        [id],
        |r| {
            Ok(FieldState {
                payload: FieldPayload {
                    label: r.get(0)?,
                    applies_to: applies_to(&r.get::<_, String>(1)?),
                    is_active: r.get(2)?,
                },
                retiring: r.get(3)?,
                retired: r.get(4)?,
            })
        },
    )?)
}

impl Contract for ContactField {
    const NAME: &'static str = "contacts.field";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_fields";
    const COUNTER: &'static str = "save_version";
    type Payload = FieldPayload;
    type State = FieldState;

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

    fn load(&self, tx: &OrgTx, id: &str) -> Result<FieldState, ContractError> {
        load_field(tx.read(), id)
    }

    /// A retired field changes only by a restore (and stays retired); a
    /// retiring one not at all: reactivating would let values back in,
    /// and a rename would change what the retire's history names.
    fn apply(
        &self,
        current: Option<&FieldState>,
        p: &FieldPayload,
        command: &Command,
    ) -> Result<FieldState, ContractError> {
        if let Some(c) = current {
            if c.retired && command.source != Source::Restore {
                return Err(ContractError::rejected(
                    "retired_field",
                    "This field has been retired",
                ));
            }
            if c.retiring {
                return Err(retiring_refusal(&c.payload.label));
            }
        }
        Ok(FieldState {
            payload: p.clone(),
            retiring: false,
            retired: current.is_some_and(|c| c.retired),
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&FieldState>,
        next: &FieldState,
    ) -> Result<(), ContractError> {
        let next = &next.payload;
        let normalized = normalise_label(&next.label);
        let kinds = serde_json::to_string(&next.applies_to)?;
        // A retired field's label is free again: only live ones clash.
        if !before.is_some_and(|b| b.retired) {
            let clash: Option<String> = tx
                .query_row(
                    "SELECT label FROM contact_fields
                     WHERE label_normalized = ?1 AND id != ?2 AND retired = 0",
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
        }
        if before.is_some() {
            // The retire phase is system-owned: never touched here.
            tx.execute(
                "UPDATE contact_fields SET label = ?2, label_normalized = ?3, applies_to = ?4,
                     is_active = ?5
                 WHERE id = ?1",
                params![id, next.label, normalized, kinds, next.is_active],
            )?;
        } else {
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM contact_fields WHERE retired = 0",
                [],
                |r| r.get(0),
            )?;
            if count >= MAX_FIELDS {
                return Err(ContractError::rejected(
                    "field_limit",
                    format!(
                        "An organisation has at most {MAX_FIELDS} fields: retire one to make room"
                    ),
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

// ── contacts.fieldOption ───────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct OptionState {
    #[serde(flatten)]
    pub payload: FieldOptionPayload,
    #[serde(skip)]
    restoring: bool,
}

fn load_option(conn: &Connection, id: &str) -> Result<OptionState, ContractError> {
    Ok(conn.query_row(
        "SELECT field_id, label, position, is_active FROM contact_field_options WHERE id = ?1",
        [id],
        |r| {
            Ok(OptionState {
                payload: FieldOptionPayload {
                    field_id: r.get(0)?,
                    label: r.get(1)?,
                    position: r.get(2)?,
                    is_active: r.get(3)?,
                },
                restoring: false,
            })
        },
    )?)
}

impl Contract for ContactFieldOption {
    const NAME: &'static str = "contacts.fieldOption";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_field_options";
    const COUNTER: &'static str = "save_version";
    type Payload = FieldOptionPayload;
    type State = OptionState;

    fn prepare(&self, mut p: FieldOptionPayload) -> Result<FieldOptionPayload, ContractError> {
        p.label = tidy(&p.label);
        match label_problem(&p.label, "An option") {
            Some(problem) => Err(ContractError::Invalid(vec![problem])),
            None => Ok(p),
        }
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<OptionState, ContractError> {
        load_option(tx.read(), id)
    }

    fn apply(
        &self,
        current: Option<&OptionState>,
        p: &FieldOptionPayload,
        command: &Command,
    ) -> Result<OptionState, ContractError> {
        if current.is_some_and(|c| c.payload.field_id != p.field_id) {
            return Err(ContractError::rejected(
                "field_fixed",
                "An option belongs to its field for good",
            ));
        }
        Ok(OptionState {
            payload: p.clone(),
            restoring: command.source == Source::Restore,
        })
    }

    /// A retiring field's options can't be edited at all (nor added, nor
    /// reordered); a retired field's only by a restore.
    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&OptionState>,
        next: &OptionState,
    ) -> Result<(), ContractError> {
        let restoring = next.restoring;
        let next = &next.payload;
        let Some(field) = field_row(tx, &next.field_id)? else {
            return Err(ContractError::rejected(
                "unknown_field",
                "The field must exist",
            ));
        };
        if field.retired && !restoring {
            return Err(ContractError::rejected(
                "retired_field",
                format!("{} has been retired", field.label),
            ));
        }
        if field.retiring {
            return Err(retiring_refusal(&field.label));
        }
        let normalized = normalise_label(&next.label);
        let clash: Option<String> = tx
            .query_row(
                "SELECT label FROM contact_field_options
                 WHERE field_id = ?1 AND label_normalized = ?2 AND id != ?3",
                params![next.field_id, normalized, id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(clash) = clash {
            return Err(ContractError::rejected(
                "duplicate_option_label",
                format!("{} already has {clash}", field.label),
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
                format!(
                    "A field can have at most {FIELD_OPTION_LIMIT} options, archived ones included"
                ),
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

// ── contacts.fieldRetire ───────────────────────────────────────────────────

fn phase_of(retiring: bool, retired: bool) -> RetirePhase {
    match (retiring, retired) {
        (_, true) => RetirePhase::Retired,
        (true, false) => RetirePhase::Retiring,
        (false, false) => RetirePhase::Live,
    }
}

/// The retire's two steps, each a revision (and an event: the Settings
/// tab sees a retire start and end wherever it ran). Only forward, and
/// never by a restore: a retired field's values are gone.
impl Contract for ContactFieldRetire {
    const NAME: &'static str = "contacts.fieldRetire";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_fields";
    const COUNTER: &'static str = "retire_version";
    type Payload = FieldRetirePayload;
    type State = FieldRetirePayload;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<FieldRetirePayload, ContractError> {
        Ok(tx.read().query_row(
            "SELECT retiring, retired FROM contact_fields WHERE id = ?1",
            [id],
            |r| {
                Ok(FieldRetirePayload {
                    phase: phase_of(r.get(0)?, r.get(1)?),
                })
            },
        )?)
    }

    fn apply(
        &self,
        current: Option<&FieldRetirePayload>,
        p: &FieldRetirePayload,
        command: &Command,
    ) -> Result<FieldRetirePayload, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "A retire targets an existing field",
            ));
        };
        if command.source == Source::Restore {
            return Err(ContractError::rejected(
                "not_restorable",
                "A retire can't be undone",
            ));
        }
        let forward = matches!(
            (current.phase, p.phase),
            (RetirePhase::Live, RetirePhase::Retiring)
                | (RetirePhase::Retiring, RetirePhase::Retired)
        );
        if !forward {
            return Err(ContractError::rejected(
                "retire_phase",
                "A retire only goes forward: live, retiring, retired",
            ));
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&FieldRetirePayload>,
        next: &FieldRetirePayload,
    ) -> Result<(), ContractError> {
        tx.execute(
            "UPDATE contact_fields SET retiring = ?2, retired = ?3 WHERE id = ?1",
            params![
                id,
                next.phase == RetirePhase::Retiring,
                next.phase == RetirePhase::Retired
            ],
        )?;
        Ok(())
    }
}

// ── deletes ────────────────────────────────────────────────────────────────

/// A delete's payload: the deleted row's counter as last read; a mismatch
/// is that row's own contract going stale.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct DeletionPayload {
    pub expected: i64,
}

fn not_restorable() -> ContractError {
    ContractError::rejected("not_restorable", "A deleted field can't be brought back")
}

/// Delete a field none of whose options was ever used, with its options.
/// Nothing references them (a value marks its option used), so nothing
/// dangles; their revisions stay as history. Not restorable.
impl Contract for ContactFieldDeletion {
    const NAME: &'static str = "contacts.fieldDelete";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_field_deletions";
    const COUNTER: &'static str = "delete_version";
    type Payload = DeletionPayload;
    type State = DeletionPayload;

    fn load(&self, _: &OrgTx, _: &str) -> Result<DeletionPayload, ContractError> {
        Ok(DeletionPayload { expected: -1 })
    }

    fn apply(
        &self,
        current: Option<&DeletionPayload>,
        p: &DeletionPayload,
        _: &Command,
    ) -> Result<DeletionPayload, ContractError> {
        if current.is_some() {
            return Err(not_restorable());
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&DeletionPayload>,
        next: &DeletionPayload,
    ) -> Result<(), ContractError> {
        let row: (i64, String) = tx
            .query_row(
                "SELECT save_version, label FROM contact_fields WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(ContractError::NotFound)?;
        if row.0 != next.expected {
            return Err(ContractError::Stale {
                contract: ContactField::NAME,
                counter: row.0,
                current: serde_json::to_value(load_field(tx, id)?)?,
            });
        }
        let used: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM contact_field_options WHERE field_id = ?1 AND used)",
            [id],
            |r| r.get(0),
        )?;
        if used {
            return Err(ContractError::rejected(
                "used",
                format!("{} has been used: archive or retire it instead", row.1),
            ));
        }
        let options = tx.execute(
            "DELETE FROM contact_field_options WHERE field_id = ?1",
            [id],
        )?;
        tx.execute("DELETE FROM contact_fields WHERE id = ?1", [id])?;
        tx.execute(
            "INSERT INTO contact_field_deletions (id, deleted) VALUES (?1, ?2)",
            params![id, options as i64 + 1],
        )?;
        Ok(())
    }
}

/// Delete an option that has never been on a contact. Once used, it can
/// only be archived: contacts keep it and history names it.
impl Contract for ContactFieldOptionDeletion {
    const NAME: &'static str = "contacts.fieldOptionDelete";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_field_option_deletions";
    const COUNTER: &'static str = "delete_version";
    type Payload = DeletionPayload;
    type State = DeletionPayload;

    fn load(&self, _: &OrgTx, _: &str) -> Result<DeletionPayload, ContractError> {
        Ok(DeletionPayload { expected: -1 })
    }

    fn apply(
        &self,
        current: Option<&DeletionPayload>,
        p: &DeletionPayload,
        _: &Command,
    ) -> Result<DeletionPayload, ContractError> {
        if current.is_some() {
            return Err(not_restorable());
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&DeletionPayload>,
        next: &DeletionPayload,
    ) -> Result<(), ContractError> {
        let (counter, label, used): (i64, String, bool) = tx
            .query_row(
                "SELECT save_version, label, used FROM contact_field_options WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or(ContractError::NotFound)?;
        if counter != next.expected {
            return Err(ContractError::Stale {
                contract: ContactFieldOption::NAME,
                counter,
                current: serde_json::to_value(load_option(tx, id)?)?,
            });
        }
        if used {
            return Err(ContractError::rejected(
                "used",
                format!("{label} has been used, so it can only be archived"),
            ));
        }
        tx.execute("DELETE FROM contact_field_options WHERE id = ?1", [id])?;
        tx.execute(
            "INSERT INTO contact_field_option_deletions (id) VALUES (?1)",
            [id],
        )?;
        Ok(())
    }
}

/// How many rows a field delete took (the field and its options).
pub fn deleted_count(conn: &Connection, id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT deleted FROM contact_field_deletions WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
}

// ── commands ───────────────────────────────────────────────────────────────

/// The live field `id`, or not found (a retired one too, for a command
/// that needs it live).
fn live_field(conn: &Connection, id: &str) -> Result<FieldRow, ContractError> {
    match field_row(conn, id)? {
        Some(f) if !f.retired => Ok(f),
        Some(f) => Err(ContractError::rejected(
            "retired_field",
            format!("{} has been retired", f.label),
        )),
        None => Err(ContractError::NotFound),
    }
}

struct OptionAt {
    id: String,
    payload: FieldOptionPayload,
}

/// A field's options in the admin's order, archived ones included.
fn options_of(conn: &Connection, field_id: &str) -> rusqlite::Result<Vec<OptionAt>> {
    conn.prepare_cached(
        "SELECT id, label, position, is_active FROM contact_field_options
         WHERE field_id = ?1 ORDER BY position, rowid",
    )?
    .query_map([field_id], |r| {
        Ok(OptionAt {
            id: r.get(0)?,
            payload: FieldOptionPayload {
                field_id: field_id.to_owned(),
                label: r.get(1)?,
                position: r.get(2)?,
                is_active: r.get(3)?,
            },
        })
    })?
    .collect()
}

/// A new option at the end of the field's list (Convex `addOption`).
pub fn add_option(
    ctx: &Ctx,
    field_id: &str,
    label: String,
    is_active: bool,
    source: Source,
) -> Result<Executed, ContractError> {
    // Positions are saved as given, so the last may be `u32::MAX`: no
    // room after it is a refusal, not an overflow.
    let position = match options_of(ctx.tx.read(), field_id)?
        .iter()
        .map(|o| o.payload.position)
        .max()
    {
        None => 0,
        Some(last) => last.checked_add(1).ok_or_else(|| {
            ContractError::invalid(
                "position",
                "No room after the last option: reorder them first",
            )
        })?,
    };
    execute(
        ctx,
        &FIELD_OPTION,
        FieldOptionPayload {
            field_id: field_id.to_owned(),
            label,
            position,
            is_active,
        },
        Exec::create(source),
    )
}

/// Put a field's options in `order`, which must name every one of them,
/// archived ones included (anything else is stale: an option was added or
/// deleted meanwhile). Each option whose position changes gets its own
/// contract, under one command group. Returns how many moved.
pub fn reorder_options(
    ctx: &Ctx,
    field_id: &str,
    order: &[String],
    source: Source,
) -> Result<i64, ContractError> {
    let field = field_row(ctx.tx.read(), field_id)?.ok_or(ContractError::NotFound)?;
    let options = options_of(ctx.tx.read(), field_id)?;
    let by_id: HashMap<&str, &OptionAt> = options.iter().map(|o| (o.id.as_str(), o)).collect();
    let distinct: HashSet<&str> = order.iter().map(String::as_str).collect();
    if order.len() != options.len()
        || distinct.len() != order.len()
        || order.iter().any(|id| !by_id.contains_key(id.as_str()))
    {
        return Err(ContractError::Stale {
            contract: ContactFieldOption::NAME,
            counter: -1,
            current: serde_json::Value::Null,
        });
    }
    let moves: Vec<(&OptionAt, u32)> = order
        .iter()
        .enumerate()
        .filter_map(|(position, id)| {
            let o = by_id[id.as_str()];
            (o.payload.position != position as u32).then_some((o, position as u32))
        })
        .collect();
    if moves.is_empty() {
        return Ok(0);
    }
    let group = command_group(ctx, &format!("Reorder {}", field.label))?;
    for (o, position) in &moves {
        execute(
            ctx,
            &FIELD_OPTION,
            FieldOptionPayload {
                position: *position,
                ..o.payload.clone()
            },
            Exec::update(&o.id, None, source).in_group(&group),
        )?;
    }
    Ok(moves.len() as i64)
}

// ── retire ─────────────────────────────────────────────────────────────────

/// The command group a retire batch runs under.
pub fn retire_group_name(label: &str) -> String {
    format!("Retire field {label}")
}

/// Start (or resume) a retire: archive the field (a `contacts.field`
/// revision), then mark it retiring, after which neither field contract
/// takes an edit to it or its options and no contact takes a new value of
/// it. A field already retiring is a resumed retire.
pub fn retire_start(ctx: &Ctx, id: &str, source: Source) -> Result<(), ContractError> {
    let field = live_field(ctx.tx.read(), id)?;
    if field.retiring {
        return Ok(());
    }
    // Archive first: the contract refuses any edit once the field is marked.
    if field.is_active {
        execute(
            ctx,
            &FIELD,
            FieldPayload {
                label: field.label.clone(),
                applies_to: field.applies_to.clone(),
                is_active: false,
            },
            Exec::update(id, None, source),
        )?;
    }
    execute(
        ctx,
        &FIELD_RETIRE,
        FieldRetirePayload {
            phase: RetirePhase::Retiring,
        },
        Exec::update(id, None, source),
    )?;
    Ok(())
}

/// Clear the field from up to `limit` contacts holding a value in it,
/// under one command group ("Retire field *Label*"), each through
/// `contacts.fields` with the contact's other values kept. Holders are
/// found from the values themselves, archived contacts included. Returns
/// how many it cleared (0: none left).
pub fn retire_batch(
    ctx: &Ctx,
    id: &str,
    limit: usize,
    source: Source,
) -> Result<i64, ContractError> {
    let Some(field) = field_row(ctx.tx.read(), id)? else {
        return Err(ContractError::NotFound);
    };
    if !field.retiring {
        return Ok(0);
    }
    let holders: Vec<String> = ctx
        .tx
        .read()
        .prepare_cached(
            "SELECT contact_id FROM contact_field_values WHERE field_id = ?1
             ORDER BY contact_id LIMIT ?2",
        )?
        .query_map(params![id, limit as i64], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if holders.is_empty() {
        return Ok(0);
    }
    let group = command_group(ctx, &retire_group_name(&field.label))?;
    for contact in &holders {
        let values = load_field_values(ctx.tx.read(), contact)?
            .into_iter()
            .filter(|v| v.field_id != id)
            .collect();
        execute(
            ctx,
            &FIELD_VALUES,
            FieldValues { values },
            Exec::update(contact, None, source).in_group(&group),
        )?;
    }
    Ok(holders.len() as i64)
}

/// End the retire once no contact holds a value in the field (the
/// retiring mark kept new ones out since it was set). Returns whether it
/// ended; false: values are left, run more batches.
pub fn retire_finish(ctx: &Ctx, id: &str, source: Source) -> Result<bool, ContractError> {
    let Some(field) = field_row(ctx.tx.read(), id)? else {
        return Err(ContractError::NotFound);
    };
    if field.retired {
        return Ok(true);
    }
    let held: bool = ctx.tx.read().query_row(
        "SELECT EXISTS (SELECT 1 FROM contact_field_values WHERE field_id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    if held {
        return Ok(false);
    }
    execute(
        ctx,
        &FIELD_RETIRE,
        FieldRetirePayload {
            phase: RetirePhase::Retired,
        },
        Exec::update(id, None, source),
    )?;
    Ok(true)
}

/// Fields whose retire is under way (or stopped part way), each with who
/// started it (the actor of its latest `contacts.fieldRetire` revision),
/// for the job that carries retires on.
pub fn retiring_fields(conn: &Connection) -> rusqlite::Result<Vec<(String, Option<i64>)>> {
    conn.prepare_cached(
        "SELECT f.id,
                (SELECT r.actor FROM revisions r
                 WHERE r.entity = 'contact_fields' AND r.entity_id = f.id
                   AND r.contract = 'contacts.fieldRetire'
                 ORDER BY r.id DESC LIMIT 1)
         FROM contact_fields f WHERE f.retiring = 1",
    )?
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
    .collect()
}

// ── bulk set ───────────────────────────────────────────────────────────────

/// Set one field to `optionId` (or clear it, `null`) on up to
/// [`BULK_FIELD_LIMIT`] contacts, in one command group ("set *Field* to
/// *Option*" / "clear *Field*"). A contact already holding it is left
/// alone; one the field doesn't apply to is skipped on a set (a clear
/// reaches every holder). Any other refusal (an archived option, a
/// retiring field) refuses the whole batch, naming it, before anything is
/// written.
pub fn bulk_set_field(
    ctx: &Ctx,
    req: &BulkSetField,
    source: Source,
) -> Result<BulkSetResult, ContractError> {
    let mut seen = HashSet::new();
    let ids: Vec<&str> = req
        .contact_ids
        .iter()
        .map(String::as_str)
        .filter(|id| seen.insert(*id))
        .collect();
    if ids.len() > BULK_FIELD_LIMIT {
        return Err(ContractError::invalid(
            "contactIds",
            format!("At most {BULK_FIELD_LIMIT} contacts per batch"),
        ));
    }
    let conn = ctx.tx.read();
    let field = match live_field(conn, &req.field_id) {
        Err(ContractError::NotFound) => {
            return Err(ContractError::rejected(
                "unknown_field",
                "That field does not exist",
            ));
        }
        other => other?,
    };
    let option = match &req.option_id {
        Some(o) => Some(
            option_row(conn, o)?
                .filter(|o| o.field_id == field.id)
                .ok_or_else(|| {
                    ContractError::rejected(
                        "unknown_option",
                        format!("That option is not one of {}'s", field.label),
                    )
                })?,
        ),
        None => None,
    };
    let mut skipped = 0;
    let mut plans: Vec<(&str, i64, Vec<FieldValue>)> = Vec::new();
    for id in ids {
        let Some(kind) = contact_kind(conn, id)? else {
            return Err(ContractError::rejected(
                "unknown_contact",
                "Contact must exist",
            ));
        };
        let held = load_field_values(conn, id)?;
        let current = held
            .iter()
            .find(|v| v.field_id == field.id)
            .map(|v| v.option_id.as_str());
        if current == req.option_id.as_deref() {
            continue;
        }
        let mut values: Vec<FieldValue> = held
            .iter()
            .filter(|v| v.field_id != field.id)
            .cloned()
            .collect();
        if let Some(o) = &option {
            if !field.applies_to.contains(&kind) {
                skipped += 1;
                continue;
            }
            let value = FieldValue {
                field_id: field.id.clone(),
                option_id: o.id.clone(),
            };
            // The contract's own rule, checked up front so a refusal names
            // the batch, not one contact in it.
            if let Some(r) = field_refusals(conn, id, std::slice::from_ref(&value))?
                .into_iter()
                .next()
            {
                return Err(ContractError::rejected(r.reason, r.message));
            }
            values.push(value);
        }
        values.sort_by(|a, b| a.field_id.cmp(&b.field_id));
        let counter: i64 = conn.query_row(
            "SELECT fields_version FROM contacts WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        plans.push((id, counter, values));
    }
    if plans.is_empty() {
        return Ok(BulkSetResult {
            changed: 0,
            skipped,
            group: None,
        });
    }
    let name = match &option {
        Some(o) => format!("set {} to {}", field.label, o.label),
        None => format!("clear {}", field.label),
    };
    let group: CommandGroup = command_group(ctx, &name)?;
    for (id, expected, values) in &plans {
        execute(
            ctx,
            &FIELD_VALUES,
            FieldValues {
                values: values.clone(),
            },
            Exec::update(id, Some(*expected), source).in_group(&group),
        )?;
    }
    Ok(BulkSetResult {
        changed: plans.len() as i64,
        skipped,
        group: Some(group.id),
    })
}

// ── reads ──────────────────────────────────────────────────────────────────

/// Every live (not retired) field with its options in the admin's order
/// (archived included), fields in creation order. Two queries.
pub fn definitions(conn: &Connection) -> rusqlite::Result<Vec<FieldDefinition>> {
    let mut fields: Vec<FieldDefinition> = conn
        .prepare_cached(
            "SELECT id, label, applies_to, is_active, retiring, save_version FROM contact_fields
             WHERE retired = 0 ORDER BY rowid",
        )?
        .query_map([], |r| {
            Ok(FieldDefinition {
                id: r.get(0)?,
                label: r.get(1)?,
                applies_to: applies_to(&r.get::<_, String>(2)?),
                is_active: r.get(3)?,
                retiring: r.get(4)?,
                save_version: r.get(5)?,
                options: vec![],
                deletable: true,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let options = conn
        .prepare_cached(
            "SELECT o.id, o.field_id, o.label, o.position, o.is_active, o.used, o.save_version
             FROM contact_field_options o JOIN contact_fields f ON f.id = o.field_id
             WHERE f.retired = 0
             ORDER BY o.field_id, o.position, o.rowid",
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
    let at: HashMap<String, usize> = fields
        .iter()
        .enumerate()
        .map(|(i, f)| (f.id.clone(), i))
        .collect();
    for o in options {
        if let Some(&i) = at.get(&o.field_id) {
            let f = &mut fields[i];
            f.deletable &= !o.used;
            f.options.push(o);
        }
    }
    Ok(fields)
}
