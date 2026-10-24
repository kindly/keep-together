//! The Contact aggregate's slices (ADR 0014), each its own contract and
//! counter column on `contacts`: details, methods (emails + phones),
//! addresses, archive, fields. Apply is pure state application; `write`
//! persists only the slice's own columns and child rows, and preserves the
//! system-owned ones no payload carries (number, an option's `used`).

use std::collections::{HashMap, HashSet};

use contracts::{
    ChildRow, Command, Contract, ContractError, OrgTx, ProjectionTx, WriteTx, reconcile,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::fields::{FieldRow, OptionRow, field_row, option_row};
use crate::number::take_number;
use crate::projection::rebuild_search;
use crate::rules::{
    computed_names, fold, normalise_email, normalise_phone, prepare_addresses, prepare_details,
    prepare_fields, prepare_methods, sort_values,
};
use crate::types::{
    AddressRow, Addresses, Archive, ChannelLabel, Details, EmailRow, FieldValue, FieldValues, Kind,
    Methods, PhoneRow,
};

pub struct ContactDetails;
pub struct ContactMethods;
pub struct ContactAddresses;
pub struct ContactArchive;
pub struct ContactFieldValues;

pub static DETAILS: ContactDetails = ContactDetails;
pub static METHODS: ContactMethods = ContactMethods;
pub static ADDRESSES: ContactAddresses = ContactAddresses;
pub static ARCHIVE: ContactArchive = ContactArchive;
pub static FIELD_VALUES: ContactFieldValues = ContactFieldValues;

fn no_root(contract: &str) -> ContractError {
    ContractError::rejected("no_root", format!("{contract} targets an existing contact"))
}

pub(crate) fn contact_kind(conn: &Connection, id: &str) -> rusqlite::Result<Option<Kind>> {
    conn.query_row("SELECT kind FROM contacts WHERE id = ?1", [id], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map(|k| k.and_then(|k| Kind::parse(&k)))
}

// ── details ────────────────────────────────────────────────────────────────

pub(crate) fn load_details(conn: &Connection, id: &str) -> rusqlite::Result<Details> {
    conn.query_row(
        "SELECT kind, title, first_name, last_name, nickname, name, birth_date,
                is_deceased, deceased_date
         FROM contacts WHERE id = ?1",
        [id],
        |r| {
            Ok(Details {
                client_key: None,
                kind: Kind::parse(&r.get::<_, String>(0)?).unwrap_or(Kind::Individual),
                title: r.get(1)?,
                first_name: r.get(2)?,
                last_name: r.get(3)?,
                nickname: r.get(4)?,
                name: r.get(5)?,
                birth_date: r.get(6)?,
                is_deceased: r.get(7)?,
                deceased_date: r.get(8)?,
            })
        },
    )
}

impl Contract for ContactDetails {
    const NAME: &'static str = "contacts.details";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contacts";
    const COUNTER: &'static str = "details_version";
    type Payload = Details;
    type State = Details;

    fn prepare(&self, payload: Details) -> Result<Details, ContractError> {
        prepare_details(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Details, ContractError> {
        Ok(load_details(tx.read(), id)?)
    }

    fn apply(
        &self,
        current: Option<&Details>,
        p: &Details,
        _: &Command,
    ) -> Result<Details, ContractError> {
        let mut next = p.clone();
        if let Some(current) = current {
            if current.kind != p.kind {
                // CiviCRM allows it; that is a bug farm, not a feature.
                return Err(ContractError::rejected(
                    "kind_change",
                    format!("Contact is {}; kind cannot change", current.kind.as_str()),
                ));
            }
            // Create-only.
            next.client_key = None;
        }
        Ok(next)
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&Details>,
        n: &Details,
    ) -> Result<(), ContractError> {
        let (display, sort) = computed_names(n.kind, &n.first_name, &n.last_name, &n.name);
        let sort_key = fold(&sort);
        if before.is_some() {
            tx.prepare_cached(
                "UPDATE contacts SET title = ?2, first_name = ?3, last_name = ?4,
                     nickname = ?5, name = ?6, birth_date = ?7, is_deceased = ?8,
                     deceased_date = ?9, display_name = ?10, sort_name = ?11, sort_key = ?12
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                n.title,
                n.first_name,
                n.last_name,
                n.nickname,
                n.name,
                n.birth_date,
                n.is_deceased,
                n.deceased_date,
                display,
                sort,
                sort_key
            ])?;
            return Ok(());
        }
        if let Some(key) = &n.client_key {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM contacts WHERE client_key = ?1",
                    [key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                // The command already ran (double submit, retried import).
                return Err(ContractError::Duplicate { id: existing });
            }
        }
        // After the duplicate check, so a refused create takes no number.
        let number = take_number(tx)?;
        tx.prepare_cached(
            "INSERT INTO contacts (number, id, client_key, kind, title, first_name, last_name,
                 nickname, name, birth_date, is_deceased, deceased_date, display_name,
                 sort_name, sort_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?
        .execute(params![
            number,
            id,
            n.client_key,
            n.kind.as_str(),
            n.title,
            n.first_name,
            n.last_name,
            n.nickname,
            n.name,
            n.birth_date,
            n.is_deceased,
            n.deceased_date,
            display,
            sort,
            sort_key
        ])?;
        Ok(())
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        Ok(rebuild_search(tx, id)?)
    }
}

// ── child rows ─────────────────────────────────────────────────────────────

impl ChildRow for EmailRow {
    fn id(&self) -> &str {
        self.key.as_deref().unwrap_or("")
    }
    fn identity(&self) -> Option<&str> {
        Some(&self.address)
    }
}

impl ChildRow for PhoneRow {
    fn id(&self) -> &str {
        self.key.as_deref().unwrap_or("")
    }
    fn identity(&self) -> Option<&str> {
        Some(&self.number)
    }
}

impl ChildRow for AddressRow {
    fn id(&self) -> &str {
        self.key.as_deref().unwrap_or("")
    }
}

/// A key new to this contact that another contact's row holds is refused
/// (the insert would otherwise hit the primary key).
fn check_ownership<T: ChildRow>(
    tx: &Connection,
    table: &str,
    contact_id: &str,
    added: &[&T],
) -> Result<(), ContractError> {
    let mut stmt = tx.prepare_cached(&format!("SELECT contact_id FROM {table} WHERE id = ?1"))?;
    for row in added {
        let owner: Option<String> = stmt.query_row([row.id()], |r| r.get(0)).optional()?;
        if owner.is_some_and(|o| o != contact_id) {
            return Err(ContractError::rejected(
                "child_ownership",
                format!("{table} row {} belongs to another contact", row.id()),
            ));
        }
    }
    Ok(())
}

/// Delete removed rows, then set every kept or new row's position.
fn remove_rows<T: ChildRow>(tx: &Connection, table: &str, removed: &[&T]) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached(&format!("DELETE FROM {table} WHERE id = ?1"))?;
    for row in removed {
        stmt.execute([row.id()])?;
    }
    Ok(())
}

fn position_of<T: ChildRow>(rows: &[T], id: &str) -> i64 {
    rows.iter().position(|r| r.id() == id).unwrap_or(0) as i64
}

fn set_positions<T: ChildRow>(tx: &Connection, table: &str, rows: &[T]) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached(&format!(
        "UPDATE {table} SET position = ?2 WHERE id = ?1 AND position != ?2"
    ))?;
    for (i, row) in rows.iter().enumerate() {
        stmt.execute(params![row.id(), i as i64])?;
    }
    Ok(())
}

pub(crate) fn load_methods(conn: &Connection, id: &str) -> rusqlite::Result<Methods> {
    let emails = conn
        .prepare_cached(
            "SELECT id, label, address, is_primary FROM contact_emails
             WHERE contact_id = ?1 ORDER BY position",
        )?
        .query_map([id], |r| {
            Ok(EmailRow {
                key: Some(r.get(0)?),
                label: ChannelLabel::parse(&r.get::<_, String>(1)?),
                address: r.get(2)?,
                is_primary: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let phones = conn
        .prepare_cached(
            "SELECT id, label, number, is_primary FROM contact_phones
             WHERE contact_id = ?1 ORDER BY position",
        )?
        .query_map([id], |r| {
            Ok(PhoneRow {
                key: Some(r.get(0)?),
                label: ChannelLabel::parse(&r.get::<_, String>(1)?),
                number: r.get(2)?,
                is_primary: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Methods { emails, phones })
}

impl Contract for ContactMethods {
    const NAME: &'static str = "contacts.methods";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contacts";
    const COUNTER: &'static str = "methods_version";
    type Payload = Methods;
    type State = Methods;

    fn prepare(&self, payload: Methods) -> Result<Methods, ContractError> {
        prepare_methods(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Methods, ContractError> {
        Ok(load_methods(tx.read(), id)?)
    }

    fn apply(
        &self,
        current: Option<&Methods>,
        p: &Methods,
        _: &Command,
    ) -> Result<Methods, ContractError> {
        current.ok_or_else(|| no_root(Self::NAME))?;
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&Methods>,
        next: &Methods,
    ) -> Result<(), ContractError> {
        let before = before.ok_or_else(|| no_root(Self::NAME))?;
        let emails = reconcile("emails", &before.emails, &next.emails)?;
        let phones = reconcile("phones", &before.phones, &next.phones)?;
        check_ownership(tx, "contact_emails", id, &emails.added)?;
        check_ownership(tx, "contact_phones", id, &phones.added)?;

        remove_rows(tx, "contact_emails", &emails.removed)?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO contact_emails
                 (id, contact_id, position, label, address, address_normalized, is_primary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for e in &emails.added {
            insert.execute(params![
                e.id(),
                id,
                position_of(&next.emails, e.id()),
                e.label.as_str(),
                e.address,
                // Derived from the identity field, so it never changes per key.
                normalise_email(&e.address),
                e.is_primary
            ])?;
        }
        let mut update = tx.prepare_cached(
            "UPDATE contact_emails SET label = ?2, is_primary = ?3 WHERE id = ?1",
        )?;
        for e in &emails.changed {
            update.execute(params![e.id(), e.label.as_str(), e.is_primary])?;
        }
        set_positions(tx, "contact_emails", &next.emails)?;

        remove_rows(tx, "contact_phones", &phones.removed)?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO contact_phones
                 (id, contact_id, position, label, number, number_normalized, is_primary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for p in &phones.added {
            insert.execute(params![
                p.id(),
                id,
                position_of(&next.phones, p.id()),
                p.label.as_str(),
                p.number,
                normalise_phone(&p.number),
                p.is_primary
            ])?;
        }
        let mut update = tx.prepare_cached(
            "UPDATE contact_phones SET label = ?2, is_primary = ?3 WHERE id = ?1",
        )?;
        for p in &phones.changed {
            update.execute(params![p.id(), p.label.as_str(), p.is_primary])?;
        }
        set_positions(tx, "contact_phones", &next.phones)?;
        Ok(())
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        Ok(rebuild_search(tx, id)?)
    }
}

pub(crate) fn load_addresses(conn: &Connection, id: &str) -> rusqlite::Result<Addresses> {
    let addresses = conn
        .prepare_cached(
            "SELECT id, label, line1, line2, line3, town, postcode, country, is_primary
             FROM contact_addresses WHERE contact_id = ?1 ORDER BY position",
        )?
        .query_map([id], |r| {
            Ok(AddressRow {
                key: Some(r.get(0)?),
                label: ChannelLabel::parse(&r.get::<_, String>(1)?),
                line1: r.get(2)?,
                line2: r.get(3)?,
                line3: r.get(4)?,
                town: r.get(5)?,
                postcode: r.get(6)?,
                country: r.get(7)?,
                is_primary: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Addresses { addresses })
}

impl Contract for ContactAddresses {
    const NAME: &'static str = "contacts.addresses";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contacts";
    const COUNTER: &'static str = "addresses_version";
    type Payload = Addresses;
    type State = Addresses;

    fn prepare(&self, payload: Addresses) -> Result<Addresses, ContractError> {
        prepare_addresses(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Addresses, ContractError> {
        Ok(load_addresses(tx.read(), id)?)
    }

    fn apply(
        &self,
        current: Option<&Addresses>,
        p: &Addresses,
        _: &Command,
    ) -> Result<Addresses, ContractError> {
        current.ok_or_else(|| no_root(Self::NAME))?;
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&Addresses>,
        next: &Addresses,
    ) -> Result<(), ContractError> {
        let before = before.ok_or_else(|| no_root(Self::NAME))?;
        // No identity field: the key is the identity, every field correctable.
        let rows = reconcile("addresses", &before.addresses, &next.addresses)?;
        check_ownership(tx, "contact_addresses", id, &rows.added)?;
        remove_rows(tx, "contact_addresses", &rows.removed)?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO contact_addresses (id, contact_id, position, label, line1, line2,
                 line3, town, postcode, country, is_primary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for a in &rows.added {
            insert.execute(params![
                a.id(),
                id,
                position_of(&next.addresses, a.id()),
                a.label.as_str(),
                a.line1,
                a.line2,
                a.line3,
                a.town,
                a.postcode,
                a.country,
                a.is_primary
            ])?;
        }
        let mut update = tx.prepare_cached(
            "UPDATE contact_addresses SET label = ?2, line1 = ?3, line2 = ?4, line3 = ?5,
                 town = ?6, postcode = ?7, country = ?8, is_primary = ?9
             WHERE id = ?1",
        )?;
        for a in &rows.changed {
            update.execute(params![
                a.id(),
                a.label.as_str(),
                a.line1,
                a.line2,
                a.line3,
                a.town,
                a.postcode,
                a.country,
                a.is_primary
            ])?;
        }
        set_positions(tx, "contact_addresses", &next.addresses)?;
        Ok(())
    }

    fn project(&self, tx: &ProjectionTx, id: &str) -> Result<(), ContractError> {
        Ok(rebuild_search(tx, id)?)
    }
}

// ── archive ────────────────────────────────────────────────────────────────

impl Contract for ContactArchive {
    const NAME: &'static str = "contacts.archive";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contacts";
    const COUNTER: &'static str = "archive_version";
    type Payload = Archive;
    type State = Archive;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Archive, ContractError> {
        Ok(tx
            .read()
            .query_row("SELECT archived FROM contacts WHERE id = ?1", [id], |r| {
                Ok(Archive {
                    archived: r.get(0)?,
                })
            })?)
    }

    fn apply(
        &self,
        current: Option<&Archive>,
        p: &Archive,
        _: &Command,
    ) -> Result<Archive, ContractError> {
        current.ok_or_else(|| no_root(Self::NAME))?;
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&Archive>,
        next: &Archive,
    ) -> Result<(), ContractError> {
        tx.execute(
            "UPDATE contacts SET archived = ?2 WHERE id = ?1",
            params![id, next.archived],
        )?;
        Ok(())
    }
    // No projection: search joins `contacts` for archived.
}

// ── dropdown field values ──────────────────────────────────────────────────

/// `contacts.fields` as stored, plus what its checks need (not serialised:
/// a stale refusal's `current` is just `{values}`).
#[derive(Clone, Debug, Serialize)]
pub struct FieldState {
    pub values: Vec<FieldValue>,
    #[serde(skip)]
    kind: Option<Kind>,
    #[serde(skip)]
    restoring: bool,
}

pub(crate) fn load_field_values(conn: &Connection, id: &str) -> rusqlite::Result<Vec<FieldValue>> {
    conn.prepare_cached(
        "SELECT field_id, option_id FROM contact_field_values
         WHERE contact_id = ?1 ORDER BY field_id",
    )?
    .query_map([id], |r| {
        Ok(FieldValue {
            field_id: r.get(0)?,
            option_id: r.get(1)?,
        })
    })?
    .collect()
}

/// A field value `contacts.fields` refuses, and why.
#[derive(Clone, Debug)]
pub struct FieldRefusal {
    pub field_id: String,
    pub reason: &'static str,
    pub message: String,
}

/// What a value newly set (not already `held`) needs.
enum Mode {
    Save,
    Restore,
}

/// The tier-1 rule for each value (Convex `fieldValueVerdict`): the field
/// and option exist and belong together; a value already on the contact
/// is fine whatever changed since; a value newly set must suit the
/// contact's kind and, on a save, have an active field and option (a
/// restore may put back an archived one). Returns the refusals and the
/// options going on the contact for the first time.
fn check_values(
    conn: &Connection,
    kind: Kind,
    held: &[FieldValue],
    values: &[FieldValue],
    mode: Mode,
) -> rusqlite::Result<(Vec<FieldRefusal>, Vec<String>)> {
    let held: HashSet<(&str, &str)> = held
        .iter()
        .map(|v| (v.field_id.as_str(), v.option_id.as_str()))
        .collect();
    let mut refused = Vec::new();
    let mut newly = Vec::new();
    for v in values {
        let field = field_row(conn, &v.field_id)?;
        let option = option_row(conn, &v.option_id)?;
        let no = |reason, message: String| FieldRefusal {
            field_id: v.field_id.clone(),
            reason,
            message,
        };
        let (Some(field), Some(option)) = (field, option) else {
            refused.push(no(
                "unknown_field",
                "That field or option does not exist".into(),
            ));
            continue;
        };
        if option.field_id != field.id {
            refused.push(no(
                "unknown_option",
                format!("That option is not one of {}'s", field.label),
            ));
            continue;
        }
        if held.contains(&(v.field_id.as_str(), v.option_id.as_str())) {
            continue;
        }
        if let Some(r) = new_value_refusal(&field, &option, kind, &mode) {
            refused.push(no(r.0, r.1));
            continue;
        }
        if !option.used {
            newly.push(option.id);
        }
    }
    Ok((refused, newly))
}

fn new_value_refusal(
    field: &FieldRow,
    option: &OptionRow,
    kind: Kind,
    mode: &Mode,
) -> Option<(&'static str, String)> {
    if !field.applies_to.contains(&kind) {
        return Some((
            "wrong_kind",
            format!("{} doesn't apply to a {}", field.label, kind.as_str()),
        ));
    }
    if matches!(mode, Mode::Save) {
        if !field.is_active {
            return Some((
                "archived_field",
                format!("{} has been archived", field.label),
            ));
        }
        if !option.is_active {
            return Some((
                "archived_option",
                format!("{} has been archived: choose another", option.label),
            ));
        }
    }
    None
}

/// The form's pre-check: every refusal, so each is reported on its field
/// while the other slices save.
pub fn field_refusals(
    conn: &Connection,
    contact_id: &str,
    values: &[FieldValue],
) -> rusqlite::Result<Vec<FieldRefusal>> {
    let Some(kind) = contact_kind(conn, contact_id)? else {
        return Ok(vec![]);
    };
    let held = load_field_values(conn, contact_id)?;
    Ok(check_values(conn, kind, &held, values, Mode::Save)?.0)
}

impl Contract for ContactFieldValues {
    const NAME: &'static str = "contacts.fields";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contacts";
    const COUNTER: &'static str = "fields_version";
    type Payload = FieldValues;
    type State = FieldState;

    fn prepare(&self, payload: FieldValues) -> Result<FieldValues, ContractError> {
        prepare_fields(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<FieldState, ContractError> {
        Ok(FieldState {
            values: load_field_values(tx.read(), id)?,
            kind: contact_kind(tx.read(), id)?,
            restoring: false,
        })
    }

    fn apply(
        &self,
        current: Option<&FieldState>,
        p: &FieldValues,
        command: &Command,
    ) -> Result<FieldState, ContractError> {
        let current = current.ok_or_else(|| no_root(Self::NAME))?;
        Ok(FieldState {
            values: p.values.clone(),
            kind: current.kind,
            restoring: command.source == contracts::Source::Restore,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&FieldState>,
        next: &FieldState,
    ) -> Result<(), ContractError> {
        let before = before.ok_or_else(|| no_root(Self::NAME))?;
        let kind = before.kind.ok_or(ContractError::NotFound)?;
        let mode = if next.restoring {
            Mode::Restore
        } else {
            Mode::Save
        };
        let (refused, newly) = check_values(tx, kind, &before.values, &next.values, mode)?;
        if let Some(r) = refused.into_iter().next() {
            return Err(ContractError::rejected(r.reason, r.message));
        }
        tx.execute(
            "DELETE FROM contact_field_values WHERE contact_id = ?1",
            [id],
        )?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO contact_field_values (contact_id, field_id, option_id) VALUES (?1, ?2, ?3)",
        )?;
        for v in &next.values {
            insert.execute(params![id, v.field_id, v.option_id])?;
        }
        // System-owned, never cleared: the option has been on a contact.
        let mut mark = tx.prepare_cached(
            "UPDATE contact_field_options SET used = 1 WHERE id = ?1 AND used = 0",
        )?;
        for option in newly {
            mark.execute([option])?;
        }
        Ok(())
    }

    /// What a restore can write back now: a value whose field no longer
    /// suits the contact's kind (or is gone) is left out, and the field
    /// keeps what the contact holds now. Applied *and* recorded.
    fn restore_payload(
        &self,
        tx: &OrgTx,
        mut p: FieldValues,
        current: &FieldState,
    ) -> Result<FieldValues, ContractError> {
        let Some(kind) = current.kind else {
            return Ok(p);
        };
        let held: HashMap<&str, &FieldValue> = current
            .values
            .iter()
            .map(|v| (v.field_id.as_str(), v))
            .collect();
        let mut out = Vec::new();
        let mut skipped = HashSet::new();
        for v in p.values.drain(..) {
            let fits = match field_row(tx.read(), &v.field_id)? {
                Some(f) => {
                    f.applies_to.contains(&kind)
                        || held
                            .get(v.field_id.as_str())
                            .is_some_and(|h| h.option_id == v.option_id)
                }
                None => false,
            };
            if fits {
                out.push(v);
            } else {
                skipped.insert(v.field_id.clone());
            }
        }
        for field_id in skipped {
            if let Some(h) = held.get(field_id.as_str()) {
                out.push((*h).clone());
            }
        }
        sort_values(&mut out);
        Ok(FieldValues { values: out })
    }
}
