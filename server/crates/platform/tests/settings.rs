//! `tenantSettings`: per-organisation secrets, AES-GCM under
//! `KEEP_SETTINGS_KEY`. Not used by a feature yet; these pin the rules.

use contracts::{Source, transact};
use platform::settings::{self, SettingsError, SettingsKey};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

fn store(dir: &std::path::Path) -> Store {
    Store::open(StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: Migrations::new(vec![
            M::up(contracts::MIGRATION),
            M::up(settings::MIGRATION),
        ]),
        readers: 1,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap()
}

fn put(db: &OrgDb, key: &SettingsKey, name: &str, value: &str) {
    transact(db, Some(1), |ctx| {
        settings::put(ctx, key, name, value, Source::System)
    })
    .unwrap();
}

fn get(db: &OrgDb, key: &SettingsKey, name: &str) -> Result<Option<String>, SettingsError> {
    db.read(|r| Ok::<_, rusqlite::Error>(settings::get(r, key, name)))
        .unwrap()
}

#[test]
fn round_trips_and_overwrites_with_only_ciphertext_at_rest() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    let key = SettingsKey::parse(&SettingsKey::generate()).unwrap();
    assert_eq!(get(&a, &key, "webhook").unwrap(), None);
    put(&a, &key, "webhook", "whsec_first-secret");
    put(&a, &key, "webhook", "whsec_second-secret");
    assert_eq!(
        get(&a, &key, "webhook").unwrap().as_deref(),
        Some("whsec_second-secret")
    );

    // One row; neither value appears anywhere in the file (rows or revisions).
    let (rows, revisions): (i64, i64) = a
        .read(|r| {
            r.query_row(
                "SELECT (SELECT count(*) FROM tenant_settings), (SELECT count(*) FROM revisions)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!((rows, revisions), (1, 2));
    drop(a);
    drop(store);
    let mut bytes = vec![];
    for entry in std::fs::read_dir(tmp.path().join("orgs")).unwrap() {
        bytes.extend(std::fs::read(entry.unwrap().path()).unwrap());
    }
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("secret"), "plaintext at rest");
}

#[test]
fn the_wrong_key_or_a_moved_row_does_not_decrypt() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    let key = SettingsKey::parse(&SettingsKey::generate()).unwrap();
    let other = SettingsKey::parse(&SettingsKey::generate()).unwrap();
    put(&a, &key, "webhook", "s3cret");
    put(&a, &key, "provider", "p");
    assert!(matches!(
        get(&a, &other, "webhook"),
        Err(SettingsError::Undecryptable(_))
    ));
    // Someone copies the webhook ciphertext onto the provider row: the name
    // is the associated data, so it no longer opens.
    a.write_raw(|tx| {
        tx.conn().execute(
            "UPDATE tenant_settings SET (nonce, ciphertext) =
               (SELECT nonce, ciphertext FROM tenant_settings WHERE name = 'webhook')
             WHERE name = 'provider'",
            [],
        )
    })
    .unwrap();
    assert!(matches!(
        get(&a, &key, "provider"),
        Err(SettingsError::Undecryptable(_))
    ));
}

#[test]
fn settings_are_per_organisation_file() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    let b = store
        .org(&store.create_tenant("beta", "Beta").unwrap().id)
        .unwrap();
    let key = SettingsKey::parse(&SettingsKey::generate()).unwrap();
    put(&a, &key, "webhook", "a-only");
    assert_eq!(get(&b, &key, "webhook").unwrap(), None);
}

#[test]
fn the_key_must_be_32_bytes_of_base64() {
    assert!(matches!(
        SettingsKey::parse("not base64!"),
        Err(SettingsError::BadKey)
    ));
    assert!(matches!(
        SettingsKey::parse("AAAA"),
        Err(SettingsError::BadKey)
    ));
    let k = SettingsKey::parse(&SettingsKey::generate()).unwrap();
    assert_eq!(format!("{k:?}"), "SettingsKey(..)");
}
