//! Memberships in `platform.db`, as functions on a connection the caller
//! holds (`Platform::with_write` / `with_read`), so auth composes them with
//! its own writes in one transaction (invite accept, last-admin checks).

use rusqlite::{Connection, OptionalExtension, params};
use store::{Role, TenantId, UserId};

/// One member of an organisation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberRow {
    pub user: UserId,
    pub email: String,
    pub role: Role,
}

fn role(raw: String) -> Role {
    Role::parse(&raw).unwrap_or(Role::Viewer)
}

/// Every member of `tenant`, by email.
pub fn members(conn: &Connection, tenant: &TenantId) -> rusqlite::Result<Vec<MemberRow>> {
    let mut stmt = conn.prepare(
        "SELECT u.id, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = ?1 ORDER BY u.email",
    )?;
    stmt.query_map([tenant.as_str()], |r| {
        Ok(MemberRow {
            user: UserId(r.get(0)?),
            email: r.get(1)?,
            role: role(r.get(2)?),
        })
    })?
    .collect()
}

/// `user`'s role in `tenant`, if a member.
pub fn role_of(
    conn: &Connection,
    user: UserId,
    tenant: &TenantId,
) -> rusqlite::Result<Option<Role>> {
    conn.query_row(
        "SELECT role FROM memberships WHERE user_id = ?1 AND tenant_id = ?2",
        params![user.0, tenant.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map(|r| r.map(role))
}

/// Make `user` a member of `tenant` with `role` (an existing membership
/// takes the new role).
pub fn add_membership(
    conn: &Connection,
    user: UserId,
    tenant: &TenantId,
    role: Role,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = excluded.role",
        params![user.0, tenant.as_str(), role.as_str()],
    )?;
    Ok(())
}

/// Change a member's role. False if `user` isn't a member.
pub fn set_role(
    conn: &Connection,
    user: UserId,
    tenant: &TenantId,
    role: Role,
) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE memberships SET role = ?3 WHERE user_id = ?1 AND tenant_id = ?2",
        params![user.0, tenant.as_str(), role.as_str()],
    )? == 1)
}

/// End a membership. False if `user` wasn't a member.
pub fn remove_membership(
    conn: &Connection,
    user: UserId,
    tenant: &TenantId,
) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "DELETE FROM memberships WHERE user_id = ?1 AND tenant_id = ?2",
        params![user.0, tenant.as_str()],
    )? == 1)
}

/// How many admins `tenant` has (the last-admin rule: check in the same
/// transaction as the role change or removal).
pub fn admin_count(conn: &Connection, tenant: &TenantId) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM memberships WHERE tenant_id = ?1 AND role = 'admin'",
        [tenant.as_str()],
        |r| r.get(0),
    )
}
