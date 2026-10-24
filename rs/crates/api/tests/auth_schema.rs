//! Auth's `platform.db` steps run inside the boot migration: the boot
//! copies `platform.db` before they run, so a rollback restores a file
//! the previous release understands.

use std::path::Path;

use api::schema;
use store::{Store, StoreConfig};

fn open(dir: &Path, schemas: &[store::PlatformSchema]) -> Store {
    let s = Store::open_with(
        StoreConfig {
            dir: dir.to_path_buf(),
            org_migrations: schema::org_migrations(),
            readers: 1,
            max_open: 4,
        },
        schemas,
    )
    .unwrap();
    s.migrate_all().unwrap();
    s
}

fn tables(path: &Path) -> Vec<String> {
    let c = rusqlite::Connection::open(path).unwrap();
    let mut stmt = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'auth_%' ORDER BY name")
        .unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn has_table(path: &Path, name: &str) -> bool {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        == 1
}

#[test]
fn a_release_adding_auth_is_copied_first_and_rolls_back() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let platform = dir.join("platform.db");
    // The previous release: every platform schema but auth's.
    let before: Vec<_> = schema::PLATFORM_SCHEMAS
        .iter()
        .copied()
        .filter(|s| s.name != "auth")
        .collect();
    let s = open(dir, &before);
    s.create_tenant("alpha", "Alpha").unwrap();
    drop(s);
    assert!(tables(&platform).is_empty());

    // The release with auth boots: platform.db is copied, then migrated.
    let s = open(dir, schema::PLATFORM_SCHEMAS);
    drop(s);
    assert_eq!(
        tables(&platform),
        [
            "auth_credentials",
            "auth_email_gates",
            "auth_factor_failures",
            "auth_invites",
            "auth_log",
            "auth_recovery_codes",
            "auth_resets",
            "auth_sessions"
        ]
    );
    let boot = std::fs::read_dir(dir.join("premigrate"))
        .unwrap()
        .flatten()
        .next()
        .unwrap()
        .path();
    let copies: Vec<String> = std::fs::read_dir(&boot)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("platform.v"))
        .collect();
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert!(
        tables(&boot.join(&copies[0])).is_empty(),
        "the copy predates auth"
    );

    // The previous release's code on the migrated file, without the
    // rollback script: it refuses to open it (fails closed), naming auth.
    let refused = Store::open_with(
        StoreConfig {
            dir: dir.to_path_buf(),
            org_migrations: schema::org_migrations(),
            readers: 1,
            max_open: 4,
        },
        &before,
    );
    assert!(
        matches!(refused, Err(store::StoreError::UnknownSchema(ref n)) if n == "auth"),
        "{:?}",
        refused.err()
    );

    // Rolling back restores the copy: no auth tables, no auth version.
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
    assert!(tables(&platform).is_empty());
    assert!(
        has_table(&platform, "sessions"),
        "the previous release's table is back"
    );
    let auth_version: i64 = rusqlite::Connection::open(&platform)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM platform_schema WHERE name = 'auth'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(auth_version, 0);
    // And the previous release opens it.
    drop(open(dir, &before));
}

/// S1 M2: a `platform.db` from before auth step 3 (plaintext TOTP secrets,
/// unpeppered SHA-256 codes) migrates: the old code hashes go (they can't
/// be converted), and the boot's sealing pass seals each TOTP secret,
/// which still verifies afterwards. Running the pass again changes nothing.
#[test]
fn step_3_seals_totp_secrets_and_drops_unpeppered_codes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let v2 = store::PlatformSchema {
        name: "auth",
        steps: &auth::SCHEMA.steps[..2],
    };
    let mut before: Vec<_> = schema::PLATFORM_SCHEMAS
        .iter()
        .copied()
        .filter(|s| s.name != "auth")
        .collect();
    before.push(v2);
    let s = open(dir, &before);
    let user = s.platform().upsert_user("ann@alpha.org").unwrap().0;
    let plain = auth::totp::new_secret();
    s.platform()
        .with_write(|tx| {
            tx.execute(
                "INSERT INTO auth_credentials (user_id, password_hash, second_factor, totp_secret, updated_at)
                 VALUES (?1, 'x', 'totp', ?2, 0)",
                rusqlite::params![user, plain],
            )?;
            tx.execute(
                "INSERT INTO auth_recovery_codes (user_id, code_hash) VALUES (?1, ?2)",
                rusqlite::params![user, auth::secret::hash("abcdefghjk")],
            )
        })
        .unwrap();
    drop(s);

    let s = open(dir, schema::PLATFORM_SCHEMAS);
    let keys = auth::Keys::parse(&auth::Keys::generate(), &auth::Keys::generate()).unwrap();
    let sealed = s
        .platform()
        .with_write(|tx| auth::keys::seal_plaintext_secrets(tx, &keys))
        .unwrap();
    assert_eq!(sealed, 1);
    let again = s
        .platform()
        .with_write(|tx| auth::keys::seal_plaintext_secrets(tx, &keys))
        .unwrap();
    assert_eq!(again, 0, "idempotent");
    let (creds, codes) = s
        .platform()
        .with_read(|c| {
            Ok::<_, rusqlite::Error>((
                auth::accounts::credentials(c, user)?.unwrap(),
                c.query_row("SELECT count(*) FROM auth_recovery_codes", [], |r| {
                    r.get::<_, i64>(0)
                })?,
            ))
        })
        .unwrap();
    let stored = creds.totp_sealed.clone().unwrap();
    assert!(stored.starts_with("v1:") && !stored.contains(&plain));
    assert_eq!(
        creds.totp_secret(&keys, user).as_deref(),
        Some(plain.as_str())
    );
    assert_eq!(
        creds.totp_secret(&auth::Keys::dev(), user),
        None,
        "another key"
    );
    assert_eq!(codes, 0);
    let now = 1_800_000_000;
    let code = auth::totp::code_at(&plain, now).unwrap();
    assert!(auth::totp::verify(&creds.totp_secret(&keys, user).unwrap(), &code, now, 0).is_some());
}
