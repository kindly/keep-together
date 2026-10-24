//! The org-file schema: one ordered, append-only list of migrations, run
//! on every org file when it opens (`PRAGMA user_version`). Never edit or
//! reorder a step that has shipped; add a new one.
//!
//! SQLite doesn't re-validate existing rows against a new schema the way a
//! Convex deploy does, so the two-phase loosen/backfill/tighten rule
//! becomes a per-migration judgement: a step that adds a constraint must
//! backfill (or refuse) in the same step.

use contracts::{ContractError, Ctx};
use store::{M, Migrations, PlatformSchema};

pub fn org_migrations() -> Migrations<'static> {
    Migrations::new(vec![
        // 1: revisions + command groups
        M::up(contracts::MIGRATION),
        // 2: contacts, children, dropdown fields, both FTS variants
        M::up(contacts::MIGRATION),
        // 3: drop the trigram FTS variant
        M::up(contacts::DROP_TRIGRAM),
        // 4: tenant preferences (the three "staff can manage" switches)
        M::up(platform::preferences::MIGRATION),
        // 5: tenant settings (encrypted secrets)
        M::up(platform::settings::MIGRATION),
        // 6: identifiers and their types, notes, relationships and their types
        M::up(contacts::MIGRATION_IDENTIFIERS_NOTES),
        // 7: email suppressions
        M::up(comms::MIGRATION),
        // 8: source codes (A2)
        M::up(sources::MIGRATION),
        // 9: a contact's acquisition code (A2)
        M::up(contacts::acquisition::MIGRATION),
        // 10: gifts, their allocations and the allocation projection (B2)
        M::up(giving::MIGRATION),
        // 11: Gift Aid declarations (B2)
        M::up(giftaid::MIGRATION),
    ])
}

/// `platform.db`'s per-crate schemas, run in this order after its base
/// schema. Each crate appends only to its own list.
pub const PLATFORM_SCHEMAS: &[PlatformSchema] = &[platform::SCHEMA, auth::SCHEMA];

/// A new organisation's reference data, in its file's first transaction
/// (`keep tenant create`, the dev seeds): each crate's `seed_new_org`, in
/// order. A crate with reference data adds its line here.
pub fn seed_new_org(ctx: &Ctx) -> Result<(), ContractError> {
    contacts::seed_new_org(ctx)?;
    Ok(())
}
