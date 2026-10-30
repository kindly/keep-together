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
        // 10: a field's retire phase, field and option delete logs (B1)
        M::up(contacts::fields::MIGRATION_RETIRE),
        // 11: gifts, their allocations and the allocation projection (B2)
        M::up(giving::MIGRATION),
        // 12: Gift Aid declarations (B2)
        M::up(giftaid::MIGRATION),
        // 13: the recovery generation in event cursors (C1 fix)
        M::up(crate::events::MIGRATION),
        // 14: a Gift Aid declaration's details counter (snapshot editable)
        M::up(giftaid::MIGRATION_DETAILS),
        // 15: Gift Aid claims, their lines and adjustments, HMRC details
        M::up(giftaid::MIGRATION_CLAIMS),
        // 16: a gift's void reason and claim lock
        M::up(giving::MIGRATION_CLAIM_LOCK),
        // 17: Direct Debit: `gifts.method` widened (a rebuild), regular
        // gifts and their payments (GoCardless D2)
        M::up_with_hook(
            "",
            rebuild_with_deferred_keys(giving::MIGRATION_DIRECT_DEBIT),
        ),
        // 18: gifts are every payment attempt (ADR 0025): `gifts.status`
        // widened and the provider columns (a rebuild), Direct Debit
        // payments rebuilt, one gift per payment backfilled
        M::up_with_hook("", rebuild_with_deferred_keys(giving::MIGRATION_UNIFIED)),
        // 19: scanned Gift Aid declarations and their pages (the images
        // are in the org's files db: `store::files`)
        M::up(giftaid::MIGRATION_SCANS),
        // 20: regular gift terms are a dated chain (ADR 0026):
        // `regular_gifts` rebuilt without its terms, the terms and their
        // split backfilled as each one's first row, `scheduled_on`
        M::up_with_hook("", rebuild_with_deferred_keys(giving::terms::MIGRATION)),
        // 21: bank transfers (ADR 0027): bank accounts, statement imports
        // and their credit lines, remembered payers, not-a-donation rules,
        // paying-in batches; `gifts` rebuilt with `bank_transfer` and
        // `cheque` and its line and batch; `regular_gifts.kind`
        M::up_with_hook("", rebuild_with_deferred_keys(BANK_TRANSFERS)),
        // 22: matching statement lines (bank transfers step 4): a
        // contact's remembered payers forgotten, and matched lines by
        // payer key
        M::up(banking::matching::MIGRATION),
        // 23: standing orders (bank transfers step 5): the terms'
        // frequency widened to quarterly (a rebuild), a standing order's
        // bank reference and its missed flag
        M::up_with_hook("", rebuild_with_deferred_keys(giving::standing::MIGRATION)),
    ])
}

/// Step 21 (ADR 0027): the bank transfers step, held by `giving` (its
/// gifts and batches point at the statement side) so the domain crates'
/// tests migrate with it.
pub use giving::bank::MIGRATION as BANK_TRANSFERS;

/// A step that rebuilds a table other tables point at (drop, create,
/// copy back). Foreign keys can't be switched off inside the migration's
/// transaction, so they are deferred to its commit instead: the drop
/// orphans the child rows and the copy back finds their parents again.
/// Then `PRAGMA foreign_key_check` runs on the result, inside the hook,
/// and any row it finds fails the step: the deferred check only counts
/// on a connection with foreign keys on, and rusqlite_migration's own
/// `foreign_key_check()` runs before a hook, not after it.
/// `defer_foreign_keys` resets itself at the commit.
pub fn rebuild_with_deferred_keys(
    sql: &'static str,
) -> impl Fn(&rusqlite::Transaction) -> rusqlite_migration::HookResult + Clone + Send + Sync + 'static
{
    move |tx| {
        tx.pragma_update(None, "defer_foreign_keys", "ON")?;
        tx.execute_batch(sql)?;
        let orphans: Vec<(String, i64, String)> = tx
            .prepare("PRAGMA foreign_key_check")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        if let Some((table, rowid, parent)) = orphans.first() {
            return Err(rusqlite_migration::HookError::Hook(format!(
                "{} row(s) point at nothing after the rebuild (first: {table} rowid {rowid} → {parent})",
                orphans.len()
            )));
        }
        Ok(())
    }
}

/// `platform.db`'s per-crate schemas, run in this order after its base
/// schema. Each crate appends only to its own list.
pub const PLATFORM_SCHEMAS: &[PlatformSchema] = &[
    platform::SCHEMA,
    auth::SCHEMA,
    crate::jobs::SCHEMA,
    crate::address::SCHEMA,
    crate::gocardless::SCHEMA,
    crate::scans::SCHEMA,
];

/// A new organisation's reference data, in its file's first transaction
/// (`keep tenant create`, the dev seeds): each crate's `seed_new_org`, in
/// order. A crate with reference data adds its line here.
pub fn seed_new_org(ctx: &Ctx) -> Result<(), ContractError> {
    contacts::seed_new_org(ctx)?;
    sources::seed_new_org(ctx)?;
    Ok(())
}
