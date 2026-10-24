//! `platform.db`: tenants, users, memberships, sessions. The control plane;
//! no domain data lives here.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use rusqlite_migration::{M, Migrations};

use crate::conn::{self, ReaderPool};
use crate::{StoreError, TenantId};

/// How long a session lasts from sign-in (L2; auth replaces the store).
pub const SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

const MIGRATIONS: &[M<'static>] = &[
    M::up(
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
    ),
    // Hourly snapshots (`api::backup`): what each org's (and the
    // 'platform' row's) last snapshots were taken at. No FK: the platform
    // file has a row too. `api::backup` runs the same DDL.
    M::up(
        "CREATE TABLE IF NOT EXISTS snapshots (tenant_id TEXT PRIMARY KEY, last_revision INTEGER, at INTEGER NOT NULL, daily_revision INTEGER, daily_day TEXT, monthly_month TEXT) STRICT;",
    ),
];

/// `platform.db`'s base schema (copied first at boot when steps are
/// pending). Frozen: new tables go in a crate's [`PlatformSchema`].
pub(crate) fn migrations() -> Migrations<'static> {
    Migrations::from_slice(MIGRATIONS)
}

/// One crate's own migration list on `platform.db` (`platform`, `auth`):
/// append-only steps, each run in its own transaction, its version kept
/// in `platform_schema` under `name`, so crates never share a list.
#[derive(Clone, Copy, Debug)]
pub struct PlatformSchema {
    pub name: &'static str,
    pub steps: &'static [&'static str],
}

const SCHEMA_TABLE: &str = "CREATE TABLE IF NOT EXISTS platform_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;";

fn schema_version(conn: &Connection, name: &str) -> rusqlite::Result<usize> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'platform_schema')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    let v: Option<i64> = conn
        .query_row(
            "SELECT version FROM platform_schema WHERE name = ?1",
            [name],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or(0) as usize)
}

/// Whether any schema has steps to run. Fails closed on a file newer than
/// this code: a schema at a version past its steps, or one this code
/// doesn't list at all (a rolled-back release meeting a later crate's
/// tables).
pub(crate) fn schemas_pending(
    conn: &Connection,
    schemas: &[PlatformSchema],
) -> Result<bool, StoreError> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'platform_schema')",
        [],
        |r| r.get(0),
    )?;
    if exists {
        let mut stmt = conn.prepare("SELECT name FROM platform_schema ORDER BY name")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for name in names {
            let name = name?;
            if !schemas.iter().any(|s| s.name == name) {
                return Err(StoreError::UnknownSchema(name));
            }
        }
    }
    let mut pending = false;
    for s in schemas {
        let v = schema_version(conn, s.name)?;
        if v > s.steps.len() {
            return Err(StoreError::NewerSchema {
                name: s.name,
                stored: v,
                code: s.steps.len(),
            });
        }
        pending |= v < s.steps.len();
    }
    Ok(pending)
}

fn migrate_schemas(conn: &mut Connection, schemas: &[PlatformSchema]) -> Result<(), StoreError> {
    schemas_pending(conn, schemas)?;
    for s in schemas {
        for (i, step) in s
            .steps
            .iter()
            .enumerate()
            .skip(schema_version(conn, s.name)?)
        {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(SCHEMA_TABLE)?;
            tx.execute_batch(step)?;
            tx.execute(
                "INSERT INTO platform_schema (name, version) VALUES (?1, ?2)
                 ON CONFLICT (name) DO UPDATE SET version = excluded.version",
                params![s.name, (i + 1) as i64],
            )?;
            tx.commit()?;
        }
    }
    Ok(())
}

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

    pub fn parse(s: &str) -> Option<Self> {
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
    pub(crate) fn open(
        path: &Path,
        readers: usize,
        schemas: &[PlatformSchema],
    ) -> Result<Self, StoreError> {
        let mut writer = conn::open(path, true, false)?;
        migrations().to_latest(&mut writer)?;
        migrate_schemas(&mut writer, schemas)?;
        Ok(Self {
            writer: Mutex::new(writer),
            readers: ReaderPool::open(path, readers)?,
        })
    }

    fn write<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.with_write(|tx| f(tx))
    }

    fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, StoreError> {
        Ok(self.readers.with(|conn| f(conn))?)
    }

    /// Run `f` in one `BEGIN IMMEDIATE` transaction on `platform.db`'s
    /// single writer: commit on `Ok`, roll back on `Err`. Blocking. For the
    /// control-plane crates (`platform`, `auth`), whose functions take the
    /// transaction so several compose into one.
    pub fn with_write<T, E>(&self, f: impl FnOnce(&Transaction) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// Run `f` on a read-only `platform.db` connection. Blocking.
    pub fn with_read<T, E>(&self, f: impl FnOnce(&Connection) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        self.readers.with(|conn| f(conn))
    }

    /// Insert the tenant row, run `make_file` (in the same transaction),
    /// commit only if it succeeded.
    pub(crate) fn insert_tenant(
        &self,
        id: &TenantId,
        slug: &str,
        name: &str,
        make_file: impl FnOnce(&Connection) -> Result<(), StoreError>,
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
            make_file(tx)?;
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
        self.write(|tx| Ok(Self::upsert_user_in(tx, email)?))
    }

    /// [`Platform::upsert_user`] inside a transaction the caller holds.
    pub fn upsert_user_in(conn: &Connection, email: &str) -> rusqlite::Result<UserId> {
        let email = email.trim().to_lowercase();
        conn.execute(
            "INSERT INTO users (email) VALUES (?1) ON CONFLICT (email) DO NOTHING",
            [&email],
        )?;
        Ok(UserId(conn.query_row(
            "SELECT id FROM users WHERE email = ?1",
            [&email],
            |r| r.get(0),
        )?))
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

    /// Forget expired sessions. Returns how many.
    pub fn delete_expired_sessions(&self, now_ms: i64) -> Result<usize, StoreError> {
        self.write(|tx| {
            Ok(tx.execute(
                "DELETE FROM sessions WHERE created_at <= ?1",
                [now_ms - SESSION_TTL_MS],
            )?)
        })
    }

    pub fn delete_session(&self, token: &str) -> Result<(), StoreError> {
        self.write(|tx| {
            tx.execute("DELETE FROM sessions WHERE token = ?1", [token])?;
            Ok(())
        })
    }

    /// The live session for `token`: unknown and expired read the same.
    pub fn session(&self, token: &str, now_ms: i64) -> Result<Option<Session>, StoreError> {
        self.read(|c| {
            c.query_row(
                "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token = ?1 AND s.created_at > ?2",
                params![token, now_ms - SESSION_TTL_MS],
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
