//! Storage: one SQLite file per organisation plus `platform.db`.
//!
//! Tenancy is structural. An [`OrgDb`] is one organisation's file and
//! nothing else; domain code receives an [`OrgTx`] or [`OrgRead`] on it and
//! has no way to name another organisation. A [`TenantId`] can only come
//! from a `platform.db` row (or from creating a tenant), so a request can't
//! choose a file by spelling its name.

mod checkpoint;
mod conn;
mod events;
pub mod files;
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
pub use platform::{Member, Platform, PlatformSchema, Role, Tenant, UserId};
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
    #[error("the new organisation's setup failed")]
    InitFailed,
    #[error("organisation file {0} is missing")]
    MissingFile(PathBuf),
    #[error("platform schema {0:?} is in platform.db but not in this code: a newer release's")]
    UnknownSchema(String),
    #[error("platform schema {name}: stored version {stored} is newer than code version {code}")]
    NewerSchema {
        name: &'static str,
        stored: usize,
        code: usize,
    },
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
    /// Org files get a checkpointer thread (`checkpoint`); off when
    /// Litestream owns checkpoints.
    checkpointer: bool,
}

impl Store {
    /// Open the data directory with only `platform.db`'s base schema (no
    /// crate's [`PlatformSchema`]). For tests on fresh directories: a data
    /// dir the app has opened carries crate schemas, which this refuses as
    /// unknown. Binaries use [`Store::open_with`].
    pub fn open(config: StoreConfig) -> Result<Self, StoreError> {
        Self::open_with(config, &[])
    }

    /// Open the data directory. `platform.db` migrates here (its base
    /// schema, then each of `schemas` in order), copied first (into this
    /// boot's `premigrate/` directory) if any step is pending.
    pub fn open_with(config: StoreConfig, schemas: &[PlatformSchema]) -> Result<Self, StoreError> {
        std::fs::create_dir_all(config.dir.join("orgs"))?;
        let boot = migrate::BootCopies::new(&config.dir);
        let platform_path = config.dir.join("platform.db");
        if platform_path.exists() {
            let conn = conn::open(&platform_path, false, false)?;
            let copied =
                migrate::copy_if_pending(&boot, &conn, &platform::migrations(), "platform")?;
            if !copied && platform::schemas_pending(&conn, schemas)? {
                migrate::copy_platform(&boot, &conn)?;
            }
        }
        let platform = Platform::open(&platform_path, config.readers, schemas)?;
        Ok(Self {
            dir: config.dir,
            platform,
            org_migrations: config.org_migrations,
            readers: config.readers.max(1),
            max_open: config.max_open.max(1),
            orgs: Mutex::new(HashMap::new()),
            boot,
            checkpointer: true,
        })
    }

    /// Leave org files' checkpoints to Litestream: no checkpointer
    /// threads. Under Litestream they can't checkpoint anyway (its read
    /// lock stops any other process copying the WAL back), and their tries
    /// only contend with its own. Call before any org file is opened.
    pub fn without_checkpointer(mut self) -> Self {
        self.checkpointer = false;
        self
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

    /// `files/<tenant-id>.db`: its own directory, never `orgs/`, where
    /// every `*.db` is taken for an org file (g1q1).
    fn files_path(&self, id: &TenantId) -> PathBuf {
        self.dir.join("files").join(format!("{}.db", id.as_str()))
    }

    /// Create a tenant: its `platform.db` row and its org file (stamped
    /// with its id, migrated). The row commits only if the file was made;
    /// the handle is cached only once the row has committed, and the file
    /// is removed if it didn't.
    pub fn create_tenant(&self, slug: &str, name: &str) -> Result<Tenant, StoreError> {
        self.create_tenant_with(slug, name, |_, _, _| Ok::<_, StoreError>(()))
    }

    /// [`Store::create_tenant`], then `init` before the tenant row commits:
    /// with the platform transaction (its admin membership), the tenant,
    /// and its new file (seeds). If `init` fails, nothing remains: no row,
    /// no file.
    pub fn create_tenant_with<E: From<StoreError>>(
        &self,
        slug: &str,
        name: &str,
        init: impl FnOnce(&rusqlite::Connection, &Tenant, &OrgDb) -> Result<(), E>,
    ) -> Result<Tenant, E> {
        let id = TenantId::new();
        let path = self.org_path(&id);
        let mut made = None;
        let mut failed = None;
        let tenant = self.platform.insert_tenant(&id, slug, name, |tx| {
            let db = OrgDb::create(
                &path,
                &self.files_path(&id),
                &id,
                &self.org_migrations,
                self.readers,
                self.checkpointer,
            )?;
            let tenant = Tenant {
                id: id.clone(),
                slug: slug.into(),
                name: name.into(),
            };
            let out = init(tx, &tenant, &db);
            made = Some(db);
            out.map_err(|e| {
                failed = Some(e);
                StoreError::InitFailed
            })
        });
        let tenant = match (tenant, failed) {
            (Err(_), Some(e)) => Err(e),
            (other, _) => other.map_err(E::from),
        };
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
            &self.files_path(id),
            id,
            &self.org_migrations,
            self.readers,
            self.checkpointer,
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
        let mut closed = Vec::new();
        for (_, id) in open {
            if excess == 0 {
                break;
            }
            if close_if_unused(&orgs[&id].slot, &mut closed) {
                orgs.remove(&id);
                excess -= 1;
            }
        }
        // Closed with the map unlocked: closing joins the file's
        // checkpointer and may checkpoint, and every org's requests need
        // the map.
        drop(orgs);
        drop(closed);
    }

    /// Close handles nobody has used for `idle` (the API runs this as a
    /// job). Returns how many were closed. Blocking: closing a file may
    /// checkpoint it.
    pub fn close_idle(&self, idle: Duration) -> usize {
        let mut orgs = self.orgs.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<TenantId> = orgs
            .iter()
            .filter(|(_, e)| e.last_used.elapsed() >= idle)
            .map(|(id, _)| id.clone())
            .collect();
        let mut closed = Vec::new();
        let mut count = 0;
        for id in stale {
            if close_if_unused(&orgs[&id].slot, &mut closed) {
                orgs.remove(&id);
                count += 1;
            }
        }
        // As in `evict`: closed with the map unlocked.
        drop(orgs);
        drop(closed);
        count
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

    /// The largest un-checkpointed WAL among the open org files, in bytes
    /// (`/healthz`). Skips a handle being opened or closed; opens nothing.
    pub fn wal_backlog_worst(&self) -> i64 {
        let slots: Vec<Slot> = self
            .orgs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|e| e.slot.clone())
            .collect();
        slots
            .iter()
            .filter_map(|slot| {
                slot.try_lock()
                    .ok()?
                    .as_ref()
                    .map(|db| db.wal_backlog_bytes())
            })
            .max()
            .unwrap_or(0)
    }

    /// Every organisation's id, from `platform.db`. Jobs loop over these
    /// one file at a time; nothing spans two files in one transaction.
    pub fn each_org(&self) -> Result<Vec<TenantId>, StoreError> {
        Ok(self.platform.tenants()?.into_iter().map(|t| t.id).collect())
    }

    /// Read one organisation's file on a connection of its own, outside
    /// the handle cache (a boot-time scan leaves no handle open). Checks
    /// the stamp; `MissingFile` if the file isn't there.
    pub fn read_org_file<T>(
        &self,
        id: &TenantId,
        f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        let path = self.org_path(id);
        if !path.exists() {
            return Err(StoreError::MissingFile(path));
        }
        let conn = conn::open(&path, false, true)?;
        org::check_stamp(&conn, &path, id)?;
        Ok(f(&conn)?)
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

/// Take the cache's handle out if nobody else holds it and nobody is
/// about to open or use it (holds the slot), into `closed`: the caller
/// drops it once the map is unlocked. Called with the map locked, so no
/// new slot clone can appear meanwhile. True if the slot is now empty.
fn close_if_unused(slot: &Slot, closed: &mut Vec<Arc<OrgDb>>) -> bool {
    if Arc::strong_count(slot) > 1 {
        return false;
    }
    let Ok(mut guard) = slot.try_lock() else {
        return false;
    };
    match guard.as_ref() {
        Some(db) if Arc::strong_count(db) > 1 => false,
        _ => {
            closed.extend(guard.take());
            true
        }
    }
}

pub(crate) fn remove_db_files(path: &Path) {
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

    fn wal_len(path: &Path) -> u64 {
        let mut p = path.as_os_str().to_owned();
        p.push("-wal");
        std::fs::metadata(PathBuf::from(p)).map_or(0, |m| m.len())
    }

    #[test]
    fn commits_never_checkpoint_the_checkpointer_does() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let b = store.create_tenant("beta", "Beta").unwrap();
        let db = store.org(&a.id).unwrap();
        let page = 4096;
        db.pause_checkpoints(true);
        // Each commit writes a page or two, well past SQLite's default
        // auto-checkpoint at 1000. Only a checkpoint writes the main file:
        // its size must not change.
        let file_len = || std::fs::metadata(db.path()).unwrap().len();
        let before = file_len();
        for i in 0..1500 {
            db.write_raw(|tx| {
                tx.conn().execute(
                    "INSERT INTO things (name) VALUES (?1)",
                    [format!("{i:04}{}", "x".repeat(3000))],
                )
            })
            .unwrap();
            assert_eq!(file_len(), before, "commit {i} checkpointed");
        }
        assert!(db.wal_backlog_bytes() > 1000 * page);
        assert!(wal_len(db.path()) as i64 > 1000 * page);
        assert_eq!(store.wal_backlog_worst(), db.wal_backlog_bytes());
        // Another org's file is untouched by it.
        assert_eq!(store.org(&b.id).unwrap().wal_backlog_bytes(), 0);

        // Let the checkpointer go: it copies the WAL back, off the writer.
        db.pause_checkpoints(false);
        let deadline = Instant::now() + Duration::from_secs(10);
        while db.wal_backlog_bytes() > 0 {
            assert!(Instant::now() < deadline, "the checkpointer never ran");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(file_len() > before + 1000 * page as u64);
        // Idle, and the file is past 4 MB: it is truncated next.
        let deadline = Instant::now() + Duration::from_secs(10);
        while wal_len(db.path()) > 0 {
            assert!(
                Instant::now() < deadline,
                "the idle WAL was never truncated"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        let rows = db
            .read(|r| r.query_row("SELECT count(*) FROM things", [], |r| r.get::<_, i64>(0)))
            .unwrap();
        assert_eq!(rows, 1500);
    }

    #[test]
    fn without_a_checkpointer_nothing_checkpoints_but_the_backlog_is_kept() {
        let tmp = tempfile::tempdir().unwrap();
        // Under Litestream: it does the checkpoints.
        let store = store(tmp.path()).without_checkpointer();
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let db = store.org(&a.id).unwrap();
        let file_len = || std::fs::metadata(db.path()).unwrap().len();
        let before = file_len();
        for i in 0..300 {
            db.write_raw(|tx| {
                tx.conn().execute(
                    "INSERT INTO things (name) VALUES (?1)",
                    [format!("{i:04}{}", "x".repeat(3000))],
                )
            })
            .unwrap();
        }
        let backlog = db.wal_backlog_bytes();
        assert!(backlog > 300 * 4096, "{backlog}");
        std::thread::sleep(checkpoint::INTERVAL * 2);
        assert_eq!(file_len(), before, "something checkpointed");
        assert_eq!(db.wal_backlog_bytes(), backlog);
    }

    #[test]
    fn closing_an_org_still_checkpoints_it() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let db = store.org(&a.id).unwrap();
        db.pause_checkpoints(true);
        for _ in 0..50 {
            db.write_raw(|tx| {
                tx.conn()
                    .execute("INSERT INTO things (name) VALUES ('x')", [])
            })
            .unwrap();
        }
        let path = db.path().to_path_buf();
        assert!(wal_len(&path) > 0);
        drop(db);
        drop(store);
        // The last connection to close checkpointed and removed the WAL.
        assert_eq!(wal_len(&path), 0);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM things", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 50);
    }

    #[test]
    fn a_queued_write_runs_between_two_steps_of_a_loop() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let db = store.org(&a.id).unwrap();
        let steps = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        // A job: short steps back to back, each its own transaction, as
        // `Tenant::run_job` runs them; each holds the writer ~0.1 ms.
        let job = {
            let (db, steps, stop) = (db.clone(), steps.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    db.write_raw(|tx| {
                        tx.conn()
                            .execute("INSERT INTO things (name) VALUES ('step')", [])?;
                        let t = Instant::now();
                        while t.elapsed() < Duration::from_micros(100) {
                            std::hint::spin_loop();
                        }
                        Ok::<_, rusqlite::Error>(())
                    })
                    .unwrap();
                    steps.fetch_add(1, Ordering::SeqCst);
                }
            })
        };
        while steps.load(Ordering::SeqCst) == 0 {
            std::thread::yield_now();
        }
        // Request writes, one at a time: how many job steps commit between
        // a request asking for the writer and getting it? Handed off, the
        // one the request was queued behind (plus one if it hadn't parked
        // yet); with std's mutex the job keeps it, thousands of steps.
        // (parking_lot's plain unlock hands off here too in practice;
        // `unlock_fair` makes it a guarantee, which no timing test can
        // tell apart.) The median, so a request a loaded machine
        // deschedules before it queues can't fail the test.
        let mut passed: Vec<u64> = (0..21)
            .map(|_| {
                let asked = steps.load(Ordering::SeqCst);
                let got = db
                    .write_raw(|tx| {
                        tx.conn()
                            .execute("INSERT INTO things (name) VALUES ('request')", [])?;
                        Ok::<_, rusqlite::Error>(steps.load(Ordering::SeqCst))
                    })
                    .unwrap();
                std::thread::sleep(Duration::from_millis(1));
                got - asked
            })
            .collect();
        stop.store(true, Ordering::SeqCst);
        job.join().unwrap();
        passed.sort();
        assert!(passed[passed.len() / 2] <= 2, "steps passed: {passed:?}");
    }

    #[test]
    fn the_files_db_is_made_at_the_first_put_stamped_and_per_org() {
        use crate::files::{CAP_BYTES, FilesError};
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let b = store.create_tenant("beta", "Beta").unwrap();
        let a_db = store.org(&a.id).unwrap();
        // No scan yet: no file, and reading makes none.
        assert!(a_db.files_if_any().unwrap().is_none());
        let files_dir = tmp.path().join("files");
        assert!(!files_dir.join(format!("{}.db", a.id)).exists());

        let page = b"a page".to_vec();
        let put = a_db
            .files()
            .unwrap()
            .put(&page, "image/jpeg", 1, CAP_BYTES)
            .unwrap();
        assert!(put.new);
        assert_eq!(put.sha256, crate::files::sha256_hex(&page));
        assert!(files_dir.join(format!("{}.db", a.id)).exists());
        // Never under orgs/: the boot migration takes every *.db there.
        assert_eq!(migrate::org_files(tmp.path()).unwrap().len(), 2);
        // Idempotent by content.
        let again = a_db
            .files()
            .unwrap()
            .put(&page, "image/jpeg", 2, CAP_BYTES)
            .unwrap();
        assert!(!again.new);
        assert_eq!(a_db.files().unwrap().usage().unwrap(), page.len() as i64);
        let got = a_db.files().unwrap().get(&put.sha256).unwrap().unwrap();
        assert_eq!(
            (got.bytes, got.content_type.as_str()),
            (page.clone(), "image/jpeg")
        );

        // B holds nothing of A's, even by the same key, and asking makes
        // B no file.
        let b_db = store.org(&b.id).unwrap();
        assert!(b_db.files_if_any().unwrap().is_none());
        b_db.files()
            .unwrap()
            .put(b"other", "image/jpeg", 1, CAP_BYTES)
            .unwrap();
        assert!(b_db.files().unwrap().get(&put.sha256).unwrap().is_none());

        // The cap: a new blob past it is refused, one already held isn't.
        let tight = page.len() as i64 + 3;
        let refused = a_db.files().unwrap().put(b"four", "image/jpeg", 3, tight);
        assert!(matches!(refused, Err(FilesError::Full { .. })));
        assert!(
            a_db.files()
                .unwrap()
                .put(&page, "image/jpeg", 3, tight)
                .is_ok()
        );

        // Closed with the org's handle, reopened from disk.
        drop((a_db, b_db));
        drop(store);
        let store = self::store(tmp.path());
        let a_db = store.org(&a.id).unwrap();
        assert!(
            a_db.files_if_any()
                .unwrap()
                .unwrap()
                .get(&put.sha256)
                .unwrap()
                .is_some()
        );

        // A's files db copied over B's is refused, like an org file.
        drop(a_db);
        drop(store);
        std::fs::copy(
            files_dir.join(format!("{}.db", a.id)),
            files_dir.join(format!("{}.db", b.id)),
        )
        .unwrap();
        let store = self::store(tmp.path());
        assert!(matches!(
            store.org(&b.id).unwrap().files_if_any(),
            Err(StoreError::WrongFile { .. })
        ));
    }

    #[test]
    fn delete_unreferenced_keeps_referenced_and_recently_put_blobs() {
        use crate::files::CAP_BYTES;
        use std::collections::HashSet;
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let a = store.create_tenant("alpha", "Alpha").unwrap();
        let files = store.org(&a.id).unwrap().files().unwrap();
        let old_kept = files.put(b"kept", "image/jpeg", 100, CAP_BYTES).unwrap();
        let old_orphan = files.put(b"orphan", "image/jpeg", 100, CAP_BYTES).unwrap();
        let fresh = files.put(b"fresh", "image/jpeg", 1_000, CAP_BYTES).unwrap();
        // An old blob put again just now (a write in flight) is fresh.
        let reput = files.put(b"reput", "image/jpeg", 100, CAP_BYTES).unwrap();
        files.put(b"reput", "image/jpeg", 1_000, CAP_BYTES).unwrap();
        let before = files.changes().unwrap();
        let referenced: HashSet<String> = [old_kept.sha256.clone()].into();
        let gone = files.delete_unreferenced(&referenced, 500).unwrap();
        assert_eq!(gone, vec![old_orphan.sha256.clone()]);
        for kept in [&old_kept, &fresh, &reput] {
            assert!(files.get(&kept.sha256).unwrap().is_some());
        }
        assert!(files.get(&old_orphan.sha256).unwrap().is_none());
        assert_eq!(files.changes().unwrap(), before + 1);
        // Nothing to delete: the counter stays.
        assert!(
            files
                .delete_unreferenced(&referenced, 500)
                .unwrap()
                .is_empty()
        );
        assert_eq!(files.changes().unwrap(), before + 1);
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
