//! `keep sql` is read-only by construction: whatever the SQL text says,
//! the file is unchanged.

use std::path::Path;
use std::time::Duration;

use cli::sql::{Format, SqlError, open, run, run_within};

fn setup(dir: &Path) {
    let alpha = cli::tenant::create(dir, "alpha", "Alpha", "ann@alpha.org").unwrap();
    cli::tenant::create(dir, "beta", "Beta", "bob@beta.org").unwrap();
    let store = store::Store::open(store::StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: api::schema::org_migrations(),
        readers: 1,
        max_open: 4,
    })
    .unwrap();
    store
        .org(&alpha.id)
        .unwrap()
        .write_raw(|tx| {
            tx.conn().execute_batch(
                "INSERT INTO command_groups (name, actor, at) VALUES ('first, \"quoted\"', 1, 10);
                 INSERT INTO command_groups (name, actor, at) VALUES ('second', NULL, 20);",
            )
        })
        .unwrap();
}

fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<_> = std::fs::read_dir(dir.join("orgs"))
        .unwrap()
        .flatten()
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
fn selects_come_back_as_csv_or_json() {
    let tmp = tempfile::tempdir().unwrap();
    setup(tmp.path());
    let conn = open(tmp.path(), "alpha").unwrap();
    let sql = "SELECT name, actor FROM command_groups ORDER BY at";
    assert_eq!(
        run(&conn, sql, Format::Csv).unwrap(),
        "name,actor\n\"first, \"\"quoted\"\"\",1\nsecond,\n"
    );
    let json: serde_json::Value =
        serde_json::from_str(&run(&conn, sql, Format::Json).unwrap()).unwrap();
    assert_eq!(
        json[1],
        serde_json::json!({ "name": "second", "actor": null })
    );
    // Each slug is its own file.
    let beta = open(tmp.path(), "beta").unwrap();
    assert_eq!(
        run(
            &beta,
            "SELECT count(*) AS n FROM command_groups",
            Format::Csv
        )
        .unwrap(),
        "n\n0\n"
    );
    assert!(matches!(
        open(tmp.path(), "gamma"),
        Err(SqlError::UnknownOrg(_))
    ));
    assert!(matches!(
        open(tmp.path(), "' OR 1=1 --"),
        Err(SqlError::UnknownOrg(_))
    ));
}

#[test]
fn every_kind_of_write_is_refused_and_the_file_is_unchanged() {
    let tmp = tempfile::tempdir().unwrap();
    setup(tmp.path());
    let before = files(tmp.path());
    let conn = open(tmp.path(), "alpha").unwrap();
    let other = tmp.path().join("orgs/stolen.db");
    for sql in [
        "DELETE FROM command_groups",
        "UPDATE command_groups SET name = 'x'",
        "INSERT INTO command_groups (name, at) VALUES ('x', 1)",
        "WITH doomed AS (SELECT id FROM command_groups) DELETE FROM command_groups WHERE id IN doomed",
        "WITH RECURSIVE n(i) AS (SELECT 1) INSERT INTO command_groups (name, at) SELECT 'x', i FROM n",
        &format!("ATTACH DATABASE '{}' AS other", other.display()),
        "PRAGMA writable_schema = ON",
        "PRAGMA query_only = OFF",
        "SELECT * FROM pragma_table_info('contacts')",
        "CREATE TABLE t (x)",
        "DROP TABLE command_groups",
        "BEGIN IMMEDIATE",
        "VACUUM",
        "SELECT 1; DELETE FROM command_groups",
    ] {
        let out = run(&conn, sql, Format::Csv);
        assert!(out.is_err(), "{sql} was allowed: {out:?}");
    }
    drop(conn);
    // Reading a WAL-mode file leaves an empty `-wal` and a `-shm` index
    // beside it; the database itself is byte for byte the same.
    let after = files(tmp.path());
    let db = |f: &[(String, Vec<u8>)]| {
        f.iter()
            .filter(|(n, _)| n.ends_with(".db"))
            .cloned()
            .collect::<Vec<_>>()
    };
    assert!(db(&after) == db(&before), "an org file changed");
    for (name, bytes) in &after {
        if name.ends_with("-wal") {
            assert!(bytes.is_empty(), "{name} has frames");
        }
    }
    assert!(!other.exists());
}

#[test]
fn a_runaway_query_is_interrupted() {
    let tmp = tempfile::tempdir().unwrap();
    setup(tmp.path());
    let conn = open(tmp.path(), "alpha").unwrap();
    let forever =
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n";
    let err = run_within(&conn, forever, Format::Csv, Duration::from_millis(200)).unwrap_err();
    assert!(err.to_string().contains("interrupt"), "{err}");
    // The connection is usable again afterwards.
    run(&conn, "SELECT 1", Format::Csv).unwrap();
}
