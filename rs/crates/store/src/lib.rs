//! Storage: one SQLite file per organisation plus `platform.db`.
//!
//! Tenancy is structural. An [`OrgDb`] is one organisation's file and
//! nothing else; domain code receives an [`OrgTx`] or [`OrgRead`] on it and
//! has no way to name another organisation. A [`TenantId`] can only come
//! from a `platform.db` row (or from creating a tenant), so a request can't
//! choose a file by spelling its name.

mod conn;
mod events;
mod org;
mod platform;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub use events::OrgEvent;
pub use org::{OrgDb, OrgRead, OrgTx};
pub use platform::{Member, Platform, Role, Session, Tenant, UserId};
pub use rusqlite_migration::{M, Migrations};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Migration(#[from] rusqlite_migration::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("invalid slug {0:?}")]
    InvalidSlug(String),
    #[error("slug {0:?} is taken")]
    SlugTaken(String),
    #[error("organisation file {path} belongs to tenant {found}, expected {expected}")]
    WrongFile {
        path: PathBuf,
        expected: String,
        found: String,
    },
    #[error("organisation file {0} is missing")]
    MissingFile(PathBuf),
}

/// An organisation's id: 32 lowercase hex characters (a UUIDv7, simple
/// form), which is also its file name under `orgs/`. Not constructible
/// outside this crate except by reading `platform.db`, and validated even
/// then, so a corrupt row can't become a path.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct TenantId(String);

impl TenantId {
    fn new() -> Self {
        Self(uuid::Uuid::now_v7().simple().to_string())
    }

    fn parse(raw: String) -> Option<Self> {
        let ok = raw.len() == 32
            && raw
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        ok.then_some(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TenantId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TenantId({})", self.0)
    }
}

/// Opening options for a [`Store`].
pub struct StoreConfig {
    pub dir: PathBuf,
    /// The org schema, run on every org file when it opens. Append-only.
    pub org_migrations: Migrations<'static>,
    /// Reader connections per file.
    pub readers: usize,
}

/// The data directory: `platform.db` and `orgs/<tenant-id>.db`, with a
/// cache of open org handles (one writer + reader pool per file).
pub struct Store {
    dir: PathBuf,
    platform: Platform,
    org_migrations: Migrations<'static>,
    readers: usize,
    orgs: Mutex<HashMap<TenantId, Arc<OrgDb>>>,
}

impl Store {
    pub fn open(config: StoreConfig) -> Result<Self, StoreError> {
        std::fs::create_dir_all(config.dir.join("orgs"))?;
        let platform = Platform::open(&config.dir.join("platform.db"), config.readers)?;
        Ok(Self {
            dir: config.dir,
            platform,
            org_migrations: config.org_migrations,
            readers: config.readers.max(1),
            orgs: Mutex::new(HashMap::new()),
        })
    }

    pub fn platform(&self) -> &Platform {
        &self.platform
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn org_path(&self, id: &TenantId) -> PathBuf {
        self.dir.join("orgs").join(format!("{}.db", id.as_str()))
    }

    /// Create a tenant: its `platform.db` row and its org file (stamped
    /// with its id, migrated). The row commits only if the file was made.
    pub fn create_tenant(&self, slug: &str, name: &str) -> Result<Tenant, StoreError> {
        let id = TenantId::new();
        self.platform.insert_tenant(&id, slug, name, || {
            let path = self.org_path(&id);
            let db = OrgDb::create(&path, &id, &self.org_migrations, self.readers)?;
            self.orgs.lock().unwrap().insert(id.clone(), Arc::new(db));
            Ok(())
        })
    }

    /// The open handle on one organisation's file. Fails if the file is
    /// missing or stamped with another tenant's id.
    pub fn org(&self, id: &TenantId) -> Result<Arc<OrgDb>, StoreError> {
        let mut orgs = self.orgs.lock().unwrap();
        if let Some(db) = orgs.get(id) {
            return Ok(db.clone());
        }
        let db = Arc::new(OrgDb::open(
            &self.org_path(id),
            id,
            &self.org_migrations,
            self.readers,
        )?);
        orgs.insert(id.clone(), db.clone());
        Ok(db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path) -> Store {
        Store::open(StoreConfig {
            dir: dir.to_path_buf(),
            org_migrations: Migrations::new(vec![M::up(
                "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
            )]),
            readers: 2,
        })
        .unwrap()
    }

    #[test]
    fn tenant_ids_never_become_paths_unless_well_formed() {
        assert!(TenantId::parse("../../etc/passwd".into()).is_none());
        assert!(TenantId::parse("0123456789ABCDEF0123456789abcdef".into()).is_none());
        assert!(TenantId::parse("0123456789abcdef0123456789abcdef".into()).is_some());
    }

    #[test]
    fn each_org_is_its_own_file() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let b = store.create_tenant("beta", "Beta").unwrap();
        assert_ne!(a.id, b.id);

        let a_db = store.org(&a.id).unwrap();
        a_db.write(|tx| tx.execute("INSERT INTO things (name) VALUES ('a-thing')", []))
            .unwrap();
        let count = |db: &OrgDb| {
            db.read(|r| {
                r.query_row("SELECT count(*) FROM things", [], |row| {
                    row.get::<_, i64>(0)
                })
            })
            .unwrap()
        };
        assert_eq!(count(&a_db), 1);
        assert_eq!(count(&store.org(&b.id).unwrap()), 0);

        // Reopened from disk (fresh store), the files keep their contents.
        drop(store);
        let store = self::store(tmp.path());
        assert_eq!(count(&store.org(&a.id).unwrap()), 1);
        assert_eq!(count(&store.org(&b.id).unwrap()), 0);
    }

    #[test]
    fn a_file_stamped_for_another_tenant_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let b = store.create_tenant("beta", "Beta").unwrap();
        drop(store);
        // Someone copies A's file over B's.
        std::fs::copy(
            tmp.path().join(format!("orgs/{}.db", a.id.as_str())),
            tmp.path().join(format!("orgs/{}.db", b.id.as_str())),
        )
        .unwrap();
        let store = self::store(tmp.path());
        assert!(matches!(
            store.org(&b.id),
            Err(StoreError::WrongFile { .. })
        ));
    }

    #[test]
    fn org_connections_cannot_attach_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let b = store.create_tenant("beta", "Beta").unwrap();
        let b_path = tmp.path().join(format!("orgs/{}.db", b.id.as_str()));
        let sql = format!("ATTACH DATABASE '{}' AS other", b_path.display());
        let db = store.org(&a.id).unwrap();
        assert!(db.write(|tx| tx.execute_batch(&sql)).is_err());
        assert!(db.read(|r| r.execute_batch(&sql)).is_err());
    }

    #[test]
    fn readers_are_read_only() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let db = store.org(&a.id).unwrap();
        assert!(
            db.read(|r| r.execute("INSERT INTO things (name) VALUES ('x')", []))
                .is_err()
        );
    }

    #[test]
    fn slugs_are_validated_and_unique() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        assert!(matches!(
            store.create_tenant("../x", "X"),
            Err(StoreError::InvalidSlug(_))
        ));
        store.create_tenant("alpha", "Alpha").unwrap();
        assert!(matches!(
            store.create_tenant("alpha", "Again"),
            Err(StoreError::SlugTaken(_))
        ));
        // The refused tenant left no file behind.
        assert_eq!(
            std::fs::read_dir(tmp.path().join("orgs"))
                .unwrap()
                .filter(|e| {
                    e.as_ref()
                        .unwrap()
                        .path()
                        .extension()
                        .is_some_and(|x| x == "db")
                })
                .count(),
            1
        );
    }
}
