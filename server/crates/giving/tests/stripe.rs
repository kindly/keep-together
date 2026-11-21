//! Card gifts through Stripe (plan stripe.sv, S2) on real org files with
//! two organisations: the page's settings, what donors typed and what
//! became of it, Stripe's payments and whose they are. Organisation B is
//! a separate file, so "B untouched" is checked by reading B's tables,
//! and A's ids are unknown there.

use std::sync::Arc;

use contacts::acquisition::{NewContact, create_contact};
use contacts::types::{CreateContact, Details, Kind};
use contracts::{ContractError, Ctx, Exec, Source, command_group, execute, restore};
use giving::stripe::{
    self, DONATION_SUBMISSION, DONATION_SUBMISSION_OUTCOME, DeclarationScope, DisputeState,
    DonationPagePayload, DonorForm, STRIPE_PAYMENT, STRIPE_PAYMENT_MATCH,
    StripePaymentMatchPayload, StripePaymentPayload, StripePaymentStatus, SubmissionGiftAid,
    SubmissionOutcomePayload, SubmissionStatus, UnmatchedReason,
};
use giving::types::{AllocationRow, GiftPayload, Method};
use rusqlite::Connection;
use sources::SourceCodePayload;
use store::{M, Migrations, OrgDb, Store, StoreConfig};

const ANN: i64 = 1;
const DAY: i64 = 86_400_000;
/// 2026-11-18T12:00:00Z.
const NOON: i64 = 1_795_003_200_000;
const S1: &str = "000000000000000000000000000000a1";
const S2: &str = "000000000000000000000000000000a2";

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
    /// A live source code in A; `code_b` is B's.
    code: String,
    code_b: String,
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
        M::up(giving::terms::MIGRATION),
        M::up(giving::bank::MIGRATION),
        M::up(giving::standing::MIGRATION),
        M::up(giving::stripe::MIGRATION),
        M::up(giving::stripe::MIGRATION_NO_SUBMISSION),
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
    let code_a = code(&a, "Web");
    let code_b = code(&b, "Web");
    World {
        _tmp: tmp,
        a,
        b,
        code: code_a,
        code_b,
    }
}

fn tx<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    contracts::transact(db, Some(ANN), f)
}

/// A transaction with nobody signed in (the public page, a webhook), at
/// `at` ms.
fn system<T>(
    db: &OrgDb,
    at: i64,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    contracts::transact(db, None, |ctx| {
        f(&Ctx {
            tx: ctx.tx,
            actor: None,
            at,
        })
    })
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    db.read(|c| f(c)).unwrap()
}

fn count(db: &OrgDb, table: &str) -> i64 {
    read(db, |c| {
        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
    })
}

fn reason(err: ContractError) -> String {
    match err {
        ContractError::Rejected { reason, .. } => reason,
        ContractError::Invalid(p) => format!("invalid {}", p[0].field),
        ContractError::NotFound => "not_found".into(),
        ContractError::Stale { .. } => "stale".into(),
        ContractError::Duplicate { .. } => "duplicate".into(),
        other => format!("{other:?}"),
    }
}

/// A live full code under the first seeded category: its version's id.
fn code(db: &OrgDb, detail: &str) -> String {
    let category = read(db, sources::tree)
        .into_iter()
        .find(|p| p.parent_id.is_none())
        .unwrap()
        .id;
    tx(db, |ctx| {
        sources::create_part(
            ctx,
            SourceCodePayload {
                parent_id: Some(category),
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
    .unwrap()
    .version_id
    .unwrap()
}

fn archive(db: &OrgDb, id: &str) {
    let p = read(db, sources::tree)
        .into_iter()
        .find(|p| p.id == id)
        .unwrap();
    tx(db, |ctx| {
        execute(
            ctx,
            &sources::CODE,
            SourceCodePayload {
                parent_id: None,
                name: p.name,
                description: p.description,
                start_date: p.start_date,
                end_date: p.end_date,
                is_active: false,
            },
            Exec::update(id, Some(p.save_version), Source::Ui),
        )
    })
    .unwrap();
}

fn contact(db: &OrgDb, first: &str, last: &str) -> String {
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
                        last_name: last.into(),
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

fn gift(db: &OrgDb, contact_id: &str, code: &str, amount: i64) -> String {
    tx(db, |ctx| {
        giving::create_gift(
            ctx,
            GiftPayload {
                contact_id: contact_id.into(),
                received_on: "2026-11-18".into(),
                amount,
                method: Method::Cash,
                reference: None,
                allocations: vec![AllocationRow {
                    key: None,
                    source_code_id: code.into(),
                    amount,
                }],
                client_key: None,
                origin: None,
                from_line: None,
                paying_in_batch_id: None,
                instalment: None,
            },
            Source::Ui,
            None,
        )
    })
    .unwrap()
}

fn page_with(code: &str) -> DonationPagePayload {
    DonationPagePayload {
        source_code_id: Some(code.into()),
        ..DonationPagePayload::default()
    }
}

/// Both groups' pages take donations, each to its own code.
fn open_pages(w: &World) {
    for (db, code) in [(&w.a, &w.code), (&w.b, &w.code_b)] {
        tx(db, |ctx| {
            stripe::save_page(ctx, page_with(code), None, Source::Ui)
        })
        .unwrap();
    }
}

fn aid() -> SubmissionGiftAid {
    SubmissionGiftAid {
        scope: DeclarationScope::FutureAndPast4y,
        wording_version: "hmrc-2016-04".into(),
        address_line1: "12 High Street".into(),
        postcode: "AB1 2CD".into(),
    }
}

fn form(amount: i64, gift_aid: bool) -> DonorForm {
    DonorForm {
        amount,
        first_name: "Jane".into(),
        last_name: "Smith".into(),
        email: "jane@example.org".into(),
        gift_aid: gift_aid.then(aid),
    }
}

fn submit(
    db: &OrgDb,
    id: &str,
    at: i64,
    form: DonorForm,
) -> Result<stripe::Submission, ContractError> {
    system(db, at, |ctx| stripe::submit(ctx, id, form, true))
}

fn report(payment_id: &str, submission: Option<&str>) -> StripePaymentPayload {
    StripePaymentPayload {
        payment_id: payment_id.into(),
        submission_id: submission.map(Into::into),
        amount: 2500,
        currency: "gbp".into(),
        status: StripePaymentStatus::Succeeded,
        paid_on: Some("2026-11-18".into()),
        refunded_amount: 0,
        dispute: None,
        reason: None,
    }
}

fn record(
    db: &OrgDb,
    report: StripePaymentPayload,
) -> Result<(stripe::PaymentRecord, bool), ContractError> {
    system(db, NOON, |ctx| {
        let group = command_group(ctx, "stripe.donation")?;
        stripe::record_payment(ctx, report, &group)
    })
}

fn revisions(db: &OrgDb, id: &str) -> Vec<(String, i64, String)> {
    read(db, |c| {
        c.prepare(
            "SELECT contract, counter, payload FROM revisions WHERE entity_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect()
    })
}

// ── giving.donationPage ────────────────────────────────────────────────────

#[test]
fn a_page_never_saved_reads_its_defaults_and_takes_no_donations() {
    let w = world();
    let page = read(&w.a, stripe::page);
    assert_eq!(page.page, DonationPagePayload::default());
    assert_eq!(page.version, None);
    assert!(!page.taking_donations);
    assert_eq!(count(&w.a, "donation_page"), 0);
}

#[test]
fn a_group_sets_its_own_amounts_and_code_and_a_stale_save_is_refused() {
    let w = world();
    let mine = DonationPagePayload {
        amounts: [500, 1500, 3000],
        minimum: 300,
        maximum: 50_000,
        source_code_id: Some(w.code.clone()),
    };
    let saved = tx(&w.a, |ctx| {
        stripe::save_page(ctx, mine.clone(), None, Source::Ui)
    })
    .unwrap();
    assert_eq!(saved.counter, 0);
    let page = read(&w.a, stripe::page);
    assert_eq!(page.page, mine);
    assert_eq!(page.version, Some(0));
    assert!(page.taking_donations);

    // Seeing no row when one exists, or an old counter, is stale.
    for expected in [None, Some(7)] {
        let err = tx(&w.a, |ctx| {
            stripe::save_page(ctx, DonationPagePayload::default(), expected, Source::Ui)
        })
        .unwrap_err();
        assert_eq!(reason(err), "stale");
    }
    let saved = tx(&w.a, |ctx| {
        stripe::save_page(ctx, DonationPagePayload::default(), Some(0), Source::Ui)
    })
    .unwrap();
    assert_eq!(saved.counter, 1);
    // One row, ever; and no code again: no donations.
    assert_eq!(count(&w.a, "donation_page"), 1);
    assert!(!read(&w.a, stripe::page).taking_donations);
    // B's page is its own.
    assert_eq!(read(&w.b, stripe::page).version, None);
    assert_eq!(count(&w.b, "donation_page"), 0);
}

#[test]
fn a_group_cannot_set_a_page_outside_a_pound_to_a_thousand() {
    let w = world();
    for (page, field) in [
        (
            DonationPagePayload {
                minimum: 99,
                ..page_with(&w.code)
            },
            "minimum",
        ),
        (
            DonationPagePayload {
                maximum: 100_001,
                ..page_with(&w.code)
            },
            "maximum",
        ),
        (
            DonationPagePayload {
                amounts: [1000, 2500, 150],
                ..page_with(&w.code)
            },
            "amounts.2",
        ),
    ] {
        let err = tx(&w.a, |ctx| stripe::save_page(ctx, page, None, Source::Ui)).unwrap_err();
        assert_eq!(reason(err), format!("invalid {field}"));
    }
    assert_eq!(count(&w.a, "donation_page"), 0);
}

#[test]
fn a_page_code_must_be_live_when_picked_and_an_archived_one_stops_donations() {
    let w = world();
    // Another group's code is no code here.
    let err = tx(&w.a, |ctx| {
        stripe::save_page(ctx, page_with(&w.code_b), None, Source::Ui)
    })
    .unwrap_err();
    assert_eq!(reason(err), "unknown_source_code");
    let dead = code(&w.a, "Old");
    archive(&w.a, &dead);
    let err = tx(&w.a, |ctx| {
        stripe::save_page(ctx, page_with(&dead), None, Source::Ui)
    })
    .unwrap_err();
    assert_eq!(reason(err), "archived_source_code");

    open_pages(&w);
    assert!(read(&w.a, stripe::page).taking_donations);
    archive(&w.a, &w.code);
    let page = read(&w.a, stripe::page);
    assert!(!page.taking_donations);
    assert_eq!(
        reason(submit(&w.a, S1, NOON, form(2500, false)).unwrap_err()),
        "not_taking_donations"
    );
    // The amounts can still be edited around the archived code.
    tx(&w.a, |ctx| {
        stripe::save_page(
            ctx,
            DonationPagePayload {
                amounts: [600, 2500, 5000],
                ..page.page
            },
            page.version,
            Source::Ui,
        )
    })
    .unwrap();
}

// ── giving.donationSubmission ──────────────────────────────────────────────

#[test]
fn a_page_with_no_source_code_takes_no_donations() {
    let w = world();
    assert_eq!(
        reason(submit(&w.a, S1, NOON, form(2500, false)).unwrap_err()),
        "not_taking_donations"
    );
    assert_eq!(count(&w.a, "donation_submissions"), 0);
}

#[test]
fn a_submission_keeps_what_the_donor_typed_and_makes_no_gift() {
    let w = world();
    open_pages(&w);
    let held = submit(&w.a, S1, NOON, form(2500, true)).unwrap();
    assert_eq!(held.id, S1);
    assert_eq!(held.typed.amount, 2500);
    assert_eq!(
        (
            held.typed.first_name.as_str(),
            held.typed.last_name.as_str()
        ),
        ("Jane", "Smith")
    );
    assert_eq!(held.typed.email, "jane@example.org");
    assert_eq!(held.typed.gift_aid, Some(aid()));
    // The page's code, and the moment the donor sent it.
    assert_eq!(held.typed.source_code_id, w.code);
    assert_eq!(held.submitted_at, NOON);
    assert_eq!(
        held.outcome,
        SubmissionOutcomePayload {
            checkout_session_id: None,
            state: SubmissionStatus::Started,
            stripe_payment_id: None,
            personal_cleared_at: None,
        }
    );
    // Never optimistic: no gift, no contact, no payment.
    for table in ["gifts", "contacts", "stripe_payments"] {
        assert_eq!(count(&w.a, table), 0, "{table}");
    }
    // Recorded as the system's, by nobody on the staff.
    let (actor, source): (Option<i64>, String) = read(&w.a, |c| {
        c.query_row(
            "SELECT actor, source FROM revisions WHERE entity_id = ?1",
            [S1],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    });
    assert_eq!((actor, source.as_str()), (None, "system"));
}

#[test]
fn an_amount_outside_the_groups_range_is_refused() {
    let w = world();
    tx(&w.a, |ctx| {
        stripe::save_page(
            ctx,
            DonationPagePayload {
                amounts: [500, 1500, 3000],
                minimum: 500,
                maximum: 5000,
                source_code_id: Some(w.code.clone()),
            },
            None,
            Source::Ui,
        )
    })
    .unwrap();
    for amount in [499, 5001, 0, -100] {
        assert_eq!(
            reason(submit(&w.a, S1, NOON, form(amount, false)).unwrap_err()),
            "invalid amount",
            "{amount}"
        );
    }
    assert_eq!(count(&w.a, "donation_submissions"), 0);
    submit(&w.a, S1, NOON, form(500, false)).unwrap();
    submit(&w.a, S2, NOON, form(5000, false)).unwrap();
}

#[test]
fn a_ticked_submission_is_refused_when_the_group_does_not_claim_gift_aid() {
    let w = world();
    open_pages(&w);
    let err = system(&w.a, NOON, |ctx| {
        stripe::submit(ctx, S1, form(2500, true), false)
    })
    .unwrap_err();
    assert_eq!(reason(err), "gift_aid_not_offered");
    assert_eq!(count(&w.a, "donation_submissions"), 0);
    // Not ticked: taken as any other.
    let held = system(&w.a, NOON, |ctx| {
        stripe::submit(ctx, S1, form(2500, false), false)
    })
    .unwrap();
    assert_eq!(held.typed.gift_aid, None);
}

#[test]
fn the_same_attempt_sent_twice_is_one_submission_as_first_stored() {
    let w = world();
    open_pages(&w);
    let first = submit(&w.a, S1, NOON, form(2500, true)).unwrap();
    let again = submit(&w.a, S1, NOON + 5000, form(9900, false)).unwrap();
    assert_eq!(again, first);
    assert_eq!(count(&w.a, "donation_submissions"), 1);
    // A key that isn't 32 hex is refused.
    assert_eq!(
        reason(submit(&w.a, "nope", NOON, form(2500, false)).unwrap_err()),
        "invalid id"
    );
}

#[test]
fn a_submission_is_never_edited_or_restored() {
    let w = world();
    open_pages(&w);
    let held = submit(&w.a, S1, NOON, form(2500, true)).unwrap();
    let err = tx(&w.a, |ctx| {
        execute(
            ctx,
            &DONATION_SUBMISSION,
            giving::stripe::DonationSubmissionPayload {
                amount: 100,
                ..held.typed.clone()
            },
            Exec::update(S1, None, Source::Ui),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "immutable");
    let revision: i64 = read(&w.a, |c| {
        c.query_row("SELECT id FROM revisions WHERE entity_id = ?1", [S1], |r| {
            r.get(0)
        })
    });
    assert!(tx(&w.a, |ctx| restore(ctx, &giving::REGISTRY, revision, None)).is_err());
    assert_eq!(read(&w.a, |c| stripe::submission(c, S1)).unwrap(), held);
}

// ── giving.donationSubmissionOutcome ───────────────────────────────────────

#[test]
fn a_submission_keeps_the_one_checkout_session_it_was_given() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S1, NOON, form(2500, false)).unwrap();
    submit(&w.a, S2, NOON, form(1000, false)).unwrap();
    let set = |id: &str, session: &str| {
        system(&w.a, NOON, |ctx| {
            stripe::set_checkout_session(ctx, id, session)
        })
    };
    assert_eq!(set(S1, "cs_1").unwrap().unwrap().counter, 1);
    // A repeat changes nothing; another session is refused.
    assert_eq!(set(S1, "cs_1").unwrap(), None);
    assert_eq!(reason(set(S1, "cs_2").unwrap_err()), "identity_immutable");
    // One session, one submission.
    assert_eq!(reason(set(S2, "cs_1").unwrap_err()), "duplicate");
    let found = read(&w.a, |c| stripe::submission_by_session(c, "cs_1")).unwrap();
    assert_eq!(found.id, S1);
    assert_eq!(
        read(&w.a, |c| stripe::submission_by_session(c, "cs_2")),
        None
    );
    // The typed slice's counter never moved.
    let version: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT version FROM donation_submissions WHERE id = ?1",
            [S1],
            |r| r.get(0),
        )
    });
    assert_eq!(version, 0);
}

#[test]
fn an_unpaid_or_expired_session_makes_no_gift_and_only_its_payment_makes_it_paid() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S1, NOON, form(2500, false)).unwrap();
    submit(&w.a, S2, NOON, form(2500, false)).unwrap();
    let state = |id: &str| read(&w.a, |c| stripe::submission(c, id)).unwrap().outcome;

    assert!(
        system(&w.a, NOON, |ctx| stripe::mark_expired(ctx, S1))
            .unwrap()
            .is_some()
    );
    assert_eq!(state(S1).state, SubmissionStatus::Expired);
    // A replayed event changes nothing.
    assert_eq!(
        system(&w.a, NOON, |ctx| stripe::mark_expired(ctx, S1)).unwrap(),
        None
    );
    assert_eq!(count(&w.a, "gifts"), 0);

    // Paid needs the payment that came from this submission.
    let (other, _) = record(&w.a, report("pi_other", Some(S2))).unwrap();
    let paid = |id: &str, payment: &str| {
        system(&w.a, NOON, |ctx| {
            let group = command_group(ctx, "stripe.donation")?;
            stripe::mark_paid(ctx, id, payment, &group)
        })
    };
    assert_eq!(reason(paid(S1, &other.id).unwrap_err()), "unknown_payment");
    assert_eq!(reason(paid(S1, S2).unwrap_err()), "unknown_payment");
    let err = tx(&w.a, |ctx| {
        execute(
            ctx,
            &DONATION_SUBMISSION_OUTCOME,
            SubmissionOutcomePayload {
                state: SubmissionStatus::Paid,
                ..state(S1)
            },
            Exec::update(S1, None, Source::System),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "invalid stripePaymentId");

    // The money decides: an expired submission whose payment arrives is paid.
    let (mine, _) = record(&w.a, report("pi_mine", Some(S1))).unwrap();
    assert!(paid(S1, &mine.id).unwrap().is_some());
    assert_eq!(state(S1).state, SubmissionStatus::Paid);
    assert_eq!(state(S1).stripe_payment_id, Some(mine.id.clone()));
    // Events out of order end in the same state: paid stays paid.
    assert_eq!(paid(S1, &mine.id).unwrap(), None);
    assert_eq!(
        system(&w.a, NOON, |ctx| stripe::mark_expired(ctx, S1)).unwrap(),
        None
    );
    assert_eq!(state(S1).state, SubmissionStatus::Paid);
    let err = tx(&w.a, |ctx| {
        execute(
            ctx,
            &DONATION_SUBMISSION_OUTCOME,
            SubmissionOutcomePayload {
                state: SubmissionStatus::Expired,
                stripe_payment_id: None,
                ..state(S1)
            },
            Exec::update(S1, None, Source::System),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "paid");
    // Recording payments and outcomes made no gift: that is the api's
    // command, with the contact and the match.
    assert_eq!(count(&w.a, "gifts"), 0);
}

#[test]
fn an_unpaid_submissions_personal_fields_are_cleared_after_30_days_and_its_row_stays() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S1, NOON, form(2500, true)).unwrap();
    system(&w.a, NOON, |ctx| {
        stripe::set_checkout_session(ctx, S1, "cs_1")
    })
    .unwrap();
    system(&w.a, NOON, |ctx| stripe::mark_expired(ctx, S1)).unwrap();
    // One still waiting at Stripe, never expired.
    submit(&w.a, S2, NOON + DAY, form(1000, false)).unwrap();

    // A day short: nothing is cleared, by the job or by hand.
    let cleared = system(&w.a, NOON + 30 * DAY - 1, |ctx| {
        stripe::clear_unpaid(ctx, 100)
    });
    assert_eq!(cleared.unwrap(), Vec::<String>::new());
    let outcome = read(&w.a, |c| stripe::submission(c, S1)).unwrap().outcome;
    let early = system(&w.a, NOON + 29 * DAY, |ctx| {
        execute(
            ctx,
            &DONATION_SUBMISSION_OUTCOME,
            SubmissionOutcomePayload {
                personal_cleared_at: Some(NOON + 29 * DAY),
                ..outcome.clone()
            },
            Exec::update(S1, None, Source::System),
        )
    });
    assert_eq!(reason(early.unwrap_err()), "retention_running");
    assert!(revisions(&w.a, S1)[0].2.contains("jane@example.org"));

    // Thirty days on: the first is cleared, the second a day later.
    let at = NOON + 30 * DAY;
    assert_eq!(
        system(&w.a, at, |ctx| stripe::clear_unpaid(ctx, 100)).unwrap(),
        [S1]
    );
    let held = read(&w.a, |c| stripe::submission(c, S1)).unwrap();
    assert_eq!(held.outcome.personal_cleared_at, Some(at));
    assert_eq!(held.outcome.state, SubmissionStatus::Expired);
    assert_eq!(held.outcome.checkout_session_id.as_deref(), Some("cs_1"));
    assert_eq!(
        (
            held.typed.first_name.as_str(),
            held.typed.last_name.as_str(),
            held.typed.email.as_str()
        ),
        ("", "", "")
    );
    // What isn't personal stays: the amount, the code, that Gift Aid was
    // ticked and under which wording.
    assert_eq!((held.typed.amount, held.submitted_at), (2500, NOON));
    assert_eq!(held.typed.source_code_id, w.code);
    assert_eq!(
        held.typed.gift_aid,
        Some(SubmissionGiftAid {
            address_line1: String::new(),
            postcode: String::new(),
            ..aid()
        })
    );
    // History holds none of it either, and says the clearing happened.
    let history = revisions(&w.a, S1);
    for (contract, _, payload) in &history {
        for personal in ["Jane", "Smith", "jane@example.org", "High Street", "AB1"] {
            assert!(!payload.contains(personal), "{contract}: {payload}");
        }
    }
    assert_eq!(history[0].0, "giving.donationSubmission");
    let last = history.last().unwrap();
    assert_eq!(last.0, "giving.donationSubmissionOutcome");
    assert!(last.2.contains(&format!("\"personalClearedAt\":{at}")));
    assert_eq!(count(&w.a, "donation_submissions"), 2);

    // Nothing is cleared twice, and the other isn't due until its own day.
    assert!(
        system(&w.a, at, |ctx| stripe::clear_unpaid(ctx, 100))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        system(&w.a, at + DAY, |ctx| stripe::clear_unpaid(ctx, 100)).unwrap(),
        [S2]
    );
    // A cleared submission can't become a gift, or be un-cleared.
    let (late, _) = record(&w.a, report("pi_late", Some(S1))).unwrap();
    let err = system(&w.a, at + DAY, |ctx| {
        let group = command_group(ctx, "stripe.donation")?;
        stripe::mark_paid(ctx, S1, &late.id, &group)
    })
    .unwrap_err();
    assert_eq!(reason(err), "cleared");
    let err = system(&w.a, at + DAY, |ctx| {
        execute(
            ctx,
            &DONATION_SUBMISSION_OUTCOME,
            SubmissionOutcomePayload {
                personal_cleared_at: None,
                ..held.outcome.clone()
            },
            Exec::update(S1, None, Source::System),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "cleared");
}

#[test]
fn a_paid_submissions_personal_fields_are_never_cleared() {
    let w = world();
    open_pages(&w);
    let typed = submit(&w.a, S1, NOON, form(2500, true)).unwrap().typed;
    let (payment, _) = record(&w.a, report("pi_1", Some(S1))).unwrap();
    system(&w.a, NOON, |ctx| {
        let group = command_group(ctx, "stripe.donation")?;
        stripe::mark_paid(ctx, S1, &payment.id, &group)
    })
    .unwrap();

    let years = NOON + 3650 * DAY;
    assert!(
        system(&w.a, years, |ctx| stripe::clear_unpaid(ctx, 100))
            .unwrap()
            .is_empty()
    );
    let held = read(&w.a, |c| stripe::submission(c, S1)).unwrap();
    let err = system(&w.a, years, |ctx| {
        execute(
            ctx,
            &DONATION_SUBMISSION_OUTCOME,
            SubmissionOutcomePayload {
                personal_cleared_at: Some(years),
                ..held.outcome.clone()
            },
            Exec::update(S1, None, Source::System),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "paid");
    assert_eq!(
        read(&w.a, |c| stripe::submission(c, S1)).unwrap().typed,
        typed
    );
    assert!(revisions(&w.a, S1)[0].2.contains("jane@example.org"));
}

/// Review M1: Stripe took the money and the payment waits in the staff
/// queue, so nothing marked the submission paid. It is still the
/// evidence for the gift that payment will become.
#[test]
fn a_submission_a_succeeded_payment_names_is_never_cleared_even_before_it_is_marked_paid() {
    let w = world();
    open_pages(&w);
    let typed = submit(&w.a, S1, NOON, form(2500, true)).unwrap().typed;
    let (payment, _) = record(&w.a, report("pi_1", Some(S1))).unwrap();
    system(&w.a, NOON, |ctx| {
        let unmatched = StripePaymentMatchPayload {
            unmatched: Some(UnmatchedReason::Ambiguous),
            ..StripePaymentMatchPayload::default()
        };
        stripe::set_match(ctx, &payment.id, unmatched, None, Source::System, None)
    })
    .unwrap();
    // Beside it, one whose only payment failed: that one is unpaid.
    submit(&w.a, S2, NOON, form(1000, false)).unwrap();
    record(
        &w.a,
        StripePaymentPayload {
            status: StripePaymentStatus::Failed,
            paid_on: None,
            ..report("pi_2", Some(S2))
        },
    )
    .unwrap();
    let held = read(&w.a, |c| stripe::submission(c, S1)).unwrap();
    assert_eq!(held.outcome.state, SubmissionStatus::Started);

    // Long past 30 days: the job skips it, and clears the other.
    let later = NOON + 400 * DAY;
    assert_eq!(
        system(&w.a, later, |ctx| stripe::clear_unpaid(ctx, 100)).unwrap(),
        [S2]
    );
    // The contract refuses it too, whoever asks.
    let err = system(&w.a, later, |ctx| {
        execute(
            ctx,
            &DONATION_SUBMISSION_OUTCOME,
            SubmissionOutcomePayload {
                personal_cleared_at: Some(later),
                ..held.outcome.clone()
            },
            Exec::update(S1, None, Source::System),
        )
    })
    .unwrap_err();
    assert_eq!(reason(err), "paid_for");
    let now = read(&w.a, |c| stripe::submission(c, S1)).unwrap();
    assert_eq!(now.typed, typed);
    assert_eq!(now.outcome.personal_cleared_at, None);
    assert!(revisions(&w.a, S1)[0].2.contains("jane@example.org"));

    // So when staff match the payment, it can still be marked paid, with
    // the donor's name and declaration to hand.
    let paid = system(&w.a, later, |ctx| {
        let group = command_group(ctx, "stripe.donation")?;
        stripe::mark_paid(ctx, S1, &payment.id, &group)
    });
    assert!(paid.unwrap().is_some());
    let now = read(&w.a, |c| stripe::submission(c, S1)).unwrap();
    assert_eq!(now.outcome.state, SubmissionStatus::Paid);
    assert_eq!(now.typed, typed);
}

/// Review L2: paid is for good, so a payment that hasn't succeeded
/// can't make a submission paid.
#[test]
fn a_payment_that_has_not_succeeded_does_not_make_its_submission_paid() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S1, NOON, form(2500, false)).unwrap();
    let mark = |payment: &str| {
        system(&w.a, NOON, |ctx| {
            let group = command_group(ctx, "stripe.donation")?;
            stripe::mark_paid(ctx, S1, payment, &group)
        })
    };
    let mut row = String::new();
    for status in [
        StripePaymentStatus::Pending,
        StripePaymentStatus::Failed,
        StripePaymentStatus::Cancelled,
    ] {
        let (payment, _) = record(
            &w.a,
            StripePaymentPayload {
                status,
                paid_on: None,
                ..report("pi_1", Some(S1))
            },
        )
        .unwrap();
        assert_eq!(
            reason(mark(&payment.id).unwrap_err()),
            "payment_not_succeeded",
            "{status:?}"
        );
        row = payment.id;
    }
    let held = read(&w.a, |c| stripe::submission(c, S1)).unwrap();
    assert_eq!(held.outcome.state, SubmissionStatus::Started);
    assert_eq!(held.outcome.stripe_payment_id, None);
    // The same payment, once the card goes through.
    record(&w.a, report("pi_1", None)).unwrap();
    assert!(mark(&row).unwrap().is_some());
    // A later refund or dispute doesn't undo paid, or trip the check.
    record(
        &w.a,
        StripePaymentPayload {
            refunded_amount: 2500,
            ..report("pi_1", None)
        },
    )
    .unwrap();
    assert_eq!(mark(&row).unwrap(), None);
    assert_eq!(
        read(&w.a, |c| stripe::submission(c, S1))
            .unwrap()
            .outcome
            .state,
        SubmissionStatus::Paid
    );
}

#[test]
fn clearing_takes_the_oldest_first_up_to_its_limit() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S2, NOON + 1000, form(1000, false)).unwrap();
    submit(&w.a, S1, NOON, form(1000, false)).unwrap();
    let at = NOON + 40 * DAY;
    assert_eq!(
        system(&w.a, at, |ctx| stripe::clear_unpaid(ctx, 1)).unwrap(),
        [S1]
    );
    assert_eq!(
        system(&w.a, at, |ctx| stripe::clear_unpaid(ctx, 1)).unwrap(),
        [S2]
    );
    assert!(
        system(&w.a, at, |ctx| stripe::clear_unpaid(ctx, 1))
            .unwrap()
            .is_empty()
    );
}

// ── giving.stripePayment ───────────────────────────────────────────────────

#[test]
fn a_payment_is_one_row_for_its_whole_life_following_what_stripe_reports() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S1, NOON, form(2500, false)).unwrap();
    let (first, changed) = record(&w.a, report("pi_1", Some(S1))).unwrap();
    assert!(changed);
    assert_eq!(first.payment, report("pi_1", Some(S1)));
    assert_eq!((first.version, first.match_version), (0, 0));
    assert_eq!(first.matched, StripePaymentMatchPayload::default());

    // A replay is a no-op, with or without the submission named again.
    for replay in [report("pi_1", Some(S1)), report("pi_1", None)] {
        let (same, changed) = record(&w.a, replay).unwrap();
        assert!(!changed);
        assert_eq!(same, first);
    }

    // Part refunded, then all of it, then a dispute: the same row.
    let partly = StripePaymentPayload {
        refunded_amount: 1000,
        reason: Some("  requested_by_customer ".into()),
        ..report("pi_1", None)
    };
    let (now, changed) = record(&w.a, partly).unwrap();
    assert!(changed);
    assert_eq!(now.id, first.id);
    assert_eq!(now.version, 1);
    assert_eq!(now.payment.submission_id.as_deref(), Some(S1));
    assert_eq!(now.payment.reason.as_deref(), Some("requested_by_customer"));
    assert_eq!(stripe::gift_status(&now.payment), giving::Status::Completed);
    assert_eq!(stripe::kept_amount(&now.payment), 1500);
    let disputed = StripePaymentPayload {
        dispute: Some(DisputeState::Lost),
        ..report("pi_1", None)
    };
    let (now, _) = record(&w.a, disputed).unwrap();
    assert_eq!(
        stripe::gift_status(&now.payment),
        giving::Status::ChargedBack
    );
    assert_eq!(count(&w.a, "stripe_payments"), 1);
    assert_eq!(
        read(&w.a, |c| stripe::payment_by_stripe_id(c, "pi_1")).unwrap(),
        now
    );
    assert_eq!(read(&w.a, |c| stripe::payment(c, &now.id)).unwrap(), now);
}

#[test]
fn a_payment_that_is_not_in_pounds_is_never_recorded() {
    let w = world();
    for currency in ["usd", "eur", ""] {
        let err = record(
            &w.a,
            StripePaymentPayload {
                currency: currency.into(),
                ..report("pi_1", None)
            },
        )
        .unwrap_err();
        assert_eq!(reason(err), "invalid currency", "{currency}");
    }
    assert_eq!(count(&w.a, "stripe_payments"), 0);
    // Stripe's own spelling of pounds is taken.
    record(
        &w.a,
        StripePaymentPayload {
            currency: "GBP".into(),
            ..report("pi_1", None)
        },
    )
    .unwrap();
}

#[test]
fn a_payment_keeps_its_stripe_id_and_its_submission() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S1, NOON, form(2500, false)).unwrap();
    submit(&w.a, S2, NOON, form(2500, false)).unwrap();
    let (held, _) = record(&w.a, report("pi_1", Some(S1))).unwrap();
    let update = |p: StripePaymentPayload| {
        tx(&w.a, |ctx| {
            execute(
                ctx,
                &STRIPE_PAYMENT,
                p,
                Exec::update(&held.id, None, Source::System),
            )
        })
    };
    assert_eq!(
        reason(update(report("pi_2", Some(S1))).unwrap_err()),
        "identity_immutable"
    );
    assert_eq!(
        reason(update(report("pi_1", Some(S2))).unwrap_err()),
        "identity_immutable"
    );
    assert_eq!(
        reason(update(report("pi_1", None)).unwrap_err()),
        "identity_immutable"
    );
    // A second row for the same Stripe payment is refused, naming the first.
    match tx(&w.a, |ctx| {
        execute(
            ctx,
            &STRIPE_PAYMENT,
            report("pi_1", None),
            Exec::create(Source::System),
        )
    }) {
        Err(ContractError::Duplicate { id }) => assert_eq!(id, held.id),
        other => panic!("{other:?}"),
    }
    // A payment can only come from a submission on record.
    assert_eq!(
        reason(
            record(
                &w.a,
                report("pi_3", Some("000000000000000000000000000000ff"))
            )
            .unwrap_err()
        ),
        "unknown_submission"
    );
    // Its amounts are checked as pence.
    for (bad, field) in [
        (
            StripePaymentPayload {
                amount: 0,
                ..report("pi_4", None)
            },
            "amount",
        ),
        (
            StripePaymentPayload {
                refunded_amount: 2501,
                ..report("pi_4", None)
            },
            "refundedAmount",
        ),
        (
            StripePaymentPayload {
                paid_on: None,
                ..report("pi_4", None)
            },
            "paidOn",
        ),
    ] {
        assert_eq!(
            reason(record(&w.a, bad).unwrap_err()),
            format!("invalid {field}")
        );
    }
    assert_eq!(count(&w.a, "stripe_payments"), 1);
}

// ── giving.stripePaymentMatch ──────────────────────────────────────────────

fn matched(contact: &str, gift: &str) -> StripePaymentMatchPayload {
    StripePaymentMatchPayload {
        contact_id: Some(contact.into()),
        gift_id: Some(gift.into()),
        ..StripePaymentMatchPayload::default()
    }
}

fn set_match(
    db: &OrgDb,
    id: &str,
    m: StripePaymentMatchPayload,
    expected: Option<i64>,
) -> Result<i64, ContractError> {
    tx(db, |ctx| {
        stripe::set_match(ctx, id, m, expected, Source::Ui, None).map(|e| e.counter)
    })
}

#[test]
fn an_unmatched_payment_has_no_gift_and_is_listed_for_staff_until_matched() {
    let w = world();
    let (first, _) = record(&w.a, report("pi_1", None)).unwrap();
    let (second, _) = record(&w.a, report("pi_2", None)).unwrap();
    // Not looked at yet: in no queue.
    assert!(read(&w.a, stripe::unmatched).is_empty());
    for (payment, why) in [
        (&first, UnmatchedReason::Ambiguous),
        (&second, UnmatchedReason::NameDiffers),
    ] {
        let unmatched = StripePaymentMatchPayload {
            unmatched: Some(why),
            ..StripePaymentMatchPayload::default()
        };
        system(&w.a, NOON, |ctx| {
            stripe::set_match(ctx, &payment.id, unmatched, None, Source::System, None)
        })
        .unwrap();
    }
    let queue = read(&w.a, stripe::unmatched);
    // Newest first, each with why.
    assert_eq!(
        queue
            .iter()
            .map(|p| (p.payment.payment_id.as_str(), p.matched.unmatched))
            .collect::<Vec<_>>(),
        [
            ("pi_2", Some(UnmatchedReason::NameDiffers)),
            ("pi_1", Some(UnmatchedReason::Ambiguous))
        ]
    );
    assert_eq!(count(&w.a, "gifts"), 0);

    // Staff match one with the counter they read; a second click is stale.
    let jo = contact(&w.a, "Jo", "Bloggs");
    let g = gift(&w.a, &jo, &w.code, 2500);
    assert_eq!(
        set_match(&w.a, &first.id, matched(&jo, &g), Some(1)).unwrap(),
        2
    );
    assert_eq!(
        reason(set_match(&w.a, &first.id, matched(&jo, &g), Some(1)).unwrap_err()),
        "stale"
    );
    let queue = read(&w.a, stripe::unmatched);
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].id, second.id);
    let now = read(&w.a, |c| stripe::payment(c, &first.id)).unwrap();
    assert_eq!(now.matched, matched(&jo, &g));
    assert_eq!(
        read(&w.a, |c| stripe::payment_of_gift(c, &g)).unwrap().id,
        first.id
    );
    // Who matched it and when are the command's.
    let (by, at): (Option<i64>, Option<i64>) = read(&w.a, |c| {
        c.query_row(
            "SELECT matched_by, matched_at FROM stripe_payments WHERE id = ?1",
            [&first.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    });
    assert_eq!(by, Some(ANN));
    assert!(at.is_some());
    // Stripe's record was untouched: its counter is its own.
    assert_eq!(now.version, 0);
}

#[test]
fn a_match_is_a_contact_and_that_contacts_gift_for_the_payments_whole_life() {
    let w = world();
    let (p, _) = record(&w.a, report("pi_1", None)).unwrap();
    let (q, _) = record(&w.a, report("pi_2", None)).unwrap();
    let jo = contact(&w.a, "Jo", "Bloggs");
    let sam = contact(&w.a, "Sam", "Bloggs");
    let jos = gift(&w.a, &jo, &w.code, 2500);
    let sams = gift(&w.a, &sam, &w.code, 2500);

    let half = StripePaymentMatchPayload {
        contact_id: Some(jo.clone()),
        ..StripePaymentMatchPayload::default()
    };
    assert_eq!(
        reason(set_match(&w.a, &p.id, half, None).unwrap_err()),
        "invalid giftId"
    );
    let both = StripePaymentMatchPayload {
        unmatched: Some(UnmatchedReason::Ambiguous),
        ..matched(&jo, &jos)
    };
    assert_eq!(
        reason(set_match(&w.a, &p.id, both, None).unwrap_err()),
        "invalid unmatched"
    );
    // A flag for staff needs a gift to be about.
    let flagged = StripePaymentMatchPayload {
        first_name_typed: Some("Jane".into()),
        ..StripePaymentMatchPayload::default()
    };
    assert_eq!(
        reason(set_match(&w.a, &p.id, flagged, None).unwrap_err()),
        "invalid giftId"
    );
    // Someone else's gift; a contact that doesn't exist.
    assert_eq!(
        reason(set_match(&w.a, &p.id, matched(&jo, &sams), None).unwrap_err()),
        "unknown_gift"
    );
    assert_eq!(
        reason(set_match(&w.a, &p.id, matched("nobody", &jos), None).unwrap_err()),
        "unknown_contact"
    );

    set_match(&w.a, &p.id, matched(&jo, &jos), None).unwrap();
    // One gift per payment: another payment can't take it,
    assert_eq!(
        reason(set_match(&w.a, &q.id, matched(&jo, &jos), None).unwrap_err()),
        "gift_taken"
    );
    // and this payment can't swap or drop it.
    assert_eq!(
        reason(set_match(&w.a, &p.id, matched(&sam, &sams), None).unwrap_err()),
        "already_matched"
    );
    assert_eq!(
        reason(set_match(&w.a, &p.id, StripePaymentMatchPayload::default(), None).unwrap_err()),
        "already_matched"
    );
    // A match isn't restorable history.
    let revision: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT id FROM revisions WHERE contract = 'giving.stripePaymentMatch'",
            [],
            |r| r.get(0),
        )
    });
    assert!(tx(&w.a, |ctx| restore(ctx, &giving::REGISTRY, revision, None)).is_err());
}

#[test]
fn the_staff_flags_ride_on_a_matched_payment_and_staff_clear_them() {
    let w = world();
    let (p, _) = record(&w.a, report("pi_1", None)).unwrap();
    let john = contact(&w.a, "John", "Smith");
    let g = gift(&w.a, &john, &w.code, 2500);
    // Linked on the last name; the donor typed another first name.
    let linked = StripePaymentMatchPayload {
        first_name_typed: Some("  Jane ".into()),
        ..matched(&john, &g)
    };
    system(&w.a, NOON, |ctx| {
        stripe::set_match(ctx, &p.id, linked, None, Source::System, None)
    })
    .unwrap();
    let now = read(&w.a, |c| stripe::payment(c, &p.id)).unwrap();
    assert_eq!(now.matched.first_name_typed.as_deref(), Some("Jane"));
    assert!(!now.matched.partial_refund_claimed);
    // The system matched it: nobody on the staff did.
    let by: Option<i64> = read(&w.a, |c| {
        c.query_row(
            "SELECT matched_by FROM stripe_payments WHERE id = ?1",
            [&p.id],
            |r| r.get(0),
        )
    });
    assert_eq!(by, None);

    // A partial refund on a claimed gift is flagged; the name flag stays.
    let refunded = StripePaymentMatchPayload {
        partial_refund_claimed: true,
        ..now.matched.clone()
    };
    system(&w.a, NOON, |ctx| {
        stripe::set_match(ctx, &p.id, refunded.clone(), None, Source::System, None)
    })
    .unwrap();
    // Staff have looked: they clear the name flag, with the counter read.
    let cleared = StripePaymentMatchPayload {
        first_name_typed: None,
        ..refunded
    };
    assert_eq!(set_match(&w.a, &p.id, cleared.clone(), Some(2)).unwrap(), 3);
    assert_eq!(
        read(&w.a, |c| stripe::payment(c, &p.id)).unwrap().matched,
        cleared
    );
}

// ── isolation ──────────────────────────────────────────────────────────────

#[test]
fn another_organisation_never_sees_a_submission_payment_or_queue() {
    let w = world();
    open_pages(&w);
    submit(&w.a, S1, NOON, form(2500, true)).unwrap();
    system(&w.a, NOON, |ctx| {
        stripe::set_checkout_session(ctx, S1, "cs_1")
    })
    .unwrap();
    let (payment, _) = record(&w.a, report("pi_1", Some(S1))).unwrap();
    system(&w.a, NOON, |ctx| {
        let unmatched = StripePaymentMatchPayload {
            unmatched: Some(UnmatchedReason::Ambiguous),
            ..StripePaymentMatchPayload::default()
        };
        stripe::set_match(ctx, &payment.id, unmatched, None, Source::System, None)
    })
    .unwrap();
    assert_eq!(read(&w.a, stripe::unmatched).len(), 1);

    // B reads nothing of it, by any key.
    assert_eq!(read(&w.b, |c| stripe::submission(c, S1)), None);
    assert_eq!(
        read(&w.b, |c| stripe::submission_by_session(c, "cs_1")),
        None
    );
    assert_eq!(read(&w.b, |c| stripe::payment(c, &payment.id)), None);
    assert_eq!(
        read(&w.b, |c| stripe::payment_by_stripe_id(c, "pi_1")),
        None
    );
    assert!(read(&w.b, stripe::unmatched).is_empty());
    for table in ["donation_submissions", "stripe_payments"] {
        assert_eq!(count(&w.b, table), 0, "{table}");
    }

    // A's ids under B are not found, and write nothing.
    let b_revisions = count(&w.b, "revisions");
    assert_eq!(
        reason(system(&w.b, NOON, |ctx| stripe::mark_expired(ctx, S1)).unwrap_err()),
        "not_found"
    );
    assert_eq!(
        reason(
            system(&w.b, NOON, |ctx| stripe::set_checkout_session(
                ctx, S1, "cs_9"
            ))
            .unwrap_err()
        ),
        "not_found"
    );
    assert_eq!(
        reason(
            set_match(
                &w.b,
                &payment.id,
                StripePaymentMatchPayload::default(),
                None
            )
            .unwrap_err()
        ),
        "not_found"
    );
    assert_eq!(
        reason(
            tx(&w.b, |ctx| {
                execute(
                    ctx,
                    &STRIPE_PAYMENT_MATCH,
                    StripePaymentMatchPayload::default(),
                    Exec::update(&payment.id, None, Source::Ui),
                )
            })
            .unwrap_err()
        ),
        "not_found"
    );
    // A payment reported to B naming A's submission is refused.
    assert_eq!(
        reason(record(&w.b, report("pi_2", Some(S1))).unwrap_err()),
        "unknown_submission"
    );
    assert_eq!(count(&w.b, "revisions"), b_revisions);
    for table in ["donation_submissions", "stripe_payments"] {
        assert_eq!(count(&w.b, table), 0, "{table}");
    }

    // The same attempt key and the same Stripe ids in B are B's own rows.
    let theirs = submit(&w.b, S1, NOON, form(1000, false)).unwrap();
    assert_eq!(theirs.typed.source_code_id, w.code_b);
    assert_eq!(
        read(&w.a, |c| stripe::submission(c, S1))
            .unwrap()
            .typed
            .amount,
        2500
    );
    // Clearing B's old submissions leaves A's alone.
    let later = NOON + 31 * DAY;
    assert_eq!(
        system(&w.b, later, |ctx| stripe::clear_unpaid(ctx, 100)).unwrap(),
        [S1]
    );
    assert_eq!(
        read(&w.a, |c| stripe::submission(c, S1))
            .unwrap()
            .typed
            .email,
        "jane@example.org"
    );
}
