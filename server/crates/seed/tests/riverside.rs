//! `seed::riverside`: the Convex `platform/testSeed.test.ts` cases, plus
//! the generator's parity with the TS one and the Rust port's additions.

use std::collections::{BTreeMap, BTreeSet};

use auth::Keys;
use contacts::queries::{SearchQuery, search};
use contracts::{Exec, Source, execute, transact};
use rusqlite::Connection;
use seed::riverside::data::{self, DONOR_COUNT, IDENTIFIER_TYPES, SOURCE_DETAILS};
use seed::riverside::{self, Credential, Origin, SLUG, SeedError, USERS};
use store::{Role, Store, StoreConfig, Tenant};

fn open(dir: &std::path::Path) -> Store {
    Store::open_with(
        StoreConfig {
            dir: dir.into(),
            org_migrations: api::schema::org_migrations(),
            readers: 1,
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
        },
        api::schema::PLATFORM_SCHEMAS,
    )
    .unwrap()
}

fn passwords(staff: &str) -> Vec<Credential> {
    let env = |name: &str| match name {
        "KEEP_RIVERSIDE_ADMIN_PASSWORD" => Some("admin-password-123".into()),
        "KEEP_RIVERSIDE_STAFF_PASSWORD" => Some(staff.into()),
        "KEEP_RIVERSIDE_VIEWER_PASSWORD" => Some("viewer-password-123".into()),
        n if n.ends_with("_TOTP") => Some("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP".into()),
        _ => None,
    };
    riverside::credentials_from_env(env, false).unwrap()
}

fn seed(store: &Store, creds: &[Credential]) -> riverside::Seeded {
    let mut creds = creds.to_vec();
    riverside::seed(store, &Keys::dev(), &mut creds, api::schema::seed_new_org).unwrap()
}

/// Two unrelated organisations with a contact each, so every test can
/// assert the seed leaves them alone.
fn others(store: &Store) -> Vec<Tenant> {
    ["other-a", "other-b"]
        .into_iter()
        .map(|slug| {
            let t = store.create_tenant(slug, slug).unwrap();
            let db = store.org(&t.id).unwrap();
            transact(&db, None, |ctx| {
                api::schema::seed_new_org(ctx)?;
                execute(
                    ctx,
                    &contacts::DETAILS,
                    contacts::types::Details {
                        client_key: Some(data::generate().donors[0].client_key.clone()),
                        kind: contacts::types::Kind::Individual,
                        title: String::new(),
                        first_name: "Ada".into(),
                        last_name: slug.into(),
                        nickname: String::new(),
                        name: String::new(),
                        birth_date: None,
                        is_deceased: false,
                        deceased_date: None,
                    },
                    Exec::create(Source::Test),
                )
            })
            .unwrap();
            t
        })
        .collect()
}

const TABLES: [&str; 11] = [
    "contacts",
    "contact_notes",
    "relationships",
    "relationship_types",
    "identifier_types",
    "contact_identifiers",
    "contact_field_values",
    "contact_fields",
    "source_codes",
    "command_groups",
    "revisions",
];

fn counts(store: &Store, t: &Tenant) -> BTreeMap<&'static str, i64> {
    store
        .org(&t.id)
        .unwrap()
        .read(|r| {
            TABLES
                .iter()
                .map(|table| {
                    let n = r.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
                    Ok((*table, n))
                })
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap()
}

fn platform_counts(store: &Store) -> (i64, i64, i64) {
    store
        .platform()
        .with_read(|c: &Connection| {
            let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
            Ok::<_, rusqlite::Error>((
                n("SELECT count(*) FROM users")?,
                n("SELECT count(*) FROM tenants")?,
                n("SELECT count(*) FROM memberships")?,
            ))
        })
        .unwrap()
}

fn riverside_tenant(store: &Store) -> Tenant {
    store.platform().tenant_by_slug(SLUG).unwrap().unwrap()
}

#[test]
fn the_generator_is_the_convex_one() {
    // tests/fixtures/convex-riverside.json is the TS generator's output
    // (`generateDonors()` in convex/platform/testSeedData.ts, run once).
    let convex: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/convex-riverside.json")).unwrap();
    let rust = serde_json::to_value(data::generate()).unwrap();
    let (c, r) = (&convex["donors"], &rust["donors"]);
    for i in 0..DONOR_COUNT {
        assert_eq!(r[i], c[i], "donor {i}");
    }
    assert_eq!(rust["relationships"], convex["relationships"]);
}

#[test]
fn the_generator_is_deterministic_and_varied() {
    let world = data::generate();
    assert_eq!(data::generate(), world);
    let donors = &world.donors;
    assert_eq!(donors.len(), DONOR_COUNT);
    let keys: BTreeSet<_> = donors.iter().map(|d| &d.client_key).collect();
    assert_eq!(keys.len(), DONOR_COUNT);
    use contacts::types::Kind;
    for kind in [Kind::Individual, Kind::Organization] {
        assert!(donors.iter().filter(|d| d.details.kind == kind).count() > 5);
    }
    assert!(donors.iter().all(|d| d.details.kind != Kind::Household)); // dormant
    let emails: Vec<_> = donors
        .iter()
        .flat_map(|d| d.methods.emails.iter().map(|e| &e.address))
        .collect();
    assert!(emails.iter().collect::<BTreeSet<_>>().len() < emails.len()); // some shared
    assert!(emails.iter().any(|e| !contacts::rules::looks_like_email(e)));
    let addresses: Vec<_> = donors.iter().flat_map(|d| &d.addresses.addresses).collect();
    assert!(addresses.iter().any(|a| a.postcode.is_empty()));
    assert!(addresses.iter().any(|a| a.country != "GB"));
    assert!(addresses.iter().any(|a| a.country == "GB"
        && !a.postcode.is_empty()
        && !contacts::rules::looks_like_uk_postcode(&a.postcode)));
    assert!(donors.iter().any(|d| d.archived));
    let notes: Vec<_> = donors.iter().flat_map(|d| &d.notes).collect();
    assert!(notes.iter().any(|n| n.pinned));
    assert!(notes.iter().any(|n| n.archived));
    let ids: Vec<_> = donors.iter().flat_map(|d| &d.identifiers).collect();
    for t in IDENTIFIER_TYPES {
        assert!(ids.iter().filter(|x| x.type_name == t).count() > 5);
    }
    assert!(donors.iter().any(|d| d.identifiers.len() > 1));
    assert_eq!(
        ids.iter().map(|x| &x.value).collect::<BTreeSet<_>>().len(),
        ids.len()
    );
    let used: BTreeSet<_> = world.relationships.iter().map(|r| r.type_label).collect();
    let uk: BTreeSet<_> = contacts::relationships::UK_RELATIONSHIP_TYPES
        .iter()
        .map(|t| t.0)
        .collect();
    assert_eq!(used, uk);

    // The Rust additions: deterministic, on some people only.
    let extras = data::extras(&world);
    assert_eq!(data::extras(&world), extras);
    let volunteers = extras.iter().filter(|e| e.volunteer.is_some()).count();
    let acquired = extras.iter().filter(|e| e.acquisition.is_some()).count();
    assert!((10..60).contains(&volunteers), "{volunteers}");
    assert!((20..80).contains(&acquired), "{acquired}");
    assert!(
        extras
            .iter()
            .zip(donors)
            .all(|(e, d)| e.volunteer.is_none() || d.details.kind == Kind::Individual)
    );
}

#[test]
fn one_user_per_role_each_a_member_at_that_role_with_a_hashed_password_and_totp() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let creds = passwords("staff-password-123");
    let world = seed(&store, &creds);
    assert_eq!(world.tenant.slug, SLUG);
    assert!(world.created);
    type Row = (String, String, String, Option<String>, Option<String>, i64);
    let rows: Vec<Row> = store
        .platform()
        .with_read(|c: &Connection| {
            c.prepare(
                "SELECT u.email, m.role, a.password_hash, a.second_factor, a.totp_secret, u.id
                 FROM memberships m JOIN users u ON u.id = m.user_id
                 JOIN auth_credentials a ON a.user_id = u.id
                 WHERE m.tenant_id = ?1 ORDER BY u.email",
            )?
            .query_map([world.tenant.id.as_str()], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    let mut expected: Vec<(String, String)> = USERS
        .iter()
        .map(|(role, email)| ((*email).into(), role.as_str().into()))
        .collect();
    expected.sort();
    assert_eq!(
        rows.iter()
            .map(|r| (r.0.clone(), r.1.clone()))
            .collect::<Vec<_>>(),
        expected
    );
    for (email, _, hash, factor, sealed, id) in &rows {
        let c = creds.iter().find(|c| c.email == email).unwrap();
        // Stored as a hash, never the password itself.
        assert_ne!(hash, &c.password);
        assert!(auth::password::verify(&c.password, hash));
        assert_eq!(factor.as_deref(), Some("totp"));
        // Sealed with the keys (S1), and opens to the seeded secret.
        let sealed = sealed.as_deref().unwrap();
        assert!(!sealed.contains(&c.totp_secret));
        let opened = Keys::dev().open(&auth::keys::totp_aad(*id), sealed);
        assert_eq!(opened.as_deref(), Some(c.totp_secret.as_str()));
    }
}

#[test]
fn a_hundred_donors_land_in_riverside_only_through_contracts() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let others = others(&store);
    let before: Vec<_> = others.iter().map(|t| counts(&store, t)).collect();
    let world = seed(&store, &passwords("staff-password-123"));
    assert_eq!(world.donors_created, DONOR_COUNT);
    let after: Vec<_> = others.iter().map(|t| counts(&store, t)).collect();
    assert_eq!(after, before);

    let admin = store.platform().upsert_user(USERS[0].1).unwrap();
    // The seeded admin is a member of riverside and of nothing else.
    let theirs = store.platform().memberships(admin).unwrap();
    assert_eq!(
        theirs
            .iter()
            .map(|m| m.tenant.slug.as_str())
            .collect::<Vec<_>>(),
        [SLUG]
    );

    let world_spec = data::generate();
    let db = store.org(&riverside_tenant(&store).id).unwrap();
    db.read(|r| {
        let n = |sql: &str| r.query_row(sql, [], |row| row.get::<_, i64>(0));
        assert_eq!(n("SELECT count(*) FROM contacts")?, DONOR_COUNT as i64);
        let archived: BTreeSet<_> = world_spec.donors.iter().filter(|d| d.archived).map(|d| &d.client_key).collect();
        assert_eq!(n("SELECT count(*) FROM contacts WHERE archived")?, archived.len() as i64);
        let notes = world_spec.donors.iter().map(|d| d.notes.len()).sum::<usize>() as i64;
        assert_eq!(n("SELECT count(*) FROM contact_notes")?, notes);
        assert_eq!(
            n(&format!("SELECT count(*) FROM contact_notes WHERE created_by IS NOT {}", admin.0))?,
            0
        );
        assert_eq!(
            n("SELECT count(*) FROM contact_notes WHERE pinned")?,
            world_spec.donors.iter().flat_map(|d| &d.notes).filter(|x| x.pinned).count() as i64
        );
        assert_eq!(n("SELECT count(*) FROM relationships")?, world_spec.relationships.len() as i64);
        // Every contact made by contacts.details, with its methods and
        // addresses slices.
        assert_eq!(
            n("SELECT count(*) FROM contacts c WHERE (
                 SELECT count(DISTINCT contract) FROM revisions
                 WHERE entity_id = c.id AND contract IN
                   ('contacts.details', 'contacts.methods', 'contacts.addresses')) <> 3")?,
            0
        );
        assert_eq!(n("SELECT count(*) FROM revisions WHERE source <> 'seed'")?, 0);
        assert_eq!(n(&format!("SELECT count(*) FROM revisions WHERE actor IS NOT {}", admin.0))?, 0);

        // Identifier rows under the two types.
        let mut rows: Vec<(String, String, String)> = r
            .prepare(
                "SELECT c.client_key, t.name, i.value FROM contact_identifiers i
                 JOIN contacts c ON c.id = i.contact_id JOIN identifier_types t ON t.id = i.type_id",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        rows.sort();
        let mut seeded: Vec<(String, String, String)> = world_spec
            .donors
            .iter()
            .flat_map(|d| {
                d.identifiers
                    .iter()
                    .map(|x| (d.client_key.clone(), x.type_name.into(), x.value.clone()))
            })
            .collect();
        seeded.sort();
        assert_eq!(rows, seeded);

        // Findable by the list search.
        let (key, _, value) = &seeded[0];
        let hits = search(
            r,
            &SearchQuery {
                q: value.clone(),
                include_archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let id = contacts::queries::by_client_key(r, key)?.unwrap();
        assert_eq!(hits.rows.iter().map(|x| &x.id).collect::<Vec<_>>(), [&id]);

        // The additions: field values on individuals, acquisition codes.
        let extras = data::extras(&world_spec);
        assert_eq!(
            n("SELECT count(*) FROM contact_field_values")?,
            extras.iter().filter(|e| e.volunteer.is_some()).count() as i64
        );
        assert_eq!(
            n("SELECT count(*) FROM contacts WHERE acquisition_code_id IS NOT NULL")?,
            extras.iter().filter(|e| e.acquisition.is_some()).count() as i64
        );
        Ok::<_, rusqlite::Error>(())
    })
    .unwrap();

    // The warnings the mix is there to show.
    db.read(|r| {
        let ids: Vec<String> = r
            .prepare("SELECT id FROM contacts")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let messages: Vec<String> = ids
            .iter()
            .flat_map(|id| contacts::queries::get(r, id).unwrap().unwrap().warnings)
            .map(|w| w.message)
            .collect();
        for needle in ["email", "postcode", "also used by"] {
            assert!(
                messages.iter().any(|m| m.to_lowercase().contains(needle)),
                "no warning mentioning {needle:?} in {messages:?}"
            );
        }
        Ok::<_, rusqlite::Error>(())
    })
    .unwrap();
}

#[test]
fn a_rerun_creates_nothing_and_leaves_the_data_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let creds = passwords("staff-password-123");
    let first = seed(&store, &creds);
    let t = riverside_tenant(&store);
    let (data_before, platform_before) = (counts(&store, &t), platform_counts(&store));
    let again = seed(&open(tmp.path()), &creds);
    assert!(!again.created);
    assert_eq!(again.tenant.id, first.tenant.id);
    assert_eq!(again.donors_created, 0);
    assert_eq!(counts(&store, &t), data_before);
    assert_eq!(platform_counts(&store), platform_before);
}

#[test]
fn demo_source_codes_land_under_the_seeded_categories_in_riverside_only() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let others = others(&store);
    seed(&store, &passwords("staff-password-123"));
    let tree = |t: &Tenant| {
        store
            .org(&t.id)
            .unwrap()
            .read(|r| sources::tree(r))
            .unwrap()
    };
    let level = |p: &sources::types::Part| serde_json::to_value(p.level).unwrap();
    let parts = tree(&riverside_tenant(&store));
    let codes: BTreeSet<_> = parts
        .iter()
        .filter(|p| level(p) == "version")
        .map(|p| p.code.as_str())
        .collect();
    for c in [
        "Street-Wesser-001",
        "Street-Wesser-002",
        "Direct mail-Xmas25-Warm",
        "Direct mail-Xmas25-Lapsed",
        "Event-Gala26-001",
    ] {
        assert!(codes.contains(c), "{c} in {codes:?}");
    }
    assert_eq!(
        parts.iter().filter(|p| level(p) == "detail").count(),
        SOURCE_DETAILS.len()
    );
    let bath = parts
        .iter()
        .find(|p| p.code == "Event-BathHalf25-001")
        .unwrap();
    assert!(bath.is_active && !bath.visible);
    let spring = parts
        .iter()
        .find(|p| p.code == "Street-Wesser-001")
        .unwrap();
    assert_eq!(spring.description.as_deref(), Some("Spring run"));
    assert_eq!(spring.end_date.as_deref(), Some("2026-05-31"));
    for t in &others {
        assert!(tree(t).iter().all(|p| level(p) == "category"));
    }
}

#[test]
fn a_changed_password_replaces_the_stored_one_the_same_one_keeps_it() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let secrets = || {
        store
            .platform()
            .with_read(|c: &Connection| {
                c.prepare(
                    "SELECT a.password_hash FROM auth_credentials a JOIN users u ON u.id = a.user_id
                     ORDER BY u.email",
                )?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
    };
    seed(&store, &passwords("staff-password-123"));
    let first = secrets();
    seed(&store, &passwords("staff-password-123"));
    assert_eq!(secrets(), first);
    seed(&store, &passwords("a-new-staff-password"));
    let after = secrets();
    // admin@, staff@, viewer@ in email order.
    assert_eq!(after[0], first[0]);
    assert_ne!(after[1], first[1]);
    assert_eq!(after[2], first[2]);
}

#[test]
fn missing_credentials_are_refused_before_anything_is_written() {
    let env =
        |name: &str| (name == "KEEP_RIVERSIDE_ADMIN_PASSWORD").then(|| "admin-password-123".into());
    match riverside::credentials_from_env(env, false) {
        Err(SeedError::MissingCredentials(missing)) => assert_eq!(
            missing,
            [
                "KEEP_RIVERSIDE_ADMIN_TOTP",
                "KEEP_RIVERSIDE_STAFF_PASSWORD",
                "KEEP_RIVERSIDE_STAFF_TOTP",
                "KEEP_RIVERSIDE_VIEWER_PASSWORD",
                "KEEP_RIVERSIDE_VIEWER_TOTP",
            ]
        ),
        other => panic!("{other:?}"),
    }
    // Locally, the missing ones are generated (and marked so).
    let made = riverside::credentials_from_env(env, true).unwrap();
    assert_eq!(
        (
            made[0].password.as_str(),
            made[0].password_origin,
            made[0].totp_origin
        ),
        ("admin-password-123", Origin::Env, Origin::Generated)
    );
    assert!(
        made[1..]
            .iter()
            .all(|c| c.password_origin == Origin::Generated)
    );
    // A bad one is refused, naming the var.
    let short = |n: &str| (n == "KEEP_RIVERSIDE_STAFF_PASSWORD").then(|| "short".into());
    let err = riverside::credentials_from_env(short, true).unwrap_err();
    assert!(
        err.to_string().contains("KEEP_RIVERSIDE_STAFF_PASSWORD"),
        "{err}"
    );
    let bad_totp = |n: &str| (n == "KEEP_RIVERSIDE_VIEWER_TOTP").then(|| "not base32!".into());
    let err = riverside::credentials_from_env(bad_totp, true).unwrap_err();
    assert!(
        err.to_string().contains("KEEP_RIVERSIDE_VIEWER_TOTP"),
        "{err}"
    );

    // `seed` itself refuses a set without every role, writing nothing.
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let before = platform_counts(&store);
    let mut creds = passwords("staff-password-123");
    creds.retain(|c| c.role == Role::Admin);
    assert!(matches!(
        riverside::seed(&store, &Keys::dev(), &mut creds, api::schema::seed_new_org),
        Err(SeedError::MissingCredentials(_))
    ));
    assert_eq!(platform_counts(&store), before);
}

#[test]
fn refused_unless_keep_env_is_dev_or_staging() {
    assert!(riverside::allowed(Some("dev")).is_ok());
    assert!(riverside::allowed(Some("staging")).is_ok());
    for env in [None, Some("prod"), Some(""), Some("production")] {
        let err = riverside::allowed(env).unwrap_err();
        assert!(err.to_string().contains("KEEP_ENV"), "{err}");
    }
}

#[test]
fn an_archived_external_reference_stays_archived_and_its_rows_are_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    // An older riverside: the org exists and an admin archived the type
    // before the donors were seeded.
    let t = store.create_tenant(SLUG, riverside::NAME).unwrap();
    let db = store.org(&t.id).unwrap();
    transact(&db, None, |ctx| {
        let made = execute(
            ctx,
            &contacts::identifiers::IDENTIFIER_TYPE,
            contacts::identifiers::IdentifierTypePayload {
                name: "External reference".into(),
                is_active: true,
            },
            Exec::create(Source::Test),
        )?;
        execute(
            ctx,
            &contacts::identifiers::IDENTIFIER_TYPE,
            contacts::identifiers::IdentifierTypePayload {
                name: "External reference".into(),
                is_active: false,
            },
            Exec::update(&made.id, Some(made.counter), Source::Test),
        )
    })
    .unwrap();
    let world = seed(&store, &passwords("staff-password-123"));
    assert_eq!(world.donors_created, DONOR_COUNT);
    db.read(|r| {
        let types: BTreeSet<(String, bool)> = r
            .prepare("SELECT name, is_active FROM identifier_types")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        assert_eq!(
            types,
            BTreeSet::from([
                ("External reference".into(), false),
                ("Membership number".into(), true)
            ])
        );
        let rows: Vec<String> = r
            .prepare(
                "SELECT t.name FROM contact_identifiers i JOIN identifier_types t ON t.id = i.type_id",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let expected = data::generate()
            .donors
            .iter()
            .flat_map(|d| &d.identifiers)
            .filter(|x| x.type_name == "Membership number")
            .count();
        assert_eq!(rows.len(), expected);
        assert!(rows.iter().all(|n| n == "Membership number"));
        Ok::<_, rusqlite::Error>(())
    })
    .unwrap();
}

#[test]
fn the_giving_generator_is_deterministic_and_varied() {
    let world = data::generate();
    let giving = data::giving(&world);
    assert_eq!(data::giving(&world), giving);
    assert_eq!(giving.len(), DONOR_COUNT);
    let gifts: Vec<_> = giving.iter().flat_map(|g| &g.gifts).collect();
    let givers = giving.iter().filter(|g| !g.gifts.is_empty()).count();
    assert!((40..80).contains(&givers), "{givers}");
    assert!(gifts.iter().any(|g| g.card_reference.is_some()));
    assert!(gifts.iter().any(|g| g.card_reference.is_none()));
    assert!(gifts.iter().any(|g| g.void));
    assert!(
        gifts
            .iter()
            .all(|g| g.amount > 0 && g.received_on.as_str() < "2026-10")
    );
    let declarations: Vec<_> = giving.iter().flat_map(|g| &g.declarations).collect();
    assert!(declarations.len() > 5, "{}", declarations.len());
    assert_eq!(declarations.iter().filter(|d| d.voided).count(), 1);
    assert!(declarations.iter().any(|d| d.cancelled_from.is_some()));
    // Only living individuals with an address declare.
    for (g, d) in giving.iter().zip(&world.donors) {
        if !g.declarations.is_empty() {
            assert_eq!(d.details.kind, contacts::types::Kind::Individual);
            assert!(!d.details.is_deceased && !d.addresses.addresses.is_empty());
        }
    }
}

#[test]
fn gifts_and_declarations_land_through_the_contracts() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    seed(&store, &passwords("staff-password-123"));
    let world = data::generate();
    let giving = data::giving(&world);
    let gifts: Vec<_> = giving.iter().flat_map(|g| &g.gifts).collect();
    let declarations: Vec<_> = giving.iter().flat_map(|g| &g.declarations).collect();
    let db = store.org(&riverside_tenant(&store).id).unwrap();
    db.read(|r| {
        let n = |sql: &str| r.query_row(sql, [], |row| row.get::<_, i64>(0));
        assert_eq!(n("SELECT count(*) FROM gifts")?, gifts.len() as i64);
        assert_eq!(
            n("SELECT count(*) FROM gifts WHERE status = 'void'")?,
            gifts.iter().filter(|g| g.void).count() as i64
        );
        assert_eq!(
            n("SELECT count(*) FROM gifts WHERE method = 'card'")?,
            gifts.iter().filter(|g| g.card_reference.is_some()).count() as i64
        );
        assert_eq!(
            n("SELECT sum(amount) FROM gifts")?,
            gifts.iter().map(|g| g.amount).sum::<i64>()
        );
        // Every gift wholly allocated to a source code version.
        assert_eq!(
            n("SELECT count(*) FROM gifts g WHERE g.amount <>
                 (SELECT sum(a.amount) FROM gift_allocations a WHERE a.gift_id = g.id)")?,
            0
        );
        assert_eq!(
            n("SELECT count(*) FROM gift_aid_declarations")?,
            declarations.len() as i64
        );
        assert_eq!(
            n("SELECT count(*) FROM gift_aid_declarations WHERE voided_at IS NOT NULL")?,
            1
        );
        assert_eq!(
            n("SELECT count(*) FROM gift_aid_declarations WHERE cancelled_from IS NOT NULL")?,
            declarations
                .iter()
                .filter(|d| d.cancelled_from.is_some())
                .count() as i64
        );
        assert_eq!(
            n("SELECT count(*) FROM revisions WHERE source <> 'seed'")?,
            0
        );
        Ok::<_, rusqlite::Error>(())
    })
    .unwrap();
}

/// Review L2: on dev, generated credentials never replace stored ones, so
/// an authenticator enrolled from the first run keeps working; one from
/// the env still applies.
#[test]
fn generated_credentials_are_kept_on_a_rerun_env_ones_still_apply() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let keys = Keys::dev();
    let run = |env: &dyn Fn(&str) -> Option<String>| {
        let mut creds = riverside::credentials_from_env(env, true).unwrap();
        riverside::seed(&store, &keys, &mut creds, api::schema::seed_new_org).unwrap();
        creds
    };
    let stored = || {
        store
            .platform()
            .with_read(|c: &Connection| {
                c.prepare(
                    "SELECT a.password_hash, a.totp_secret FROM auth_credentials a
                     JOIN users u ON u.id = a.user_id ORDER BY u.email",
                )?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
    };
    let first = run(&|_| None);
    assert!(
        first
            .iter()
            .all(|c| c.password_origin == Origin::Generated && c.totp_origin == Origin::Generated)
    );
    let before = stored();
    let second = run(&|_| None);
    assert!(second.iter().all(|c| c.password_origin == Origin::Kept
        && c.totp_origin == Origin::Kept
        && c.password.is_empty()
        && c.totp_secret.is_empty()));
    assert_eq!(stored(), before);
    // The first run's sign-in still works.
    let admin = first.iter().find(|c| c.role == Role::Admin).unwrap();
    assert!(auth::password::verify(&admin.password, &before[0].0));
    // A password from the env replaces the stored one.
    let third = run(&|n: &str| {
        (n == "KEEP_RIVERSIDE_ADMIN_PASSWORD").then(|| "a-new-admin-password".into())
    });
    assert_eq!(third[0].password_origin, Origin::Env);
    let after = stored();
    assert!(auth::password::verify("a-new-admin-password", &after[0].0));
    assert_eq!(after[0].1, before[0].1, "the TOTP secret stays");
    assert_eq!(after[1..], before[1..]);
}

/// `KEEP_AUTH_POLICY=relaxed` on dev (the preview): every role signs in
/// with [`riverside::RELAXED_PASSWORD`] and no TOTP secret is made or
/// set; one from env still applies, and staging still needs all six.
#[test]
fn relaxed_seeds_the_simple_password_and_no_totp() {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let relaxed = auth::Policy::Relaxed;
    let mut creds = riverside::credentials_from_env_with(|_| None, true, relaxed).unwrap();
    assert!(
        creds
            .iter()
            .all(|c| c.password == riverside::RELAXED_PASSWORD
                && c.password_origin == Origin::Generated
                && c.totp_origin == Origin::None
                && c.totp_secret.is_empty())
    );
    riverside::seed(&store, &Keys::dev(), &mut creds, api::schema::seed_new_org).unwrap();
    let rows: Vec<(String, Option<String>, Option<String>)> = store
        .platform()
        .with_read(|c: &Connection| {
            c.prepare(
                "SELECT a.password_hash, a.second_factor, a.totp_secret FROM auth_credentials a
                 JOIN users u ON u.id = a.user_id ORDER BY u.email",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(rows.len(), USERS.len());
    for (hash, factor, secret) in rows {
        assert!(auth::password::verify(riverside::RELAXED_PASSWORD, &hash));
        assert_eq!((factor, secret), (None, None));
    }
    // A TOTP secret and a short password from env are taken under relaxed.
    let env = |n: &str| match n {
        "KEEP_RIVERSIDE_ADMIN_PASSWORD" => Some("pw".into()),
        "KEEP_RIVERSIDE_ADMIN_TOTP" => Some("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP".into()),
        _ => None,
    };
    let made = riverside::credentials_from_env_with(env, true, relaxed).unwrap();
    assert_eq!(
        (made[0].password.as_str(), made[0].totp_origin),
        ("pw", Origin::Env)
    );
    // Strict refuses the short one; staging (no generating) needs all six.
    assert!(matches!(
        riverside::credentials_from_env_with(env, true, auth::Policy::Strict),
        Err(SeedError::BadCredential(_))
    ));
    assert!(matches!(
        riverside::credentials_from_env_with(|_| None, false, relaxed),
        Err(SeedError::MissingCredentials(_))
    ));
}
