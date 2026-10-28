//! Staff authentication (ADR 0020 §3, without Google): argon2id passwords,
//! a required second factor (TOTP or an emailed code) with recovery
//! codes, invites, reset by emailed link, sessions with step-up, and the
//! no-enumeration rules.
//!
//! This crate is the control plane's auth state in `platform.db` and the
//! crypto around it. It never touches an org file. Every function that
//! reads or writes takes the caller's `&Connection` (a `platform.db`
//! transaction), so the API composes a sign-in, an invite acceptance or a
//! member removal into one transaction with the membership rows. HTTP,
//! cookies and email live in `api::auth`.
//!
//! Crates do the parts that must not be hand-rolled: `argon2` (password
//! hashing), `totp-rs` (RFC 6238), `governor` (rate limits), `sha2` and
//! `getrandom` (the OS RNG). Sessions are hand-written ([`sessions`]); their
//! invariants are listed there.

pub mod accounts;
pub mod codes;
pub mod failures;
pub mod gate;
pub mod keys;
pub mod limits;
pub mod notices;
mod operator;
pub mod password;
pub mod policy;
pub mod schema;
pub mod secret;
pub mod sessions;
pub mod totp;
pub mod users;

pub use operator::{operator_invite, operator_reset_2fa};

pub use accounts::SecondFactor;
pub use keys::Keys;
pub use policy::Policy;
pub use schema::SCHEMA;
pub use sessions::{Session, Stage};

/// Partial sign-ins (password checked, second factor or enrolment
/// pending) last this long.
pub const PARTIAL_TTL_MS: i64 = 15 * 60 * 1000;
/// Emailed codes last this long (ASVS 2.7.2: at most 10 minutes).
pub const EMAIL_CODE_TTL_MS: i64 = 10 * 60 * 1000;
/// A full session lasts this long from sign-in (ADR 0020: 7 days).
pub const SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// ...and ends sooner after this long without a request (ASVS 3.3.2).
pub const IDLE_MS: i64 = 12 * 60 * 60 * 1000;
/// A session's `last_seen` is written at most this often.
pub const TOUCH_MS: i64 = 5 * 60 * 1000;
/// Wrong codes one partial sign-in may enter before it ends (sign in
/// again).
pub const SESSION_FACTOR_FAILURES: i64 = 5;
/// Wrong codes per user within [`FACTOR_WINDOW_MS`] before the second
/// factor is locked for the rest of that window (S1 review M1).
pub const USER_FACTOR_FAILURES: i64 = 10;
pub const FACTOR_WINDOW_MS: i64 = 60 * 60 * 1000;
/// Admin-only routes need a sign-in (or step-up) this recent.
pub const STEP_UP_MS: i64 = 60 * 60 * 1000;
/// Reset links: 15 minutes, single use.
pub const RESET_TTL_MS: i64 = 15 * 60 * 1000;
/// Invites: 7 days, single use.
pub const INVITE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Wrong emailed codes before the code is burned.
pub const EMAIL_CODE_ATTEMPTS: i64 = 5;
/// Recovery codes issued per enrolment.
pub const RECOVERY_CODES: usize = 10;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("password hashing: {0}")]
    Hash(String),
    #[error("{0:?} is not an email address")]
    InvalidEmail(String),
}
