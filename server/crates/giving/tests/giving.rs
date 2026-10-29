//! Gifts on real org files with two organisations: the Rust port of
//! `convex/giving/giving.test.ts`. Each test names the Convex case it
//! ports. Who may write (viewers refused) is the tenant middleware's, so
//! those cases live in `api/tests/gifts_routes.rs`; organisation B is a
//! separate file, so "B untouched" is checked by reading B's gift tables.

use std::sync::Arc;

use contacts::acquisition::{NewContact, create_contact};
use contacts::types::{CreateContact, Details, Kind};
use contracts::{
    ContractError, Ctx, Exec, Executed, Source, canonical, execute, restore, restore_entity_to,
};
use giving::types::{AllocationRow, GiftPayload, Method, Status, StatusPayload};
use giving::{GIFT, RECENT_LIMIT, REGISTRY, STATUS};
use rusqlite::Connection;
use serde_json::{Value, json};
use sources::{CODE, SourceCodePayload};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

const ANN: i64 = 1;
const SAM: i64 = 2;

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
    jo: String,
    street: Code,
    online: Code,
}

#[derive(Clone)]
struct Code {
    category: String,
    detail: String,
    version: String,
}

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(contracts::MIGRATION),
        M::up(contacts::MIGRATION),
        M::up(contacts::DROP_TRIGRAM),
        M::up(contacts::MIGRATION_IDENTIFIERS_NOTES),
        M::up(sources::MIGRATION),
        M::up(contacts::acquisition::MIGRATION),
        M::up(giving::MIGRATION),
        M::up(giving::MIGRATION_CLAIM_LOCK),
        // On an empty file: no rows for the rebuild to carry.
        M::up(giving::MIGRATION_DIRECT_DEBIT),
        M::up(giving::MIGRATION_UNIFIED),
    ])
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(StoreConfig {
        dir: tmp.path().to_path_buf(),
        org_migrations: migrations(),
        readers: 2,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap();
    let a = store
        .org(&store.create_tenant("alpha", "Alpha").unwrap().id)
        .unwrap();
    let b = store
        .org(&store.create_tenant("beta", "Beta").unwrap().id)
        .unwrap();
    for db in [&a, &b] {
        tx(db, sources::seed_new_org).unwrap();
    }
    let jo = contact(&a, "Jo");
    let street = code(&a, "Street", "Wesser");
    let online = code(&a, "Online", "Spring");
    World {
        _tmp: tmp,
        a,
        b,
        jo,
        street,
        online,
    }
}

fn tx<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    contracts::transact(db, Some(ANN), f)
}

/// A transaction as `actor`, at `at` ms (for "restore to a moment").
fn tx_as<T>(
    db: &OrgDb,
    actor: i64,
    at: Option<i64>,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    contracts::transact(db, Some(actor), |ctx| match at {
        Some(at) => f(&Ctx {
            tx: ctx.tx,
            actor: ctx.actor,
            at,
        }),
        None => f(ctx),
    })
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> Result<T, ContractError>) -> T {
    db.read(|c| f(c)).unwrap()
}

fn contact(db: &OrgDb, first: &str) -> String {
    tx(db, |ctx| {
        create_contact(
            ctx,
            NewContact {
                create: CreateContact {
                    id: None,
                    details: Details {
                        client_key: None,
                        kind: Kind::Individual,
                        title: String::new(),
                        first_name: first.into(),
                        last_name: "Bloggs".into(),
                        nickname: String::new(),
                        name: String::new(),
                        birth_date: None,
                        is_deceased: false,
                        deceased_date: None,
                    },
                },
                acquisition_code_id: None,
            },
            Source::Ui,
        )
    })
    .unwrap()
    .id
}

fn part(db: &OrgDb, id: &str) -> sources::types::Part {
    read(db, |c| Ok(sources::tree(c)?))
        .into_iter()
        .find(|p| p.id == id)
        .unwrap()
}

/// A seeded category, a detail under it and its version `001`.
fn code(db: &OrgDb, category: &str, detail: &str) -> Code {
    let category = read(db, |c| Ok(sources::tree(c)?))
        .into_iter()
        .find(|p| p.parent_id.is_none() && p.name == category)
        .unwrap()
        .id;
    let made = tx(db, |ctx| {
        sources::create_part(
            ctx,
            SourceCodePayload {
                parent_id: Some(category.clone()),
                name: detail.into(),
                description: None,
                start_date: None,
                end_date: None,
                is_active: true,
            },
            Source::Ui,
            None,
        )
    })
    .unwrap();
    Code {
        category,
        detail: made.id,
        version: made.version_id.unwrap(),
    }
}

/// Save a part through its contract with some fields changed.
fn change_part(db: &OrgDb, id: &str, f: impl FnOnce(&mut SourceCodePayload)) {
    let p = part(db, id);
    let mut next = SourceCodePayload {
        parent_id: None,
        name: p.name,
        description: p.description,
        start_date: p.start_date,
        end_date: p.end_date,
        is_active: p.is_active,
    };
    f(&mut next);
    tx(db, |ctx| {
        execute(
            ctx,
            &CODE,
            next,
            Exec::update(id, Some(p.save_version), Source::Ui),
        )
    })
    .unwrap();
}

fn archive(db: &OrgDb, id: &str) {
    change_part(db, id, |p| p.is_active = false);
}

/// A projection row: (key, code, detail, category, date, amount, status, contact).
type IndexRow = (String, String, String, String, String, i64, String, String);
/// A revision: (id, contract, counter, group, group name).
type RevisionRow = (i64, String, i64, Option<i64>, Option<String>);

fn row(code: &str, amount: i64) -> AllocationRow {
    AllocationRow {
        key: None,
        source_code_id: code.into(),
        amount,
    }
}

impl World {
    fn gift(&self, amount: i64) -> GiftPayload {
        GiftPayload {
            contact_id: self.jo.clone(),
            received_on: "2026-10-20".into(),
            amount,
            method: Method::Cash,
            reference: None,
            allocations: vec![row(&self.street.version, amount)],
            client_key: None,
            origin: None,
        }
    }

    fn create(&self, p: GiftPayload) -> Result<String, ContractError> {
        tx(&self.a, |ctx| giving::create_gift(ctx, p, Source::Ui, None))
    }

    fn save(&self, id: &str, expected: i64, p: GiftPayload) -> Result<Executed, ContractError> {
        self.save_as(ANN, id, expected, p)
    }

    fn save_as(
        &self,
        who: i64,
        id: &str,
        expected: i64,
        p: GiftPayload,
    ) -> Result<Executed, ContractError> {
        tx_as(&self.a, who, None, |ctx| {
            execute(ctx, &GIFT, p, Exec::update(id, Some(expected), Source::Ui))
        })
    }

    fn set_status(
        &self,
        id: &str,
        expected: i64,
        status: Status,
    ) -> Result<Executed, ContractError> {
        tx(&self.a, |ctx| {
            giving::set_status(ctx, id, expected, status, None, Source::Ui)
        })
    }

    /// The gift row's columns that matter here.
    fn stored(&self, id: &str) -> Value {
        read(&self.a, |c| {
            Ok(c.query_row(
                "SELECT contact_id, received_on, amount, method, reference, status, entered_by,
                        client_key, gift_version, status_version
                 FROM gifts WHERE id = ?1",
                [id],
                |r| {
                    Ok(json!({
                        "contactId": r.get::<_, String>(0)?,
                        "receivedOn": r.get::<_, String>(1)?,
                        "amount": r.get::<_, i64>(2)?,
                        "method": r.get::<_, String>(3)?,
                        "reference": r.get::<_, Option<String>>(4)?,
                        "status": r.get::<_, String>(5)?,
                        "enteredBy": r.get::<_, Option<i64>>(6)?,
                        "clientKey": r.get::<_, Option<String>>(7)?,
                        "giftVersion": r.get::<_, i64>(8)?,
                        "statusVersion": r.get::<_, i64>(9)?,
                    }))
                },
            )?)
        })
    }

    fn keys(&self, id: &str) -> Vec<String> {
        read(&self.a, |c| Ok(giving::get(c, id)?.unwrap()))
            .gift
            .allocations
            .into_iter()
            .map(|a| a.key)
            .collect()
    }

    /// The projection's rows: (key, code, detail, category, date, amount, status).
    fn index(&self, id: &str) -> Vec<IndexRow> {
        read(&self.a, |c| {
            Ok(c.prepare(
                "SELECT allocation_id, source_code_id, detail_id, category_id, received_on, amount,
                        status, contact_id
                 FROM gift_allocation_index WHERE gift_id = ?1 ORDER BY allocation_id",
            )?
            .query_map([id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?)
        })
    }

    /// (id, contract, counter, group, group name), oldest first.
    fn revisions(&self, id: &str) -> Vec<RevisionRow> {
        read(&self.a, |c| {
            Ok(c.prepare(
                "SELECT id, contract, counter, group_id, group_name FROM revisions
                 WHERE entity = 'gifts' AND entity_id = ?1 ORDER BY id",
            )?
            .query_map([id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<_>>()?)
        })
    }

    fn revision(&self, id: &str, contract: &str, counter: i64) -> i64 {
        self.revisions(id)
            .into_iter()
            .find(|r| r.1 == contract && r.2 == counter)
            .unwrap()
            .0
    }

    fn used(&self, id: &str) -> bool {
        part(&self.a, id).used
    }

    /// B's gift tables are as they were: nothing of A's reached it.
    fn b_untouched(&self) {
        let n: i64 = read(&self.b, |c| {
            Ok(c.query_row(
                "SELECT (SELECT count(*) FROM gifts) + (SELECT count(*) FROM gift_allocations)
                      + (SELECT count(*) FROM gift_allocation_index)
                      + (SELECT count(*) FROM revisions WHERE entity = 'gifts')",
                [],
                |r| r.get(0),
            )?)
        });
        assert_eq!(n, 0);
    }
}

fn reason(err: ContractError) -> String {
    match err {
        ContractError::Rejected { reason, .. } => reason,
        other => format!("{other:?}"),
    }
}

fn problem_fields(err: ContractError) -> Vec<String> {
    match err {
        ContractError::Invalid(p) => p.into_iter().map(|p| p.field).collect(),
        other => panic!("expected invalid, got {other:?}"),
    }
}

// ── creating a gift ────────────────────────────────────────────────────────

/// "a client key already on a gift is refused as duplicate (giving.gift)"
#[test]
fn a_client_key_already_on_a_gift_is_refused_as_duplicate() {
    let w = world();
    let id = w
        .create(GiftPayload {
            client_key: Some("k1".into()),
            ..w.gift(2000)
        })
        .unwrap();
    assert_eq!(w.stored(&id)["clientKey"], "k1");
    let err = w
        .create(GiftPayload {
            client_key: Some("k1".into()),
            ..w.gift(500)
        })
        .unwrap_err();
    assert!(
        matches!(&err, ContractError::Duplicate { id: dup } if *dup == id),
        "{err:?}"
    );
    assert_eq!(w.revisions(&id).len(), 2, "the refusal wrote nothing");
    // An edit keeps the key (system-owned).
    w.save(&id, 0, w.gift(2500)).unwrap();
    assert_eq!(w.stored(&id)["clientKey"], "k1");
    w.b_untouched();
}

/// "stores the gift, its status and one allocation row per share"
#[test]
fn stores_the_gift_its_status_and_one_allocation_row_per_share() {
    let w = world();
    let id = w.create(w.gift(1_234_567)).unwrap();
    assert_eq!(
        w.stored(&id),
        json!({
            "contactId": w.jo, "receivedOn": "2026-10-20", "amount": 1_234_567,
            "method": "cash", "reference": null, "status": "completed", "enteredBy": ANN,
            "clientKey": null, "giftVersion": 0, "statusVersion": 1,
        })
    );
    let keys = w.keys(&id);
    assert_eq!(keys.len(), 1);
    assert!(contracts::is_client_id(&keys[0]));
    assert_eq!(
        w.index(&id),
        [(
            keys[0].clone(),
            w.street.version.clone(),
            w.street.detail.clone(),
            w.street.category.clone(),
            "2026-10-20".into(),
            1_234_567,
            "completed".into(),
            w.jo.clone(),
        )]
    );
    w.b_untouched();
}

/// "runs both contracts in one group named after the gift"
#[test]
fn runs_both_contracts_in_one_group_named_after_the_gift() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    let revs = w.revisions(&id);
    assert_eq!(
        revs.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(),
        ["giving.gift", "giving.status"]
    );
    assert_eq!(revs[0].3, revs[1].3);
    assert!(revs[0].3.is_some());
    assert_eq!(
        revs[0].4.as_deref(),
        Some("gift £20 cash, Street-Wesser-001")
    );
}

/// "marks the code used, with its detail and category"
#[test]
fn marks_the_code_used_with_its_detail_and_category() {
    let w = world();
    w.create(w.gift(2000)).unwrap();
    for id in [&w.street.version, &w.street.detail, &w.street.category] {
        assert!(w.used(id));
    }
    assert!(!w.used(&w.online.version));
}

/// "a card reference is kept; an empty one is none"
#[test]
fn a_card_reference_is_kept_and_an_empty_one_is_none() {
    let w = world();
    let id = w
        .create(GiftPayload {
            method: Method::Card,
            reference: Some("  SUMUP-123 ".into()),
            ..w.gift(2000)
        })
        .unwrap();
    assert_eq!(w.stored(&id)["reference"], "SUMUP-123");
    let blank = w
        .create(GiftPayload {
            method: Method::Card,
            reference: Some(" ".into()),
            ..w.gift(2000)
        })
        .unwrap();
    assert_eq!(w.stored(&blank)["reference"], Value::Null);
}

/// "refuses %s" (zero, negative, not a date, no code, shares not adding
/// up, a zero share, a reference on cash): invalid, nothing written.
#[test]
fn refuses_unstorable_gifts_and_writes_nothing() {
    let w = world();
    let split = |a, b| vec![row(&w.street.version, a), row(&w.online.version, b)];
    let cases: Vec<(GiftPayload, &str)> = vec![
        (w.gift(0), "amount"),
        (w.gift(-100), "amount"),
        (
            GiftPayload {
                received_on: "2026-02-30".into(),
                ..w.gift(2000)
            },
            "receivedOn",
        ),
        (
            GiftPayload {
                allocations: vec![],
                ..w.gift(2000)
            },
            "allocations",
        ),
        (
            GiftPayload {
                allocations: split(1500, 400),
                ..w.gift(2000)
            },
            "allocations",
        ),
        (
            GiftPayload {
                allocations: split(2000, 0),
                ..w.gift(2000)
            },
            "allocations",
        ),
        (
            GiftPayload {
                reference: Some("R1".into()),
                ..w.gift(2000)
            },
            "reference",
        ),
    ];
    for (p, field) in cases {
        let fields = problem_fields(w.create(p).unwrap_err());
        assert!(fields.contains(&field.to_owned()), "{field}: {fields:?}");
    }
    let n: i64 = read(&w.a, |c| {
        Ok(c.query_row("SELECT count(*) FROM gifts", [], |r| r.get(0))?)
    });
    assert_eq!(n, 0);
}

/// "refuses an archived code, and nothing is written"
#[test]
fn refuses_an_archived_code_and_writes_nothing() {
    let w = world();
    archive(&w.a, &w.street.detail);
    let groups = |w: &World| -> i64 {
        read(&w.a, |c| {
            Ok(c.query_row("SELECT count(*) FROM command_groups", [], |r| r.get(0))?)
        })
    };
    let before = groups(&w);
    assert_eq!(
        reason(w.create(w.gift(2000)).unwrap_err()),
        "archived_source_code"
    );
    assert_eq!(groups(&w), before);
    assert!(!w.used(&w.street.version));
}

/// "refuses a detail or category as the code"
#[test]
fn refuses_a_detail_or_category_as_the_code() {
    let w = world();
    for part in [&w.street.detail, &w.street.category] {
        let err = w
            .create(GiftPayload {
                allocations: vec![row(part, 2000)],
                ..w.gift(2000)
            })
            .unwrap_err();
        assert_eq!(reason(err), "unknown_source_code");
    }
}

// ── tenancy ────────────────────────────────────────────────────────────────

/// "another tenant's contact or code is refused"
#[test]
fn another_organisations_contact_or_code_is_refused() {
    let w = world();
    let b_contact = contact(&w.b, "Bea");
    let b_code = code(&w.b, "Street", "Other");
    let err = w
        .create(GiftPayload {
            contact_id: b_contact,
            ..w.gift(2000)
        })
        .unwrap_err();
    assert_eq!(reason(err), "unknown_contact");
    let err = w
        .create(GiftPayload {
            allocations: vec![row(&b_code.version, 2000)],
            ..w.gift(2000)
        })
        .unwrap_err();
    assert_eq!(reason(err), "unknown_source_code");
    w.b_untouched();
}

/// "tenant B can't read or change tenant A's gift", "describeGift is
/// tenant-scoped": A's id in B's file is unknown everywhere.
#[test]
fn organisation_b_can_neither_read_nor_change_as_gift() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    read(&w.b, |c| {
        assert!(giving::get(c, &id)?.is_none());
        assert!(giving::describe_gift(c, &id)?.is_none());
        assert!(giving::my_recent(c, ANN)?.is_empty());
        assert!(giving::by_contact(c, &w.jo, None, 10)?.rows.is_empty());
        assert!(giving::history(c, &id, None, 10)?.moments.is_empty());
        Ok(())
    });
    let b_jo = contact(&w.b, "Jo");
    let err = tx(&w.b, |ctx| {
        execute(
            ctx,
            &GIFT,
            GiftPayload {
                contact_id: b_jo.clone(),
                ..w.gift(2000)
            },
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap_err();
    assert!(matches!(err, ContractError::NotFound), "{err:?}");
    let err = tx(&w.b, |ctx| {
        giving::set_status(ctx, &id, 1, Status::Void, None, Source::Ui)
    })
    .unwrap_err();
    assert!(matches!(err, ContractError::NotFound), "{err:?}");
    assert_eq!(
        read(&w.a, |c| Ok(giving::describe_gift(c, &id)?)),
        Some(giving::GiftFacts {
            contact_id: w.jo.clone(),
            received_on: "2026-10-20".into(),
            status: Status::Completed,
        })
    );
    w.b_untouched();
}

// ── editing a gift ─────────────────────────────────────────────────────────

/// "follows edits in the projection, by allocation key"
#[test]
fn the_projection_follows_edits_by_allocation_key() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    let first = w.keys(&id)[0].clone();
    // Split across two codes, a new date and amount.
    w.save(
        &id,
        0,
        GiftPayload {
            amount: 5000,
            received_on: "2026-10-01".into(),
            allocations: vec![
                AllocationRow {
                    key: Some(first.clone()),
                    ..row(&w.street.version, 3000)
                },
                row(&w.online.version, 2000),
            ],
            ..w.gift(5000)
        },
    )
    .unwrap();
    let mut rows: Vec<_> = w
        .index(&id)
        .into_iter()
        .map(|r| (r.1, r.2, r.5, r.4))
        .collect();
    rows.sort();
    let mut want = vec![
        (
            w.street.version.clone(),
            w.street.detail.clone(),
            3000,
            "2026-10-01".to_owned(),
        ),
        (
            w.online.version.clone(),
            w.online.detail.clone(),
            2000,
            "2026-10-01".to_owned(),
        ),
    ];
    want.sort();
    assert_eq!(rows, want);
    // Back to one share: the other row goes, the kept key stays.
    w.save(
        &id,
        1,
        GiftPayload {
            allocations: vec![AllocationRow {
                key: Some(first.clone()),
                ..row(&w.online.version, 5000)
            }],
            ..w.gift(5000)
        },
    )
    .unwrap();
    let rows = w.index(&id);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (&rows[0].0, &rows[0].1, &rows[0].2, &rows[0].3, rows[0].5),
        (
            &first,
            &w.online.version,
            &w.online.detail,
            &w.online.category,
            5000
        )
    );
    assert_eq!(w.keys(&id), [first]);
    w.b_untouched();
}

/// "the donor can't change"
#[test]
fn the_donor_cant_change() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    let sam = contact(&w.a, "Sam");
    let err = w
        .save(
            &id,
            0,
            GiftPayload {
                contact_id: sam,
                ..w.gift(2000)
            },
        )
        .unwrap_err();
    assert_eq!(reason(err), "contact_change");
}

/// "a stale expected throws stale"
#[test]
fn a_stale_expected_is_stale_with_the_gift_as_it_is() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    w.save(&id, 0, w.gift(2500)).unwrap();
    match w.save(&id, 0, w.gift(2000)).unwrap_err() {
        ContractError::Stale {
            contract,
            counter,
            current,
        } => {
            assert_eq!((contract, counter), ("giving.gift", 1));
            assert_eq!(current["amount"], 2500);
            assert_eq!(current["contactId"], json!(w.jo));
        }
        other => panic!("{other:?}"),
    }
}

/// "status and gift edits never conflict"
#[test]
fn status_and_gift_edits_never_conflict() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    // Both forms opened at giftVersion 0, statusVersion 1.
    w.set_status(&id, 1, Status::Void).unwrap();
    w.save(&id, 0, w.gift(2500)).unwrap();
    let g = w.stored(&id);
    assert_eq!(
        (
            &g["status"],
            &g["amount"],
            &g["giftVersion"],
            &g["statusVersion"]
        ),
        (&json!("void"), &json!(2500), &json!(1), &json!(2))
    );
}

/// "an unchanged archived code is kept; a new archived one is refused"
#[test]
fn an_unchanged_archived_code_is_kept_and_a_new_archived_one_refused() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    archive(&w.a, &w.street.version);
    w.save(
        &id,
        0,
        GiftPayload {
            received_on: "2026-10-19".into(),
            ..w.gift(2000)
        },
    )
    .unwrap();
    assert_eq!(w.stored(&id)["receivedOn"], "2026-10-19");
    // The gift page's picker shows it marked archived.
    let view = read(&w.a, |c| Ok(giving::get(c, &id)?.unwrap()));
    assert_eq!(
        view.gift.allocations[0].code.as_deref(),
        Some("Street-Wesser-001")
    );
    assert!(!view.gift.allocations[0].is_active);
    archive(&w.a, &w.online.category);
    let err = w
        .save(
            &id,
            1,
            GiftPayload {
                allocations: vec![row(&w.online.version, 2000)],
                ..w.gift(2000)
            },
        )
        .unwrap_err();
    assert_eq!(reason(err), "archived_source_code");
}

/// "enteredBy survives another member's save and a restore"
#[test]
fn entered_by_survives_another_members_save_and_a_restore() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    w.save_as(SAM, &id, 0, w.gift(2500)).unwrap();
    let created = w.revision(&id, "giving.gift", 0);
    tx_as(&w.a, SAM, None, |ctx| {
        restore(ctx, &REGISTRY, created, None)
    })
    .unwrap();
    let g = w.stored(&id);
    assert_eq!((&g["amount"], &g["enteredBy"]), (&json!(2000), &json!(ANN)));
}

// ── void and restore ───────────────────────────────────────────────────────

/// "void marks the projection; un-void restores it"
#[test]
fn void_marks_the_projection_and_unvoid_restores_it() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    w.set_status(&id, 1, Status::Void).unwrap();
    assert_eq!(w.index(&id)[0].6, "void");
    // Re-sending the current status writes nothing.
    assert_eq!(
        w.set_status(&id, 2, Status::Void).unwrap(),
        Executed {
            id: id.clone(),
            counter: 2
        }
    );
    assert_eq!(w.revisions(&id).len(), 3);
    w.set_status(&id, 2, Status::Completed).unwrap();
    assert_eq!(w.index(&id)[0].6, "completed");
    // A stale void is refused.
    let err = w.set_status(&id, 2, Status::Void).unwrap_err();
    assert!(
        matches!(err, ContractError::Stale { counter: 3, .. }),
        "{err:?}"
    );
    w.b_untouched();
}

/// "the projection follows restores of either slice"
#[test]
fn the_projection_follows_restores_of_either_slice() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    w.save(
        &id,
        0,
        GiftPayload {
            allocations: vec![row(&w.online.version, 3000)],
            ..w.gift(3000)
        },
    )
    .unwrap();
    w.set_status(&id, 1, Status::Void).unwrap();
    for (contract, counter) in [("giving.gift", 0), ("giving.status", 1)] {
        let rev = w.revision(&id, contract, counter);
        tx(&w.a, |ctx| restore(ctx, &REGISTRY, rev, None)).unwrap();
    }
    let rows = w.index(&id);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (&rows[0].1, rows[0].5, rows[0].6.as_str()),
        (&w.street.version, 2000, "completed")
    );
}

/// "restore brings back a code archived since"
#[test]
fn restore_brings_back_a_code_archived_since() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    w.save(
        &id,
        0,
        GiftPayload {
            allocations: vec![row(&w.online.version, 2000)],
            ..w.gift(2000)
        },
    )
    .unwrap();
    archive(&w.a, &w.street.version);
    let first = w.revision(&id, "giving.gift", 0);
    tx(&w.a, |ctx| restore(ctx, &REGISTRY, first, None)).unwrap();
    assert_eq!(w.index(&id)[0].1, w.street.version);
}

// ── restoring a gift to a moment ───────────────────────────────────────────

fn restore_to(w: &World, id: &str, at: i64) -> Vec<String> {
    tx(&w.a, |ctx| {
        restore_entity_to(ctx, &REGISTRY, "gifts", id, at, &[], None)
    })
    .unwrap()
}

/// "brings back the amounts, and only the slice that changed"
#[test]
fn restore_to_brings_back_the_amounts_and_only_the_slice_that_changed() {
    let w = world();
    let id = tx_as(&w.a, ANN, Some(1_000), |ctx| {
        giving::create_gift(ctx, w.gift(2000), Source::Ui, None)
    })
    .unwrap();
    tx_as(&w.a, ANN, Some(2_000), |ctx| {
        execute(
            ctx,
            &GIFT,
            GiftPayload {
                allocations: vec![row(&w.street.version, 1000), row(&w.online.version, 2000)],
                ..w.gift(3000)
            },
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    assert_eq!(restore_to(&w, &id, 1_000), ["giving.gift"]);
    let g = w.stored(&id);
    assert_eq!(
        (&g["amount"], &g["giftVersion"], &g["statusVersion"]),
        (&json!(2000), &json!(2), &json!(1))
    );
    let rows = w.index(&id);
    assert_eq!(
        rows.iter().map(|r| (r.1.as_str(), r.5)).collect::<Vec<_>>(),
        [(w.street.version.as_str(), 2000)]
    );
    w.b_untouched();
}

/// "a gift already in that state restores nothing"
#[test]
fn a_gift_already_in_that_state_restores_nothing() {
    let w = world();
    let id = tx_as(&w.a, ANN, Some(1_000), |ctx| {
        giving::create_gift(ctx, w.gift(2000), Source::Ui, None)
    })
    .unwrap();
    assert!(restore_to(&w, &id, 1_000).is_empty());
    let key = w.keys(&id)[0].clone();
    let back = |amount| GiftPayload {
        allocations: vec![AllocationRow {
            key: Some(key.clone()),
            ..row(&w.street.version, amount)
        }],
        ..w.gift(amount)
    };
    w.save(&id, 0, back(2500)).unwrap();
    w.save(&id, 1, back(2000)).unwrap();
    // The gift is back as it was then: nothing to restore.
    assert!(restore_to(&w, &id, 1_000).is_empty());
}

/// "a stored payload is canonically equal to the one sent"
#[test]
fn a_stored_payload_is_canonically_equal_to_the_one_sent() {
    let w = world();
    let sent = w.gift(1_234_567);
    let id = w.create(sent.clone()).unwrap();
    let stored: String = read(&w.a, |c| {
        Ok(c.query_row(
            "SELECT payload FROM revisions WHERE entity = 'gifts' AND entity_id = ?1
             AND contract = 'giving.gift'",
            [&id],
            |r| r.get(0),
        )?)
    });
    let stored: Value = serde_json::from_str(&stored).unwrap();
    let key = w.keys(&id)[0].clone();
    let mut expect = serde_json::to_value(&sent).unwrap();
    expect["allocations"][0]["key"] = json!(key);
    assert_eq!(canonical(&stored), canonical(&expect));
    // Money is a JSON integer, never a float or a string.
    assert!(stored["amount"].is_i64());
}

// ── queries ────────────────────────────────────────────────────────────────

/// "myRecent: only my gifts, newest entered first, void marked"
#[test]
fn my_recent_is_only_my_gifts_newest_entered_first_void_marked() {
    let w = world();
    let mut ids = Vec::new();
    for i in 0..RECENT_LIMIT as i64 + 2 {
        ids.push(w.create(w.gift(100 + i)).unwrap());
    }
    tx_as(&w.a, SAM, None, |ctx| {
        giving::create_gift(ctx, w.gift(999), Source::Ui, None)
    })
    .unwrap();
    w.set_status(ids.last().unwrap(), 1, Status::Void).unwrap();
    let recent = read(&w.a, |c| Ok(giving::my_recent(c, ANN)?));
    let want: Vec<String> = ids.iter().rev().take(RECENT_LIMIT).cloned().collect();
    assert_eq!(
        recent.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        want
    );
    let top = &recent[0];
    assert_eq!(
        (
            top.contact_id.as_str(),
            top.contact_name.as_str(),
            top.amount,
            top.status,
            top.method
        ),
        (
            w.jo.as_str(),
            "Jo Bloggs",
            100 + RECENT_LIMIT as i64 + 1,
            Status::Void,
            Method::Cash
        )
    );
    assert!(recent[1..].iter().all(|r| r.status == Status::Completed));
    let theirs = read(&w.a, |c| Ok(giving::my_recent(c, SAM)?));
    assert_eq!(theirs.iter().map(|r| r.amount).collect::<Vec<_>>(), [999]);
}

/// "byContact: newest date first, a page at a time, codes named"
#[test]
fn by_contact_is_newest_date_first_a_page_at_a_time_codes_named() {
    let w = world();
    let sam = contact(&w.a, "Sam");
    for day in ["05", "20", "12"] {
        w.create(GiftPayload {
            received_on: format!("2026-10-{day}"),
            ..w.gift(2000)
        })
        .unwrap();
    }
    w.create(GiftPayload {
        contact_id: sam,
        ..w.gift(2000)
    })
    .unwrap();
    let first = read(&w.a, |c| giving::by_contact(c, &w.jo, None, 2));
    assert_eq!(
        first
            .rows
            .iter()
            .map(|g| g.received_on.as_str())
            .collect::<Vec<_>>(),
        ["2026-10-20", "2026-10-12"]
    );
    assert_eq!(
        first.rows[0].allocations[0].code.as_deref(),
        Some("Street-Wesser-001")
    );
    assert!(!first.is_done);
    let second = read(&w.a, |c| {
        giving::by_contact(c, &w.jo, first.next_cursor.as_deref(), 2)
    });
    assert_eq!(
        second
            .rows
            .iter()
            .map(|g| g.received_on.as_str())
            .collect::<Vec<_>>(),
        ["2026-10-05"]
    );
    assert!(second.is_done);
    // Two gifts on one date page by entry order, newest first.
    let later = w.create(w.gift(2000)).unwrap();
    let one = read(&w.a, |c| giving::by_contact(c, &w.jo, None, 1));
    assert_eq!(one.rows[0].id, later);
    let next = read(&w.a, |c| {
        giving::by_contact(c, &w.jo, one.next_cursor.as_deref(), 1)
    });
    assert_eq!(next.rows[0].received_on, "2026-10-20");
    assert_ne!(next.rows[0].id, later);
    // A cursor this list never gave is refused.
    let bad = w.a.read(|c| giving::by_contact(c, &w.jo, Some("nope"), 2));
    assert!(matches!(bad, Err(ContractError::Invalid(_))));
}

/// "get: the gift with its donor and codes; history as moments"
#[test]
fn get_has_the_donor_and_codes_and_history_is_moments() {
    let w = world();
    let id = w
        .create(GiftPayload {
            method: Method::Card,
            reference: Some("R-1".into()),
            ..w.gift(2000)
        })
        .unwrap();
    change_part(&w.a, &w.street.detail, |p| p.name = "Wessex".into());
    w.set_status(&id, 1, Status::Void).unwrap();
    let view = read(&w.a, |c| Ok(giving::get(c, &id)?.unwrap()));
    assert_eq!(view.gift.reference.as_deref(), Some("R-1"));
    assert_eq!(view.gift.status, Status::Void);
    let donor = view.contact.unwrap();
    assert_eq!(
        (donor.id.as_str(), donor.display_name.as_str(), donor.kind),
        (w.jo.as_str(), "Jo Bloggs", Kind::Individual)
    );
    let a = &view.gift.allocations[0];
    assert_eq!(
        (a.code.as_deref(), a.is_active, a.amount),
        (Some("Street-Wessex-001"), true, 2000)
    );

    let history = read(&w.a, |c| giving::history(c, &id, None, 10));
    let moments: Vec<(Option<String>, Vec<String>)> = history
        .moments
        .into_iter()
        .map(|m| {
            let mut s = m.slices;
            s.sort();
            (m.group_name, s)
        })
        .collect();
    assert_eq!(
        moments,
        [
            (None, vec!["status".to_owned()]),
            // The group keeps the code as it read then.
            (
                Some("gift £20 card, Street-Wesser-001".to_owned()),
                vec!["gift".to_owned(), "status".to_owned()]
            ),
        ]
    );
    // Pages: one revision at a time, the group cut across two pages.
    let first = read(&w.a, |c| giving::history(c, &id, None, 1));
    assert_eq!(first.moments.len(), 1);
    let second = read(&w.a, |c| giving::history(c, &id, first.next_before, 1));
    assert_eq!(second.moments[0].slices, ["status"]);
    assert!(second.next_before.is_some());
}

/// The status slice can't create a gift.
#[test]
fn status_needs_an_existing_gift() {
    let w = world();
    let err = tx(&w.a, |ctx| {
        execute(
            ctx,
            &STATUS,
            StatusPayload {
                status: Status::Void,
                reason: None,
            },
            Exec::create(Source::Ui),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "no_root");
}

// ── the Gift Aid claim lock ────────────────────────────────────────────────

const CLAIM_A: &str = "0190f0c0a0b0c0d0e0f0a0b0c0d0ea01";
const CLAIM_B: &str = "0190f0c0a0b0c0d0e0f0a0b0c0d0ea02";

fn lock(w: &World, gift: &str, claim: &str) -> Result<Executed, ContractError> {
    tx(&w.a, |ctx| {
        let group = contracts::command_group(ctx, "Gift Aid claim")?;
        giving::lock_for_claim(ctx, gift, claim, Source::Ui, &group)
    })
}

fn release(w: &World, gift: &str, claim: &str) -> Result<Executed, ContractError> {
    tx(&w.a, |ctx| {
        let group = contracts::command_group(ctx, "Gift Aid claim deleted")?;
        giving::release_from_claim(ctx, gift, claim, Source::Ui, &group)
    })
}

/// A gift's revisions of `contract`, oldest first.
fn revisions(w: &World, gift: &str, contract: &str) -> Vec<i64> {
    read(&w.a, |c| {
        Ok(c.prepare(
            "SELECT id FROM revisions WHERE entity_id = ?1 AND contract = ?2 ORDER BY id",
        )?
        .query_map([gift, contract], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
    })
}

/// Gift Aid claims: while a claim holds a gift, its amount and date are
/// refused on a save and on a restore alike (both go through apply);
/// what the claim doesn't rely on stays editable.
#[test]
fn a_claimed_gift_keeps_its_amount_and_date_on_every_path() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    w.save(&id, 0, w.gift(3000)).unwrap();
    lock(&w, &id, CLAIM_A).unwrap();
    assert_eq!(w.stored(&id)["amount"], 3000);

    assert_eq!(
        reason(w.save(&id, 1, w.gift(2500)).unwrap_err()),
        "claimed_gift"
    );
    let mut later = w.gift(3000);
    later.received_on = "2026-10-21".into();
    assert_eq!(reason(w.save(&id, 1, later).unwrap_err()), "claimed_gift");
    let created = revisions(&w, &id, "giving.gift")[0];
    let err = tx(&w.a, |ctx| restore(ctx, &REGISTRY, created, None)).unwrap_err();
    assert_eq!(
        reason(err),
        "claimed_gift",
        "a restore to the old amount too"
    );

    let mut card = w.gift(3000);
    card.method = Method::Card;
    card.reference = Some("R-1".into());
    w.save(&id, 1, card).unwrap();
    assert_eq!(w.stored(&id)["method"], "card");

    // Let go, it is editable again.
    release(&w, &id, CLAIM_A).unwrap();
    w.save(&id, 2, w.gift(2500)).unwrap();
}

/// Voiding a claimed gift needs a reason (the next claim pays HMRC
/// back), and the void can't be undone, by a status save or a restore.
#[test]
fn a_claimed_gift_is_voided_with_a_reason_for_good() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    lock(&w, &id, CLAIM_A).unwrap();
    assert_eq!(
        reason(w.set_status(&id, 1, Status::Void).unwrap_err()),
        "void_reason_required"
    );
    let blank = tx(&w.a, |ctx| {
        giving::set_status(ctx, &id, 1, Status::Void, Some("   ".into()), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(reason(blank), "void_reason_required", "blank is none");
    tx(&w.a, |ctx| {
        giving::set_status(
            ctx,
            &id,
            1,
            Status::Void,
            Some(" Bounced ".into()),
            Source::Ui,
        )
    })
    .unwrap();
    let reason_now: Option<String> = read(&w.a, |c| {
        Ok(
            c.query_row("SELECT void_reason FROM gifts WHERE id = ?1", [&id], |r| {
                r.get(0)
            })?,
        )
    });
    assert_eq!(reason_now.as_deref(), Some("Bounced"));
    assert_eq!(
        reason(w.set_status(&id, 2, Status::Completed).unwrap_err()),
        "claimed_gift"
    );
    let completed = revisions(&w, &id, "giving.status")[0];
    let err = tx(&w.a, |ctx| restore(ctx, &REGISTRY, completed, None)).unwrap_err();
    assert_eq!(reason(err), "claimed_gift");
}

/// An unclaimed gift voids without a reason, and un-voiding clears one.
#[test]
fn an_unclaimed_gifts_void_reason_is_optional_and_cleared_by_unvoid() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    tx(&w.a, |ctx| {
        giving::set_status(ctx, &id, 1, Status::Void, Some("Typo".into()), Source::Ui)
    })
    .unwrap();
    w.set_status(&id, 2, Status::Completed).unwrap();
    let held: Option<String> = read(&w.a, |c| {
        Ok(
            c.query_row("SELECT void_reason FROM gifts WHERE id = ?1", [&id], |r| {
                r.get(0)
            })?,
        )
    });
    assert_eq!(held, None);
}

/// Only its claim moves the lock: another claim, a void gift, the wrong
/// claim letting go and any restore are refused.
#[test]
fn the_claim_lock_is_the_claims_alone() {
    let w = world();
    let id = w.create(w.gift(2000)).unwrap();
    lock(&w, &id, CLAIM_A).unwrap();
    lock(&w, &id, CLAIM_A).unwrap();
    assert_eq!(
        reason(lock(&w, &id, CLAIM_B).unwrap_err()),
        "already_claimed"
    );
    assert_eq!(
        reason(release(&w, &id, CLAIM_B).unwrap_err()),
        "not_in_claim"
    );
    let locked = revisions(&w, &id, "giving.claimLock")[0];
    release(&w, &id, CLAIM_A).unwrap();
    let err = tx(&w.a, |ctx| restore(ctx, &REGISTRY, locked, None)).unwrap_err();
    assert_eq!(reason(err), "not_restorable");

    let void = w.create(w.gift(500)).unwrap();
    w.set_status(&void, 1, Status::Void).unwrap();
    assert_eq!(reason(lock(&w, &void, CLAIM_A).unwrap_err()), "void_gift");
    assert!(matches!(
        release(&w, "0190f0c0a0b0c0d0e0f0a0b0c0d0ea99", CLAIM_A),
        Err(ContractError::NotFound)
    ));
}

/// What a claim's eligibility reads: unclaimed completed gifts in a date
/// range, and claimed gifts voided since.
#[test]
fn claim_reads() {
    let w = world();
    let a = w.create(w.gift(2000)).unwrap();
    let b = w.create(w.gift(1000)).unwrap();
    let mut early = w.gift(700);
    early.received_on = "2020-01-01".into();
    let old = w.create(early).unwrap();
    lock(&w, &b, CLAIM_A).unwrap();
    let in_range = read(&w.a, |c| {
        Ok(giving::unclaimed_between(c, "2022-01-01", "2026-12-31")?)
    });
    assert_eq!(
        in_range.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
        [a.as_str()]
    );
    assert_eq!(
        read(&w.a, |c| Ok(giving::unclaimed_before(c, "2022-01-01")?)),
        1
    );
    let _ = old;
    tx(&w.a, |ctx| {
        giving::set_status(ctx, &b, 1, Status::Void, Some("Gone".into()), Source::Ui)
    })
    .unwrap();
    let voided = read(&w.a, |c| Ok(giving::voided_in_claims(c)?));
    assert_eq!(
        voided,
        [giving::VoidedClaimedGift {
            id: b,
            claim_id: CLAIM_A.into(),
            void_reason: Some("Gone".into()),
        }]
    );
    // One claim's own, by its index (review L6).
    assert_eq!(
        read(&w.a, |c| Ok(giving::voided_in_claim(c, CLAIM_A)?)),
        voided
    );
    assert!(read(&w.a, |c| Ok(giving::voided_in_claim(c, CLAIM_B)?)).is_empty());
    // B's file has none of it.
    assert!(read(&w.b, |c| Ok(giving::voided_in_claims(c)?)).is_empty());
}

/// Set a gift's status as the system (a provider's word), with `reason`.
fn provider_says(w: &World, id: &str, status: Status, reason: Option<&str>) {
    tx(&w.a, |ctx| {
        execute(
            ctx,
            &STATUS,
            StatusPayload {
                status,
                reason: reason.map(str::to_owned),
            },
            Exec::update(id, None, Source::System),
        )
    })
    .unwrap();
}

/// ADR 0025, never optimistic: pending, failed, cancelled, refunded,
/// charged-back and void gifts count for nothing. Income
/// (`received_total`) and Gift Aid's eligibility reads (`unclaimed_*`)
/// see only the completed gift, and a claim can't take the others.
#[test]
fn only_money_received_counts_as_income_or_can_be_claimed() {
    let w = world();
    let received = w.create(w.gift(1000)).unwrap();
    let mut others = vec![];
    for (i, status) in [
        Status::Pending,
        Status::Failed,
        Status::Cancelled,
        Status::Refunded,
        Status::ChargedBack,
        Status::Void,
    ]
    .into_iter()
    .enumerate()
    {
        let id = w.create(w.gift(100 * (i as i64 + 1))).unwrap();
        provider_says(&w, &id, status, Some("not collected"));
        others.push((id, status));
    }
    let mut early = w.gift(5000);
    early.received_on = "2020-01-01".into();
    let old_pending = w.create(early).unwrap();
    provider_says(&w, &old_pending, Status::Pending, None);

    assert_eq!(
        read(&w.a, |c| Ok(giving::received_total(
            c,
            "2026-01-01",
            "2026-12-31"
        )?)),
        1000,
        "income is the completed gift alone"
    );
    let claimable = read(&w.a, |c| {
        Ok(giving::unclaimed_between(c, "2022-01-01", "2026-12-31")?)
    });
    assert_eq!(
        claimable.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
        [received.as_str()]
    );
    assert_eq!(
        read(&w.a, |c| Ok(giving::unclaimed_before(c, "2022-01-01")?)),
        0,
        "a pending gift isn't even too old to claim"
    );
    for (id, status) in &others {
        let refused = reason(lock(&w, id, CLAIM_A).unwrap_err());
        let expected = if *status == Status::Void {
            "void_gift"
        } else {
            "not_received"
        };
        assert_eq!(refused, expected, "{status:?}");
    }
    lock(&w, &received, CLAIM_A).unwrap();
    // Every status is listed, marked: none hidden.
    let page = read(&w.a, |c| giving::by_contact(c, &w.jo, None, 50));
    assert_eq!(page.rows.len(), 8);
}

/// Staff set completed or void, never a provider's status; on a gift
/// entered by hand there is no other.
#[test]
fn staff_set_completed_or_void_only() {
    let w = world();
    let id = w.create(w.gift(1000)).unwrap();
    for status in [
        Status::Pending,
        Status::Failed,
        Status::Cancelled,
        Status::Refunded,
        Status::ChargedBack,
    ] {
        let err = tx(&w.a, |ctx| {
            giving::set_status(ctx, &id, 1, status, None, Source::Ui)
        })
        .unwrap_err();
        assert_eq!(reason(err), "provider_status", "{status:?}");
    }
    tx(&w.a, |ctx| {
        giving::set_status(ctx, &id, 1, Status::Void, None, Source::Ui)
    })
    .unwrap();
}

/// ADR 0025 decision 5: a claimed gift whose money stops counting, for
/// any reason (charged back, failed late, cancelled, refunded), is what
/// the next claim pays back, with the provider's reason; one whose money
/// comes back before then is owed nothing. It keeps its claimed amount
/// and date throughout.
#[test]
fn a_claimed_gift_that_stops_counting_is_paid_back_whatever_the_reason() {
    let w = world();
    let mut ids = vec![];
    for status in [
        Status::ChargedBack,
        Status::Failed,
        Status::Cancelled,
        Status::Refunded,
    ] {
        let id = w.create(w.gift(1000)).unwrap();
        lock(&w, &id, CLAIM_A).unwrap();
        provider_says(&w, &id, status, Some("the bank said so"));
        ids.push(id);
    }
    let owed = read(&w.a, |c| Ok(giving::voided_in_claims(c)?));
    assert_eq!(
        owed.iter().map(|v| v.id.clone()).collect::<Vec<_>>(),
        ids,
        "each is paid back"
    );
    assert!(
        owed.iter()
            .all(|v| v.void_reason.as_deref() == Some("the bank said so"))
    );
    // Stopping counting needs a reason while claimed.
    let id = w.create(w.gift(300)).unwrap();
    lock(&w, &id, CLAIM_A).unwrap();
    let err = tx(&w.a, |ctx| {
        execute(
            ctx,
            &STATUS,
            StatusPayload {
                status: Status::ChargedBack,
                reason: None,
            },
            Exec::update(&id, None, Source::System),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "void_reason_required");
    // A chargeback cancelled: completed again, nothing owed.
    provider_says(&w, &ids[0], Status::Completed, None);
    let owed = read(&w.a, |c| Ok(giving::voided_in_claim(c, CLAIM_A)?));
    assert!(!owed.iter().any(|v| v.id == ids[0]));
    let g = read(&w.a, |c| Ok(giving::get(c, &ids[0])?)).unwrap().gift;
    assert_eq!(
        (g.status, g.void_reason, g.claim_id.as_deref()),
        (Status::Completed, None, Some(CLAIM_A))
    );
}
