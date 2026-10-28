//! The emailed code a sign-in needs once the per-email password limit is
//! spent (S1 review M5): the limit slows guessing without locking the
//! owner out.
//!
//! Over the limit, a sign-in answers "check your email" whatever the
//! password, and only a right password mails a code (to the account's
//! address). The browser then sends the password again with the code. A
//! wrong password and a right password with a wrong code answer the same,
//! so a guess can't be confirmed without the mailbox. The code is stored
//! as HMAC under the pepper, lasts [`crate::EMAIL_CODE_TTL_MS`] and is
//! burned after [`crate::EMAIL_CODE_ATTEMPTS`] wrong tries; wrong codes
//! count towards the user's lock ([`crate::failures`]).

use rusqlite::{Connection, OptionalExtension, params};

use crate::keys::Keys;
use crate::{EMAIL_CODE_ATTEMPTS, EMAIL_CODE_TTL_MS, codes, secret};

fn mac(keys: &Keys, user: i64, code: &str) -> String {
    keys.mac(&format!("gate:{user}"), code)
}

/// A new code for `user`, replacing any earlier one. Returns it to mail.
pub fn issue(conn: &Connection, keys: &Keys, user: i64, now: i64) -> rusqlite::Result<String> {
    let code = codes::email_code();
    conn.execute(
        "INSERT INTO auth_email_gates (user_id, code_hash, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash,
             expires_at = excluded.expires_at, attempts = 0",
        params![user, mac(keys, user, &code), now + EMAIL_CODE_TTL_MS],
    )?;
    Ok(code)
}

/// Check `code`; the code is gone once right, or after its last try.
pub fn check(
    conn: &Connection,
    keys: &Keys,
    user: i64,
    code: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    let row: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT code_hash, expires_at, attempts FROM auth_email_gates WHERE user_id = ?1",
            [user],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((stored, expires, attempts)) = row else {
        return Ok(false);
    };
    let ok = expires > now
        && attempts < EMAIL_CODE_ATTEMPTS
        && secret::same(&stored, &mac(keys, user, code.trim()));
    if ok || attempts + 1 >= EMAIL_CODE_ATTEMPTS {
        conn.execute("DELETE FROM auth_email_gates WHERE user_id = ?1", [user])?;
    } else {
        conn.execute(
            "UPDATE auth_email_gates SET attempts = attempts + 1 WHERE user_id = ?1",
            [user],
        )?;
    }
    Ok(ok)
}

/// Forget expired codes (the sweep job).
pub fn sweep(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM auth_email_gates WHERE expires_at <= ?1", [now])?;
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

    #[test]
    fn a_gate_code_works_once_expires_and_burns() {
        let c = db();
        let k = Keys::dev();
        let code = issue(&c, &k, 1, 0).unwrap();
        assert!(check(&c, &k, 1, &code, 1).unwrap());
        assert!(!check(&c, &k, 1, &code, 2).unwrap(), "once");
        let code = issue(&c, &k, 1, 0).unwrap();
        assert!(
            !check(&c, &k, 1, &code, EMAIL_CODE_TTL_MS).unwrap(),
            "expired"
        );
        let code = issue(&c, &k, 1, 0).unwrap();
        let wrong = if code == "000000" { "000001" } else { "000000" };
        for _ in 0..EMAIL_CODE_ATTEMPTS {
            assert!(!check(&c, &k, 1, wrong, 1).unwrap());
        }
        assert!(!check(&c, &k, 1, &code, 1).unwrap(), "burned");
        let stored: i64 = c
            .query_row("SELECT count(*) FROM auth_email_gates", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, 0);
    }
}
