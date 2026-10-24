//! Boot migration: every org file to the head schema before the API serves
//! a request. Fail closed: the first file that won't migrate stops the
//! boot with its id, so a deploy fails visibly instead of serving some
//! organisations on an old schema.
//!
//! Before a file's pending migrations run, `VACUUM INTO` writes a copy to
//! `premigrate/<id>.v<from>.db` and older copies of that org are deleted.
//! Rolling back a release is the previous image plus
//! `scripts/ops/rollback-migration.sh`, which puts the copies back.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::limits::Limit;
use rusqlite_migration::Migrations;

use crate::conn;
use crate::org::check_stamp;
use crate::{StoreError, TenantId};

#[derive(Debug, thiserror::Error)]
#[error("organisation {org}: migration failed: {source}")]
pub struct MigrationFailed {
    /// The file's stem (the tenant id), or the path if it isn't one.
    pub org: String,
    #[source]
    pub source: StoreError,
}

fn org_files(dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir.join("orgs"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "db"))
        .collect();
    files.sort();
    Ok(files)
}

pub(crate) fn migrate_all(
    dir: &Path,
    migrations: &Migrations<'static>,
    concurrency: usize,
) -> Result<usize, MigrationFailed> {
    let files = org_files(dir).map_err(|source| MigrationFailed {
        org: dir.join("orgs").display().to_string(),
        source,
    })?;
    let premigrate = dir.join("premigrate");
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
                    match migrate_file(path, migrations, &premigrate) {
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
        None => Ok(migrated.into_inner().unwrap()),
    }
}

/// Migrate one file if it has migrations pending. True if it did.
pub(crate) fn migrate_file(
    path: &Path,
    migrations: &Migrations<'static>,
    premigrate: &Path,
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
    let pending = migrations
        .pending_migrations(&conn)
        .map_err(|e| fail(e.into()))?;
    if pending == 0 {
        return Ok(false);
    }
    // Negative: the file is newer than this code. `to_latest` refuses it.
    if pending > 0 {
        let from: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| fail(e.into()))?;
        std::fs::create_dir_all(premigrate).map_err(|e| fail(e.into()))?;
        let copy = premigrate.join(format!("{stem}.v{from}.db"));
        let _ = std::fs::remove_file(&copy);
        // `VACUUM INTO` attaches its target: lift the no-ATTACH limit on
        // this boot-only connection for that one statement.
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 1)
            .map_err(|e| fail(e.into()))?;
        let copied = conn.execute("VACUUM INTO ?1", [copy.to_string_lossy()]);
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
            .map_err(|e| fail(e.into()))?;
        copied.map_err(|e| fail(e.into()))?;
        remove_older_copies(premigrate, &stem, &copy);
    }
    migrations
        .to_latest(&mut conn)
        .map_err(|e| fail(e.into()))?;
    Ok(true)
}

fn remove_older_copies(premigrate: &Path, stem: &str, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(premigrate) else {
        return;
    };
    let prefix = format!("{stem}.v");
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) && name.ends_with(".db") && path != keep {
            let _ = std::fs::remove_file(path);
        }
    }
}
