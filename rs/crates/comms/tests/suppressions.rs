//! Email suppression (Convex `comms/suppressions.test.ts`): the system
//! suppresses, a hold belongs to the address, an admin releases, and two
//! organisations kept apart.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use comms::{Reason, Release, held, is_suppressed, release, suppress_address};
use contacts::METHODS;
use contacts::form::{create, restore_contact};
use contacts::queries::{email_addresses, get};
use contacts::types::*;
use contracts::{ContractError, Ctx, Exec, Source, execute};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

const BOUNCED: &str = "lovelace@example.com";

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(StoreConfig {
        dir: tmp.path().to_path_buf(),
        org_migrations: Migrations::new(vec![
            M::up(contracts::MIGRATION),
            M::up(contacts::MIGRATION),
            M::up(contacts::DROP_TRIGRAM),
            M::up(contacts::MIGRATION_IDENTIFIERS_NOTES),
            // A2: `get` reads the contact's acquisition code.
            M::up(sources::MIGRATION),
            M::up(contacts::acquisition::MIGRATION),
            M::up(comms::MIGRATION),
        ]),
        readers: 2,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap();
    let a = store.create_tenant("alpha", "Alpha").unwrap();
    let b = store.create_tenant("beta", "Beta").unwrap();
    World {
        a: store.org(&a.id).unwrap(),
        b: store.org(&b.id).unwrap(),
        _tmp: tmp,
    }
}

/// As a user (a request); `system` runs with no actor, as a webhook does.
fn w<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    contracts::transact(db, Some(1), f)
}

fn system<T>(
    db: &OrgDb,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    contracts::transact(db, None, f)
}

fn suppress(db: &OrgDb, address: &str) -> (bool, i64) {
    system(db, |ctx| {
        suppress_address(ctx, address, Some("ses-1".into()), None)
    })
    .unwrap()
}

fn contact(db: &OrgDb, first: &str) -> String {
    w(db, |ctx| {
        create(
            ctx,
            CreateContact {
                id: None,
                details: Details {
                    client_key: None,
                    kind: Kind::Individual,
                    title: String::new(),
                    first_name: first.into(),
                    last_name: "Lovelace".into(),
                    nickname: String::new(),
                    name: String::new(),
                    birth_date: None,
                    is_deceased: false,
                    deceased_date: None,
                },
            },
            Source::Test,
        )
    })
    .unwrap()
    .id
}

fn row(key: &str, address: &str) -> EmailRow {
    EmailRow {
        key: Some(format!("{key:0>32}")),
        label: ChannelLabel::Home,
        address: address.into(),
        is_primary: false,
    }
}

fn save_methods(db: &OrgDb, id: &str, expected: i64, emails: Vec<EmailRow>) {
    w(db, |ctx| {
        execute(
            ctx,
            &METHODS,
            Methods {
                emails,
                phones: vec![],
            },
            Exec::update(id, Some(expected), Source::Test),
        )
    })
    .unwrap();
}

/// Each of the contact's email rows (by key's last two characters): held?
fn held_of(db: &OrgDb, id: &str) -> BTreeMap<String, bool> {
    db.read(|c| {
        let v = get(c, id)?.unwrap();
        let h = held(c, &email_addresses(c, id)?)?;
        Ok::<_, ContractError>(
            v.methods
                .emails
                .iter()
                .map(|e| {
                    let key = e.key.clone().unwrap();
                    (
                        key[key.len() - 2..].to_owned(),
                        h.contains_key(&e.address.to_lowercase()),
                    )
                })
                .collect(),
        )
    })
    .unwrap()
}

fn suppression_rows(db: &OrgDb) -> Vec<(String, bool, String, i64)> {
    db.read(|c| {
        c.prepare("SELECT address_normalized, suppressed, reason, since FROM email_suppressions")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap()
}

fn suppression_revisions(db: &OrgDb) -> Vec<(String, Option<i64>, String)> {
    db.read(|c| {
        c.prepare(
            "SELECT contract, actor, source FROM revisions
             WHERE entity = 'email_suppressions' ORDER BY id",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap()
}

/// Ada with two emails, e1 (fine) and e2 (to be bounced).
fn ada(db: &OrgDb) -> String {
    let id = contact(db, "Ada");
    save_methods(
        db,
        &id,
        0,
        vec![
            row("e1", "ada@example.com"),
            row("e2", "Lovelace@Example.com"),
        ],
    );
    id
}

// ── suppress ───────────────────────────────────────────────────────────────

#[test]
fn suppresses_the_address_in_its_organisation_with_a_comms_revision() {
    let world = world();
    let id = ada(&world.a);
    assert_eq!(suppress(&world.a, "  LOVELACE@example.com "), (true, 0));
    assert_eq!(
        held_of(&world.a, &id),
        BTreeMap::from([("e1".into(), false), ("e2".into(), true)])
    );
    assert_eq!(
        suppression_revisions(&world.a),
        [("comms.suppression".to_owned(), None, "comms".to_owned())]
    );
    assert!(world.a.read(|c| is_suppressed(c, BOUNCED)).unwrap());
    assert!(!world.b.read(|c| is_suppressed(c, BOUNCED)).unwrap());
}

#[test]
fn a_second_event_changes_nothing_and_keeps_the_first_ones_time() {
    let world = world();
    suppress(&world.a, BOUNCED);
    let before = suppression_rows(&world.a);
    std::thread::sleep(std::time::Duration::from_millis(3));
    assert_eq!(suppress(&world.a, BOUNCED), (false, 0));
    assert_eq!(suppression_rows(&world.a), before);
    assert_eq!(suppression_revisions(&world.a).len(), 1);
}

#[test]
fn the_contact_itself_is_untouched() {
    let world = world();
    let id = ada(&world.a);
    let before = world.a.read(|c| get(c, &id)).unwrap().unwrap();
    suppress(&world.a, BOUNCED);
    let after = world.a.read(|c| get(c, &id)).unwrap().unwrap();
    assert_eq!(before.counters, after.counters);
    let contact_revisions: i64 = world
        .a
        .read(|c| {
            c.query_row(
                "SELECT count(*) FROM revisions WHERE entity = 'contacts'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(contact_revisions, 2);
}

#[test]
fn only_a_bounce_is_a_storable_suppression() {
    let world = world();
    // A suppression with a release's reason isn't one (nor is anything
    // else: a complaint can't even be said, `Reason` has no such value).
    let e = system(&world.a, |ctx| {
        execute(
            ctx,
            &comms::SUPPRESSION,
            comms::suppressions::Payload {
                address_normalized: BOUNCED.into(),
                suppressed: true,
                reason: Reason::Release,
                event_ref: None,
                note: None,
            },
            Exec::create(Source::Comms),
        )
    });
    assert!(matches!(e, Err(ContractError::Invalid(_))));
    assert!(serde_json::from_str::<Reason>("\"complaint\"").is_err());
    assert!(suppression_rows(&world.a).is_empty());
}

#[test]
fn a_caller_with_a_user_is_refused_only_the_system_suppresses() {
    let world = world();
    let e = w(&world.a, |ctx| suppress_address(ctx, BOUNCED, None, None));
    assert!(matches!(e, Err(ContractError::Rejected { reason, .. }) if reason == "system_only"));
    assert!(suppression_rows(&world.a).is_empty());
}

// ── a hold belongs to the address ──────────────────────────────────────────

#[test]
fn a_hold_survives_restores_and_re_adds_of_the_address() {
    let world = world();
    let id = ada(&world.a);
    suppress(&world.a, BOUNCED);
    let with_both = world
        .a
        .read(|c| contacts::queries::history(c, &id, None, 10))
        .unwrap()
        .revisions
        .into_iter()
        .find(|r| r.contract == "contacts.methods")
        .unwrap();
    let both = BTreeMap::from([("e1".into(), false), ("e2".into(), true)]);
    // A methods revision that brings the row back.
    save_methods(&world.a, &id, 1, vec![row("e1", "ada@example.com")]);
    w(&world.a, |ctx| {
        restore_contact(
            ctx,
            &id,
            RestoreRequest::Revision {
                revision_id: with_both.id,
            },
        )
    })
    .unwrap();
    assert_eq!(held_of(&world.a, &id), both);
    // The whole contact to a moment before the row was removed: the hold is
    // the address's, so it shows again and no suppression row changes.
    std::thread::sleep(std::time::Duration::from_millis(3));
    let before_removal = contracts::now_ms();
    std::thread::sleep(std::time::Duration::from_millis(3));
    save_methods(&world.a, &id, 3, vec![row("e1", "ada@example.com")]);
    let rows = suppression_rows(&world.a);
    let done = w(&world.a, |ctx| {
        restore_contact(ctx, &id, RestoreRequest::At { at: before_removal })
    })
    .unwrap();
    assert_eq!(done.restored, ["contacts.methods"]);
    assert_eq!(held_of(&world.a, &id), both);
    assert_eq!(suppression_rows(&world.a), rows);
    // Removing the row and adding the same key back.
    save_methods(&world.a, &id, 5, vec![row("e1", "ada@example.com")]);
    save_methods(
        &world.a,
        &id,
        6,
        vec![
            row("e1", "ada@example.com"),
            row("e2", "lovelace@example.com"),
        ],
    );
    assert_eq!(held_of(&world.a, &id), both);
    // The same address under a new key.
    save_methods(
        &world.a,
        &id,
        7,
        vec![
            row("e1", "ada@example.com"),
            row("e9", "LOVELACE@example.com"),
        ],
    );
    assert_eq!(
        held_of(&world.a, &id),
        BTreeMap::from([("e1".into(), false), ("e9".into(), true)])
    );
    assert_eq!(suppression_rows(&world.a).len(), 1);
}

#[test]
fn another_contact_using_the_address_is_held_in_this_organisation_only() {
    let world = world();
    ada(&world.a);
    suppress(&world.a, BOUNCED);
    let carol = contact(&world.a, "Carol");
    save_methods(&world.a, &carol, 0, vec![row("c1", BOUNCED)]);
    assert_eq!(
        held_of(&world.a, &carol),
        BTreeMap::from([("c1".into(), true)])
    );
    let bob = contact(&world.b, "Bob");
    save_methods(&world.b, &bob, 0, vec![row("b1", BOUNCED)]);
    assert_eq!(
        held_of(&world.b, &bob),
        BTreeMap::from([("b1".into(), false)])
    );
}

// ── release ────────────────────────────────────────────────────────────────

fn rel(db: &OrgDb, expected: i64, address: &str) -> Result<i64, ContractError> {
    w(db, |ctx| {
        Ok(release(
            ctx,
            Release {
                address: address.into(),
                expected,
                note: " Confirmed by phone ".into(),
            },
        )?
        .counter)
    })
}

#[test]
fn a_release_lifts_it_logged_with_who_and_why_and_a_later_bounce_holds_it_again() {
    let world = world();
    let id = ada(&world.a);
    suppress(&world.a, BOUNCED);
    assert_eq!(rel(&world.a, 0, "Lovelace@Example.com").unwrap(), 1);
    assert!(!held_of(&world.a, &id)["e2"]);
    let (_, suppressed, reason, _) = suppression_rows(&world.a).remove(0);
    assert_eq!((suppressed, reason.as_str()), (false, "release"));
    let note: Option<String> = world
        .a
        .read(|c| c.query_row("SELECT note FROM email_suppressions", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(note.as_deref(), Some("Confirmed by phone"));
    assert_eq!(
        suppression_revisions(&world.a)[1],
        ("comms.suppression".into(), Some(1), "ui".into())
    );
    // A later bounce holds it again, on the same row.
    assert_eq!(suppress(&world.a, BOUNCED), (true, 2));
    assert!(held_of(&world.a, &id)["e2"]);
    assert_eq!(suppression_rows(&world.a).len(), 1);
}

#[test]
fn stale_not_held_and_another_organisations_address_are_refused() {
    let world = world();
    suppress(&world.a, BOUNCED);
    assert!(matches!(
        rel(&world.a, 7, BOUNCED),
        Err(ContractError::Stale { counter: 0, .. })
    ));
    let not_held = |e: Result<i64, ContractError>| matches!(e, Err(ContractError::Rejected { reason, .. }) if reason == "not_held");
    assert!(not_held(rel(&world.a, 0, "ada@example.com")));
    assert!(not_held(rel(&world.b, 0, BOUNCED)));
    rel(&world.a, 0, BOUNCED).unwrap();
    assert!(not_held(rel(&world.a, 1, BOUNCED)));
}

// ── who may write ──────────────────────────────────────────────────────────

fn rust_sources(dir: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n != "target") {
                rust_sources(&path, out);
            }
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push((
                path.display().to_string(),
                std::fs::read_to_string(&path).unwrap(),
            ));
        }
    }
}

/// Outside comms (and tests), only the QC seed's hold, which runs only
/// with `KEEP_QC_SEED` and dev auth, calls the system writer or runs the
/// suppression contract.
#[test]
fn only_comms_writes_a_suppression() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap();
    let mut files = Vec::new();
    rust_sources(&crates, &mut files);
    let callers: Vec<_> = files
        .iter()
        .filter(|(path, text)| {
            !path.contains("/crates/comms/")
                && !path.contains("/tests/")
                && (text.contains("suppress_address(") || text.contains("SUPPRESSION,"))
        })
        .map(|(path, _)| path.rsplit("crates/").next().unwrap().to_owned())
        .collect();
    assert_eq!(callers, ["api/src/routes/qc_seed.rs"]);
}
