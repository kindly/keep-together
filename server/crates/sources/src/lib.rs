//! Source codes: the Rust counterpart of `convex/sources/`. A domain
//! crate: depends on `contracts`, never on `store` or `platform`; it
//! can't name an organisation, the org file is the scope.
//!
//! Managing the list (create, save, delete) is for admins, and staff
//! while the organisation's "staff can manage source codes" switch is on:
//! the routes check that (`platform::may_manage_list`). Assigning a code
//! to a contact or a gift is ordinary staff editing, through
//! [`mark_used`].

pub mod code;
pub mod rules;
pub mod seed;
pub mod types;

use std::sync::LazyLock;

use contracts::{CommandGroup, ContractError, Ctx, Exec, Registry, Source, command_group, execute};

pub use code::{
    CODE, DELETION, DeletionPayload, PICKER_LIMIT, deleted_count, describe, filter_options,
    mark_used, picker, resolve_all, tree,
};
pub use rules::{Level, SOURCE_CODE_LIMIT};
pub use seed::{SeedDetail, SeedVersion, seed_details, seed_new_org};
pub use types::{CodeDescription, Created, SourceCodePayload};

use rules::FIRST_VERSION_NAME;

/// The org-schema migration this crate owns. A version's id is the code:
/// contacts and gifts reference it. `parent_id IS NULL` for a category;
/// sibling names are unique (`coalesce` so categories are siblings too).
pub const MIGRATION: &str = "
CREATE TABLE source_codes (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES source_codes (id),
    level TEXT NOT NULL CHECK (level IN ('category', 'detail', 'version')),
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL,
    description TEXT,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    save_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX source_codes_by_parent_name
    ON source_codes (coalesce(parent_id, ''), name_normalized);
CREATE INDEX source_codes_by_parent ON source_codes (parent_id);
CREATE TABLE source_code_deletions (
    id TEXT PRIMARY KEY,
    deleted INTEGER NOT NULL,
    delete_version INTEGER NOT NULL DEFAULT 0
) STRICT;
";

/// Every contract restore may meet in an org file's source-code history.
pub static REGISTRY: LazyLock<Registry> = LazyLock::new(|| Registry::new(&[&CODE, &DELETION]));

/// A new part (`payload.parentId` absent: a category). A new detail comes
/// with its first version, `001`, in one command group (`group`, or one
/// named after it), so it can be assigned at once (plan g2q4).
pub fn create_part(
    ctx: &Ctx,
    payload: SourceCodePayload,
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<Created, ContractError> {
    let parent_is_category = match payload.parent_id.as_deref() {
        Some(parent) => ctx
            .tx
            .read()
            .query_row(
                "SELECT level = 'category' FROM source_codes WHERE id = ?1",
                [parent],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false),
        None => false,
    };
    if !parent_is_category {
        let opts = match group {
            Some(g) => Exec::create(source).in_group(g),
            None => Exec::create(source),
        };
        let id = execute(ctx, &CODE, payload, opts)?.id;
        return Ok(Created {
            id,
            version_id: None,
        });
    }
    let own;
    let group = match group {
        Some(g) => g,
        None => {
            own = command_group(ctx, &format!("create {}", payload.name.trim()))?;
            &own
        }
    };
    let id = execute(ctx, &CODE, payload, Exec::create(source).in_group(group))?.id;
    let version_id = execute(
        ctx,
        &CODE,
        SourceCodePayload {
            parent_id: Some(id.clone()),
            name: FIRST_VERSION_NAME.into(),
            description: None,
            start_date: None,
            end_date: None,
            is_active: true,
        },
        Exec::create(source).in_group(group),
    )?
    .id;
    Ok(Created {
        id,
        version_id: Some(version_id),
    })
}
