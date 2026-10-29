//! Hourly snapshots: the second backup beside Litestream (plan
//! `migration-rust.sv`, round 2). Every hour, each org file whose newest
//! revision id moved since its last snapshot, plus `platform.db`, is
//! copied (`VACUUM INTO`, one read transaction, so the copy is consistent
//! under writes), checked (`integrity_check`), compressed (zstd) and
//! uploaded to the snapshot bucket, which lives in another AWS account
//! with Object Lock. The app can put and read there, never delete.
//!
//! Keys are `<tier>/<env>/<tenant-id|platform>/<YYYY-MM-DDTHHZ>.db.zst`.
//! The tier is in the key so the bucket's lifecycle rules can expire by
//! prefix (`scripts/aws/backup.sh`: hourly 48 h, daily 30 d, monthly 12
//! months). Which tiers a file gets, per run:
//!
//! - **hourly** when its revision moved since the last snapshot (always
//!   for `platform.db`, which has no revisions);
//! - **daily** at the first run of a UTC day, when it moved since the last
//!   daily one: the end-of-yesterday state;
//! - **monthly** at the first run of a UTC month, whether it moved or
//!   not, so an org untouched for a year still has a copy.
//!
//! So the newest state of every file is always in the bucket: in the
//! hourly tier for 48 h, the daily for 30 d, then the monthly.
//!
//! An organisation's **files db** (`files/<tenant-id>.db`, scanned pages:
//! `store::files`) is a source too, named `files-<tenant-id>`, with no
//! hourly tier (plan `declaration-scans.sv`, g2q2): it can reach 2 GB and
//! its blobs never change, so it is copied at most daily, when its change
//! counter moved since the last daily copy, plus the monthly. Litestream
//! covers the hours in between.
//!
//! What was uploaded is recorded in `platform.db` (`snapshots`). The job
//! never holds a transaction across two files.
//!
//! **Nothing is held whole in memory** (a files db can be 2 GB; a machine
//! has 512 MB): the copy and its zstd are files under `snapshots-tmp/`,
//! compressed stream to stream, and the upload's body is the compressed
//! file memory-mapped, clean file-backed pages the kernel can drop, never
//! the heap. It stays one create-only `PUT` (`If-None-Match: *`): the
//! bucket policy refuses a write without it, multipart uploads included,
//! and a multipart complete could overwrite. S3 takes up to 5 GB in one
//! `PUT`. A restore streams the download to a file, then decompresses
//! file to file.
//!
//! Also here: what `/healthz` reports about backups ([`health`]): the age
//! of the last snapshot and Litestream's replication lag, read from its
//! control socket (`GET /list`, `last_sync_at` per database).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use object_store::aws::{AmazonS3Builder, Checksum, S3ConditionalPut};
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt, PutMode, PutOptions, PutPayload};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;

const PLATFORM: &str = "platform";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Hourly,
    Daily,
    Monthly,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Hourly => "hourly",
            Tier::Daily => "daily",
            Tier::Monthly => "monthly",
        }
    }
}

/// The object key of one snapshot. Stamped to the minute, so a second
/// pass in the same hour (`keep-snapshot run` beside the job) gets its own
/// key: keys are never overwritten (see [`SnapshotJob`]).
pub fn key(tier: Tier, env: &str, name: &str, at: OffsetDateTime) -> ObjectPath {
    ObjectPath::from(format!(
        "{}/{env}/{name}/{}.db.zst",
        tier.as_str(),
        stamp(at)
    ))
}

/// `YYYY-MM-DDTHHMMZ` in UTC: sorts as a string in time order.
fn stamp(at: OffsetDateTime) -> String {
    at.to_offset(time::UtcOffset::UTC)
        .format(format_description!("[year]-[month]-[day]T[hour][minute]Z"))
        .expect("format a UTC minute")
}

/// The snapshot job's settings.
pub struct SnapshotConfig {
    /// The data dir: `platform.db` and `orgs/`.
    pub data_dir: PathBuf,
    /// `KEEP_ENV`: the second key segment, so staging and prod can share a
    /// bucket and each IAM user is limited to its own.
    pub env: String,
    pub bucket: Arc<dyn ObjectStore>,
}

impl SnapshotConfig {
    /// From the environment; `None` when `KEEP_SNAPSHOT_BUCKET` is unset
    /// (dev, QC, tests: snapshots off).
    ///
    /// `KEEP_SNAPSHOT_BUCKET` (or `file:///some/dir`), `KEEP_SNAPSHOT_REGION`
    /// (default eu-west-2),
    /// `KEEP_SNAPSHOT_ACCESS_KEY_ID`, `KEEP_SNAPSHOT_SECRET_ACCESS_KEY`,
    /// optionally `KEEP_SNAPSHOT_SESSION_TOKEN` (temporary credentials) and
    /// `KEEP_SNAPSHOT_ENDPOINT` (any S3-compatible store), and
    /// `KEEP_ENV` (default `dev`). Not the `AWS_*` names: those belong to
    /// Litestream's replica, which is another account and another key.
    pub fn from_env(data_dir: &Path) -> Result<Option<Self>, String> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let Some(bucket) = var("KEEP_SNAPSHOT_BUCKET") else {
            return Ok(None);
        };
        let env = var("KEEP_ENV").unwrap_or_else(|| "dev".into());
        // A directory standing in for the bucket: local runs of the image's
        // restore path, without S3.
        if let Some(dir) = bucket.strip_prefix("file://") {
            std::fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))?;
            let local = object_store::local::LocalFileSystem::new_with_prefix(dir)
                .map_err(|e| e.to_string())?;
            return Ok(Some(Self {
                data_dir: data_dir.to_path_buf(),
                env,
                bucket: Arc::new(local),
            }));
        }
        let need =
            |k: &str| var(k).ok_or_else(|| format!("{k} is required with KEEP_SNAPSHOT_BUCKET"));
        let mut s3 = AmazonS3Builder::new()
            .with_bucket_name(bucket)
            .with_region(var("KEEP_SNAPSHOT_REGION").unwrap_or_else(|| "eu-west-2".into()))
            .with_access_key_id(need("KEEP_SNAPSHOT_ACCESS_KEY_ID")?)
            .with_secret_access_key(need("KEEP_SNAPSHOT_SECRET_ACCESS_KEY")?)
            // An Object Lock bucket refuses a PUT without an integrity
            // checksum (Content-MD5 or x-amz-checksum-*).
            .with_checksum_algorithm(Checksum::SHA256)
            // `PutMode::Create` sends `If-None-Match: *`; the bucket policy
            // refuses any PUT from the app without it.
            .with_conditional_put(S3ConditionalPut::ETagMatch);
        // Temporary credentials (a human's SSO profile, for a local drill).
        if let Some(token) = var("KEEP_SNAPSHOT_SESSION_TOKEN") {
            s3 = s3.with_token(token);
        }
        if let Some(endpoint) = var("KEEP_SNAPSHOT_ENDPOINT") {
            s3 = s3
                .with_allow_http(endpoint.starts_with("http://"))
                .with_endpoint(endpoint);
        }
        let bucket = s3.build().map_err(|e| e.to_string())?;
        Ok(Some(Self {
            data_dir: data_dir.to_path_buf(),
            env,
            bucket: Arc::new(bucket),
        }))
    }
}

/// What one run did.
#[derive(Debug, Default, Clone)]
pub struct RunReport {
    /// `(name, tiers)` for every file uploaded.
    pub uploaded: Vec<(String, Vec<Tier>)>,
    /// Files with nothing to do.
    pub skipped: usize,
    /// `(name, error)`: a failed file doesn't stop the others.
    pub failed: Vec<(String, String)>,
}

pub struct SnapshotJob {
    config: SnapshotConfig,
    /// The UTC day whose usage line ([`usage_line`]) is logged.
    usage_logged: Mutex<Option<time::Date>>,
}

impl crate::jobs::Job for SnapshotJob {
    fn name(&self) -> &'static str {
        "snapshots"
    }

    fn every(&self) -> Duration {
        Duration::from_secs(3600)
    }

    /// A minute after boot, not an hour: staging's reset empties the
    /// ledger on every deploy, and prod must get a snapshot even when
    /// deploys come faster than hourly. A minute keeps a crash loop from
    /// uploading every few seconds.
    fn first_after(&self) -> Duration {
        Duration::from_secs(60)
    }

    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let now = OffsetDateTime::now_utc();
            let first_today = {
                let mut day = self.usage_logged.lock().unwrap();
                let first = *day != Some(now.date());
                *day = Some(now.date());
                first
            };
            if first_today {
                eprintln!("{}", usage_line(&self.config.data_dir));
            }
            let report = self.run_once(now).await?;
            let failed = report.failed.len();
            if let Some(state) = HEALTH.get() {
                *state.last_run.lock().unwrap() = Some(report.clone());
            }
            eprintln!(
                "snapshots: {} uploaded, {} unchanged, {failed} failed",
                report.uploaded.len(),
                report.skipped
            );
            if failed == 0 {
                Ok(())
            } else {
                let err = report
                    .failed
                    .iter()
                    .map(|(name, e)| format!("{name}: {e}"))
                    .collect::<Vec<_>>()
                    .join("; ");
                // The job runner only logs; failed snapshots also go to
                // Sentry.
                crate::observe::error(&format!("snapshots: {err}"));
                Err(err)
            }
        })
    }
}

/// The daily line of what the data volume holds, so growth can be read
/// from the log: org files and files dbs (count, bytes), and the volume.
pub fn usage_line(data_dir: &Path) -> String {
    let u = crate::scans::limits::data_usage(data_dir);
    let volume = match crate::scans::limits::volume(data_dir) {
        Ok((free, total)) => format!("{free} of {total} bytes free"),
        Err(e) => format!("unreadable ({e})"),
    };
    format!(
        "data usage: {} org files {} bytes, {} files dbs {} bytes; volume {volume}",
        u.org_files, u.org_bytes, u.files_dbs, u.files_bytes
    )
}

/// One source file: `platform.db`, an org file named by its tenant id,
/// or an org's files db (`files-<tenant id>`).
struct Source {
    name: String,
    path: PathBuf,
}

/// The snapshot name of an organisation's files db.
const FILES_PREFIX: &str = "files-";

fn is_files(name: &str) -> bool {
    name.starts_with(FILES_PREFIX)
}

/// A `snapshots` row.
#[derive(Default)]
struct Ledger {
    last_revision: Option<i64>,
    daily_revision: Option<i64>,
    daily_day: Option<String>,
    monthly_month: Option<String>,
}

impl SnapshotJob {
    pub fn new(config: SnapshotConfig) -> Self {
        Self {
            config,
            usage_logged: Mutex::new(None),
        }
    }

    /// Snapshot what's due at `now`. Errors only if the data dir can't be
    /// read; a failing file is in the report.
    ///
    /// `platform.db` goes first and `orgs/` is listed after its copy, so
    /// the platform copy never names an org this run didn't see.
    pub async fn run_once(&self, now: OffsetDateTime) -> Result<RunReport, String> {
        let mut report = RunReport::default();
        let platform = Source {
            name: PLATFORM.into(),
            path: platform_path(&self.config.data_dir),
        };
        let dir = self.config.data_dir.clone();
        let mut sources = vec![platform];
        let mut listed = false;
        while let Some(source) = sources.pop() {
            match self.one(&source, now).await {
                Ok(tiers) if tiers.is_empty() => report.skipped += 1,
                Ok(tiers) => report.uploaded.push((source.name, tiers)),
                Err(e) => report.failed.push((source.name, e)),
            }
            if !listed {
                listed = true;
                let dir = dir.clone();
                sources = off(move || {
                    let mut all = org_sources(&dir)?;
                    all.extend(files_sources(&dir)?);
                    Ok(all)
                })
                .await?;
                sources.reverse(); // popped from the end: sorted order
            }
        }
        Ok(report)
    }

    async fn one(&self, source: &Source, now: OffsetDateTime) -> Result<Vec<Tier>, String> {
        let ledger_path = platform_path(&self.config.data_dir);
        let (name, path) = (source.name.clone(), source.path.clone());
        let tmp_dir = self.config.data_dir.join("snapshots-tmp");
        // Decide, copy, check, compress: all blocking.
        let prepared = off(move || {
            let revision = if name == PLATFORM {
                None
            } else if is_files(&name) {
                Some(files_changes(&path)?)
            } else {
                Some(latest_revision(&path)?)
            };
            let ledger = ledger_row(&ledger_path, &name)?;
            let mut tiers = due(&ledger, revision, now);
            if is_files(&name) {
                // Daily at most (g2q2).
                tiers.retain(|t| *t != Tier::Hourly);
            }
            if tiers.is_empty() {
                return Ok::<_, String>(None);
            }
            let compressed = copy_and_compress(&path, &tmp_dir, &name)?;
            Ok(Some((tiers, revision, compressed)))
        })
        .await?;
        let Some((tiers, revision, compressed)) = prepared else {
            return Ok(vec![]);
        };
        let uploaded = self.upload(source, now, &tiers, &compressed).await;
        let _ = std::fs::remove_file(&compressed);
        let uploaded = uploaded?;
        if uploaded.is_empty() {
            return Ok(vec![]);
        }
        let ledger_path = platform_path(&self.config.data_dir);
        let (name, recorded) = (source.name.clone(), uploaded.clone());
        off(move || record(&ledger_path, &name, revision, &recorded, now)).await?;
        Ok(uploaded)
    }

    /// Upload the compressed copy at `compressed` under each tier's key.
    /// Create-only: a key that exists (a second pass in the same minute)
    /// is left alone and that tier stays due for the next run. Nothing the
    /// app holds can replace a stored snapshot.
    async fn upload(
        &self,
        source: &Source,
        now: OffsetDateTime,
        tiers: &[Tier],
        compressed: &Path,
    ) -> Result<Vec<Tier>, String> {
        let payload = mapped(compressed)?;
        let mut uploaded = vec![];
        for tier in tiers {
            let key = key(*tier, &self.config.env, &source.name, now);
            let opts = PutOptions {
                mode: PutMode::Create,
                ..Default::default()
            };
            match self
                .config
                .bucket
                .put_opts(&key, payload.clone(), opts)
                .await
            {
                Ok(_) => uploaded.push(*tier),
                Err(object_store::Error::AlreadyExists { .. }) => {}
                Err(e) => return Err(format!("upload {key}: {e}")),
            }
        }
        Ok(uploaded)
    }
}

/// A file as an upload's body without reading it into the heap: its
/// pages, mapped read-only (the mapping lives as long as the payload).
fn mapped(path: &Path) -> Result<PutPayload, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    // Safety: the file is this job's own temp file under `snapshots-tmp/`,
    // written and closed before this and removed only after the upload;
    // nothing truncates it while mapped.
    let map =
        unsafe { memmap2::Mmap::map(&file) }.map_err(|e| format!("map {}: {e}", path.display()))?;
    Ok(PutPayload::from(bytes::Bytes::from_owner(map)))
}

/// Blocking SQLite and file work, off the async runtime.
async fn off<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn platform_path(data_dir: &Path) -> PathBuf {
    data_dir.join("platform.db")
}

/// Every `orgs/<32 hex>.db`, sorted. Anything else in `orgs/` is not an
/// org.
fn org_sources(data_dir: &Path) -> Result<Vec<Source>, String> {
    let mut orgs = vec![];
    let entries = std::fs::read_dir(data_dir.join("orgs")).map_err(|e| e.to_string())?;
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let id = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".db"));
        if let Some(id) = id.filter(|id| is_tenant_id(id)) {
            orgs.push(Source {
                name: id.to_owned(),
                path: path.clone(),
            });
        }
    }
    orgs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(orgs)
}

/// Every `files/<32 hex>.db`, sorted, as `files-<id>`. An org that never
/// scanned has none.
fn files_sources(data_dir: &Path) -> Result<Vec<Source>, String> {
    let mut files = vec![];
    let entries = match std::fs::read_dir(data_dir.join("files")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let id = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".db"));
        if let Some(id) = id.filter(|id| is_tenant_id(id)) {
            files.push(Source {
                name: format!("{FILES_PREFIX}{id}"),
                path: path.clone(),
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn is_tenant_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A read-only connection outside the store's handle cache: the job never
/// takes an org's writer lock, and WAL lets it read beside the writer.
fn open_read_only(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open {}: {e}", path.display()))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn latest_revision(path: &Path) -> Result<i64, String> {
    open_read_only(path)?
        .query_row("SELECT coalesce(max(id), 0) FROM revisions", [], |r| {
            r.get(0)
        })
        .map_err(|e| format!("read revisions of {}: {e}", path.display()))
}

/// A files db's change counter (`store::files`): it has no revisions.
fn files_changes(path: &Path) -> Result<i64, String> {
    open_read_only(path)?
        .query_row("SELECT seq FROM changes WHERE id = 1", [], |r| r.get(0))
        .map_err(|e| format!("read changes of {}: {e}", path.display()))
}

/// The ledger: `snapshots` in `platform.db` (platform migration 2), which
/// the store has migrated before any job or health check runs.
fn open_ledger(platform: &Path) -> Result<Connection, String> {
    let conn = Connection::open(platform).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn ledger_row(platform: &Path, name: &str) -> Result<Ledger, String> {
    let row = open_ledger(platform)?
        .query_row(
            "SELECT last_revision, daily_revision, daily_day, monthly_month
             FROM snapshots WHERE tenant_id = ?1",
            [name],
            |r| {
                Ok(Ledger {
                    last_revision: r.get(0)?,
                    daily_revision: r.get(1)?,
                    daily_day: r.get(2)?,
                    monthly_month: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or_default())
}

fn day(at: OffsetDateTime) -> String {
    at.date().to_string()
}

fn month(at: OffsetDateTime) -> String {
    format!("{}-{:02}", at.year(), u8::from(at.month()))
}

/// The tiers `ledger` is due at `now`, given its newest revision
/// (`None` for `platform.db`: always due hourly).
fn due(ledger: &Ledger, revision: Option<i64>, now: OffsetDateTime) -> Vec<Tier> {
    let mut tiers = vec![];
    let moved = |since: Option<i64>| revision.is_none() || since != revision;
    if moved(ledger.last_revision) {
        tiers.push(Tier::Hourly);
    }
    if ledger.daily_day.as_deref() != Some(&day(now)) && moved(ledger.daily_revision) {
        tiers.push(Tier::Daily);
    }
    if ledger.monthly_month.as_deref() != Some(&month(now)) {
        tiers.push(Tier::Monthly);
    }
    tiers
}

fn record(
    platform: &Path,
    name: &str,
    revision: Option<i64>,
    tiers: &[Tier],
    now: OffsetDateTime,
) -> Result<(), String> {
    let conn = open_ledger(platform)?;
    let at = (now.unix_timestamp_nanos() / 1_000_000) as i64;
    conn.execute(
        "INSERT INTO snapshots (tenant_id, at) VALUES (?1, ?2)
         ON CONFLICT (tenant_id) DO UPDATE SET at = excluded.at",
        rusqlite::params![name, at],
    )
    .map_err(|e| e.to_string())?;
    let set = |sql: &str, value: &dyn rusqlite::ToSql| {
        conn.execute(sql, rusqlite::params![value, name])
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    if tiers.contains(&Tier::Hourly) {
        set(
            "UPDATE snapshots SET last_revision = ?1 WHERE tenant_id = ?2",
            &revision,
        )?;
    }
    if tiers.contains(&Tier::Daily) {
        set(
            "UPDATE snapshots SET daily_revision = ?1 WHERE tenant_id = ?2",
            &revision,
        )?;
        set(
            "UPDATE snapshots SET daily_day = ?1 WHERE tenant_id = ?2",
            &day(now),
        )?;
    }
    if tiers.contains(&Tier::Monthly) {
        set(
            "UPDATE snapshots SET monthly_month = ?1 WHERE tenant_id = ?2",
            &month(now),
        )?;
    }
    Ok(())
}

/// `VACUUM INTO` a temp file, `integrity_check` it, then zstd it file to
/// file (streamed: a few MB of buffers whatever the size). Returns the
/// compressed file, which the caller removes; the uncompressed copy is
/// removed whatever happens.
fn copy_and_compress(path: &Path, tmp_dir: &Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    let tmp = tmp_dir.join(format!("{name}.db"));
    let compressed = tmp_dir.join(format!("{name}.db.zst"));
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&compressed);
    let out = (|| {
        open_read_only(path)?
            .execute("VACUUM INTO ?1", [tmp.to_string_lossy()])
            .map_err(|e| format!("copy {}: {e}", path.display()))?;
        let check: String = open_read_only(&tmp)?
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err(format!("integrity_check of the copy: {check}"));
        }
        let from = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
        let to = std::fs::File::create(&compressed).map_err(|e| e.to_string())?;
        let mut to = std::io::BufWriter::new(to);
        zstd::stream::copy_encode(from, &mut to, 9).map_err(|e| e.to_string())?;
        use std::io::Write;
        to.flush().map_err(|e| e.to_string())?;
        Ok(compressed.clone())
    })();
    let _ = std::fs::remove_file(&tmp);
    if out.is_err() {
        let _ = std::fs::remove_file(&compressed);
    }
    out
}

// ---- restore -----------------------------------------------------------

/// What [`restore_latest`] did.
#[derive(Debug, Default)]
pub struct Restored {
    /// `(name, key, bytes on disk)` for every file put back (an org's
    /// files db as `files-<id>`).
    pub files: Vec<(String, String, u64)>,
    /// Orgs `platform.db` lists that have no usable snapshot. Everything
    /// else was restored; whether to boot without them is the caller's
    /// call (`restore.sh` exits 4).
    pub missing: Vec<String>,
    /// `(key, why)` for copies passed over: stamped in the future, or
    /// failing to decompress or `integrity_check`. An older copy of the
    /// same file was tried next.
    pub passed_over: Vec<(String, String)>,
}

/// After boot, how long a database may go without its first sync before
/// `/healthz` calls it an error.
const STARTUP_GRACE: Duration = Duration::from_secs(120);

/// How far ahead of `now` a stamp may be (clock skew) before it's ignored.
const FUTURE_SKEW: time::Duration = time::Duration::minutes(10);

/// Restore `platform.db` and every org it lists from the newest good
/// snapshot of each (any tier), into an empty `data_dir`.
///
/// - Copies stamped later than `now` are ignored (a planted far-future key
///   would otherwise win), and a copy that fails to decompress or check
///   gives way to the next-newest.
/// - Orgs the bucket holds that the restored `platform.db` doesn't list
///   (staging's reset leaves old ones behind) are not restored.
/// - An org with no usable copy is listed in `missing`; the rest are
///   still restored.
/// - Each restored org file gets a new recovery generation
///   (`events::rotate_generation`), so event cursors from before reset.
/// - Each org's files db comes back from its own newest good copy, if
///   the bucket holds one: an org that never scanned has none, so none
///   is not `missing`. A files db is daily, so it may be up to a day
///   older than its org file: pages committed since point at no blob
///   (the image route answers 404) until Litestream's copy is used.
pub async fn restore_latest(
    bucket: &dyn ObjectStore,
    env: &str,
    data_dir: &Path,
    now: OffsetDateTime,
) -> Result<Restored, String> {
    if platform_path(data_dir).exists() {
        return Err(format!(
            "{} exists: restore only into an empty data dir",
            platform_path(data_dir).display()
        ));
    }
    std::fs::create_dir_all(data_dir.join("orgs")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(data_dir.join("files")).map_err(|e| e.to_string())?;
    let mut out = Restored::default();
    let candidates = candidate_keys(bucket, env, now, &mut out.passed_over).await?;
    let no_keys = vec![];
    let platform_keys = candidates.get(PLATFORM).unwrap_or(&no_keys);
    if platform_keys.is_empty() {
        return Err(format!("no platform snapshot for env {env:?}"));
    }
    let Some((key, size)) =
        fetch_newest_good(bucket, platform_keys, &platform_path(data_dir), &mut out).await
    else {
        return Err("no platform snapshot passed its checks".into());
    };
    out.files.push((PLATFORM.to_owned(), key, size));
    let platform = platform_path(data_dir);
    let tenants: Vec<String> = off(move || {
        let conn = open_read_only(&platform)?;
        let mut stmt = conn
            .prepare("SELECT id FROM tenants ORDER BY id")
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |r| r.get(0))
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())
    })
    .await?;
    for id in tenants {
        if !is_tenant_id(&id) {
            return Err(format!("platform.db lists a malformed tenant id {id:?}"));
        }
        let keys = candidates.get(id.as_str()).unwrap_or(&no_keys);
        let target = data_dir.join("orgs").join(format!("{id}.db"));
        match fetch_newest_good(bucket, keys, &target, &mut out).await {
            Some((key, size)) => {
                // Its history may now reuse revision ids a tab's event
                // cursor names: a new generation resets those cursors.
                off(move || {
                    let conn = Connection::open(&target).map_err(|e| e.to_string())?;
                    crate::events::rotate_generation(&conn)
                        .map_err(|e| format!("recovery generation: {e}"))
                })
                .await?;
                out.files.push((id.clone(), key, size))
            }
            None => out.missing.push(id.clone()),
        }
        let name = format!("{FILES_PREFIX}{id}");
        if let Some(keys) = candidates.get(name.as_str()) {
            let target = data_dir.join("files").join(format!("{id}.db"));
            if let Some((key, size)) = fetch_newest_good(bucket, keys, &target, &mut out).await {
                out.files.push((name, key, size));
            }
        }
    }
    Ok(out)
}

/// Every key per file name across the three tiers, newest first. Stamps
/// sort as strings (`YYYY-MM-DDTHHMMZ`); later than `now` (plus skew) is
/// passed over.
async fn candidate_keys(
    bucket: &dyn ObjectStore,
    env: &str,
    now: OffsetDateTime,
    passed_over: &mut Vec<(String, String)>,
) -> Result<std::collections::HashMap<String, Vec<ObjectPath>>, String> {
    use futures_util::TryStreamExt;
    let latest_ok = stamp(now + FUTURE_SKEW);
    let mut found: std::collections::HashMap<String, Vec<(String, ObjectPath)>> =
        Default::default();
    for tier in [Tier::Hourly, Tier::Daily, Tier::Monthly] {
        let prefix = ObjectPath::from(format!("{}/{env}", tier.as_str()));
        let metas: Vec<_> = bucket
            .list(Some(&prefix))
            .try_collect()
            .await
            .map_err(|e| format!("list {prefix}: {e}"))?;
        for meta in metas {
            let parts: Vec<_> = meta.location.parts().collect();
            let [_, _, name, file] = parts.as_slice() else {
                continue;
            };
            let Some(stamp) = file.as_ref().strip_suffix(".db.zst") else {
                continue;
            };
            if stamp > latest_ok.as_str() {
                passed_over.push((meta.location.to_string(), "stamped in the future".into()));
                continue;
            }
            found
                .entry(name.as_ref().to_owned())
                .or_default()
                .push((stamp.to_owned(), meta.location.clone()));
        }
    }
    Ok(found
        .into_iter()
        .map(|(name, mut keys)| {
            keys.sort_by(|a, b| b.0.cmp(&a.0));
            (name, keys.into_iter().map(|(_, k)| k).collect())
        })
        .collect())
}

/// The first of `keys` (newest first) that downloads, decompresses and
/// passes `integrity_check`, put at `target`.
async fn fetch_newest_good(
    bucket: &dyn ObjectStore,
    keys: &[ObjectPath],
    target: &Path,
    out: &mut Restored,
) -> Option<(String, u64)> {
    for key in keys {
        match fetch_into(bucket, key, target).await {
            Ok(size) => return Some((key.to_string(), size)),
            Err(e) => out.passed_over.push((key.to_string(), e)),
        }
    }
    None
}

/// Download to `<target>.zst` (streamed), decompress to
/// `<target>.restoring` (file to file), `integrity_check`, then rename
/// into place. Returns the restored size. Neither the download nor the
/// file is held in memory.
async fn fetch_into(
    bucket: &dyn ObjectStore,
    key: &ObjectPath,
    target: &Path,
) -> Result<u64, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let download = target.with_extension("db.zst");
    let fetched = async {
        let mut stream = bucket
            .get(key)
            .await
            .map_err(|e| format!("get: {e}"))?
            .into_stream();
        let mut file = tokio::fs::File::create(&download)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("read: {e}"))?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = fetched {
        let _ = std::fs::remove_file(&download);
        return Err(e);
    }
    let target = target.to_path_buf();
    off(move || {
        let partial = target.with_extension("db.restoring");
        let result = (|| {
            let from = std::fs::File::open(&download).map_err(|e| e.to_string())?;
            let to = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
            let mut to = std::io::BufWriter::new(to);
            zstd::stream::copy_decode(from, &mut to).map_err(|e| format!("decompress: {e}"))?;
            use std::io::Write;
            to.flush().map_err(|e| e.to_string())?;
            drop(to);
            let check: String = open_read_only(&partial)?
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .map_err(|e| format!("integrity_check: {e}"))?;
            if check != "ok" {
                return Err(format!("integrity_check: {check}"));
            }
            let size = std::fs::metadata(&partial)
                .map_err(|e| e.to_string())?
                .len();
            std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
            Ok(size)
        })();
        let _ = std::fs::remove_file(&download);
        if result.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        result
    })
    .await
}

// ---- health ------------------------------------------------------------

/// What `/healthz` reports about backups. Informational: the 15-minute
/// GitHub cron (`.github/workflows/health.yml`) judges it. A stale backup
/// must not fail Fly's health check, which would take the only machine
/// out of service.
///
/// `/healthz` is public, so this holds counts and status words only:
/// error text (bucket names, account ids, tenant ids) goes to the log and
/// Sentry.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupHealth {
    /// `off` (no bucket configured), or `on`.
    pub snapshots: &'static str,
    /// Seconds since the last `platform.db` snapshot, which every run
    /// takes; `None` before the first.
    pub snapshot_age_seconds: Option<i64>,
    /// Files that failed in the last run of this process.
    pub snapshot_error_count: usize,
    /// `off` (no socket configured), `ok`, `starting` (in the first two
    /// minutes, databases that haven't synced yet), or `error`
    /// (unreachable, or a database not replicating).
    pub litestream: &'static str,
    /// The worst database's seconds since its last sync.
    pub litestream_lag_seconds: Option<i64>,
    /// Databases Litestream tracks.
    pub litestream_databases: usize,
    /// How this volume's data was last restored, while that needs a look
    /// (`entrypoint.sh` writes `/data/.restored`; the human removes it).
    pub restore: Option<RestoreMarker>,
}

/// `/data/.restored`, written by the entrypoint after an empty-volume
/// restore.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreMarker {
    /// `litestream` or `snapshot`.
    pub source: String,
    /// The snapshots were used because Litestream had no replica: up to an
    /// hour of writes may be gone. Needs a human.
    pub fallback: bool,
    /// Orgs `platform.db` lists that couldn't be restored.
    pub missing_orgs: usize,
    pub at: String,
}

impl RestoreMarker {
    /// A restore someone has to look at (`health.yml` alerts on it).
    pub fn needs_review(&self) -> bool {
        self.fallback || self.missing_orgs > 0
    }
}

pub const RESTORE_MARKER: &str = ".restored";

struct HealthState {
    data_dir: PathBuf,
    snapshots: bool,
    litestream_socket: Option<PathBuf>,
    last_run: Mutex<Option<RunReport>>,
    restore: Option<RestoreMarker>,
    started: std::time::Instant,
    /// The last Litestream problem logged, so a lasting one is logged
    /// once, not on every 15 s health check.
    last_litestream_problem: Mutex<Option<String>>,
}

static HEALTH: OnceLock<HealthState> = OnceLock::new();

/// Set once at boot: where [`health`] looks. `litestream_socket` is
/// `KEEP_LITESTREAM_SOCKET` (the image sets `/run/litestream.sock`). A
/// restore marker that needs review is reported to the log and Sentry
/// here, once per boot.
pub fn init_health(data_dir: &Path, snapshots: bool, litestream_socket: Option<PathBuf>) {
    let restore = read_restore_marker(data_dir);
    if let Some(marker) = restore.as_ref().filter(|m| m.needs_review()) {
        crate::observe::error(&format!(
            "data restored from {} at {} (fallback: {}, missing orgs: {}): check it, then delete {}",
            marker.source,
            marker.at,
            marker.fallback,
            marker.missing_orgs,
            data_dir.join(RESTORE_MARKER).display()
        ));
    }
    let _ = HEALTH.set(HealthState {
        data_dir: data_dir.to_path_buf(),
        snapshots,
        litestream_socket,
        last_run: Mutex::new(None),
        restore,
        started: std::time::Instant::now(),
        last_litestream_problem: Mutex::new(None),
    });
}

fn read_restore_marker(data_dir: &Path) -> Option<RestoreMarker> {
    let raw = std::fs::read_to_string(data_dir.join(RESTORE_MARKER)).ok()?;
    match serde_json::from_str(&raw) {
        Ok(marker) => Some(marker),
        Err(e) => {
            crate::observe::error(&format!("unreadable {RESTORE_MARKER}: {e}"));
            Some(RestoreMarker {
                source: "unknown".into(),
                fallback: true,
                missing_orgs: 0,
                at: String::new(),
            })
        }
    }
}

/// The backup part of `/healthz`.
pub async fn health() -> BackupHealth {
    let mut out = BackupHealth {
        snapshots: "off",
        snapshot_age_seconds: None,
        snapshot_error_count: 0,
        litestream: "off",
        litestream_lag_seconds: None,
        litestream_databases: 0,
        restore: None,
    };
    let Some(state) = HEALTH.get() else {
        return out;
    };
    out.restore = state.restore.clone();
    let now = OffsetDateTime::now_utc();
    if state.snapshots {
        out.snapshots = "on";
        let platform = platform_path(&state.data_dir);
        out.snapshot_age_seconds = off(move || snapshot_age(&platform, now))
            .await
            .unwrap_or(None);
        if let Some(run) = state.last_run.lock().unwrap().as_ref() {
            out.snapshot_error_count = run.failed.len();
        }
    }
    if let Some(socket) = &state.litestream_socket {
        let mut starting = false;
        let problem = match litestream_list(socket).await {
            Ok(list) => {
                out.litestream_databases = list.databases.len();
                let (lag, problem) = lag(&list, now);
                out.litestream_lag_seconds = lag;
                // Right after boot, databases that haven't synced yet are
                // expected, not a problem to report.
                starting = state.started.elapsed() < STARTUP_GRACE
                    && list
                        .databases
                        .iter()
                        .all(|db| db.status == "replicating" || db.last_sync_at.is_none());
                problem.filter(|_| !starting)
            }
            Err(e) => Some(e),
        };
        out.litestream = match (&problem, starting) {
            (Some(_), _) => "error",
            (None, true) if out.litestream_lag_seconds.is_none() => "starting",
            (None, _) => "ok",
        };
        let mut last = state.last_litestream_problem.lock().unwrap();
        if problem.is_some() && *last != problem {
            crate::observe::error(&format!("litestream: {}", problem.as_deref().unwrap_or("")));
        }
        *last = problem;
    }
    out
}

fn snapshot_age(platform: &Path, now: OffsetDateTime) -> Result<Option<i64>, String> {
    let at: Option<i64> = open_ledger(platform)?
        .query_row(
            "SELECT at FROM snapshots WHERE tenant_id = ?1",
            [PLATFORM],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let now_ms = (now.unix_timestamp_nanos() / 1_000_000) as i64;
    Ok(at.map(|at| (now_ms - at) / 1000))
}

/// Litestream's `GET /list` on its control socket.
#[derive(Debug, Deserialize)]
pub struct LitestreamList {
    pub databases: Vec<LitestreamDb>,
}

#[derive(Debug, Deserialize)]
pub struct LitestreamDb {
    pub path: String,
    pub status: String,
    pub last_sync_at: Option<String>,
}

/// The worst lag, and what's wrong if anything is.
fn lag(list: &LitestreamList, now: OffsetDateTime) -> (Option<i64>, Option<String>) {
    let mut worst: Option<i64> = None;
    let mut problems = vec![];
    for db in &list.databases {
        if db.status != "replicating" {
            problems.push(format!("{} is {}", db.path, db.status));
        }
        match db
            .last_sync_at
            .as_deref()
            .map(|t| OffsetDateTime::parse(t, &Rfc3339))
        {
            Some(Ok(at)) => {
                let secs = (now - at).whole_seconds().max(0);
                worst = Some(worst.map_or(secs, |w| w.max(secs)));
            }
            Some(Err(e)) => problems.push(format!("{}: bad last_sync_at: {e}", db.path)),
            None => problems.push(format!("{} has never synced", db.path)),
        }
    }
    (worst, (!problems.is_empty()).then(|| problems.join("; ")))
}

/// One HTTP/1.0 request over the unix socket (no keep-alive, no chunked
/// body), with a 2 s budget.
async fn litestream_list(socket: &Path) -> Result<LitestreamList, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fetch = async {
        let mut stream = tokio::net::UnixStream::connect(socket)
            .await
            .map_err(|e| format!("connect {}: {e}", socket.display()))?;
        stream
            .write_all(b"GET /list HTTP/1.0\r\nHost: litestream\r\n\r\n")
            .await
            .map_err(|e| e.to_string())?;
        let mut raw = vec![];
        stream
            .read_to_end(&mut raw)
            .await
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw);
        let (head, body) = text
            .split_once("\r\n\r\n")
            .ok_or("malformed response from litestream")?;
        if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
            return Err(format!(
                "litestream answered {}",
                head.lines().next().unwrap_or("")
            ));
        }
        serde_json::from_str(body).map_err(|e| format!("litestream /list: {e}"))
    };
    tokio::time::timeout(Duration::from_secs(2), fetch)
        .await
        .map_err(|_| "litestream socket timed out".to_owned())?
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn keys_carry_tier_env_file_and_utc_minute() {
        let at = datetime!(2026-10-24 13:59:12 +01:00);
        assert_eq!(
            key(Tier::Daily, "staging", "platform", at).as_ref(),
            "daily/staging/platform/2026-10-24T1259Z.db.zst"
        );
    }

    #[test]
    fn tiers_due() {
        let now = datetime!(2026-10-24 13:00 UTC);
        let fresh = Ledger::default();
        assert_eq!(
            due(&fresh, Some(5), now),
            [Tier::Hourly, Tier::Daily, Tier::Monthly]
        );
        let done = Ledger {
            last_revision: Some(5),
            daily_revision: Some(5),
            daily_day: Some("2026-10-24".into()),
            monthly_month: Some("2026-10".into()),
        };
        assert!(due(&done, Some(5), now).is_empty());
        assert_eq!(due(&done, Some(6), now), [Tier::Hourly]);
        // platform.db: no revisions, so always hourly.
        assert_eq!(due(&done, None, now), [Tier::Hourly]);
        // A new day: daily only if it moved since the last daily.
        let tomorrow = datetime!(2026-10-25 00:10 UTC);
        assert!(due(&done, Some(5), tomorrow).is_empty());
        assert_eq!(due(&done, Some(6), tomorrow), [Tier::Hourly, Tier::Daily]);
        // A new month: monthly even when untouched.
        let next_month = datetime!(2026-11-01 00:10 UTC);
        assert_eq!(due(&done, Some(5), next_month), [Tier::Monthly]);
    }

    #[test]
    fn the_restore_marker_flags_fallbacks_and_missing_orgs() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_restore_marker(tmp.path()), None);
        let write = |json: &str| std::fs::write(tmp.path().join(RESTORE_MARKER), json).unwrap();
        write(
            r#"{"source":"litestream","fallback":false,"missingOrgs":0,"at":"2026-10-24T10:00:00Z"}"#,
        );
        assert!(!read_restore_marker(tmp.path()).unwrap().needs_review());
        write(
            r#"{"source":"snapshot","fallback":true,"missingOrgs":0,"at":"2026-10-24T10:00:00Z"}"#,
        );
        assert!(read_restore_marker(tmp.path()).unwrap().needs_review());
        write(
            r#"{"source":"snapshot","fallback":false,"missingOrgs":2,"at":"2026-10-24T10:00:00Z"}"#,
        );
        assert!(read_restore_marker(tmp.path()).unwrap().needs_review());
        // Unreadable counts as needing a look, not as fine.
        write("garbage");
        assert!(read_restore_marker(tmp.path()).unwrap().needs_review());
    }

    #[test]
    fn litestream_lag_is_the_worst_database() {
        let now = datetime!(2026-10-24 13:00:10 UTC);
        let list: LitestreamList = serde_json::from_str(
            r#"{"databases":[
                {"path":"/data/platform.db","status":"replicating","last_sync_at":"2026-10-24T13:00:09Z"},
                {"path":"/data/orgs/a.db","status":"replicating","last_sync_at":"2026-10-24T12:59:58.5Z"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(lag(&list, now), (Some(11), None));
        let stuck: LitestreamList = serde_json::from_str(
            r#"{"databases":[{"path":"/data/orgs/b.db","status":"stopped"}]}"#,
        )
        .unwrap();
        let (worst, problem) = lag(&stuck, now);
        assert_eq!(worst, None);
        let problem = problem.unwrap();
        assert!(problem.contains("is stopped") && problem.contains("never synced"));
    }
}
