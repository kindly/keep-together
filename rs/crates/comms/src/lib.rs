//! Suppression (rule 5: centralised here) and the mail transport. A domain
//! crate: depends on `contracts`, never on `store` or `platform`. Empty
//! until wave A (A1, and A4's `mail.rs`).

pub mod mail;
