//! Boot migration: every org file to head, with a copy first; fail closed.

use std::path::Path;

use store::{M, Migrations, Store, StoreConfig, TenantId};

const V1: &str = "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL);";
const V2: &str = "ALTER TABLE things ADD COLUMN colour TEXT;";
const V3: &str = "CREATE INDEX things_by_name ON things (name);";

fn store(dir: &Path, steps: &[&'static str]) -> Store {
    Store::open(StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: Migrations::new(steps.iter().map(|s| M::up(s)).collect()),
        readers: 1,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap()
}

fn user_version(path: &Path) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn org_file(dir: &Path, id: &TenantId) -> std::path::PathBuf {
    dir.join(format!("orgs/{id}.db"))
}

fn premigrate(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir.join("premigrate"))
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Two orgs at v1, each with a row.
fn at_v1(dir: &Path) -> (TenantId, TenantId) {
    let s = store(dir, &[V1]);
    let a = s.create_tenant("alpha", "Alpha").unwrap().id;
    let b = s.create_tenant("beta", "Beta").unwrap().id;
    for id in [&a, &b] {
        s.org(id)
            .unwrap()
            .write_raw(|tx| {
                tx.conn()
                    .execute("INSERT INTO things (name) VALUES ('x')", [])
            })
            .unwrap();
    }
    (a, b)
}

#[test]
fn every_file_migrates_at_boot_after_a_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (a, b) = at_v1(dir);

    let s = store(dir, &[V1, V2]);
    assert_eq!(s.migrate_all().unwrap(), 2);
    for id in [&a, &b] {
        assert_eq!(user_version(&org_file(dir, id)), 2);
        // The copy is the file as it was: v1, its row, intact.
        let copy = rusqlite::Connection::open(dir.join(format!("premigrate/{id}.v1.db"))).unwrap();
        let (v, rows, ok): (i64, i64, String) = copy
            .query_row(
                "SELECT (SELECT user_version FROM pragma_user_version),
                        (SELECT count(*) FROM things),
                        (SELECT integrity_check FROM pragma_integrity_check)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((v, rows, ok.as_str()), (1, 1, "ok"));
    }
    // Nothing pending: nothing copied, nothing migrated.
    assert_eq!(s.migrate_all().unwrap(), 0);
    drop(s);

    // The next release replaces each org's older copy.
    let s = store(dir, &[V1, V2, V3]);
    assert_eq!(s.migrate_all().unwrap(), 2);
    assert_eq!(
        premigrate(dir),
        vec![format!("{a}.v2.db"), format!("{b}.v2.db")]
    );
}

#[test]
fn a_failing_migration_stops_the_boot_naming_the_org() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (a, b) = at_v1(dir);
    // Org B has a row the new constraint refuses.
    rusqlite::Connection::open(org_file(dir, &b))
        .unwrap()
        .execute("INSERT INTO things (name) VALUES ('dup')", [])
        .unwrap();
    rusqlite::Connection::open(org_file(dir, &b))
        .unwrap()
        .execute("INSERT INTO things (name) VALUES ('dup')", [])
        .unwrap();
    const UNIQUE: &str = "CREATE UNIQUE INDEX things_unique_name ON things (name);";

    let s = store(dir, &[V1, UNIQUE]);
    let err = s.migrate_all().unwrap_err();
    assert_eq!(err.org, b.as_str());
    assert!(err.to_string().contains(b.as_str()));
    // B is untouched (the migration is one transaction); its copy exists.
    assert_eq!(user_version(&org_file(dir, &b)), 1);
    assert!(dir.join(format!("premigrate/{b}.v1.db")).exists());
    let _ = a;
}

#[test]
fn a_stray_file_stops_the_boot() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    at_v1(dir);
    std::fs::write(dir.join("orgs/not-a-tenant.db"), b"").unwrap();
    let err = store(dir, &[V1, V2]).migrate_all().unwrap_err();
    assert_eq!(err.org, "not-a-tenant");
}
