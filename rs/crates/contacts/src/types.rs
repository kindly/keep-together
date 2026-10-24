//! Wire types: contract payloads (each the full state of its slice, as on
//! Convex) and read shapes. `camelCase`; child rows carry `key` (ADR 0014),
//! the same name the SPA's form state uses, so the spike-04 reducer takes
//! them unchanged.

use std::collections::BTreeMap;

use contracts::Problem;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "ContactKind")]
pub enum Kind {
    Individual,
    Organization,
    Household,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::Individual, Kind::Organization, Kind::Household];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Individual => "individual",
            Kind::Organization => "organization",
            Kind::Household => "household",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ChannelLabel {
    Home,
    Work,
    Other,
}

impl ChannelLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelLabel::Home => "home",
            ChannelLabel::Work => "work",
            ChannelLabel::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "home" => ChannelLabel::Home,
            "work" => ChannelLabel::Work,
            _ => ChannelLabel::Other,
        }
    }
}

/// `contacts.details`. `clientKey` is create-only (an idempotency key).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ContactDetails")]
pub struct Details {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_key: Option<String>,
    pub kind: Kind,
    pub title: String,
    pub first_name: String,
    pub last_name: String,
    pub nickname: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub birth_date: Option<String>,
    pub is_deceased: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deceased_date: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EmailRow {
    /// Omitted = a new row; the contract mints it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    pub label: ChannelLabel,
    /// Identity: immutable per key. Malformed is storable (warned).
    pub address: String,
    pub is_primary: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PhoneRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    pub label: ChannelLabel,
    /// Identity: immutable per key.
    pub number: String,
    pub is_primary: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AddressRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    pub label: ChannelLabel,
    pub line1: String,
    pub line2: String,
    pub line3: String,
    pub town: String,
    pub postcode: String,
    pub country: String,
    pub is_primary: bool,
}

/// `contacts.methods`: emails and phones.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ContactMethods")]
pub struct Methods {
    pub emails: Vec<EmailRow>,
    pub phones: Vec<PhoneRow>,
}

/// `contacts.addresses`: no identity field, every field editable in place.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ContactAddresses")]
pub struct Addresses {
    pub addresses: Vec<AddressRow>,
}

/// `contacts.archive`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ContactArchive")]
pub struct Archive {
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldValue {
    pub field_id: String,
    pub option_id: String,
}

/// `contacts.fields`: every field with a value on the contact, at most one
/// option each, in field-id order. A field left out is not set.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ContactFieldValues")]
pub struct FieldValues {
    pub values: Vec<FieldValue>,
}

/// Every slice's counter, as the form tracks them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ContactCounters")]
pub struct Counters {
    #[ts(type = "number")]
    pub details: i64,
    #[ts(type = "number")]
    pub methods: i64,
    #[ts(type = "number")]
    pub addresses: i64,
    #[ts(type = "number")]
    pub archive: i64,
    #[ts(type = "number")]
    pub fields: i64,
    #[ts(type = "number")]
    pub identifiers: i64,
}

/// An advisory warning (ADR 0015 tier 2): storable but probably wrong.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ContactWarning")]
pub struct Warning {
    /// `emails.0` (row index), `emails#<key>` (about the row's identity),
    /// or empty for the whole contact.
    pub anchor: String,
    pub label: String,
    pub message: String,
}

/// `GET contacts/{id}`: the whole aggregate, every slice with its counter.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContactView {
    pub id: String,
    /// The sequence; `formatNumber` adds the check digit.
    #[ts(type = "number")]
    pub number: i64,
    pub kind: Kind,
    pub display_name: String,
    pub sort_name: String,
    pub archived: bool,
    pub details: Details,
    pub methods: Methods,
    pub addresses: Addresses,
    pub fields: FieldValues,
    pub counters: Counters,
    pub warnings: Vec<Warning>,
    /// In the order entered, named by their types.
    pub identifiers: Vec<crate::identifiers::IdentifierView>,
}

/// One row of the contacts list or a search.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContactRow {
    pub id: String,
    pub kind: Kind,
    pub display_name: String,
    pub sort_name: String,
    #[ts(type = "number")]
    pub number: i64,
    pub archived: bool,
    /// The primary (else first) email.
    pub email: Option<String>,
    /// Option ids, in field-id order (labels come from the definitions).
    pub field_option_ids: Vec<String>,
}

/// `GET contacts`: one keyset page in name order.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContactPage {
    pub rows: Vec<ContactRow>,
    /// Pass as `cursor` for the next page; null when `isDone`.
    pub next_cursor: Option<String>,
    pub is_done: bool,
}

/// `GET contacts/search`: one window, exact matches first.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchResult {
    pub rows: Vec<ContactRow>,
    /// More may match than `rows` holds.
    pub truncated: bool,
    /// Truncated with nothing to show.
    pub too_broad: bool,
    /// Full-text hits read.
    pub checked: u32,
    /// The row its contact number found, when that row is first.
    pub number_match: Option<String>,
    /// Six digits whose check digit is wrong, when nothing else matched.
    pub invalid_number: Option<String>,
}

/// The slices `POST contacts/{id}/save` takes; each with its `expected`.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct Expected<T> {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub slice: T,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum SaveSource {
    #[default]
    Ui,
    Autosave,
}

/// `POST contacts/{id}/save`: the contact form. Every slice provided is
/// diffed against the stored state; only changed ones execute.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveForm {
    #[serde(default)]
    #[ts(optional)]
    pub source: Option<SaveSource>,
    #[serde(default)]
    #[ts(optional)]
    pub details: Option<Expected<Details>>,
    #[serde(default)]
    #[ts(optional)]
    pub methods: Option<Expected<Methods>>,
    #[serde(default)]
    #[ts(optional)]
    pub addresses: Option<Expected<Addresses>>,
    #[serde(default)]
    #[ts(optional)]
    pub fields: Option<Expected<FieldValues>>,
    #[serde(default)]
    #[ts(optional)]
    pub identifiers: Option<Expected<crate::identifiers::Identifiers>>,
}

/// A form problem; `key` names the row or field it is about.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[ts(export, rename = "FormProblem")]
pub struct FormProblem {
    pub field: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    /// The other contact a problem names (an identifier it holds).
    #[serde(rename = "contactId", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contact_id: Option<String>,
}

impl From<Problem> for FormProblem {
    fn from(p: Problem) -> Self {
        Self {
            field: p.field,
            message: p.message,
            key: None,
            contact_id: None,
        }
    }
}

/// What a form save did, in the shape the SPA's `SaveResult` has, plus
/// `current`: each stale slice's state now, so the form merges and retries
/// without another read. Slices are named `details`, `methods`,
/// `addresses`, `fields`.
#[derive(Clone, Debug, Default, Serialize, TS)]
#[ts(export)]
pub struct SaveFormResult {
    pub saved: Vec<String>,
    pub problems: BTreeMap<String, Vec<FormProblem>>,
    /// Stale slices and their counter now; they weren't saved.
    #[ts(type = "Record<string, number>")]
    pub stale: BTreeMap<String, i64>,
    #[ts(type = "Record<string, unknown>")]
    pub current: BTreeMap<String, serde_json::Value>,
    pub counters: Counters,
}

/// `POST contacts`: a new contact (its details; other slices are saved
/// with the form). `id` is optional: a pre-generated one makes the create
/// idempotent, as does `clientKey`.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct CreateContact {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub details: Details,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct Created {
    pub id: String,
    #[ts(type = "number")]
    pub number: i64,
}

/// `POST contacts/{id}/archive`
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SetArchived {
    #[ts(type = "number")]
    pub expected: i64,
    pub archived: bool,
}

/// `POST contacts/{id}/restore`: one revision, or the whole contact as it
/// was at `at` (ms; archive excluded, it has its own toggle).
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum RestoreRequest {
    Revision {
        #[serde(rename = "revisionId")]
        #[ts(type = "number")]
        revision_id: i64,
    },
    At {
        #[ts(type = "number")]
        at: i64,
    },
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct Restored {
    /// The contracts that ran (empty: already in that state).
    pub restored: Vec<String>,
}

/// `GET contacts/{id}/history`: newest first.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryPage {
    pub revisions: Vec<contracts::Revision>,
    /// Pass as `before` for older revisions; null at the start.
    #[ts(type = "number | null")]
    pub next_before: Option<i64>,
}

// ── dropdown fields ────────────────────────────────────────────────────────

/// `contacts.field`: what an editor can change about a field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldPayload {
    pub label: String,
    pub applies_to: Vec<Kind>,
    pub is_active: bool,
}

/// `contacts.fieldOption`. `fieldId` is fixed at create; `used` is
/// system-owned.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldOptionPayload {
    pub field_id: String,
    pub label: String,
    pub position: u32,
    pub is_active: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldOptionView {
    pub id: String,
    pub field_id: String,
    pub label: String,
    pub position: u32,
    pub is_active: bool,
    /// Has been on a contact.
    pub used: bool,
    #[ts(type = "number")]
    pub save_version: i64,
}

/// `GET fields`: a field with its options in the admin's order.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldDefinition {
    pub id: String,
    pub label: String,
    pub applies_to: Vec<Kind>,
    pub is_active: bool,
    #[ts(type = "number")]
    pub save_version: i64,
    pub options: Vec<FieldOptionView>,
}

/// `POST fields`: create a field (no `id`) or save one (`id` + `expected`).
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SaveField {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected: Option<i64>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: FieldPayload,
}

/// `POST fields/options`: create an option (no `id`) or save one.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SaveFieldOption {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected: Option<i64>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: FieldOptionPayload,
}
