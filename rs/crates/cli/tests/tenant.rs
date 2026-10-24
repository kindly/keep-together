//! `keep tenant create` and `keep dev seed-demo`: the ports of
//! `convex/platform/tenants.test.ts` (create) and `devSeed.test.ts`.

use cli::dev::seed_demo;
use cli::tenant::{CreateError, create_in, open};
use store::{Role, StoreError};

fn org_files(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir.join("orgs"))
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "db")
        })
        .count()
}

#[test]
fn create_makes_the_admin_and_a_migrated_file_and_invites() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path()).unwrap();
    let made = create_in(
        &store,
        "anytown-hall",
        " Anytown Village Hall ",
        "Jo@Example.org",
    )
    .unwrap();
    assert_eq!(made.tenant.name, "Anytown Village Hall");
    let p = store.platform();
    // The email is the user's, lower-cased; they are the only member, admin.
    let members = p
        .with_read(|c| platform::members::members(c, &made.tenant.id))
        .unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(
        (members[0].email.as_str(), members[0].role),
        ("jo@example.org", Role::Admin)
    );
    assert_eq!(members[0].user, made.admin);
    assert!(made.invite.contains("jo@example.org") || made.invite.contains("Jo@Example.org"));
    // The file is at the head schema (preferences table there, empty).
    let db = store.org(&made.tenant.id).unwrap();
    let rows: i64 = db
        .read(|r| r.query_row("SELECT count(*) FROM tenant_preferences", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn an_existing_user_becomes_the_admin_without_a_duplicate() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path()).unwrap();
    let existing = store.platform().upsert_user("jo@example.org").unwrap();
    let made = create_in(&store, "alpha", "Alpha", "jo@example.org").unwrap();
    assert_eq!(made.admin, existing);
    let users: i64 = store
        .platform()
        .with_read(|c| c.query_row("SELECT count(*) FROM users", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(users, 1);
}

#[test]
fn malformed_or_taken_slugs_and_a_missing_email_are_refused_and_create_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path()).unwrap();
    create_in(&store, "alpha", "Alpha", "ann@alpha.org").unwrap();
    for bad in ["Bad Slug", "-x", "a/b", ""] {
        assert!(
            matches!(
                create_in(&store, bad, "X", "x@x.org"),
                Err(CreateError::Store(StoreError::InvalidSlug(_)))
            ),
            "{bad}"
        );
    }
    assert!(matches!(
        create_in(&store, "alpha", "Again", "x@x.org"),
        Err(CreateError::Store(StoreError::SlugTaken(_)))
    ));
    assert!(matches!(
        create_in(&store, "beta", "Beta", "   "),
        Err(CreateError::NoEmail)
    ));
    assert_eq!(org_files(tmp.path()), 1);
    assert_eq!(store.platform().tenants().unwrap().len(), 1);
    // None of the refused attempts made a user.
    let users: i64 = store
        .platform()
        .with_read(|c| c.query_row("SELECT count(*) FROM users", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(users, 1);
}

#[test]
fn a_failed_setup_leaves_no_row_no_file_no_membership() {
    // The atomicity `create_in` relies on: setup failing after the file and
    // membership were made rolls back the row and removes the file.
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path()).unwrap();
    let out = store.create_tenant_with("alpha", "Alpha", |tx, tenant, _db| {
        let user = store::Platform::upsert_user_in(tx, "ann@alpha.org")?;
        platform::members::add_membership(tx, user, &tenant.id, Role::Admin)?;
        Err::<(), _>(CreateError::NoEmail)
    });
    assert!(matches!(out, Err(CreateError::NoEmail)));
    assert_eq!(org_files(tmp.path()), 0);
    assert!(store.platform().tenants().unwrap().is_empty());
    let (users, members): (i64, i64) = store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM memberships)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!((users, members), (0, 0));
}

#[test]
fn a_new_organisation_sees_none_of_the_others() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path()).unwrap();
    let demo = seed_demo(&store, "demo", None).unwrap();
    let fresh = create_in(&store, "fresh", "Fresh", "f@x.org").unwrap();
    let count = |id| {
        store
            .org(id)
            .unwrap()
            .read(|r| r.query_row("SELECT count(*) FROM contacts", [], |r| r.get::<_, i64>(0)))
            .unwrap()
    };
    assert_eq!(count(&demo.created.tenant.id), 3);
    assert_eq!(count(&fresh.tenant.id), 0);
    // And the fresh admin is a member of fresh only.
    let groups = store.platform().memberships(fresh.admin).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].tenant.slug, "fresh");
}

#[test]
fn seed_demo_defaults_its_admin_and_refuses_a_taken_slug() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path()).unwrap();
    let demo = seed_demo(&store, "demo", None).unwrap();
    assert_eq!(demo.created.tenant.name, "demo demo group");
    let members = store
        .platform()
        .with_read(|c| platform::members::members(c, &demo.created.tenant.id))
        .unwrap();
    assert_eq!(members[0].email, "demo-admin@example.com");
    assert_eq!(demo.contact_ids.len(), 3);
    let emails: Vec<String> = store
        .org(&demo.created.tenant.id)
        .unwrap()
        .read(|r| {
            r.prepare("SELECT address FROM contact_emails ORDER BY address")?
                .query_map([], |r| r.get(0))?
                .collect()
        })
        .unwrap();
    assert_eq!(
        emails,
        ["ada@example.com", "charles@example.com", "mary@example.com"]
    );
    assert!(matches!(
        seed_demo(&store, "demo", None),
        Err(CreateError::Store(StoreError::SlugTaken(_)))
    ));

    // An existing user given as the admin becomes it.
    let me = store.platform().upsert_user("me@example.org").unwrap();
    let mine = seed_demo(&store, "mine", Some("me@example.org")).unwrap();
    assert_eq!(mine.created.admin, me);
}

#[test]
fn dev_seeds_are_refused_on_prod_and_staging() {
    use cli::dev::dev_only;
    for env in ["prod", "staging"] {
        assert!(matches!(dev_only(Some(env)), Err(CreateError::NotDev(e)) if e == env));
    }
    for env in [None, Some("dev"), Some("")] {
        assert!(dev_only(env).is_ok(), "{env:?}");
    }
    // The binary, as an operator would run it: refused, nothing made.
    for env in ["prod", "staging"] {
        let tmp = tempfile::tempdir().unwrap();
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_keep"))
            .args(["--data", tmp.path().to_str().unwrap(), "dev", "seed-demo"])
            .env("KEEP_ENV", env)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{env}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("refused when KEEP_ENV="),
            "{env}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(org_files(tmp.path()), 0, "{env}");
    }
}

#[test]
fn seed_demo_is_one_go_so_a_failure_leaves_nothing_and_it_can_run_again() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path()).unwrap();
    // The demo's contacts run where a failing step would: after the seeds,
    // in the new file's first transaction.
    let failed = cli::tenant::create_in_with(&store, "demo", "Demo", "d@x.org", |ctx, _| {
        contacts::form::create(
            ctx,
            contacts::types::CreateContact {
                id: None,
                details: serde_json::from_value(serde_json::json!({
                    "kind": "individual", "title": "", "firstName": "Half", "lastName": "Made",
                    "nickname": "", "name": "", "isDeceased": false
                }))
                .unwrap(),
            },
            contracts::Source::Seed,
        )?;
        Err(CreateError::NoEmail)
    });
    assert!(matches!(failed, Err(CreateError::NoEmail)));
    assert_eq!(org_files(tmp.path()), 0);
    assert!(store.platform().tenants().unwrap().is_empty());
    // Nothing to clear up: the same slug simply works now.
    let demo = seed_demo(&store, "demo", None).unwrap();
    assert_eq!(demo.contact_ids.len(), 3);
}
