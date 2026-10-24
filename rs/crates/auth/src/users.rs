//! `users` rows (the platform's base schema) as auth needs them, on the
//! caller's transaction. The one place auth writes SQL against tables it
//! doesn't own (`users`, `memberships`); it moves to `platform` if that
//! grows user functions.

use rusqlite::{Connection, OptionalExtension};

/// An email as stored: trimmed and lower-cased. `None` if it can't be an
/// address (ADR 0015 tier 1: just `x@y`, no format policing).
pub fn normalise_email(raw: &str) -> Option<String> {
    let e = raw.trim().to_lowercase();
    let (local, domain) = e.split_once('@')?;
    (!local.is_empty() && !domain.is_empty() && e.len() <= 254 && !e.contains(char::is_whitespace))
        .then_some(e)
}

pub fn by_email(conn: &Connection, email: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM users WHERE email = ?1", [email], |r| {
        r.get(0)
    })
    .optional()
}

/// The user with this (normalised) email, created if new.
pub fn upsert(conn: &Connection, email: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO users (email) VALUES (?1) ON CONFLICT (email) DO NOTHING",
        [email],
    )?;
    conn.query_row("SELECT id FROM users WHERE email = ?1", [email], |r| {
        r.get(0)
    })
}

/// How many organisations `user` belongs to.
pub fn membership_count(conn: &Connection, user: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM memberships WHERE user_id = ?1",
        [user],
        |r| r.get(0),
    )
}
