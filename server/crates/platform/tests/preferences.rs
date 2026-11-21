//! `convex/platform/preferences.test.ts` and the `lib/lists` rule, on one
//! org file each: preferences are org data, so a second organisation's
//! file never sees the first's switches.

use contracts::{ContractError, Source, transact};
use platform::preferences::{self, ListKind};
use platform::{Role, may_manage_list};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

fn store(dir: &std::path::Path) -> Store {
    Store::open(StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: Migrations::new(vec![
            M::up(contracts::MIGRATION),
            M::up(preferences::MIGRATION),
            M::up(preferences::MIGRATION_CLAIMS_GIFT_AID),
        ]),
        readers: 1,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap()
}

fn set(db: &OrgDb, kind: ListKind, on: bool, expected: Option<i64>) -> Result<i64, ContractError> {
    transact(db, Some(1), |ctx| {
        preferences::set(ctx, kind, on, expected, Source::Ui).map(|e| e.counter)
    })
}

fn may(db: &OrgDb, role: Role, kind: ListKind) -> bool {
    db.read(|r| may_manage_list(r, role, kind)).unwrap()
}

#[test]
fn no_row_means_every_default_and_admins_only() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    let prefs = a.read(|r| preferences::read(r)).unwrap();
    for kind in ListKind::ALL {
        assert!(!prefs.get(kind).staff_can_manage);
        assert_eq!(prefs.get(kind).version, None);
        assert!(may(&a, Role::Admin, kind));
        assert!(!may(&a, Role::Staff, kind));
        assert!(!may(&a, Role::Viewer, kind));
    }
}

#[test]
fn each_switch_is_independent_with_its_own_counter() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();

    assert_eq!(set(&a, ListKind::IdentifierTypes, true, None).unwrap(), 0);
    assert!(may(&a, Role::Staff, ListKind::IdentifierTypes));
    assert!(!may(&a, Role::Staff, ListKind::SourceCodes));
    assert!(!may(&a, Role::Staff, ListKind::Fields));
    // Viewers never, whatever the switch says.
    assert!(!may(&a, Role::Viewer, ListKind::IdentifierTypes));

    // The row exists now; the other switches' counters are still 0, so a
    // save of one never conflicts with another.
    let prefs = a.read(|r| preferences::read(r)).unwrap();
    assert_eq!(prefs.source_codes.version, Some(0));
    assert_eq!(set(&a, ListKind::SourceCodes, true, Some(0)).unwrap(), 1);
    assert_eq!(set(&a, ListKind::Fields, true, Some(0)).unwrap(), 1);
    assert_eq!(
        set(&a, ListKind::IdentifierTypes, false, Some(0)).unwrap(),
        1
    );

    let prefs = a.read(|r| preferences::read(r)).unwrap();
    assert!(!prefs.identifier_types.staff_can_manage);
    assert!(prefs.source_codes.staff_can_manage);
    assert!(prefs.fields.staff_can_manage);
    assert!(!may(&a, Role::Staff, ListKind::IdentifierTypes));
    assert!(may(&a, Role::Staff, ListKind::SourceCodes));
    assert!(may(&a, Role::Staff, ListKind::Fields));

    // One row, ever.
    let rows: i64 = a
        .read(|r| r.query_row("SELECT count(*) FROM tenant_preferences", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn a_stale_save_is_refused_with_the_current_state() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    set(&a, ListKind::Fields, true, None).unwrap();
    set(&a, ListKind::Fields, false, Some(0)).unwrap();
    match set(&a, ListKind::Fields, true, Some(0)) {
        Err(ContractError::Stale {
            contract,
            counter,
            current,
        }) => {
            assert_eq!(contract, "tenantPreferences.fields");
            assert_eq!(counter, 1);
            assert_eq!(current, serde_json::json!({"staffCanManageFields": false}));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn saving_unseen_after_another_admin_created_the_row_is_stale() {
    // Two admins both saw no row; the first save creates it, the second
    // (still sending no `expected`) must not silently overwrite.
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    set(&a, ListKind::SourceCodes, true, None).unwrap();
    assert!(matches!(
        set(&a, ListKind::SourceCodes, false, None),
        Err(ContractError::Stale { counter: 0, .. })
    ));
    // Even a different switch: the caller saw no row at all.
    assert!(matches!(
        set(&a, ListKind::Fields, true, None),
        Err(ContractError::Stale { counter: 0, .. })
    ));
}

#[test]
fn saves_write_revisions_and_preferences_stay_in_their_own_file() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    let b = store
        .org(&store.create_tenant("beta", "Beta").unwrap().id)
        .unwrap();
    set(&a, ListKind::IdentifierTypes, true, None).unwrap();
    set(&a, ListKind::IdentifierTypes, false, Some(0)).unwrap();

    let revisions: Vec<(String, i64, String)> = a
        .read(|r| {
            r.prepare("SELECT contract, counter, payload FROM revisions ORDER BY id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .unwrap();
    assert_eq!(
        revisions,
        vec![
            (
                "tenantPreferences.identifierTypes".into(),
                0,
                r#"{"staffCanManageIdentifierTypes":true}"#.into()
            ),
            (
                "tenantPreferences.identifierTypes".into(),
                1,
                r#"{"staffCanManageIdentifierTypes":false}"#.into()
            ),
        ]
    );
    set(&a, ListKind::Fields, true, Some(0)).unwrap();
    assert!(may(&a, Role::Staff, ListKind::Fields));
    assert!(!may(&b, Role::Staff, ListKind::Fields));
    assert_eq!(
        b.read(|r| preferences::read(r)).unwrap().fields.version,
        None
    );
}

fn claims(db: &OrgDb) -> preferences::ClaimsGiftAid {
    db.read(|r| preferences::read(r)).unwrap().claims_gift_aid
}

fn set_claims(db: &OrgDb, on: bool, expected: Option<i64>) -> Result<i64, ContractError> {
    transact(db, Some(1), |ctx| {
        preferences::set_claims_gift_aid(ctx, on, expected, Source::Ui).map(|e| e.counter)
    })
}

#[test]
fn a_group_claims_gift_aid_until_it_says_otherwise() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    // No row: on.
    assert!(a.read(|r| preferences::claims_gift_aid(r)).unwrap());
    assert_eq!((claims(&a).on, claims(&a).version), (true, None));

    // A row made by another switch leaves it on.
    set(&a, ListKind::Fields, true, None).unwrap();
    assert!(a.read(|r| preferences::claims_gift_aid(r)).unwrap());
    assert_eq!((claims(&a).on, claims(&a).version), (true, Some(0)));

    assert_eq!(set_claims(&a, false, Some(0)).unwrap(), 1);
    assert!(!a.read(|r| preferences::claims_gift_aid(r)).unwrap());
    assert_eq!((claims(&a).on, claims(&a).version), (false, Some(1)));
    assert_eq!(set_claims(&a, true, Some(1)).unwrap(), 2);
    assert!(a.read(|r| preferences::claims_gift_aid(r)).unwrap());
}

#[test]
fn claims_gift_aid_has_its_own_counter_and_never_conflicts_with_the_list_switches() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    // The first save of all creates the row.
    assert_eq!(set_claims(&a, false, None).unwrap(), 0);
    let prefs = a.read(|r| preferences::read(r)).unwrap();
    assert!(!prefs.claims_gift_aid.on);
    for kind in ListKind::ALL {
        assert!(!prefs.get(kind).staff_can_manage);
        assert_eq!(prefs.get(kind).version, Some(0));
    }
    // Each list switch saves at its own counter, and leaves Gift Aid off.
    assert_eq!(set(&a, ListKind::SourceCodes, true, Some(0)).unwrap(), 1);
    assert_eq!((claims(&a).on, claims(&a).version), (false, Some(0)));
    // A stale save is refused with the switch as it is.
    set_claims(&a, true, Some(0)).unwrap();
    match set_claims(&a, false, Some(0)) {
        Err(ContractError::Stale {
            contract,
            counter,
            current,
        }) => {
            assert_eq!(contract, "tenantPreferences.claimsGiftAid");
            assert_eq!(counter, 1);
            assert_eq!(current, serde_json::json!({ "claimsGiftAid": true }));
        }
        other => panic!("{other:?}"),
    }
    // Seeing no row when one exists is stale too.
    assert!(matches!(
        set_claims(&a, false, None),
        Err(ContractError::Stale { .. })
    ));
    assert!(claims(&a).on);
}

#[test]
fn one_groups_gift_aid_switch_is_not_anothers() {
    let tmp = tempfile::tempdir().unwrap();
    let store = store(tmp.path());
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    let b = store
        .org(&store.create_tenant("beta", "Beta").unwrap().id)
        .unwrap();
    set_claims(&a, false, None).unwrap();
    assert!(!a.read(|r| preferences::claims_gift_aid(r)).unwrap());
    assert!(b.read(|r| preferences::claims_gift_aid(r)).unwrap());
    assert_eq!(claims(&b).version, None);
    let rows: i64 = b
        .read(|r| r.query_row("SELECT count(*) FROM tenant_preferences", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(rows, 0);
}
