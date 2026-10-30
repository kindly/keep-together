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
    ])
}

/// Step 21 (ADR 0027, plan `factory/plans/bank-transfers.sv`). It spans
/// two modules, so it lives here: the statement side is `banking`'s
/// (accounts, imports, lines, payers, rules), the batches and the gifts
/// `giving`'s.
///
/// - `bank_lines` is the outside record, as `direct_debit_payments` is
///   for GoCardless: credits only (`amount > 0`), its content written
///   once by the import; `dedupe_key` + `occurrence` find the same line
///   in an overlapping file (most UK CSVs carry no id), `bank_id` too
///   when the format has one. `match_state`, `match_note` and
///   `match_version` are `banking.lineMatch`'s slice; the gifts a line
///   became point at it (`gifts.bank_line_id`), and a batch matched to it
///   says so (`paying_in_batches.line_id`): one link each way, never both.
/// - `bank_payers` is derived (`banking.lineMatch`'s projection): no
///   counter. A contact's rows go on erasure (rule 3).
/// - `gifts` is rebuilt (SQLite can't widen the method's CHECK in place)
///   with every column and index it has by step 20, plus `bank_line_id`
///   and `paying_in_batch_id`. A gift has one origin: a provider, or a
///   statement line, or staff (ADR 0025 decision 1, ADR 0027).
pub const BANK_TRANSFERS: &str = "
CREATE TABLE bank_accounts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    sort_code TEXT NOT NULL DEFAULT '',
    account_last4 TEXT NOT NULL DEFAULT '',
    default_source_code_id TEXT REFERENCES source_codes (id),
    csv_mapping TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE bank_imports (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    file_name TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('csv', 'ofx', 'qif')),
    preset TEXT,
    first_date TEXT,
    last_date TEXT,
    new_lines INTEGER NOT NULL DEFAULT 0 CHECK (new_lines >= 0),
    duplicate_lines INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_lines >= 0),
    imported_by INTEGER,
    imported_at INTEGER NOT NULL,
    -- `banking.import`'s counter: create-only, but a contract all the same.
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX bank_imports_by_account ON bank_imports (account_id, seq);

CREATE TABLE bank_lines (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    import_id TEXT NOT NULL REFERENCES bank_imports (id),
    posted_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    payer TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    narrative TEXT NOT NULL DEFAULT '',
    bank_id TEXT,
    dedupe_key TEXT NOT NULL,
    occurrence INTEGER NOT NULL CHECK (occurrence >= 1),
    match_state TEXT NOT NULL DEFAULT 'unmatched'
        CHECK (match_state IN ('unmatched', 'matched', 'not_donation')),
    match_note TEXT,
    matched_by INTEGER,
    matched_at INTEGER,
    match_version INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, dedupe_key, occurrence)
) STRICT;
CREATE UNIQUE INDEX bank_lines_by_bank_id ON bank_lines (account_id, bank_id)
    WHERE bank_id IS NOT NULL;
CREATE INDEX bank_lines_by_state ON bank_lines (account_id, match_state, posted_on);
CREATE INDEX bank_lines_by_import ON bank_lines (import_id, seq);

CREATE TABLE bank_payers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    payer_key TEXT NOT NULL,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    payer TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    last_line_id TEXT REFERENCES bank_lines (id),
    matched_at INTEGER NOT NULL,
    UNIQUE (account_id, payer_key, contact_id)
) STRICT;
CREATE INDEX bank_payers_by_contact ON bank_payers (contact_id);

CREATE TABLE bank_rules (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT REFERENCES bank_accounts (id),
    field TEXT NOT NULL CHECK (field IN ('narrative', 'payer', 'reference')),
    contains TEXT NOT NULL CHECK (contains <> ''),
    action TEXT NOT NULL DEFAULT 'not_donation' CHECK (action IN ('not_donation')),
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE paying_in_batches (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES bank_accounts (id),
    slip_number TEXT NOT NULL DEFAULT '',
    banked_on TEXT,
    total INTEGER CHECK (total IS NULL OR total >= 0),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'matched')),
    line_id TEXT UNIQUE REFERENCES bank_lines (id),
    opened_by INTEGER,
    opened_at INTEGER NOT NULL,
    closed_by INTEGER,
    closed_at INTEGER,
    version INTEGER NOT NULL DEFAULT 0,
    CHECK ((status = 'matched') = (line_id IS NOT NULL)),
    CHECK (status = 'open' OR total IS NOT NULL)
) STRICT;
CREATE INDEX paying_in_batches_by_account ON paying_in_batches (account_id, status, seq);

ALTER TABLE regular_gifts ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct_debit'
    CHECK (kind IN ('direct_debit', 'standing_order'));

CREATE TABLE gifts_widen AS SELECT * FROM gifts;
DROP TABLE gifts;
CREATE TABLE gifts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    received_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL
        CHECK (method IN ('cash', 'card', 'direct_debit', 'bank_transfer', 'cheque')),
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed',
        'cancelled', 'refunded', 'charged_back', 'void')),
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    client_key TEXT UNIQUE,
    gift_version INTEGER NOT NULL DEFAULT 0,
    status_version INTEGER NOT NULL DEFAULT 0,
    void_reason TEXT,
    claim_id TEXT,
    claim_lock_version INTEGER NOT NULL DEFAULT 0,
    provider TEXT CHECK (provider IN ('gocardless', 'stripe')),
    provider_payment_id TEXT CHECK (provider_payment_id IS NULL OR provider IS NOT NULL),
    regular_gift_id TEXT REFERENCES regular_gifts (id),
    scheduled_on TEXT,
    bank_line_id TEXT REFERENCES bank_lines (id)
        CHECK (bank_line_id IS NULL OR provider IS NULL),
    paying_in_batch_id TEXT REFERENCES paying_in_batches (id)
) STRICT;
INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, reference, status,
    entered_by, entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version, provider, provider_payment_id, regular_gift_id, scheduled_on)
SELECT seq, id, contact_id, received_on, amount, method, reference, status, entered_by,
    entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version, provider, provider_payment_id, regular_gift_id, scheduled_on
FROM gifts_widen;
DROP TABLE gifts_widen;
CREATE INDEX gifts_by_contact ON gifts (contact_id, received_on, seq);
CREATE INDEX gifts_by_entered_by ON gifts (entered_by, seq);
CREATE INDEX gifts_unclaimed ON gifts (received_on)
    WHERE claim_id IS NULL AND status = 'completed';
CREATE INDEX gifts_claimed_uncounted ON gifts (claim_id)
    WHERE claim_id IS NOT NULL AND status <> 'completed';
CREATE UNIQUE INDEX gifts_by_provider_payment ON gifts (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
CREATE INDEX gifts_by_regular_gift ON gifts (regular_gift_id, received_on)
    WHERE regular_gift_id IS NOT NULL;
CREATE INDEX gifts_by_scheduled ON gifts (regular_gift_id, scheduled_on)
    WHERE scheduled_on IS NOT NULL;
CREATE INDEX gifts_by_bank_line ON gifts (bank_line_id) WHERE bank_line_id IS NOT NULL;
CREATE INDEX gifts_by_paying_in_batch ON gifts (paying_in_batch_id, seq)
    WHERE paying_in_batch_id IS NOT NULL;
CREATE INDEX gifts_not_on_a_statement ON gifts (received_on)
    WHERE method = 'bank_transfer' AND bank_line_id IS NULL AND status = 'completed';
";

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
