//! Suppression (rule 5: centralised here) and the mail transport. A domain
//! crate: depends on `contracts` (and `contacts`' public rules), never on
//! `store` or `platform`. A4 adds `mail.rs`.

pub mod suppressions;

use std::sync::LazyLock;

use contracts::Registry;

pub use suppressions::{
    HELD_LOOKUP_LIMIT, Hold, MIGRATION, Reason, Release, SUPPRESSION, SUPPRESSION_NOTE_MAX, held,
    is_suppressed, release, release_at_provider, suppress_address,
};

/// Every contract restore may meet in an org file's comms history.
pub static REGISTRY: LazyLock<Registry> = LazyLock::new(|| Registry::new(&[&SUPPRESSION]));
