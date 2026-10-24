//! Sessions (`auth_sessions` in `platform.db`). Hand-written instead of
//! axum-login/tower-sessions (factory decision, A4): they need a user
//! column for revoke-all, a partial stage, a step-up time, and a signal
//! that ends live streams; the crypto underneath is from crates.
//!
//! Invariants (the security review checks each; tests in
//! `api/tests/auth_sessions.rs`):
//!
//! 1. The cookie carries a 256-bit token from the OS RNG; only its
//!    SHA-256 is stored, and a request is looked up by that hash.
//! 2. A session is `second_factor` or `enrol` (password checked, nothing
//!    else reachable, [`crate::PARTIAL_TTL_MS`]) or `full` (expires
//!    [`crate::SESSION_TTL_MS`] after sign-in; not sliding).
//! 3. The token rotates (new token, old row gone, one transaction) when a
//!    sign-in completes, on step-up, and when the user's own role changes.
//! 4. Revoke-all deletes every row of a user: on password reset, 2FA
//!    reset and removal from an organisation (and on a role change made
//!    by someone else, since that session can't be rotated in place). The
//!    API then signals live streams to close.
//! 5. An expired row reads as no session; a job sweeps them.
//! 6. A row holds no role: each request re-reads the membership.
//! 7. A TOTP secret being enrolled (`pending_secret`) lives on its session
//!    for [`crate::PARTIAL_TTL_MS`] at most: cleared when enrolment
//!    completes (the row is replaced or the column nulled), unusable once
//!    expired, and nulled by the sweep. It is never logged or returned
//!    after the enrol response.
//! 8. Handlers that act on a session re-read it inside their write
//!    transaction ([`by_id`]) and act on that row, never on the read
//!    that found it: a session revoked, or a code spent, in between is
//!    seen. [`complete`] and the rotations refuse a row that is gone.
//! 9. A dev-login session (`dev`) counts only while the server runs with
//!    dev auth; the API ignores it otherwise.

use rusqlite::{Connection, OptionalExtension, params};

use crate::{PARTIAL_TTL_MS, SESSION_TTL_MS, secret};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Password checked; the second factor is next.
    SecondFactor,
    /// Password checked (or invite accepted); no second factor yet, so
    /// enrolling one is next.
    Enrol,
    Full,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::SecondFactor => "second_factor",
            Stage::Enrol => "enrol",
            Stage::Full => "full",
        }
    }

    fn parse(s: &str) -> Stage {
        match s {
            "full" => Stage::Full,
            "enrol" => Stage::Enrol,
            _ => Stage::SecondFactor,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Session {
    /// The stored hash: what to revoke or rotate. Never the token.
    pub id: String,
    pub user: i64,
    pub email: String,
    pub stage: Stage,
    pub expires_at: i64,
    /// The last password + second factor proof (`full` only).
    pub authenticated_at: Option<i64>,
    /// A TOTP secret being enrolled, while unexpired.
    pub pending_secret: Option<String>,
    pub email_code_hash: Option<String>,
    pub email_code_expires: Option<i64>,
    pub email_code_attempts: i64,
    /// Made by the dev login (`KEEP_DEV_AUTH`).
    pub dev: bool,
}

/// A new session for `user`: the cookie token (only its hash is kept).
pub fn create(conn: &Connection, user: i64, stage: Stage, now: i64) -> rusqlite::Result<String> {
    let token = secret::token();
    let (expires, authenticated) = match stage {
        Stage::Full => (now + SESSION_TTL_MS, Some(now)),
        _ => (now + PARTIAL_TTL_MS, None),
    };
    conn.execute(
        "INSERT INTO auth_sessions (token_hash, user_id, stage, created_at, expires_at, authenticated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![secret::hash(&token), user, stage.as_str(), now, expires, authenticated],
    )?;
    Ok(token)
}

/// A full session from the dev login (no password, no second factor).
pub fn create_dev(conn: &Connection, user: i64, now: i64) -> rusqlite::Result<String> {
    let token = create(conn, user, Stage::Full, now)?;
    conn.execute(
        "UPDATE auth_sessions SET dev = 1 WHERE token_hash = ?1",
        [secret::hash(&token)],
    )?;
    Ok(token)
}

/// The live session for a cookie token. Unknown, malformed and expired
/// read the same.
pub fn get(conn: &Connection, token: &str, now: i64) -> rusqlite::Result<Option<Session>> {
    if !secret::well_formed(token) {
        return Ok(None);
    }
    by_id(conn, &secret::hash(token), now)
}

/// The live session with stored hash `id`.
pub fn by_id(conn: &Connection, id: &str, now: i64) -> rusqlite::Result<Option<Session>> {
    conn.query_row(
        "SELECT s.token_hash, s.user_id, u.email, s.stage, s.expires_at, s.authenticated_at,
                CASE WHEN s.pending_secret_expires > ?2 THEN s.pending_secret END, s.email_code_hash, s.email_code_expires, s.email_code_attempts,
                s.dev
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?1 AND s.expires_at > ?2",
        params![id, now],
        |r| {
            Ok(Session {
                id: r.get(0)?,
                user: r.get(1)?,
                email: r.get(2)?,
                stage: Stage::parse(&r.get::<_, String>(3)?),
                expires_at: r.get(4)?,
                authenticated_at: r.get(5)?,
                pending_secret: r.get(6)?,
                email_code_hash: r.get(7)?,
                email_code_expires: r.get(8)?,
                email_code_attempts: r.get(9)?,
                dev: r.get(10)?,
            })
        },
    )
    .optional()
}

/// The sign-in is complete: replace the partial session with a full one.
/// Refused (`QueryReturnedNoRows`) if the partial row is gone (revoked,
/// or a double submit already completed it): never a full session from a
/// stale read.
pub fn complete(conn: &Connection, s: &Session, now: i64) -> rusqlite::Result<String> {
    let n = conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?1", [&s.id])?;
    if n == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    create(conn, s.user, Stage::Full, now)
}

/// Step-up: a new token, signed in now, same expiry.
pub fn step_up(conn: &Connection, s: &Session, now: i64) -> rusqlite::Result<String> {
    replace(conn, s, Some(now))
}

/// A new token for the same session (the user's own role changed).
pub fn rotate(conn: &Connection, s: &Session) -> rusqlite::Result<String> {
    replace(conn, s, s.authenticated_at)
}

fn replace(
    conn: &Connection,
    s: &Session,
    authenticated_at: Option<i64>,
) -> rusqlite::Result<String> {
    let token = secret::token();
    let n = conn.execute(
        "UPDATE auth_sessions SET token_hash = ?2, authenticated_at = ?3,
             pending_secret = NULL, pending_secret_expires = NULL,
             email_code_hash = NULL, email_code_expires = NULL, email_code_attempts = 0
         WHERE token_hash = ?1",
        params![s.id, secret::hash(&token), authenticated_at],
    )?;
    if n == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(token)
}

pub fn set_stage(conn: &Connection, id: &str, stage: Stage) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auth_sessions SET stage = ?2, pending_secret = NULL, pending_secret_expires = NULL
         WHERE token_hash = ?1",
        params![id, stage.as_str()],
    )?;
    Ok(())
}

pub fn set_pending_secret(
    conn: &Connection,
    id: &str,
    secret_b32: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auth_sessions SET pending_secret = ?2, pending_secret_expires = ?3 WHERE token_hash = ?1",
        params![id, secret_b32, now + PARTIAL_TTL_MS],
    )?;
    Ok(())
}

/// A new emailed code for this session (replacing any earlier one).
pub fn set_email_code(conn: &Connection, id: &str, code: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auth_sessions SET email_code_hash = ?2, email_code_expires = ?3, email_code_attempts = 0
         WHERE token_hash = ?1",
        params![id, secret::hash(code), now + PARTIAL_TTL_MS],
    )?;
    Ok(())
}

/// Check an emailed code. A wrong one counts; after
/// [`crate::EMAIL_CODE_ATTEMPTS`] wrong ones, or on success, the code is
/// gone.
pub fn check_email_code(
    conn: &Connection,
    s: &Session,
    code: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    let live = s.email_code_expires.is_some_and(|e| e > now)
        && s.email_code_attempts < crate::EMAIL_CODE_ATTEMPTS;
    let ok = live
        && s.email_code_hash
            .as_deref()
            .is_some_and(|h| secret::same(h, &secret::hash(code.trim())));
    if ok || s.email_code_attempts + 1 >= crate::EMAIL_CODE_ATTEMPTS {
        conn.execute(
            "UPDATE auth_sessions SET email_code_hash = NULL, email_code_expires = NULL,
                 email_code_attempts = 0 WHERE token_hash = ?1",
            [&s.id],
        )?;
    } else {
        conn.execute(
            "UPDATE auth_sessions SET email_code_attempts = email_code_attempts + 1 WHERE token_hash = ?1",
            [&s.id],
        )?;
    }
    Ok(ok)
}

pub fn revoke(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?1", [id])?;
    Ok(())
}

/// Every session of `user`, gone. Returns how many.
pub fn revoke_user(conn: &Connection, user: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM auth_sessions WHERE user_id = ?1", [user])
}

/// Every session of `user` except `keep` (a password change keeps the
/// session it was made from).
pub fn revoke_others(conn: &Connection, user: i64, keep: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM auth_sessions WHERE user_id = ?1 AND token_hash <> ?2",
        params![user, keep],
    )
}

/// Delete expired sessions and null expired enrolment secrets. Returns
/// how many sessions went.
pub fn sweep(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE auth_sessions SET pending_secret = NULL, pending_secret_expires = NULL
         WHERE pending_secret_expires <= ?1",
        [now],
    )?;
    conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?1", [now])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
             CREATE TABLE tenants (id TEXT PRIMARY KEY);
             INSERT INTO users (id, email) VALUES (1, 'ann@alpha.org');",
        )
        .unwrap();
        c.execute_batch(crate::SCHEMA.steps[0]).unwrap();
        c
    }

    /// Invariant 8: a partial session read before a revoke-all (or before
    /// a double submit completed it) never becomes a full one.
    #[test]
    fn complete_refuses_a_session_gone_since_it_was_read() {
        let c = db();
        let token = create(&c, 1, Stage::SecondFactor, 0).unwrap();
        let read = get(&c, &token, 1).unwrap().unwrap();
        // Someone resets the password meanwhile: every session goes.
        revoke_user(&c, 1).unwrap();
        assert!(matches!(
            complete(&c, &read, 2),
            Err(rusqlite::Error::QueryReturnedNoRows)
        ));
        let full: i64 = c
            .query_row("SELECT count(*) FROM auth_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(full, 0);
        // And a double submit: the second completion of one read fails.
        let token = create(&c, 1, Stage::SecondFactor, 0).unwrap();
        let read = get(&c, &token, 1).unwrap().unwrap();
        complete(&c, &read, 2).unwrap();
        assert!(complete(&c, &read, 3).is_err());
        assert!(
            step_up(&c, &read, 3).is_err(),
            "a rotation of a gone row too"
        );
    }
}
