//! The contacts domain: the Contact aggregate's slices as contracts,
//! dropdown fields, the search projection and the list/search/get reads.
//! The Rust counterpart of `convex/contacts/`.
//!
//! Domain functions take a `Ctx` (a write transaction on one org file) or
//! a `&Connection` read on it, and nothing else: there is no tenant here,
//! the org file is the scope.

pub mod fields;
pub mod form;
pub mod identifiers;
pub mod notes;
pub mod number;
mod projection;
pub mod queries;
pub mod relationships;
pub mod rules;
pub mod slices;
pub mod types;

use std::sync::LazyLock;

use contracts::Registry;

pub use projection::{SEARCH_TABLE, rebuild_search};
pub use slices::{ADDRESSES, ARCHIVE, DETAILS, FIELD_VALUES, METHODS};

/// The org-schema migration this crate owns, after `contracts::MIGRATION`.
///
/// `number` is the contact's rowid, so the FTS rows (keyed by rowid) stay
/// attached through a VACUUM; the string `id` is what the API uses.
/// As shipped by the spike, with both FTS variants; [`DROP_TRIGRAM`] drops
/// the trigram one.
pub const MIGRATION: &str = "
CREATE TABLE contact_number_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next INTEGER NOT NULL
) STRICT;
CREATE TABLE contacts (
    number INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    client_key TEXT UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('individual', 'organization', 'household')),
    title TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    nickname TEXT NOT NULL,
    name TEXT NOT NULL,
    birth_date TEXT,
    is_deceased INTEGER NOT NULL,
    deceased_date TEXT,
    display_name TEXT NOT NULL,
    sort_name TEXT NOT NULL,
    sort_key TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    details_version INTEGER NOT NULL DEFAULT 0,
    methods_version INTEGER NOT NULL DEFAULT 0,
    addresses_version INTEGER NOT NULL DEFAULT 0,
    archive_version INTEGER NOT NULL DEFAULT 0,
    fields_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX contacts_live_sort ON contacts (archived, sort_key, id);
CREATE INDEX contacts_sort ON contacts (sort_key, id);
CREATE INDEX contacts_kind_live_sort ON contacts (kind, archived, sort_key, id);
CREATE INDEX contacts_kind_sort ON contacts (kind, sort_key, id);

CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    address TEXT NOT NULL,
    address_normalized TEXT NOT NULL,
    is_primary INTEGER NOT NULL
) STRICT;
CREATE INDEX contact_emails_by_contact ON contact_emails (contact_id, position);
CREATE INDEX contact_emails_by_address ON contact_emails (address_normalized);

CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    number TEXT NOT NULL,
    number_normalized TEXT NOT NULL,
    is_primary INTEGER NOT NULL
) STRICT;
CREATE INDEX contact_phones_by_contact ON contact_phones (contact_id, position);
CREATE INDEX contact_phones_by_number ON contact_phones (number_normalized);

CREATE TABLE contact_addresses (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    line1 TEXT NOT NULL,
    line2 TEXT NOT NULL,
    line3 TEXT NOT NULL,
    town TEXT NOT NULL,
    postcode TEXT NOT NULL,
    country TEXT NOT NULL,
    is_primary INTEGER NOT NULL
) STRICT;
CREATE INDEX contact_addresses_by_contact ON contact_addresses (contact_id, position);

CREATE TABLE contact_fields (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    applies_to TEXT NOT NULL,
    is_active INTEGER NOT NULL,
    save_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE contact_field_options (
    id TEXT PRIMARY KEY,
    field_id TEXT NOT NULL REFERENCES contact_fields (id),
    label TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    position INTEGER NOT NULL,
    is_active INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    save_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX contact_field_options_by_field ON contact_field_options (field_id, position);
CREATE TABLE contact_field_values (
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    field_id TEXT NOT NULL REFERENCES contact_fields (id),
    option_id TEXT NOT NULL REFERENCES contact_field_options (id),
    PRIMARY KEY (contact_id, field_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX contact_field_values_by_option ON contact_field_values (field_id, option_id, contact_id);

CREATE VIRTUAL TABLE contact_search_words USING fts5 (
    text, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE VIRTUAL TABLE contact_search_trigram USING fts5 (
    text, tokenize = 'trigram remove_diacritics 1'
);
";

/// Org schema step 3: the trigram FTS variant goes (L7).
pub const DROP_TRIGRAM: &str = "DROP TABLE contact_search_trigram;";

/// The org schema step after [`DROP_TRIGRAM`] (A1): external identifiers and their types, notes,
/// relationships and their types.
pub const MIGRATION_IDENTIFIERS_NOTES: &str = "
ALTER TABLE contacts ADD COLUMN identifiers_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE identifier_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL,
    save_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE contact_identifiers (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    position INTEGER NOT NULL,
    type_id TEXT NOT NULL REFERENCES identifier_types (id),
    value TEXT NOT NULL,
    value_normalized TEXT NOT NULL
) STRICT;
CREATE INDEX contact_identifiers_by_contact ON contact_identifiers (contact_id, position);
-- A (type, value) pair belongs to at most one contact; prefix = this value, any type.
CREATE UNIQUE INDEX contact_identifiers_by_value ON contact_identifiers (value_normalized, type_id);

CREATE TABLE contact_notes (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    body TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    edited_by INTEGER,
    edited_at INTEGER NOT NULL,
    body_version INTEGER NOT NULL DEFAULT 0,
    flags_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX contact_notes_live ON contact_notes (contact_id, archived, pinned, seq);
CREATE INDEX contact_notes_archived ON contact_notes (contact_id, archived, seq);

CREATE TABLE relationship_types (
    id TEXT PRIMARY KEY,
    label_ab TEXT NOT NULL,
    label_ba TEXT NOT NULL,
    kind_a TEXT CHECK (kind_a IN ('individual', 'organization', 'household')),
    kind_b TEXT CHECK (kind_b IN ('individual', 'organization', 'household')),
    is_active INTEGER NOT NULL,
    save_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE relationships (
    id TEXT PRIMARY KEY,
    contact_a TEXT NOT NULL REFERENCES contacts (id),
    contact_b TEXT NOT NULL REFERENCES contacts (id),
    type_id TEXT NOT NULL REFERENCES relationship_types (id),
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER NOT NULL,
    description TEXT NOT NULL,
    save_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX relationships_by_a ON relationships (contact_a);
CREATE INDEX relationships_by_b ON relationships (contact_b);
";

/// A new organisation's contacts reference data (the UK relationship
/// types). Idempotent; identifier types are never seeded.
pub use relationships::seed_new_org;

/// Every contract restore may meet in an org file's contacts history.
pub static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    Registry::new(&[
        &DETAILS,
        &METHODS,
        &ADDRESSES,
        &ARCHIVE,
        &FIELD_VALUES,
        &fields::FIELD,
        &fields::FIELD_OPTION,
        &identifiers::IDENTIFIERS,
        &identifiers::IDENTIFIER_TYPE,
        &notes::NOTE,
        &notes::NOTE_FLAGS,
        &relationships::RELATIONSHIP_TYPE,
        &relationships::RELATIONSHIP,
    ])
});
