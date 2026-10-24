//! A user's groups (`convex/platform/tenants.ts` `mine` and `opened`): which
//! one they last opened, so signing in lands them back there (cash-gifts
//! g3q1). `platform.db` only; each group's preferences come from its own
//! file (the api reads them).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use store::UserId;

/// A repeat mark of the same group inside this window writes nothing: the
/// client calls once per entry, so a burst of calls is a misbehaving
/// client (two tabs trading the mark), and one write a minute bounds it.
/// The cost: leaving a group and coming back inside a minute lands next
/// sign-in in the other one.
pub const OPENED_QUIET_MS: i64 = 60_000;

/// When `user` last opened each of their groups, by slug (`None`: never
/// recorded).
pub fn last_used(
    conn: &Connection,
    user: UserId,
) -> rusqlite::Result<HashMap<String, Option<i64>>> {
    let mut stmt = conn.prepare(
        "SELECT t.slug, m.last_used_at FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ?1",
    )?;
    stmt.query_map([user.0], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

/// What [`opened`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opened {
    /// `user` isn't a member of a group at that slug (or there is none).
    NotMember,
    /// Nothing to record: their only group, already their last used, or
    /// marked inside [`OPENED_QUIET_MS`].
    Unchanged,
    /// Marked as their last used, at this time.
    Marked(i64),
}

/// `user` opened the group at `slug`: remember it, for people in more
/// than one group, as later than every other mark (even within the same
/// millisecond). Run inside a write transaction.
pub fn opened(conn: &Connection, user: UserId, slug: &str, now: i64) -> rusqlite::Result<Opened> {
    let Some((tenant, last)): Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT m.tenant_id, m.last_used_at FROM memberships m
             JOIN tenants t ON t.id = m.tenant_id
             WHERE m.user_id = ?1 AND t.slug = ?2",
            params![user.0, slug],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    else {
        return Ok(Opened::NotMember);
    };
    let (groups, latest): (i64, Option<i64>) = conn.query_row(
        "SELECT count(*), max(last_used_at) FROM memberships WHERE user_id = ?1",
        [user.0],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if groups < 2 {
        return Ok(Opened::Unchanged);
    }
    let latest = latest.unwrap_or(0);
    if let Some(last) = last
        && (last == latest || now - last < OPENED_QUIET_MS)
    {
        return Ok(Opened::Unchanged);
    }
    let at = now.max(latest + 1);
    conn.execute(
        "UPDATE memberships SET last_used_at = ?3 WHERE user_id = ?1 AND tenant_id = ?2",
        params![user.0, tenant, at],
    )?;
    Ok(Opened::Marked(at))
}
