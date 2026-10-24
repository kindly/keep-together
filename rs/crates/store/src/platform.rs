//! `platform.db`: tenants, users, memberships, sessions. The control plane;
//! no domain data lives here.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use rusqlite_migration::{M, Migrations};

use crate::conn::{self, ReaderPool};
use crate::{StoreError, TenantId};

const MIGRATIONS: &[M<'static>] = &[M::up(
    "CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE memberships (
        user_id INTEGER NOT NULL REFERENCES users(id),
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        role TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
        PRIMARY KEY (user_id, tenant_id)
    ) STRICT;
    CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL
    ) STRICT;",
)];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Staff,
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Staff => "staff",
            Role::Admin => "admin",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "viewer" => Some(Role::Viewer),
            "staff" => Some(Role::Staff),
            "admin" => Some(Role::Admin),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct UserId(pub i64);

#[derive(Clone, Debug)]
pub struct Tenant {
    pub id: TenantId,
    pub slug: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub user: UserId,
    pub email: String,
}

/// A user's membership of one tenant: the only way the API gets a
/// [`TenantId`] for a request.
#[derive(Clone, Debug)]
pub struct Member {
    pub tenant: Tenant,
    pub role: Role,
}

pub struct Platform {
    writer: Mutex<Connection>,
    readers: ReaderPool,
}

fn valid_slug(slug: &str) -> bool {
    let b = slug.as_bytes();
    (1..=63).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn tenant_row(id: String, slug: String, name: String) -> rusqlite::Result<Tenant> {
    let id = TenantId::parse(id).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(0, "tenants.id".into(), rusqlite::types::Type::Text)
    })?;
    Ok(Tenant { id, slug, name })
}

impl Platform {
    pub(crate) fn open(path: &Path, readers: usize) -> Result<Self, StoreError> {
        let mut writer = conn::open(path, true, false)?;
        Migrations::from_slice(MIGRATIONS).to_latest(&mut writer)?;
        Ok(Self {
            writer: Mutex::new(writer),
            readers: ReaderPool::open(path, readers)?,
        })
    }

    fn write<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, StoreError> {
        Ok(self.readers.with(|conn| f(conn))?)
    }

    /// Insert the tenant row, run `make_file`, commit only if it succeeded.
    pub(crate) fn insert_tenant(
        &self,
        id: &TenantId,
        slug: &str,
        name: &str,
        make_file: impl FnOnce() -> Result<(), StoreError>,
    ) -> Result<Tenant, StoreError> {
        if !valid_slug(slug) {
            return Err(StoreError::InvalidSlug(slug.into()));
        }
        self.write(|tx| {
            let taken: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM tenants WHERE slug = ?1)",
                [slug],
                |r| r.get(0),
            )?;
            if taken {
                return Err(StoreError::SlugTaken(slug.into()));
            }
            tx.execute(
                "INSERT INTO tenants (id, slug, name) VALUES (?1, ?2, ?3)",
                params![id.as_str(), slug, name],
            )?;
            make_file()?;
            Ok(Tenant {
                id: id.clone(),
                slug: slug.into(),
                name: name.into(),
            })
        })
    }

    pub fn tenant_by_slug(&self, slug: &str) -> Result<Option<Tenant>, StoreError> {
        self.read(|c| {
            c.query_row(
                "SELECT id, slug, name FROM tenants WHERE slug = ?1",
                [slug],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .map(|(id, slug, name)| tenant_row(id, slug, name))
            .transpose()
        })
    }

    pub fn tenants(&self) -> Result<Vec<Tenant>, StoreError> {
        self.read(|c| {
            let mut stmt = c.prepare("SELECT id, slug, name FROM tenants ORDER BY slug")?;
            stmt.query_map([], |r| tenant_row(r.get(0)?, r.get(1)?, r.get(2)?))?
                .collect()
        })
    }

    /// The user with this email, created if new. Emails are compared
    /// case-insensitively (stored lower-cased).
    pub fn upsert_user(&self, email: &str) -> Result<UserId, StoreError> {
        let email = email.trim().to_lowercase();
        self.write(|tx| {
            tx.execute(
                "INSERT INTO users (email) VALUES (?1) ON CONFLICT (email) DO NOTHING",
                [&email],
            )?;
            Ok(UserId(tx.query_row(
                "SELECT id FROM users WHERE email = ?1",
                [&email],
                |r| r.get(0),
            )?))
        })
    }

    pub fn set_membership(
        &self,
        user: UserId,
        tenant: &TenantId,
        role: Role,
    ) -> Result<(), StoreError> {
        self.write(|tx| {
            tx.execute(
                "INSERT INTO memberships (user_id, tenant_id, role) VALUES (?1, ?2, ?3)
                 ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = excluded.role",
                params![user.0, tenant.as_str(), role.as_str()],
            )?;
            Ok(())
        })
    }

    /// A new session token for `user`: 244 random bits.
    pub fn create_session(&self, user: UserId, now_ms: i64) -> Result<String, StoreError> {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.write(|tx| {
            tx.execute(
                "INSERT INTO sessions (token, user_id, created_at) VALUES (?1, ?2, ?3)",
                params![token, user.0, now_ms],
            )?;
            Ok(())
        })?;
        Ok(token)
    }

    pub fn delete_session(&self, token: &str) -> Result<(), StoreError> {
        self.write(|tx| {
            tx.execute("DELETE FROM sessions WHERE token = ?1", [token])?;
            Ok(())
        })
    }

    pub fn session(&self, token: &str) -> Result<Option<Session>, StoreError> {
        self.read(|c| {
            c.query_row(
                "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token = ?1",
                [token],
                |r| {
                    Ok(Session {
                        user: UserId(r.get(0)?),
                        email: r.get(1)?,
                    })
                },
            )
            .optional()
        })
    }

    /// `user`'s membership of the tenant at `slug`, if any. Unknown slug and
    /// non-member read the same: `None`.
    pub fn member(&self, user: UserId, slug: &str) -> Result<Option<Member>, StoreError> {
        self.read(|c| {
            c.query_row(
                "SELECT t.id, t.slug, t.name, m.role FROM memberships m
                 JOIN tenants t ON t.id = m.tenant_id
                 WHERE m.user_id = ?1 AND t.slug = ?2",
                params![user.0, slug],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, String>(3)?)),
            )
            .optional()?
            .map(|(id, slug, name, role)| {
                Ok(Member {
                    tenant: tenant_row(id, slug, name)?,
                    role: Role::parse(&role).unwrap_or(Role::Viewer),
                })
            })
            .transpose()
        })
    }

    pub fn memberships(&self, user: UserId) -> Result<Vec<Member>, StoreError> {
        self.read(|c| {
            let mut stmt = c.prepare(
                "SELECT t.id, t.slug, t.name, m.role FROM memberships m
                 JOIN tenants t ON t.id = m.tenant_id
                 WHERE m.user_id = ?1 ORDER BY t.slug",
            )?;
            stmt.query_map([user.0], |r| {
                Ok(Member {
                    tenant: tenant_row(r.get(0)?, r.get(1)?, r.get(2)?)?,
                    role: Role::parse(&r.get::<_, String>(3)?).unwrap_or(Role::Viewer),
                })
            })?
            .collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        for ok in ["a", "alpha", "st-marys-2"] {
            assert!(valid_slug(ok), "{ok}");
        }
        for bad in ["", "-a", "A", "a/b", "..", "a.b", &"a".repeat(64)] {
            assert!(!valid_slug(bad), "{bad}");
        }
    }
}
