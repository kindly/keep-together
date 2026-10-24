//! The source-code API's request and response shapes (`camelCase` JSON,
//! exported to `src/lib/data/rust-types/` by `cargo test`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::rules::{DateStatus, Level};

/// The `sources.code` slice: everything about a part an editor can
/// change. `parentId` is create-only (it fixes the level for good) and is
/// left out of a save; `used` is system-owned and in no payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceCodePayload {
    /// Create only: absent makes a category, a category's id a detail, a
    /// detail's id a version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    /// YYYY-MM-DD; details and versions only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub end_date: Option<String>,
    pub is_active: bool,
}

/// `POST sources/{id}/save`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SaveSourceCode")]
pub struct SaveSourceCode {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: SourceCodePayload,
}

/// `POST sources/{id}/delete`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeleteSourceCode")]
pub struct DeleteSourceCode {
    #[ts(type = "number")]
    pub expected: i64,
}

/// `POST sources`: the new part, and for a new detail its first version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "CreatedSourceCode")]
pub struct Created {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version_id: Option<String>,
}

/// `POST sources/{id}/delete`: how many parts went (it and those under it).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeletedSourceCode")]
pub struct Deleted {
    #[ts(type = "number")]
    pub deleted: i64,
}

/// One part as the Settings tree shows it, in tree order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourceCodePart")]
pub struct Part {
    pub id: String,
    pub level: Level,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<String>,
    pub name: String,
    /// The names from the category down to this part, joined.
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub end_date: Option<String>,
    pub is_active: bool,
    /// It and every part above it active: it shows in the picker.
    pub visible: bool,
    /// Assigned at some time: only archive, never delete.
    pub used: bool,
    #[ts(type = "number")]
    pub save_version: i64,
}

/// `GET sources`: the tree, and whether the caller may change it.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourceCodeTree")]
pub struct Tree {
    pub parts: Vec<Part>,
    pub can_manage: bool,
}

/// One part as the contacts list's source filter shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourceFilterOption")]
pub struct FilterOption {
    pub id: String,
    pub level: Level,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<String>,
    pub name: String,
    pub is_active: bool,
}

/// An assignable code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourcePickerEntry")]
pub struct PickerEntry {
    pub version_id: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub status: DateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub end_date: Option<String>,
}

/// `GET sources/picker?today&search`
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourcePicker")]
pub struct Picker {
    pub codes: Vec<PickerEntry>,
    /// More matched than `codes` holds.
    pub truncated: bool,
}

/// `GET sources/picker` query string.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourcePickerQuery")]
pub struct PickerQuery {
    /// YYYY-MM-DD, the caller's date.
    pub today: String,
    #[serde(default)]
    #[ts(optional)]
    pub search: Option<String>,
}

/// A code by its version id: what contacts (and gifts) show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourceCodeDescription")]
pub struct CodeDescription {
    /// The full code, names joined by hyphens, e.g. `Street-Wesser-001`.
    pub code: String,
    pub version_id: String,
    pub detail_id: String,
    pub category_id: String,
    pub version_name: String,
    pub detail_name: String,
    pub category_name: String,
    /// False if the version or either parent is archived.
    pub is_active: bool,
    /// The version's dates, each bound falling back to its detail's.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub end_date: Option<String>,
}
