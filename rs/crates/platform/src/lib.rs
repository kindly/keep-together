//! The control plane: tenants, memberships, preferences, groups.
//!
//! Preferences are organisation data, so they live in the org file and are
//! written through contracts like any slice; tenants and memberships live
//! in `platform.db`.

pub mod members;
pub mod preferences;

use std::sync::LazyLock;

use contracts::Registry;
use store::PlatformSchema;

pub use preferences::{ListKind, may_manage_list};
pub use store::Role;

/// This crate's own steps on `platform.db` (its version is tracked under
/// `platform` in `platform_schema`; auth keeps its own list). Append-only.
pub const SCHEMA: PlatformSchema = PlatformSchema {
    name: "platform",
    steps: &[
        // 1: when each member last opened the group (`opened`, `mine`)
        "ALTER TABLE memberships ADD COLUMN last_used_at INTEGER;",
    ],
};

/// Every contract restore may meet in an org file's platform history.
pub static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    Registry::new(&[
        &preferences::IDENTIFIER_TYPES,
        &preferences::SOURCE_CODES,
        &preferences::FIELDS,
    ])
});
