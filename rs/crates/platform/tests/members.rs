//! `platform.db`: this crate's schema list, and the membership functions
//! auth composes into its own transactions.

use platform::members::{
    add_membership, admin_count, members, remove_membership, role_of, set_role,
};
use platform::{Role, SCHEMA};
use store::{M, Migrations, PlatformSchema, Store, StoreConfig, StoreError};

fn config(dir: &std::path::Path) -> StoreConfig {
    StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: Migrations::new(vec![M::up("CREATE TABLE t (x INTEGER);")]),
        readers: 1,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    }
}

fn version(store: &Store, name: &str) -> i64 {
    store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT version FROM platform_schema WHERE name = ?1",
                [name],
                |r| r.get(0),
            )
        })
        .unwrap()
}

#[test]
fn each_crate_schema_migrates_once_under_its_own_name() {
    let tmp = tempfile::tempdir().unwrap();
    const OTHER: PlatformSchema = PlatformSchema {
        name: "other",
        steps: &["CREATE TABLE other_things (id INTEGER PRIMARY KEY) STRICT;"],
    };
    let store = Store::open_with(config(tmp.path()), &[SCHEMA, OTHER]).unwrap();
    assert_eq!(version(&store, "platform"), SCHEMA.steps.len() as i64);
    assert_eq!(version(&store, "other"), 1);
    drop(store);
    // Reopening runs nothing again (an ALTER TABLE ADD COLUMN would fail).
    let store = Store::open_with(config(tmp.path()), &[SCHEMA, OTHER]).unwrap();
    assert_eq!(version(&store, "other"), 1);
    // Nothing pending: no copy was made.
    assert!(!tmp.path().join("premigrate").exists());
}

#[test]
fn a_pending_crate_step_copies_platform_db_first() {
    let tmp = tempfile::tempdir().unwrap();
    drop(Store::open(config(tmp.path())).unwrap());
    let store = Store::open_with(config(tmp.path()), &[SCHEMA]).unwrap();
    store.migrate_all().unwrap();
    let boot = std::fs::read_dir(tmp.path().join("premigrate"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let names: Vec<String> = std::fs::read_dir(&boot)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(
        names
            .iter()
            .any(|n| n.starts_with("platform.v") && n.ends_with(".db")),
        "{names:?}"
    );
}

#[test]
fn a_schema_newer_than_the_code_fails_closed() {
    let tmp = tempfile::tempdir().unwrap();
    drop(Store::open_with(config(tmp.path()), &[SCHEMA]).unwrap());
    let older = PlatformSchema {
        name: "platform",
        steps: &[],
    };
    assert!(matches!(
        Store::open_with(config(tmp.path()), &[older]),
        Err(StoreError::NewerSchema {
            name: "platform",
            ..
        })
    ));
}

#[test]
fn memberships_compose_in_one_transaction() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open_with(config(tmp.path()), &[SCHEMA]).unwrap();
    let a = store.create_tenant("alpha", "Alpha").unwrap();
    let b = store.create_tenant("beta", "Beta").unwrap();
    let p = store.platform();
    let ann = p.upsert_user("ann@alpha.org").unwrap();
    let sam = p.upsert_user("sam@alpha.org").unwrap();
    p.with_write(|tx| {
        add_membership(tx, ann, &a.id, Role::Admin)?;
        add_membership(tx, sam, &a.id, Role::Staff)?;
        add_membership(tx, sam, &b.id, Role::Admin)
    })
    .unwrap();

    let listed = p.with_read(|c| members(c, &a.id)).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|m| (m.email.as_str(), m.role))
            .collect::<Vec<_>>(),
        vec![
            ("ann@alpha.org", Role::Admin),
            ("sam@alpha.org", Role::Staff)
        ]
    );
    assert_eq!(p.with_read(|c| admin_count(c, &a.id)).unwrap(), 1);

    // The last-admin rule, as auth runs it: check and change in one tx.
    #[derive(Debug)]
    enum E {
        LastAdmin,
        Sql,
    }
    impl From<rusqlite::Error> for E {
        fn from(_: rusqlite::Error) -> Self {
            E::Sql
        }
    }
    let refused = p.with_write(|tx| {
        set_role(tx, ann, &a.id, Role::Staff)?;
        if admin_count(tx, &a.id)? == 0 {
            return Err(E::LastAdmin);
        }
        Ok(())
    });
    assert!(matches!(refused, Err(E::LastAdmin)), "{refused:?}");
    assert_eq!(
        p.with_read(|c| role_of(c, ann, &a.id)).unwrap(),
        Some(Role::Admin)
    );

    assert!(
        p.with_write(|tx| set_role(tx, sam, &a.id, Role::Viewer))
            .unwrap()
    );
    assert!(
        p.with_write(|tx| remove_membership(tx, sam, &a.id))
            .unwrap()
    );
    assert!(
        !p.with_write(|tx| remove_membership(tx, sam, &a.id))
            .unwrap()
    );
    assert_eq!(p.with_read(|c| role_of(c, sam, &a.id)).unwrap(), None);
    // Another organisation's membership is untouched.
    assert_eq!(
        p.with_read(|c| role_of(c, sam, &b.id)).unwrap(),
        Some(Role::Admin)
    );
}
