//! Credentials, second factors, recovery codes, invites, reset links and
//! the auth log: rows keyed by `users.id`, each function in the caller's
//! transaction.

use rusqlite::{Connection, OptionalExtension, params};

use crate::{INVITE_TTL_MS, RECOVERY_CODES, RESET_TTL_MS, codes, password, secret};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecondFactor {
    Totp,
    Email,
}

impl SecondFactor {
    pub fn as_str(self) -> &'static str {
        match self {
            SecondFactor::Totp => "totp",
            SecondFactor::Email => "email",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "totp" => Some(SecondFactor::Totp),
            "email" => Some(SecondFactor::Email),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Credentials {
    pub password_hash: String,
    pub second_factor: Option<SecondFactor>,
    pub totp_secret: Option<String>,
    pub totp_last_step: i64,
}

pub fn credentials(conn: &Connection, user: i64) -> rusqlite::Result<Option<Credentials>> {
    conn.query_row(
        "SELECT password_hash, second_factor, totp_secret, totp_last_step
         FROM auth_credentials WHERE user_id = ?1",
        [user],
        |r| {
            Ok(Credentials {
                password_hash: r.get(0)?,
                second_factor: r
                    .get::<_, Option<String>>(1)?
                    .as_deref()
                    .and_then(SecondFactor::parse),
                totp_secret: r.get(2)?,
                totp_last_step: r.get(3)?,
            })
        },
    )
    .optional()
}

/// Set (or replace) the password. Keeps the second factor.
pub fn set_password(conn: &Connection, user: i64, password: &str, now: i64) -> Result<(), crate::AuthError> {
    let hash = password::hash(password)?;
    conn.execute(
        "INSERT INTO auth_credentials (user_id, password_hash, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash,
             updated_at = excluded.updated_at",
        params![user, hash, now],
    )?;
    Ok(())
}

/// The second factor is now `factor` (with its TOTP secret and the step
/// its confirming code used).
pub fn set_second_factor(
    conn: &Connection,
    user: i64,
    factor: SecondFactor,
    totp: Option<(&str, i64)>,
    now: i64,
) -> rusqlite::Result<()> {
    let (secret_b32, step) = match (factor, totp) {
        (SecondFactor::Totp, Some((s, step))) => (Some(s), step),
        _ => (None, 0),
    };
    conn.execute(
        "UPDATE auth_credentials SET second_factor = ?2, totp_secret = ?3, totp_last_step = ?4,
             updated_at = ?5 WHERE user_id = ?1",
        params![user, factor.as_str(), secret_b32, step, now],
    )?;
    Ok(())
}

pub fn set_totp_step(conn: &Connection, user: i64, step: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auth_credentials SET totp_last_step = ?2 WHERE user_id = ?1",
        params![user, step],
    )?;
    Ok(())
}

/// 2FA reset: no second factor and no recovery codes, so the next
/// sign-in enrols again.
pub fn clear_second_factor(conn: &Connection, user: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auth_credentials SET second_factor = NULL, totp_secret = NULL, totp_last_step = 0,
             updated_at = ?2 WHERE user_id = ?1",
        params![user, now],
    )?;
    conn.execute("DELETE FROM auth_recovery_codes WHERE user_id = ?1", [user])?;
    Ok(())
}

/// New recovery codes, replacing all earlier ones. Shown once.
pub fn new_recovery_codes(conn: &Connection, user: i64) -> rusqlite::Result<Vec<String>> {
    conn.execute("DELETE FROM auth_recovery_codes WHERE user_id = ?1", [user])?;
    let mut out = Vec::with_capacity(RECOVERY_CODES);
    while out.len() < RECOVERY_CODES {
        let code = codes::recovery_code();
        let stored = secret::hash(&code.replace('-', ""));
        let n = conn.execute(
            "INSERT OR IGNORE INTO auth_recovery_codes (user_id, code_hash) VALUES (?1, ?2)",
            params![user, stored],
        )?;
        if n == 1 {
            out.push(code);
        }
    }
    Ok(out)
}

/// Spend a recovery code. True if it was unused and is now used.
pub fn use_recovery_code(conn: &Connection, user: i64, input: &str, now: i64) -> rusqlite::Result<bool> {
    let Some(code) = codes::normalise_recovery(input) else {
        return Ok(false);
    };
    let n = conn.execute(
        "UPDATE auth_recovery_codes SET used_at = ?3
         WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL",
        params![user, secret::hash(&code), now],
    )?;
    Ok(n == 1)
}

pub fn recovery_codes_left(conn: &Connection, user: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM auth_recovery_codes WHERE user_id = ?1 AND used_at IS NULL",
        [user],
        |r| r.get(0),
    )
}

#[derive(Clone, Debug)]
pub struct Invite {
    pub id: String,
    pub tenant_id: String,
    pub email: String,
    pub role: String,
    pub created_at: i64,
    pub expires_at: i64,
}

fn invite_row(r: &rusqlite::Row) -> rusqlite::Result<Invite> {
    Ok(Invite {
        id: r.get(0)?,
        tenant_id: r.get(1)?,
        email: r.get(2)?,
        role: r.get(3)?,
        created_at: r.get(4)?,
        expires_at: r.get(5)?,
    })
}

/// A new invite (any pending one for the same email and organisation is
/// revoked). Returns it and the link token.
pub fn create_invite(
    conn: &Connection,
    tenant_id: &str,
    email: &str,
    role: &str,
    invited_by: Option<i64>,
    now: i64,
) -> rusqlite::Result<(Invite, String)> {
    conn.execute(
        "UPDATE auth_invites SET revoked_at = ?3
         WHERE tenant_id = ?1 AND email = ?2 AND accepted_at IS NULL AND revoked_at IS NULL",
        params![tenant_id, email, now],
    )?;
    let token = secret::token();
    let id = secret::token()[..32].to_owned();
    conn.execute(
        "INSERT INTO auth_invites (id, token_hash, tenant_id, email, role, invited_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, secret::hash(&token), tenant_id, email, role, invited_by, now, now + INVITE_TTL_MS],
    )?;
    Ok((
        Invite {
            id,
            tenant_id: tenant_id.into(),
            email: email.into(),
            role: role.into(),
            created_at: now,
            expires_at: now + INVITE_TTL_MS,
        },
        token,
    ))
}

const INVITE_COLS: &str = "id, tenant_id, email, role, created_at, expires_at";

/// The pending, unexpired invite for a link token.
pub fn invite_by_token(conn: &Connection, token: &str, now: i64) -> rusqlite::Result<Option<Invite>> {
    if !secret::well_formed(token) {
        return Ok(None);
    }
    conn.query_row(
        &format!(
            "SELECT {INVITE_COLS} FROM auth_invites WHERE token_hash = ?1
             AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2"
        ),
        params![secret::hash(token), now],
        invite_row,
    )
    .optional()
}

/// Mark accepted. False if it was no longer pending (a double submit).
pub fn accept_invite(conn: &Connection, id: &str, now: i64) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE auth_invites SET accepted_at = ?2
         WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL",
        params![id, now],
    )? == 1)
}

/// Revoke a pending invite of this organisation. False if there was none.
pub fn revoke_invite(conn: &Connection, tenant_id: &str, id: &str, now: i64) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE auth_invites SET revoked_at = ?3
         WHERE tenant_id = ?1 AND id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL",
        params![tenant_id, id, now],
    )? == 1)
}

/// Every pending invite of this organisation (expired ones included, so
/// an admin sees them and can resend).
pub fn pending_invites(conn: &Connection, tenant_id: &str) -> rusqlite::Result<Vec<Invite>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {INVITE_COLS} FROM auth_invites
         WHERE tenant_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY email"
    ))?;
    stmt.query_map([tenant_id], invite_row)?.collect()
}

/// A reset link token for `user` (15 minutes, single use).
pub fn create_reset(conn: &Connection, user: i64, now: i64) -> rusqlite::Result<String> {
    let token = secret::token();
    conn.execute(
        "INSERT INTO auth_resets (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
        params![secret::hash(&token), user, now, now + RESET_TTL_MS],
    )?;
    Ok(token)
}

/// The user a live reset token is for, without spending it.
pub fn reset_user(conn: &Connection, token: &str, now: i64) -> rusqlite::Result<Option<i64>> {
    if !secret::well_formed(token) {
        return Ok(None);
    }
    conn.query_row(
        "SELECT user_id FROM auth_resets WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2",
        params![secret::hash(token), now],
        |r| r.get(0),
    )
    .optional()
}

/// Spend a reset token: it and every other live link of the same user
/// are used up. The user it was for, if it was live.
pub fn redeem_reset(conn: &Connection, token: &str, now: i64) -> rusqlite::Result<Option<i64>> {
    let Some(user) = reset_user(conn, token, now)? else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE auth_resets SET used_at = ?2 WHERE user_id = ?1 AND used_at IS NULL",
        params![user, now],
    )?;
    Ok(Some(user))
}

/// Forget spent and expired links and old invites (the sweep job).
pub fn sweep(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM auth_resets WHERE expires_at <= ?1 OR used_at IS NOT NULL", [now])?;
    // Kept a month after they stop mattering, for the members page and
    // the log's context.
    conn.execute(
        "DELETE FROM auth_invites WHERE coalesce(accepted_at, revoked_at, expires_at) <= ?1",
        [now - 30 * 24 * 60 * 60 * 1000],
    )?;
    Ok(())
}

/// Who did what, for the operator and the security review. `actor` is a
/// user id, `operator` (the CLI) or `self`.
pub fn log(
    conn: &Connection,
    now: i64,
    event: &str,
    user: Option<i64>,
    actor: &str,
    tenant_id: Option<&str>,
    detail: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO auth_log (at, event, user_id, actor, tenant_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now, event, user, actor, tenant_id, detail],
    )?;
    Ok(())
}
