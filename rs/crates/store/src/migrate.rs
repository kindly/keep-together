//! Boot migration: `platform.db` and every org file to the head schema
//! before the API serves a request. Fail closed: the first file that won't
//! migrate stops the boot with its name, so a deploy fails visibly instead
//! of serving some organisations on an old schema.
//!
//! Before a file's pending migrations run, `VACUUM INTO` writes a copy to
//! the boot directory, `premigrate/boot-<ms>/<name>.v<from>.db`
//! (`platform` or the tenant id), next to a `manifest` of the org files
//! that existed at boot. A boot that finishes marks the directory
//! `complete`. A boot that fails leaves it incomplete, and the next boot
//! (Fly's restart, the operator's retry) **reuses** it: same manifest, and
//! no second copy of a file already copied there. So the copies always
//! hold every file as it was before the release that is still being rolled
//! out. Only a boot that needs copies while the newest directory is
//! complete starts a new one, deleting the old.
//!
//! Rolling back a release is the previous image plus
//! `scripts/ops/rollback-migration.sh`: it puts that boot's copies back
//! (platform included) and sets aside org files the manifest doesn't list
//! (created at the new schema after the boot), which the old code would
//! refuse.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use rusqlite::limits::Limit;
use rusqlite_migration::Migrations;

use crate::conn;
use crate::org::check_stamp;
use crate::{StoreError, TenantId};

#[derive(Debug, thiserror::Error)]
#[error("organisation {org}: migration failed: {source}")]
pub struct MigrationFailed {
    /// The file's stem (the tenant id, or `platform`), or the path if it
    /// isn't one.
    pub org: String,
    #[source]
    pub source: StoreError,
}

pub(crate) fn org_files(dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir.join("orgs"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "db"))
        .collect();
    files.sort();
    Ok(files)
}

/// This boot's copy directory, made on first use.
pub(crate) struct BootCopies {
    data: PathBuf,
    name: String,
    dir: Mutex<Option<PathBuf>>,
}

impl BootCopies {
    pub(crate) fn new(data: &Path) -> Self {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        Self {
            data: data.to_path_buf(),
            name: format!("boot-{ms:015}"),
            dir: Mutex::new(None),
        }
    }

    /// The newest boot directory under `premigrate/`, if any.
    fn newest(&self) -> Option<PathBuf> {
        let mut boots: Vec<PathBuf> = std::fs::read_dir(self.data.join("premigrate"))
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("boot-"))
            })
            .collect();
        boots.sort();
        boots.pop()
    }

    /// The directory copies go to: an unfinished boot's (kept, with its
    /// manifest), or a new one with its manifest, the old ones deleted.
    fn dir(&self) -> Result<PathBuf, StoreError> {
        let mut dir = self.dir.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(d) = dir.as_ref() {
            return Ok(d.clone());
        }
        if let Some(unfinished) = self.newest().filter(|d| !d.join("complete").exists()) {
            // A copy the failed boot didn't finish.
            for entry in std::fs::read_dir(&unfinished)?.flatten() {
                if entry.path().extension().is_some_and(|x| x == "tmp") {
                    std::fs::remove_file(entry.path())?;
                }
            }
            *dir = Some(unfinished.clone());
            return Ok(unfinished);
        }
        let root = self.data.join("premigrate");
        let made = root.join(&self.name);
        std::fs::create_dir_all(&made)?;
        for entry in std::fs::read_dir(&root)?.flatten() {
            let path = entry.path();
            if path == made {
                continue;
            }
            if path.is_dir() {
                std::fs::remove_dir_all(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
        }
        let manifest: String = org_files(&self.data)?
            .iter()
            .filter_map(|p| p.file_name()?.to_str().map(|n| format!("{n}\n")))
            .collect();
        std::fs::write(made.join("manifest"), manifest)?;
        *dir = Some(made.clone());
        Ok(made)
    }

    /// The boot finished: mark the newest directory (this boot's, or an
    /// earlier failed boot's that this one completed) so the next boot
    /// that migrates starts afresh.
    pub(crate) fn complete(&self) -> Result<(), StoreError> {
        if let Some(newest) = self.newest() {
            std::fs::write(newest.join("complete"), "")?;
        }
        Ok(())
    }

    /// Copy the file behind `conn` (schema version `from`) as `name`.
    /// Kept if this directory already holds a copy of `name` (an earlier,
    /// failed boot made it before the file changed).
    fn copy(&self, conn: &Connection, name: &str, from: i64) -> Result<(), StoreError> {
        let dir = self.dir()?;
        let prefix = format!("{name}.v");
        let copied = std::fs::read_dir(&dir)?.flatten().any(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".db"))
        });
        if copied {
            return Ok(());
        }
        // Written to `.tmp`, synced, then renamed: a boot killed mid-copy
        // (disk full, OOM) leaves only a `.tmp`, which the check above
        // ignores and the next boot deletes, never a truncated `.db` the
        // retry would trust.
        let copy = dir.join(format!("{name}.v{from}.db"));
        let tmp = dir.join(format!("{name}.v{from}.db.tmp"));
        let _ = std::fs::remove_file(&tmp);
        // `VACUUM INTO` attaches its target: lift the no-ATTACH limit on
        // this boot-only connection for that one statement.
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 1)?;
        let copied = conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy()]);
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)?;
        copied?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, &copy)?;
        std::fs::File::open(&dir)?.sync_all()?;
        Ok(())
    }
}

/// If `conn`'s file has migrations pending, copy it first. Negative
/// pending (newer than this code) is left for `to_latest` to refuse.
pub(crate) fn copy_if_pending(
    boot: &BootCopies,
    conn: &Connection,
    migrations: &Migrations<'_>,
    name: &str,
) -> Result<bool, StoreError> {
    if migrations.pending_migrations(conn)? <= 0 {
        return Ok(false);
    }
    let from: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    boot.copy(conn, name, from)?;
    Ok(true)
}

pub(crate) fn migrate_all(
    dir: &Path,
    boot: &BootCopies,
    migrations: &Migrations<'static>,
    concurrency: usize,
) -> Result<usize, MigrationFailed> {
    let files = org_files(dir).map_err(|source| MigrationFailed {
        org: dir.join("orgs").display().to_string(),
        source,
    })?;
    let queue = Mutex::new(files.iter());
    let failed: Mutex<Option<MigrationFailed>> = Mutex::new(None);
    let migrated = Mutex::new(0usize);
    std::thread::scope(|s| {
        for _ in 0..concurrency.max(1) {
            s.spawn(|| {
                loop {
                    if failed.lock().unwrap().is_some() {
                        return;
                    }
                    let Some(path) = queue.lock().unwrap().next() else {
                        return;
                    };
                    match migrate_file(path, migrations, boot) {
                        Ok(true) => *migrated.lock().unwrap() += 1,
                        Ok(false) => {}
                        Err(err) => {
                            failed.lock().unwrap().get_or_insert(err);
                            return;
                        }
                    }
                }
            });
        }
    });
    match failed.into_inner().unwrap() {
        Some(err) => Err(err),
        None => {
            boot.complete().map_err(|source| MigrationFailed {
                org: "premigrate".into(),
                source,
            })?;
            Ok(migrated.into_inner().unwrap())
        }
    }
}

/// Migrate one file if it has migrations pending. True if it did.
fn migrate_file(
    path: &Path,
    migrations: &Migrations<'static>,
    boot: &BootCopies,
) -> Result<bool, MigrationFailed> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned();
    let fail = |source: StoreError| MigrationFailed {
        org: if stem.is_empty() {
            path.display().to_string()
        } else {
            stem.clone()
        },
        source,
    };
    let id = TenantId::parse(stem.clone()).ok_or_else(|| {
        fail(StoreError::WrongFile {
            path: path.to_path_buf(),
            expected: "a tenant id".into(),
            found: stem.clone(),
        })
    })?;
    let mut conn = conn::open(path, false, false).map_err(|e| fail(e.into()))?;
    check_stamp(&conn, path, &id).map_err(fail)?;
    if migrations
        .pending_migrations(&conn)
        .map_err(|e| fail(e.into()))?
        == 0
    {
        return Ok(false);
    }
    copy_if_pending(boot, &conn, migrations, &stem).map_err(fail)?;
    migrations
        .to_latest(&mut conn)
        .map_err(|e| fail(e.into()))?;
    Ok(true)
}
