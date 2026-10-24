//! The org-file schema: one ordered, append-only list of migrations, run
//! on every org file when it opens (`PRAGMA user_version`). Never edit or
//! reorder a step that has shipped; add a new one.
//!
//! SQLite doesn't re-validate existing rows against a new schema the way a
//! Convex deploy does, so the two-phase loosen/backfill/tighten rule
//! becomes a per-migration judgement: a step that adds a constraint must
//! backfill (or refuse) in the same step.

use store::{M, Migrations};

pub fn org_migrations() -> Migrations<'static> {
    Migrations::new(vec![
        // 1: revisions + command groups
        M::up(contracts::MIGRATION),
        // 2: contacts, children, dropdown fields, both FTS variants
        M::up(contacts::MIGRATION),
        // 3: drop the trigram FTS variant
        M::up(contacts::DROP_TRIGRAM),
        // 4: identifiers and their types, notes, relationships and their types
        M::up(contacts::MIGRATION_IDENTIFIERS_NOTES),
        // 5: email suppressions
        M::up(comms::MIGRATION),
    ])
}
