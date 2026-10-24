//! The org schema as a whole: every past version migrates to head with its
//! rows intact; money is INTEGER (rule 7); domain crates can't reach the
//! store or the platform (rule 6).

use std::collections::BTreeMap;
use std::path::Path;

use api::schema::org_migrations;
use rusqlite::Connection;
use store::{Store, StoreConfig};

/// Representative rows for each org schema version, inserted after
/// migrating to that version (`FIXTURES[n - 1]` is version n). **A new
/// migration adds its entry here**; the test fails until it does.
const FIXTURES: &[&str] = &[
    // 1: revisions + command groups
    "INSERT INTO command_groups (id, name, actor, at) VALUES (1, 'contact form save', 1, 1000);
     INSERT INTO revisions (id, entity, entity_id, contract, version, counter, payload, actor,
         source, group_id, group_name, at)
     VALUES (1, 'contacts', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 'contacts.details', 1, 0,
         '{\"kind\":\"individual\"}', 1, 'ui', 1, 'contact form save', 1000);",
    // 2: contacts, children, dropdown fields, both FTS variants
    "INSERT INTO contact_number_sequence (id, next) VALUES (1, 10002);
     INSERT INTO contacts (number, id, kind, title, first_name, last_name, nickname, name,
         is_deceased, display_name, sort_name, sort_key)
     VALUES (10001, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 'individual', '', 'Ann', 'Smith', '', '',
         0, 'Ann Smith', 'Smith, Ann', 'smith ann');
     INSERT INTO contact_emails (id, contact_id, position, label, address, address_normalized, is_primary)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 0, 'home',
         'ann@x.org', 'ann@x.org', 1);
     INSERT INTO contact_phones (id, contact_id, position, label, number, number_normalized, is_primary)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 0, 'home',
         '0113 496 0000', '01134960000', 1);
     INSERT INTO contact_addresses (id, contact_id, position, label, line1, line2, line3, town,
         postcode, country, is_primary)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f3', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 0, 'home',
         '1 Road', '', '', 'Leeds', 'LS1 1AA', 'GB', 1);
     INSERT INTO contact_fields (id, label, label_normalized, applies_to, is_active)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f4', 'Volunteer status', 'volunteer status',
         '[\"individual\"]', 1);
     INSERT INTO contact_field_options (id, field_id, label, label_normalized, position, is_active, used)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f5', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f4', 'Yes', 'yes', 0, 1, 1);
     INSERT INTO contact_field_values (contact_id, field_id, option_id)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f4',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f5');
     INSERT INTO contact_search_words (rowid, text) VALUES (10001, 'ann smith ann@x.org');
     INSERT INTO contact_search_trigram (rowid, text) VALUES (10001, 'ann smith ann@x.org');",
    // 3: drop the trigram FTS variant (no new tables)
    "",
];

const TENANT: &str = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0ff";

fn head_version() -> usize {
    let mut conn = Connection::open_in_memory().unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .unwrap() as usize
}

/// Row counts of every ordinary table (FTS shadow tables included).
fn counts(conn: &Connection) -> BTreeMap<String, i64> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|t| {
            let n = conn
                .query_row(&format!("SELECT count(*) FROM \"{t}\""), [], |r| r.get(0))
                .unwrap();
            (t, n)
        })
        .collect()
}

/// An org file at schema `version` with every fixture up to it.
fn file_at(dir: &Path, version: usize) -> BTreeMap<String, i64> {
    std::fs::create_dir_all(dir.join("orgs")).unwrap();
    let mut conn = Connection::open(dir.join(format!("orgs/{TENANT}.db"))).unwrap();
    conn.execute_batch("CREATE TABLE _org (tenant_id TEXT NOT NULL)")
        .unwrap();
    conn.execute("INSERT INTO _org (tenant_id) VALUES (?1)", [TENANT])
        .unwrap();
    let migrations = org_migrations();
    for n in 1..=version {
        migrations.to_version(&mut conn, n).unwrap();
        conn.execute_batch(FIXTURES[n - 1]).unwrap();
    }
    counts(&conn)
}

#[test]
fn every_schema_version_has_a_fixture() {
    assert_eq!(
        FIXTURES.len(),
        head_version(),
        "a new org migration needs its fixture in FIXTURES"
    );
}

#[test]
fn every_past_schema_version_migrates_to_head_with_its_rows() {
    let head = head_version();
    for version in 0..=head {
        let tmp = tempfile::tempdir().unwrap();
        let before = file_at(tmp.path(), version);
        let store = Store::open(StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: org_migrations(),
            readers: 1,
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
        })
        .unwrap();
        let migrated = store.migrate_all().unwrap();
        assert_eq!(migrated, usize::from(version < head), "v{version}");

        let conn = Connection::open(tmp.path().join(format!("orgs/{TENANT}.db"))).unwrap();
        let (v, ok): (i64, String) = conn
            .query_row(
                "SELECT (SELECT user_version FROM pragma_user_version),
                        (SELECT integrity_check FROM pragma_integrity_check)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((v as usize, ok.as_str()), (head, "ok"), "v{version}");
        // Every table that survives keeps its rows.
        let after = counts(&conn);
        for (table, n) in &before {
            if let Some(m) = after.get(table) {
                assert_eq!(m, n, "v{version}: {table}");
            }
        }
        // And the app reads them: search finds the fixture contact.
        if version >= 2 {
            let hits: i64 = conn
                .query_row(
                    "SELECT count(*) FROM contact_search_words WHERE contact_search_words MATCH 'smith'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(hits, 1, "v{version}");
        }
    }
}

#[test]
fn money_is_integer_pence_and_nothing_is_real() {
    let mut conn = Connection::open_in_memory().unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    let columns: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT m.name, p.name, upper(p.type) FROM sqlite_master m, pragma_table_info(m.name) p
             WHERE m.type = 'table' AND m.sql NOT LIKE 'CREATE VIRTUAL%'",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!columns.is_empty());
    for (table, column, ty) in &columns {
        assert!(
            !["REAL", "FLOAT", "DOUBLE", "NUMERIC", "DECIMAL"]
                .iter()
                .any(|bad| ty.contains(bad)),
            "{table}.{column} is {ty}: money is INTEGER pence (rule 7)"
        );
        let lower = column.to_lowercase();
        if lower.contains("amount") || lower.contains("pence") {
            assert_eq!(
                ty, "INTEGER",
                "{table}.{column}: money is INTEGER pence (rule 7)"
            );
        }
    }
}

/// Rule 6: a domain crate depends on `contracts` (and other domain crates
/// through their public functions), never on `store`, `platform`, `auth`
/// or `api`: it can't name an organisation or reach a file.
#[test]
fn domain_crates_cannot_reach_the_store_or_the_platform() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for domain in ["contacts", "sources", "giving", "giftaid", "comms"] {
        let manifest = std::fs::read_to_string(crates.join(domain).join("Cargo.toml"))
            .unwrap_or_else(|e| panic!("{domain}: {e}"));
        let mut section = "";
        for line in manifest.lines().map(str::trim) {
            if line.starts_with('[') {
                section = line;
                continue;
            }
            if section != "[dependencies]" {
                continue;
            }
            let name = line.split(['=', '.', ' ']).next().unwrap_or("");
            assert!(
                !["store", "platform", "auth", "api"].contains(&name),
                "{domain} depends on {name}"
            );
        }
    }
}

/// Every registered contract owns its own `INTEGER NOT NULL DEFAULT 0`
/// counter column on its root table, and every past version can be
/// upcast (Convex's registry meta-tests).
#[test]
fn every_contract_has_its_own_counter_column_and_its_upcasters() {
    let mut conn = Connection::open_in_memory().unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    let registry = &*contacts::REGISTRY;
    let mut owners = BTreeMap::new();
    for c in registry.contracts() {
        let (ty, notnull, default): (String, bool, Option<String>) = conn
            .query_row(
                "SELECT type, \"notnull\", dflt_value FROM pragma_table_info(?1) WHERE name = ?2",
                [c.entity(), c.counter()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap_or_else(|e| panic!("{}: {}.{}: {e}", c.name(), c.entity(), c.counter()));
        assert_eq!(
            (ty.as_str(), notnull, default.as_deref()),
            ("INTEGER", true, Some("0")),
            "{}",
            c.name()
        );
        if let Some(other) = owners.insert((c.entity(), c.counter()), c.name()) {
            panic!(
                "{} and {other} share {}.{}",
                c.name(),
                c.entity(),
                c.counter()
            );
        }
    }
    assert!(registry.missing_upcasters().is_empty());
}

/// Rule 6 / M3, the part the compiler can't see: `ctx.tx.read()` is a
/// plain `&Connection` that is only `query_only`, so one line of domain
/// code could switch that off or end the transaction. Domain crates may
/// not contain the strings that would: `query_only`, `authorizer(`,
/// `unchecked_transaction`, or a SQL literal that starts with a
/// transaction-control, `ATTACH` or `PRAGMA` keyword.
#[test]
fn domain_crates_cannot_switch_the_read_view_off() {
    const WORDS: &[&str] = &["query_only", "authorizer(", "unchecked_transaction"];
    const SQL: &[&str] = &[
        "COMMIT",
        "BEGIN",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "ATTACH",
        "DETACH",
        "PRAGMA",
        "END",
    ];
    fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|x| x == "rs") {
                out.push(path);
            }
        }
    }
    /// SQL keywords at the start of a string literal (after whitespace).
    fn literal_keywords(text: &str) -> Vec<String> {
        let mut found = vec![];
        for (i, _) in text.match_indices('"') {
            let rest = text[i + 1..].trim_start();
            let word: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphabetic())
                .collect::<String>()
                .to_ascii_uppercase();
            if SQL.contains(&word.as_str()) {
                found.push(word);
            }
        }
        found
    }
    assert_eq!(
        literal_keywords(r#"x("pragma query_only = 0")"#),
        vec!["PRAGMA"]
    );
    assert_eq!(literal_keywords(r#"x(" COMMIT; BEGIN")"#), vec!["COMMIT"]);
    assert!(literal_keywords(r#"x("SELECT 1", "Ended", "begins")"#).is_empty());

    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = vec![];
    for domain in ["contacts", "sources", "giving", "giftaid", "comms"] {
        sources(&crates.join(domain).join("src"), &mut files);
    }
    assert!(!files.is_empty());
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for word in WORDS {
            assert!(!text.contains(word), "{} mentions {word}", file.display());
        }
        let sql = literal_keywords(&text);
        assert!(
            sql.is_empty(),
            "{}: SQL starting with {sql:?}",
            file.display()
        );
    }
}
