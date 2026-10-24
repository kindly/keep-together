//! Wrong second-factor codes (S1 review M1, ASVS 2.2.1). Persisted, not
//! in memory, so a deploy doesn't reset them:
//!
//! - a partial sign-in ends after [`crate::SESSION_FACTOR_FAILURES`]
//!   wrong codes: the password must be given again;
//! - after [`crate::USER_FACTOR_FAILURES`] wrong codes within
//!   [`crate::FACTOR_WINDOW_MS`], the user's second factor is locked for
//!   the rest of the window: every code is refused unchecked, partial
//!   sign-ins end, and the user is emailed once. A password reset lifts
//!   it.
//!
//! Every place a code is checked counts here: sign-in, step-up, enrolment
//! confirmation and the emailed code a limited sign-in needs ([`crate::gate`]).

use rusqlite::{Connection, params};

use crate::sessions::{self, Session, Stage};
use crate::{FACTOR_WINDOW_MS, SESSION_FACTOR_FAILURES, USER_FACTOR_FAILURES};

/// What a wrong code leads to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Enter another code.
    TryAgain,
    /// This partial sign-in has ended: give the password again.
    SignInAgain,
    /// The user's second factor is locked for the window. `notify`: this
    /// failure locked it (email the user once).
    Locked { notify: bool },
}

fn recent(conn: &Connection, user: i64, now: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM auth_factor_failures WHERE user_id = ?1 AND at > ?2",
        params![user, now - FACTOR_WINDOW_MS],
        |r| r.get(0),
    )
}

/// Whether `user`'s second factor is locked now.
pub fn locked(conn: &Connection, user: i64, now: i64) -> rusqlite::Result<bool> {
    Ok(recent(conn, user, now)? >= USER_FACTOR_FAILURES)
}

/// Count a wrong code from `user` (on partial session `s`, if one).
pub fn record(
    conn: &Connection,
    user: i64,
    s: Option<&Session>,
    now: i64,
) -> rusqlite::Result<Failure> {
    conn.execute(
        "INSERT INTO auth_factor_failures (user_id, at) VALUES (?1, ?2)",
        params![user, now],
    )?;
    let n = recent(conn, user, now)?;
    if n >= USER_FACTOR_FAILURES {
        sessions::revoke_partial(conn, user)?;
        return Ok(Failure::Locked {
            notify: n == USER_FACTOR_FAILURES,
        });
    }
    if let Some(s) = s.filter(|s| s.stage != Stage::Full) {
        let failures: i64 = conn.query_row(
            "UPDATE auth_sessions SET factor_failures = factor_failures + 1
             WHERE token_hash = ?1 RETURNING factor_failures",
            [&s.id],
            |r| r.get(0),
        )?;
        if failures >= SESSION_FACTOR_FAILURES {
            sessions::revoke(conn, &s.id)?;
            return Ok(Failure::SignInAgain);
        }
    }
    Ok(Failure::TryAgain)
}

/// Forget `user`'s failures (their password was reset, or their factor).
pub fn clear(conn: &Connection, user: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM auth_factor_failures WHERE user_id = ?1",
        [user],
    )?;
    Ok(())
}

/// Forget failures older than the window (the sweep job).
pub fn sweep(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM auth_factor_failures WHERE at <= ?1",
        [now - FACTOR_WINDOW_MS],
    )?;
    Ok(())
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
        for step in crate::SCHEMA.steps {
            c.execute_batch(step).unwrap();
        }
        c
    }

    fn partial(c: &Connection, now: i64) -> Session {
        let t = sessions::create(c, 1, Stage::SecondFactor, now).unwrap();
        sessions::get(c, &t, now).unwrap().unwrap()
    }

    #[test]
    fn a_partial_sign_in_ends_after_five_wrong_codes() {
        let c = db();
        let s = partial(&c, 0);
        for _ in 0..4 {
            assert_eq!(record(&c, 1, Some(&s), 1).unwrap(), Failure::TryAgain);
        }
        assert_eq!(record(&c, 1, Some(&s), 1).unwrap(), Failure::SignInAgain);
        assert!(sessions::by_id(&c, &s.id, 2).unwrap().is_none());
    }

    #[test]
    fn ten_wrong_codes_in_an_hour_lock_the_user_until_the_hour_is_up() {
        let c = db();
        let mut outcomes = vec![];
        // Two sign-ins of five wrong codes each: the second's fifth locks.
        for round in 0..2 {
            let s = partial(&c, round);
            for _ in 0..5 {
                outcomes.push(record(&c, 1, Some(&s), 1000 + round).unwrap());
            }
        }
        assert_eq!(outcomes[9], Failure::Locked { notify: true });
        assert!(locked(&c, 1, 2000).unwrap());
        // Another wrong code (a step-up, say) doesn't notify again.
        assert_eq!(
            record(&c, 1, None, 3000).unwrap(),
            Failure::Locked { notify: false }
        );
        // A partial sign-in made while locked ends with the next failure.
        let s = partial(&c, 4000);
        assert!(matches!(
            record(&c, 1, Some(&s), 4000).unwrap(),
            Failure::Locked { .. }
        ));
        assert!(sessions::by_id(&c, &s.id, 4001).unwrap().is_none());
        // An hour after the first failures, the early ones age out.
        assert!(!locked(&c, 1, 1001 + FACTOR_WINDOW_MS).unwrap());
        sweep(&c, 1001 + FACTOR_WINDOW_MS).unwrap();
        clear(&c, 1).unwrap();
        assert!(!locked(&c, 1, 5000).unwrap());
    }
}
