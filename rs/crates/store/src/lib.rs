//! Storage: one SQLite file per organisation plus `platform.db`.
//!
//! Tenancy is structural. An [`OrgDb`] is one organisation's file and
//! nothing else; domain code receives an [`OrgTx`] or [`OrgRead`] on it and
//! has no way to name another organisation. A [`TenantId`] can only come
//! from a `platform.db` row (or from creating a tenant), so a request can't
//! choose a file by spelling its name.

mod conn;
mod events;
mod migrate;
mod org;
mod platform;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use conn::read_only_authorizer;
pub use events::OrgEvent;
pub use migrate::MigrationFailed;
pub use org::{OrgDb, OrgRead, RawTx};
pub use platform::{Member, Platform, Role, SESSION_TTL_MS, Session, Tenant, UserId};
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
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
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

impl fmt::Display for TenantId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Opening options for a [`Store`].
pub struct StoreConfig {
    pub dir: PathBuf,
    /// The org schema, run on every org file (at boot by
    /// [`Store::migrate_all`], and on open). Append-only.
    pub org_migrations: Migrations<'static>,
    /// Reader connections per file.
    pub readers: usize,
    /// Open org handles kept beyond those in use (`KEEP_MAX_OPEN_ORGS`).
    pub max_open: usize,
}

impl StoreConfig {
    pub const DEFAULT_MAX_OPEN: usize = 64;
}

/// One organisation's place in the handle cache. The slot's own mutex is
/// that org's open lock: opening (and migrating) one file never blocks a
/// request to another.
type Slot = Arc<Mutex<Option<Arc<OrgDb>>>>;

struct Entry {
    slot: Slot,
    last_used: Instant,
}

/// The data directory: `platform.db` and `orgs/<tenant-id>.db`, with an LRU
/// of open org handles (one writer + reader pool per file).
pub struct Store {
    dir: PathBuf,
    platform: Platform,
    org_migrations: Migrations<'static>,
    readers: usize,
    max_open: usize,
    orgs: Mutex<HashMap<TenantId, Entry>>,
    boot: migrate::BootCopies,
}

impl Store {
    /// Open the data directory. `platform.db` migrates here, copied first
    /// (into this boot's `premigrate/` directory) if it has steps pending.
    pub fn open(config: StoreConfig) -> Result<Self, StoreError> {
        std::fs::create_dir_all(config.dir.join("orgs"))?;
        let boot = migrate::BootCopies::new(&config.dir);
        let platform_path = config.dir.join("platform.db");
        if platform_path.exists() {
            let conn = conn::open(&platform_path, false, false)?;
            migrate::copy_if_pending(&boot, &conn, &platform::migrations(), "platform")?;
        }
        let platform = Platform::open(&platform_path, config.readers)?;
        Ok(Self {
            dir: config.dir,
            platform,
            org_migrations: config.org_migrations,
            readers: config.readers.max(1),
            max_open: config.max_open.max(1),
            orgs: Mutex::new(HashMap::new()),
            boot,
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
    /// with its id, migrated). The row commits only if the file was made;
    /// the handle is cached only once the row has committed, and the file
    /// is removed if it didn't.
    pub fn create_tenant(&self, slug: &str, name: &str) -> Result<Tenant, StoreError> {
        let id = TenantId::new();
        let path = self.org_path(&id);
        let mut made = None;
        let tenant = self.platform.insert_tenant(&id, slug, name, || {
            made = Some(OrgDb::create(
                &path,
                &id,
                &self.org_migrations,
                self.readers,
            )?);
            Ok(())
        });
        match tenant {
            Ok(tenant) => {
                if let Some(db) = made {
                    self.cache(&id, Arc::new(db));
                }
                Ok(tenant)
            }
            Err(err) => {
                if made.take().is_some() {
                    remove_db_files(&path);
                }
                Err(err)
            }
        }
    }

    fn slot(&self, id: &TenantId) -> Slot {
        let mut orgs = self.orgs.lock().unwrap_or_else(|e| e.into_inner());
        let entry = orgs.entry(id.clone()).or_insert_with(|| Entry {
            slot: Arc::default(),
            last_used: Instant::now(),
        });
        entry.last_used = Instant::now();
        entry.slot.clone()
    }

    fn cache(&self, id: &TenantId, db: Arc<OrgDb>) {
        *self.slot(id).lock().unwrap_or_else(|e| e.into_inner()) = Some(db);
        self.evict();
    }

    /// The open handle on one organisation's file. Fails if the file is
    /// missing or stamped with another tenant's id. Only this org's open
    /// lock is held while it opens.
    pub fn org(&self, id: &TenantId) -> Result<Arc<OrgDb>, StoreError> {
        let slot = self.slot(id);
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(db) = guard.as_ref() {
            return Ok(db.clone());
        }
        let db = Arc::new(OrgDb::open(
            &self.org_path(id),
            id,
            &self.org_migrations,
            self.readers,
        )?);
        *guard = Some(db.clone());
        drop(guard);
        self.evict();
        Ok(db)
    }

    /// Close least-recently-used handles until at most `max_open` are
    /// open. A handle in use (someone holds its `Arc`) or being opened is
    /// never closed; it is reconsidered next time.
    fn evict(&self) {
        let mut orgs = self.orgs.lock().unwrap_or_else(|e| e.into_inner());
        let mut open: Vec<(Instant, TenantId)> = orgs
            .iter()
            .filter(|(_, e)| e.slot.try_lock().is_ok_and(|s| s.is_some()))
            .map(|(id, e)| (e.last_used, id.clone()))
            .collect();
        if open.len() <= self.max_open {
            return;
        }
        open.sort();
        let mut excess = open.len() - self.max_open;
        for (_, id) in open {
            if excess == 0 {
                break;
            }
            if close_if_unused(&orgs[&id].slot) {
                orgs.remove(&id);
                excess -= 1;
            }
        }
    }

    /// Close handles nobody has used for `idle` (the API runs this as a
    /// job). Returns how many were closed.
    pub fn close_idle(&self, idle: Duration) -> usize {
        let mut orgs = self.orgs.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<TenantId> = orgs
            .iter()
            .filter(|(_, e)| e.last_used.elapsed() >= idle)
            .map(|(id, _)| id.clone())
            .collect();
        let mut closed = 0;
        for id in stale {
            if close_if_unused(&orgs[&id].slot) {
                orgs.remove(&id);
                closed += 1;
            }
        }
        closed
    }

    /// How many org files are open now.
    pub fn open_count(&self) -> usize {
        self.orgs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| e.slot.try_lock().map_or(true, |s| s.is_some()))
            .count()
    }

    /// Every organisation's id, from `platform.db`. Jobs loop over these
    /// one file at a time; nothing spans two files in one transaction.
    pub fn each_org(&self) -> Result<Vec<TenantId>, StoreError> {
        Ok(self.platform.tenants()?.into_iter().map(|t| t.id).collect())
    }

    /// Bring every `orgs/*.db` to the head schema before serving: 4 files
    /// at a time, each copied first (`VACUUM INTO
    /// premigrate/boot-<ms>/<id>.v<from>.db`) if it has migrations pending.
    /// The first failure is returned naming the org; the caller stops the
    /// boot.
    pub fn migrate_all(&self) -> Result<usize, MigrationFailed> {
        migrate::migrate_all(&self.dir, &self.boot, &self.org_migrations, 4)
    }
}

/// Drop the cache's handle if nobody else holds it and nobody is about to
/// open or use it (holds the slot). Called with the map locked, so no new
/// slot clone can appear meanwhile. True if the slot is now empty.
fn close_if_unused(slot: &Slot) -> bool {
    if Arc::strong_count(slot) > 1 {
        return false;
    }
    let Ok(mut guard) = slot.try_lock() else {
        return false;
    };
    match guard.as_ref() {
        Some(db) if Arc::strong_count(db) > 1 => false,
        _ => {
            *guard = None;
            true
        }
    }
}

fn remove_db_files(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(p));
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
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
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
        a_db.write_raw(|tx| {
            tx.conn()
                .execute("INSERT INTO things (name) VALUES ('a-thing')", [])
        })
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
        assert!(db.write_raw(|tx| tx.conn().execute_batch(&sql)).is_err());
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
