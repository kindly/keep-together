//! Gift Aid declarations on real org files with two organisations: the
//! Rust port of `convex/giftaid/declarations.test.ts`. Each test names
//! the Convex case it ports. A viewer's refusal is the tenant
//! middleware's, so those cases are in `api/tests/gifts_routes.rs`.

use std::sync::Arc;

use contacts::acquisition::{NewContact, create_contact};
use contacts::types::{CreateContact, Details, Kind};
use contracts::{ContractError, Ctx, Exec, Executed, Source, execute, restore, restore_entity_to};
use giftaid::types::{CancellationPayload, Declaration, DeclarationPayload, Method, Scope};
use giftaid::{CANCELLATION, HMRC_MODEL_WORDING_VERSION, REGISTRY, uk_date};
use giving::types::{AllocationRow, GiftPayload};
use rusqlite::Connection;
use sources::SourceCodePayload;
use store::{M, Migrations, OrgDb, Store, StoreConfig};

const ANN: i64 = 1;

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
    jo: String,
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
        M::up(giftaid::MIGRATION),
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
    let jo = contact(&a, person("Jo", "Bloggs"));
    World {
        _tmp: tmp,
        a,
        b,
        jo,
    }
}

fn tx<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    contracts::transact(db, Some(ANN), f)
}

/// A transaction whose commands run at `at` ms.
fn tx_at<T>(
    db: &OrgDb,
    at: i64,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    contracts::transact(db, Some(ANN), |ctx| {
        f(&Ctx {
            tx: ctx.tx,
            actor: ctx.actor,
            at,
        })
    })
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> Result<T, ContractError>) -> T {
    db.read(|c| f(c)).unwrap()
}

fn person(first: &str, last: &str) -> Details {
    Details {
        client_key: None,
        kind: Kind::Individual,
        title: String::new(),
        first_name: first.into(),
        last_name: last.into(),
        nickname: String::new(),
        name: String::new(),
        birth_date: None,
        is_deceased: false,
        deceased_date: None,
    }
}

fn organisation(kind: Kind, name: &str) -> Details {
    Details {
        kind,
        first_name: String::new(),
        last_name: String::new(),
        name: name.into(),
        ..person("", "")
    }
}

fn contact(db: &OrgDb, details: Details) -> String {
    tx(db, |ctx| {
        create_contact(
            ctx,
            NewContact {
                create: CreateContact { id: None, details },
                acquisition_code_id: None,
            },
            Source::Ui,
        )
    })
    .unwrap()
    .id
}

/// A real gift by `contact_id` dated `date`, under a fresh code, voided
/// when asked.
fn gift_for(db: &OrgDb, contact_id: &str, date: &str, void: bool) -> String {
    let category = read(db, |c| Ok(sources::tree(c)?))
        .into_iter()
        .find(|p| p.parent_id.is_none())
        .unwrap()
        .id;
    tx(db, |ctx| {
        let code = sources::create_part(
            ctx,
            SourceCodePayload {
                parent_id: Some(category),
                name: format!("D{}", contracts::new_id()),
                description: None,
                start_date: None,
                end_date: None,
                is_active: true,
            },
            Source::Ui,
            None,
        )?;
        let id = giving::create_gift(
            ctx,
            GiftPayload {
                contact_id: contact_id.into(),
                received_on: date.into(),
                amount: 2000,
                method: giving::types::Method::Cash,
                reference: None,
                allocations: vec![AllocationRow {
                    key: None,
                    source_code_id: code.version_id.unwrap(),
                    amount: 2000,
                }],
                client_key: None,
            },
            Source::Ui,
            None,
        )?;
        if void {
            giving::set_status(ctx, &id, 1, giving::Status::Void, Source::Ui)?;
        }
        Ok(id)
    })
    .unwrap()
}

impl World {
    fn payload(&self) -> DeclarationPayload {
        DeclarationPayload {
            contact_id: self.jo.clone(),
            scope: Scope::FutureAndPast4y,
            gift_id: None,
            made_on: "2026-03-03".into(),
            method: Method::PaperForm,
            wording_version: HMRC_MODEL_WORDING_VERSION.into(),
            first_name: "Jo".into(),
            last_name: "Bloggs".into(),
            address_line1: "12".into(),
            postcode: "SW1A 1AA".into(),
        }
    }

    fn declare(&self, p: DeclarationPayload) -> Result<Executed, ContractError> {
        tx(&self.a, |ctx| {
            giftaid::make_declaration(ctx, p, Source::Ui, None)
        })
    }

    fn void(&self, id: &str, reason: &str) -> Result<Executed, ContractError> {
        tx(&self.a, |ctx| {
            giftaid::void_declaration(ctx, id, reason.into(), Source::Ui)
        })
    }

    fn cancel(&self, from: &str, note: Option<&str>) -> Result<Vec<String>, ContractError> {
        tx(&self.a, |ctx| {
            giftaid::cancel_declarations(ctx, &self.jo, from, note.map(Into::into), Source::Ui)
        })
        .map(|c| c.cancelled)
    }

    fn panel(&self, today: &str) -> giftaid::Declarations {
        read(&self.a, |c| Ok(giftaid::by_contact(c, &self.jo, today)?))
    }

    fn declaration(&self, id: &str) -> Declaration {
        self.panel("2026-10-23")
            .declarations
            .into_iter()
            .find(|d| d.declaration.id == id)
            .unwrap()
            .declaration
    }

    fn covering(&self, date: &str, gift: Option<&str>) -> Option<giftaid::DeclarationSummary> {
        read(&self.a, |c| Ok(giftaid::coverage(c, &self.jo, date, gift)?))
    }

    fn revision(&self, id: &str, contract: &str) -> i64 {
        read(&self.a, |c| {
            Ok(c.query_row(
                "SELECT id FROM revisions WHERE entity = 'gift_aid_declarations'
                 AND entity_id = ?1 AND contract = ?2 ORDER BY id LIMIT 1",
                [id, contract],
                |r| r.get(0),
            )?)
        })
    }

    fn b_untouched(&self) {
        let n: i64 = read(&self.b, |c| {
            Ok(c.query_row(
                "SELECT (SELECT count(*) FROM gift_aid_declarations)
                      + (SELECT count(*) FROM revisions WHERE entity = 'gift_aid_declarations')",
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
        ContractError::Invalid(_) => "invalid".into(),
        ContractError::NotFound => "not_found".into(),
        ContractError::Stale { .. } => "stale".into(),
        other => format!("{other:?}"),
    }
}

// ── giftaid.declaration ────────────────────────────────────────────────────

/// "records method, scope, date, snapshot and who entered it"
#[test]
fn records_method_scope_date_snapshot_and_who_entered_it() {
    let w = world();
    let made = w
        .declare(DeclarationPayload {
            method: Method::Oral,
            ..w.payload()
        })
        .unwrap();
    assert_eq!(made.counter, 0);
    let panel = w.panel("2026-10-23");
    assert_eq!(panel.current_id.as_deref(), Some(made.id.as_str()));
    assert_eq!(panel.declarations.len(), 1);
    let d = &panel.declarations[0].declaration;
    assert_eq!(
        d.payload,
        DeclarationPayload {
            method: Method::Oral,
            ..w.payload()
        }
    );
    assert_eq!(
        (
            d.entered_by,
            d.declaration_version,
            d.cancellation_version,
            d.void_version
        ),
        (Some(ANN), 0, 0, 0)
    );
    let anchors: Vec<_> = panel.declarations[0]
        .warnings
        .iter()
        .map(|w| w.anchor.as_str())
        .collect();
    assert_eq!(anchors, ["method"]);
    w.b_untouched();
}

/// "the snapshot is not the contact: a later name change leaves it"
#[test]
fn the_snapshot_is_not_the_contact() {
    let w = world();
    let made = w.declare(w.payload()).unwrap();
    let counter: i64 = read(&w.a, |c| {
        Ok(c.query_row(
            "SELECT details_version FROM contacts WHERE id = ?1",
            [&w.jo],
            |r| r.get(0),
        )?)
    });
    tx(&w.a, |ctx| {
        execute(
            ctx,
            &contacts::DETAILS,
            person("Joanna", "Smith"),
            Exec::update(&w.jo, Some(counter), Source::Ui),
        )
    })
    .unwrap();
    let d = w.declaration(&made.id);
    assert_eq!(
        (d.payload.first_name.as_str(), d.payload.last_name.as_str()),
        ("Jo", "Bloggs")
    );
}

/// "refused for an organisation or a household"
#[test]
fn refused_for_an_organisation_or_a_household() {
    let w = world();
    for kind in [Kind::Organization, Kind::Household] {
        let org = contact(&w.a, organisation(kind, "Acme"));
        let err = w
            .declare(DeclarationPayload {
                contact_id: org,
                ..w.payload()
            })
            .unwrap_err();
        assert_eq!(reason(err), "not_individual");
    }
}

/// "missing snapshot fields store, with warnings"
#[test]
fn missing_snapshot_fields_store_with_warnings() {
    let w = world();
    let made = w
        .declare(DeclarationPayload {
            scope: Scope::Future,
            made_on: "2026-04-01".into(),
            address_line1: String::new(),
            postcode: String::new(),
            ..w.payload()
        })
        .unwrap();
    let row = w
        .panel("2026-10-23")
        .declarations
        .into_iter()
        .find(|d| d.declaration.id == made.id)
        .unwrap();
    assert_eq!(
        row.warnings
            .iter()
            .map(|w| w.anchor.as_str())
            .collect::<Vec<_>>(),
        ["addressLine1"]
    );
}

/// "a bad date is refused"
#[test]
fn a_bad_date_is_refused() {
    let w = world();
    let err = w
        .declare(DeclarationPayload {
            made_on: "2026-02-30".into(),
            ..w.payload()
        })
        .unwrap_err();
    assert_eq!(reason(err), "invalid");
}

/// "made today stores; made in the future is refused"
#[test]
fn made_today_stores_and_made_in_the_future_is_refused() {
    let w = world();
    let now = contracts::now_ms();
    w.declare(DeclarationPayload {
        made_on: uk_date(now),
        ..w.payload()
    })
    .unwrap();
    let err = w
        .declare(DeclarationPayload {
            made_on: uk_date(now + 36 * 3_600_000),
            ..w.payload()
        })
        .unwrap_err();
    match err {
        ContractError::Invalid(problems) => assert_eq!(
            problems,
            [contracts::Problem::new(
                "madeOn",
                "A declaration can’t be made in the future"
            )]
        ),
        other => panic!("{other:?}"),
    }
}

/// "at 23:30 UTC in BST, already tomorrow in the UK: the UK date stores;
/// the day after is refused" (the command's time is the clock).
#[test]
fn at_2330_utc_in_bst_the_uk_date_stores_and_the_day_after_is_refused() {
    let w = world();
    // 2026-07-01 23:30 UTC.
    let at = 1_782_948_600_000;
    assert_eq!(uk_date(at), "2026-07-02");
    tx_at(&w.a, at, |ctx| {
        giftaid::make_declaration(
            ctx,
            DeclarationPayload {
                made_on: "2026-07-02".into(),
                ..w.payload()
            },
            Source::Ui,
            None,
        )
    })
    .unwrap();
    let err = tx_at(&w.a, at, |ctx| {
        giftaid::make_declaration(
            ctx,
            DeclarationPayload {
                made_on: "2026-07-03".into(),
                ..w.payload()
            },
            Source::Ui,
            None,
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "invalid");
}

/// "onScreenByDonor is refused until a donor screen exists; staff ticked stores"
#[test]
fn on_screen_is_refused_and_staff_ticked_stores() {
    let w = world();
    match w
        .declare(DeclarationPayload {
            method: Method::OnScreenByDonor,
            ..w.payload()
        })
        .unwrap_err()
    {
        ContractError::Invalid(p) => assert_eq!(p[0].field, "method"),
        other => panic!("{other:?}"),
    }
    let made = w
        .declare(DeclarationPayload {
            method: Method::StaffTickedNoEvidence,
            ..w.payload()
        })
        .unwrap();
    let row = w
        .panel("2026-10-23")
        .declarations
        .into_iter()
        .find(|d| d.declaration.id == made.id)
        .unwrap();
    assert_eq!(
        row.declaration.payload.method,
        Method::StaffTickedNoEvidence
    );
    assert_eq!(
        row.warnings
            .iter()
            .map(|w| w.label.as_str())
            .collect::<Vec<_>>(),
        ["No evidence yet"]
    );
}

/// "immutable: an update and a restore are both refused"
#[test]
fn immutable_an_update_and_a_restore_are_both_refused() {
    let w = world();
    let made = w.declare(w.payload()).unwrap();
    let err = tx(&w.a, |ctx| {
        execute(
            ctx,
            &giftaid::DECLARATION,
            DeclarationPayload {
                scope: Scope::Future,
                ..w.payload()
            },
            Exec::update(&made.id, None, Source::Test),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "immutable");
    let rev = w.revision(&made.id, "giftaid.declaration");
    let err = tx(&w.a, |ctx| restore(ctx, &REGISTRY, rev, None)).unwrap_err();
    assert_eq!(reason(err), "immutable");
}

/// The v1 → v2 upcaster is the identity: a stored v1 payload upcasts to itself.
#[test]
fn a_v1_declaration_upcasts_unchanged() {
    let payload = serde_json::to_value(world().payload()).unwrap();
    let up = contracts::upcast(&giftaid::DECLARATION, payload.clone(), 1).unwrap();
    assert_eq!(up, payload);
    assert!(REGISTRY.missing_upcasters().is_empty());
}

/// "thisGift names one of the contact's own gifts"
#[test]
fn this_gift_names_one_of_the_contacts_own_gifts() {
    let w = world();
    let gift = gift_for(&w.a, &w.jo, "2026-03-03", false);
    let made = w
        .declare(DeclarationPayload {
            scope: Scope::ThisGift,
            gift_id: Some(gift.clone()),
            ..w.payload()
        })
        .unwrap();
    let panel = w.panel("2026-10-23");
    assert_eq!(
        panel.declarations[0].declaration.payload.gift_id.as_deref(),
        Some(gift.as_str())
    );
    assert_eq!(panel.declarations[0].declaration.id, made.id);
    // Not current: it covers one gift, so the form offers the tick again.
    assert!(panel.current_id.is_none());

    let sam = contact(&w.a, person("Sam", "Other"));
    let sams = gift_for(&w.a, &sam, "2026-03-03", false);
    for scope in [Scope::ThisGift, Scope::Future] {
        let err = w
            .declare(DeclarationPayload {
                scope,
                gift_id: Some(sams.clone()),
                ..w.payload()
            })
            .unwrap_err();
        assert_eq!(reason(err), "unknown_gift");
    }
    let err = w
        .declare(DeclarationPayload {
            scope: Scope::ThisGift,
            ..w.payload()
        })
        .unwrap_err();
    assert_eq!(reason(err), "invalid");
}

/// "an enduring declaration made with a back-dated gift covers that gift"
#[test]
fn an_enduring_declaration_made_with_a_back_dated_gift_covers_it() {
    let w = world();
    let gift = gift_for(&w.a, &w.jo, "2021-01-10", false);
    let other = gift_for(&w.a, &w.jo, "2021-01-10", false);
    // Both windows start after 2021-01-10 (madeOn 2026-03-03).
    let made = w
        .declare(DeclarationPayload {
            scope: Scope::Future,
            gift_id: Some(gift.clone()),
            ..w.payload()
        })
        .unwrap();
    assert_eq!(w.covering("2021-01-10", Some(&gift)).unwrap().id, made.id);
    assert!(w.covering("2021-01-10", Some(&other)).is_none());
    let past = w
        .declare(DeclarationPayload {
            gift_id: Some(other.clone()),
            ..w.payload()
        })
        .unwrap();
    assert_eq!(w.covering("2021-01-10", Some(&other)).unwrap().id, past.id);
}

/// "thisGift: a void gift or one already declared is refused; voiding frees it"
#[test]
fn this_gift_a_void_gift_or_one_already_declared_is_refused() {
    let w = world();
    let void_gift = gift_for(&w.a, &w.jo, "2026-03-03", true);
    let this = |gift: &str| DeclarationPayload {
        scope: Scope::ThisGift,
        gift_id: Some(gift.into()),
        ..w.payload()
    };
    assert_eq!(
        reason(w.declare(this(&void_gift)).unwrap_err()),
        "void_gift"
    );
    let gift = gift_for(&w.a, &w.jo, "2026-03-03", false);
    let first = w.declare(this(&gift)).unwrap();
    assert_eq!(
        reason(w.declare(this(&gift)).unwrap_err()),
        "duplicate_gift_declaration"
    );
    w.void(&first.id, "wrong gift").unwrap();
    w.declare(this(&gift)).unwrap();
}

// ── voidDeclaration (made in error) ────────────────────────────────────────

/// "a mistaken futureAndPast4y voided the same day covers no gift, past or future"
#[test]
fn a_voided_enduring_declaration_covers_no_gift_past_or_future() {
    let w = world();
    let today = uk_date(contracts::now_ms());
    let made = w
        .declare(DeclarationPayload {
            made_on: today.clone(),
            ..w.payload()
        })
        .unwrap();
    assert!(w.covering(&today, None).is_some());
    assert_eq!(
        w.void(&made.id, "entered against the wrong Jo")
            .unwrap()
            .counter,
        1
    );
    let four_back = giftaid::rules::years_before(&today, 4);
    for date in [
        four_back.as_str(),
        "2024-06-01",
        today.as_str(),
        "2099-01-01",
    ] {
        assert!(w.covering(date, None).is_none(), "{date}");
    }
    assert!(
        read(&w.a, |c| Ok(giftaid::current_declaration(
            c, &w.jo, &today
        )?))
        .is_none()
    );
    let panel = w.panel(&today);
    assert!(panel.current_id.is_none());
    let d = &panel.declarations[0].declaration;
    assert_eq!(
        (d.void_reason.as_deref(), d.voided_by, d.void_version),
        (Some("entered against the wrong Jo"), Some(ANN), 1)
    );
    assert!(d.voided_at.is_some());
    w.b_untouched();
}

/// "a voided thisGift no longer covers its gift"
#[test]
fn a_voided_this_gift_no_longer_covers_its_gift() {
    let w = world();
    let gift = gift_for(&w.a, &w.jo, "2026-03-03", false);
    let made = w
        .declare(DeclarationPayload {
            scope: Scope::ThisGift,
            gift_id: Some(gift.clone()),
            ..w.payload()
        })
        .unwrap();
    assert_eq!(w.covering("2026-03-03", Some(&gift)).unwrap().id, made.id);
    w.void(&made.id, "wrong").unwrap();
    assert!(w.covering("2026-03-03", Some(&gift)).is_none());
}

/// "a cancelled declaration can still be voided; a voided one can't be cancelled"
#[test]
fn a_cancelled_declaration_can_be_voided_and_a_voided_one_not_cancelled() {
    let w = world();
    let made = w.declare(w.payload()).unwrap();
    w.cancel("2026-06-01", None).unwrap();
    assert!(w.covering("2025-01-01", None).is_some());
    w.void(&made.id, "wrong").unwrap();
    assert!(w.covering("2025-01-01", None).is_none());
    // Cancelling finds nothing open; the contract refuses directly.
    assert_eq!(reason(w.cancel("2026-04-01", None).unwrap_err()), "invalid");
    let err = tx(&w.a, |ctx| {
        execute(
            ctx,
            &CANCELLATION,
            CancellationPayload::default(),
            Exec::update(&made.id, None, Source::Test),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "voided");
}

/// "a voided declaration lists no warnings"
#[test]
fn a_voided_declaration_lists_no_warnings() {
    let w = world();
    let made = w
        .declare(DeclarationPayload {
            method: Method::StaffTickedNoEvidence,
            ..w.payload()
        })
        .unwrap();
    w.void(&made.id, "wrong").unwrap();
    assert!(w.panel("2026-10-23").declarations[0].warnings.is_empty());
}

/// "create-only: a second void, a restore and a restore-to-before leave it voided"
#[test]
fn create_only_a_second_void_a_restore_and_a_restore_to_before_leave_it_voided() {
    let w = world();
    let made = w.declare(w.payload()).unwrap();
    w.void(&made.id, "wrong").unwrap();
    assert_eq!(reason(w.void(&made.id, "again").unwrap_err()), "immutable");
    assert_eq!(reason(w.void(&made.id, "  ").unwrap_err()), "invalid");
    let rev = w.revision(&made.id, "giftaid.void");
    let err = tx(&w.a, |ctx| restore(ctx, &REGISTRY, rev, None)).unwrap_err();
    assert_eq!(reason(err), "immutable");
    // No void revision before the void: restoring to then changes nothing.
    tx(&w.a, |ctx| {
        restore_entity_to(
            ctx,
            &REGISTRY,
            "gift_aid_declarations",
            &made.id,
            0,
            &[],
            None,
        )
    })
    .unwrap();
    assert!(w.declaration(&made.id).voided_at.is_some());
}

/// "another tenant can't void it"
#[test]
fn another_organisation_cant_void_it() {
    let w = world();
    let made = w.declare(w.payload()).unwrap();
    let err = tx(&w.b, |ctx| {
        giftaid::void_declaration(ctx, &made.id, "nope".into(), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(reason(err), "not_found");
    assert!(w.declaration(&made.id).voided_at.is_none());
    w.b_untouched();
}

// ── recordCancellation ─────────────────────────────────────────────────────

fn group_names(w: &World, from: &str) -> Vec<Option<String>> {
    read(&w.a, |c| {
        Ok(c.prepare(
            "SELECT DISTINCT group_name FROM revisions WHERE contract = 'giftaid.cancellation'
             AND json_extract(payload, '$.cancelledFrom') = ?1",
        )?
        .query_map([from], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
    })
}

/// "cancels every declaration open at the date, in one named group"
#[test]
fn cancels_every_declaration_open_at_the_date_in_one_named_group() {
    let w = world();
    let at = |scope, made_on: &str| DeclarationPayload {
        scope,
        made_on: made_on.into(),
        ..w.payload()
    };
    let first = w.declare(at(Scope::Future, "2024-01-01")).unwrap();
    let second = w.declare(at(Scope::FutureAndPast4y, "2025-01-01")).unwrap();
    // Already cancelled before the date: left alone.
    let old = w.declare(at(Scope::Future, "2020-01-01")).unwrap();
    w.cancel("2021-01-01", None).unwrap();
    // Made after the date: the donor declared again since; left alone.
    let later = w.declare(at(Scope::Future, "2026-08-01")).unwrap();

    let mut cancelled = w.cancel("2026-06-01", Some("phoned to cancel")).unwrap();
    cancelled.sort();
    let mut want = vec![first.id.clone(), second.id.clone()];
    want.sort();
    assert_eq!(cancelled, want);

    let d = w.declaration(&first.id);
    assert_eq!(
        (
            d.cancelled_from.as_deref(),
            d.cancellation_note.as_deref(),
            d.cancellation_version
        ),
        (Some("2026-06-01"), Some("phoned to cancel"), 1)
    );
    assert_eq!(
        w.declaration(&second.id).cancelled_from.as_deref(),
        Some("2026-06-01")
    );
    assert_eq!(
        w.declaration(&old.id).cancelled_from.as_deref(),
        Some("2021-01-01")
    );
    assert_eq!(w.declaration(&later.id).cancelled_from, None);
    assert_eq!(
        group_names(&w, "2026-06-01"),
        [Some("Gift Aid cancelled from 2026-06-01".to_owned())]
    );
    w.b_untouched();
}

/// "an earlier date moves an existing cancellation back"
#[test]
fn an_earlier_date_moves_an_existing_cancellation_back() {
    let w = world();
    let made = w
        .declare(DeclarationPayload {
            scope: Scope::Future,
            made_on: "2024-01-01".into(),
            ..w.payload()
        })
        .unwrap();
    w.cancel("2026-06-01", None).unwrap();
    assert_eq!(
        w.cancel("2025-06-01", None).unwrap(),
        std::slice::from_ref(&made.id)
    );
    assert_eq!(
        w.declaration(&made.id).cancelled_from.as_deref(),
        Some("2025-06-01")
    );
}

/// "nothing open, or a bad date, is refused"
#[test]
fn nothing_open_or_a_bad_date_is_refused() {
    let w = world();
    assert_eq!(reason(w.cancel("2026-06-01", None).unwrap_err()), "invalid");
    w.declare(w.payload()).unwrap();
    assert_eq!(reason(w.cancel("2026-03-02", None).unwrap_err()), "invalid");
    assert_eq!(reason(w.cancel("2026-02-30", None).unwrap_err()), "invalid");
}

/// "the cancellation contract is stale-checked and can be cleared"
#[test]
fn the_cancellation_contract_is_stale_checked_and_can_be_cleared() {
    let w = world();
    let made = w.declare(w.payload()).unwrap();
    w.cancel("2026-06-01", None).unwrap();
    let run = |expected| {
        tx(&w.a, |ctx| {
            execute(
                ctx,
                &CANCELLATION,
                CancellationPayload::default(),
                Exec::update(&made.id, Some(expected), Source::Test),
            )
        })
    };
    assert_eq!(reason(run(0).unwrap_err()), "stale");
    run(1).unwrap();
    assert_eq!(w.declaration(&made.id).cancelled_from, None);
    assert_eq!(
        w.panel("2026-10-23").current_id.as_deref(),
        Some(made.id.as_str())
    );
}

// ── coverage and currentDeclaration ────────────────────────────────────────

/// "derived from the chain, from a gift date"
#[test]
fn coverage_is_derived_from_the_chain_from_a_gift_date() {
    let w = world();
    let enduring = w.declare(w.payload()).unwrap();
    let found = w.covering("2022-03-03", None).unwrap();
    assert_eq!(
        (
            found.id.as_str(),
            found.scope,
            found.method,
            found.made_on.as_str()
        ),
        (
            enduring.id.as_str(),
            Scope::FutureAndPast4y,
            Method::PaperForm,
            "2026-03-03"
        )
    );
    assert!(w.covering("2022-03-02", None).is_none());
    w.cancel("2026-06-01", None).unwrap();
    assert!(w.covering("2026-05-31", None).is_some());
    assert!(w.covering("2026-06-01", None).is_none());

    let gift = gift_for(&w.a, &w.jo, "2026-07-01", false);
    let one = w
        .declare(DeclarationPayload {
            scope: Scope::ThisGift,
            gift_id: Some(gift.clone()),
            made_on: "2026-07-01".into(),
            ..w.payload()
        })
        .unwrap();
    assert_eq!(w.covering("2026-07-01", Some(&gift)).unwrap().id, one.id);
    assert!(w.covering("2026-07-01", None).is_none());
    assert!(
        read(&w.a, |c| Ok(giftaid::current_declaration(
            c,
            &w.jo,
            "2026-10-23"
        )?))
        .is_none()
    );
}

// ── tenancy ────────────────────────────────────────────────────────────────

/// "another tenant's contact, gift or declaration is refused or invisible"
#[test]
fn another_organisations_contact_gift_or_declaration_is_refused_or_invisible() {
    let w = world();
    let made = w.declare(w.payload()).unwrap();
    let bob = contact(&w.b, person("Bob", "Beta"));
    let err = w
        .declare(DeclarationPayload {
            contact_id: bob.clone(),
            ..w.payload()
        })
        .unwrap_err();
    assert_eq!(reason(err), "unknown_contact");
    let b_gift = gift_for(&w.b, &bob, "2026-03-03", false);
    let err = w
        .declare(DeclarationPayload {
            scope: Scope::ThisGift,
            gift_id: Some(b_gift),
            ..w.payload()
        })
        .unwrap_err();
    assert_eq!(reason(err), "unknown_gift");

    // B can't see or cancel A's declarations.
    assert!(
        read(&w.b, |c| Ok(giftaid::by_contact(c, &w.jo, "2026-10-23")?))
            .declarations
            .is_empty()
    );
    let err = tx(&w.b, |ctx| {
        giftaid::cancel_declarations(ctx, &w.jo, "2026-06-01", None, Source::Ui)
    })
    .unwrap_err();
    assert_eq!(reason(err), "invalid");
    let err = tx(&w.b, |ctx| {
        execute(
            ctx,
            &CANCELLATION,
            CancellationPayload {
                cancelled_from: Some("2026-06-01".into()),
                note: None,
            },
            Exec::update(&made.id, None, Source::Test),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "not_found");
    assert!(
        read(&w.b, |c| Ok(giftaid::coverage(
            c,
            &w.jo,
            "2026-06-01",
            None
        )?))
        .is_none()
    );
    w.b_untouched();
    assert_eq!(w.declaration(&made.id).cancelled_from, None);
}

/// A contact has at most DECLARATION_LIMIT declarations.
#[test]
fn a_contact_has_at_most_the_declaration_limit() {
    let w = world();
    tx(&w.a, |ctx| {
        for _ in 0..giftaid::rules::DECLARATION_LIMIT {
            giftaid::make_declaration(ctx, w.payload(), Source::Ui, None)?;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(
        reason(w.declare(w.payload()).unwrap_err()),
        "declaration_limit"
    );
}
