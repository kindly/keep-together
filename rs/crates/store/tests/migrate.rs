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

/// The one boot directory under `premigrate/`.
fn boot_dir(dir: &Path) -> std::path::PathBuf {
    let boots: Vec<_> = std::fs::read_dir(dir.join("premigrate"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();
    assert_eq!(boots.len(), 1, "{boots:?}");
    boots[0].clone()
}

/// The copies in the boot directory (manifest and marker left out).
fn premigrate(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(boot_dir(dir))
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".db"))
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
        let copy = rusqlite::Connection::open(boot_dir(dir).join(format!("{id}.v1.db"))).unwrap();
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
    assert!(boot_dir(dir).join(format!("{b}.v1.db")).exists());
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

/// A rollback after a release that migrated `platform.db` and the org
/// files, and after which a new org was created at the new schema: the
/// script puts every copy back and sets the new org aside, so the previous
/// release's code finds nothing newer than it knows.
#[test]
fn the_rollback_script_restores_the_last_boot_for_the_previous_release() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (a, b) = at_v1(dir);
    // The previous release's platform.db: before the `snapshots` step.
    let platform = dir.join("platform.db");
    rusqlite::Connection::open(&platform)
        .unwrap()
        .execute_batch("DROP TABLE snapshots; PRAGMA user_version = 1;")
        .unwrap();

    // The new release boots: platform and both orgs migrate (copied first),
    // then serves, and a new org is made at v2.
    let s = store(dir, &[V1, V2]);
    assert_eq!(s.migrate_all().unwrap(), 2);
    let c = s.create_tenant("gamma", "Gamma").unwrap().id;
    s.org(&a)
        .unwrap()
        .write_raw(|tx| {
            tx.conn()
                .execute("INSERT INTO things (name) VALUES ('after')", [])
        })
        .unwrap();
    drop(s);
    assert_eq!(user_version(&platform), 2);
    assert_eq!(
        premigrate(dir),
        vec![
            format!("{a}.v1.db"),
            format!("{b}.v1.db"),
            "platform.v1.db".into()
        ]
    );

    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/ops/rollback-migration.sh");
    let run = |apply: bool| {
        let mut cmd = std::process::Command::new("bash");
        cmd.arg(&script).arg(dir);
        if apply {
            cmd.arg("--apply");
        }
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    // A dry run changes nothing.
    let dry = run(false);
    assert!(dry.contains("created after the boot"), "{dry}");
    assert_eq!(user_version(&platform), 2);

    run(true);
    assert_eq!(user_version(&platform), 1);
    assert_eq!(user_version(&org_file(dir, &a)), 1);
    assert_eq!(user_version(&org_file(dir, &b)), 1);
    assert!(!org_file(dir, &c).exists());
    let kept: Vec<String> = std::fs::read_dir(dir.join("orgs"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".rolled-back-"))
        .collect();
    assert!(
        kept.iter()
            .any(|n| n.starts_with(c.as_str()) && n.ends_with("Z")),
        "{kept:?}"
    );
    assert!(kept.iter().any(|n| n.starts_with(a.as_str())), "{kept:?}");
    // A's write after the boot is gone with the rollback.
    let rows: i64 = rusqlite::Connection::open(org_file(dir, &a))
        .unwrap()
        .query_row("SELECT count(*) FROM things", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);

    // The previous release's org code finds no file ahead of it.
    let old = Store::open(StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: Migrations::new(vec![M::up(V1)]),
        readers: 1,
        max_open: 4,
    })
    .unwrap();
    assert_eq!(old.migrate_all().unwrap(), 0);
}

/// A release whose boot fails part-way, twice (Fly restarts the machine):
/// the second boot reuses the first one's copies instead of deleting
/// them, so a rollback still restores everything the first boot migrated.
#[test]
fn a_failed_boot_keeps_its_copies_for_the_retry_and_the_rollback() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (a, b) = at_v1(dir);
    let x = {
        let s = store(dir, &[V1]);
        let x = s.create_tenant("xray", "Xray").unwrap().id;
        // Rows the new constraint refuses: X never migrates.
        s.org(&x)
            .unwrap()
            .write_raw(|tx| {
                tx.conn().execute_batch(
                    "INSERT INTO things (name) VALUES ('dup'); INSERT INTO things (name) VALUES ('dup');",
                )
            })
            .unwrap();
        x
    };
    let platform = dir.join("platform.db");
    rusqlite::Connection::open(&platform)
        .unwrap()
        .execute_batch("DROP TABLE snapshots; PRAGMA user_version = 1;")
        .unwrap();
    const UNIQUE: &str = "CREATE UNIQUE INDEX things_unique_name ON things (name);";

    // Boot 1: platform migrates (copied), X fails.
    let err = store(dir, &[V1, UNIQUE]).migrate_all().unwrap_err();
    assert_eq!(err.org, x.as_str());
    assert_eq!(user_version(&platform), 2);
    let first = boot_dir(dir);
    let after_first = premigrate(dir);
    assert!(after_first.contains(&"platform.v1.db".to_owned()));
    assert!(!first.join("complete").exists());

    // Boot 2 (the retry): platform has nothing pending, X fails again.
    std::thread::sleep(std::time::Duration::from_millis(2));
    let err = store(dir, &[V1, UNIQUE]).migrate_all().unwrap_err();
    assert_eq!(err.org, x.as_str());
    // Same directory, nothing lost.
    assert_eq!(boot_dir(dir), first);
    for name in &after_first {
        assert!(premigrate(dir).contains(name), "{name} lost");
    }

    // Rolling back restores platform and every org that migrated.
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/ops/rollback-migration.sh");
    let out = std::process::Command::new("bash")
        .arg(&script)
        .arg(dir)
        .arg("--apply")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(user_version(&platform), 1);
    for id in [&a, &b, &x] {
        assert_eq!(user_version(&org_file(dir, id)), 1, "{id:?}");
    }

    // Once a boot completes, the next migrating release starts afresh.
    rusqlite::Connection::open(org_file(dir, &x))
        .unwrap()
        .execute("DELETE FROM things WHERE name = 'dup'", [])
        .unwrap();
    let s = store(dir, &[V1, UNIQUE]);
    s.migrate_all().unwrap();
    assert!(boot_dir(dir).join("complete").exists());
    drop(s);
    std::thread::sleep(std::time::Duration::from_millis(2));
    store(dir, &[V1, UNIQUE, V3]).migrate_all().unwrap();
    assert_ne!(boot_dir(dir), first);
}

/// A boot killed mid-copy (disk full, OOM) leaves a partial `.tmp`, never
/// a `.db` the retry would trust: the retry discards it and copies again.
#[test]
fn a_partial_copy_from_an_interrupted_boot_is_redone() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (a, _b) = at_v1(dir);
    // The interrupted boot: an incomplete directory, a truncated copy of A.
    let boot = dir.join("premigrate/boot-000000000000001");
    std::fs::create_dir_all(&boot).unwrap();
    let manifest: String = std::fs::read_dir(dir.join("orgs"))
        .unwrap()
        .flatten()
        .map(|e| format!("{}\n", e.file_name().to_string_lossy()))
        .collect();
    std::fs::write(boot.join("manifest"), manifest).unwrap();
    let whole = std::fs::read(org_file(dir, &a)).unwrap();
    let partial = boot.join(format!("{a}.v1.db.tmp"));
    std::fs::write(&partial, &whole[..whole.len() / 2]).unwrap();

    let s = store(dir, &[V1, V2]);
    assert_eq!(s.migrate_all().unwrap(), 2);
    assert_eq!(boot_dir(dir), boot);
    assert!(!partial.exists());
    let copy = rusqlite::Connection::open(boot.join(format!("{a}.v1.db"))).unwrap();
    let (ok, rows): (String, i64) = copy
        .query_row(
            "SELECT (SELECT integrity_check FROM pragma_integrity_check),
                    (SELECT count(*) FROM things)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((ok.as_str(), rows), ("ok", 1));
    assert!(
        std::fs::read_dir(&boot)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp"))
    );
}
