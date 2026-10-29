//! A regular gift's terms as a dated chain (ADR 0026) on a real org file:
//! the contracts (edit and withdraw while scheduled only, the effective
//! date after what GoCardless has, restores), the set-up's v1 revisions,
//! and payments copying the split in force on their scheduled date.

use std::sync::Arc;

use contacts::acquisition::{NewContact, create_contact};
use contacts::types::{CreateContact, Details, Kind};
use contracts::{ContractError, Ctx, Exec, Source, execute, restore};
use giving::regular::{
    Frequency, GiftChange, MandatePayload, PaymentOwner, PaymentReport, PaymentStatus,
    RegularStatus, SetUp, create_regular_gift, end_regular_gift, record_payment,
};
use giving::terms::{
    self, SyncState, TermAllocationRow, TermChange, TermStatus, TermView, change_terms, edit_terms,
    set_code, update_sync, withdraw,
};
use giving::terms_rules::day_number;
use giving::types::{AllocationRow, GiftPayload};
use giving::{GIFT, REGISTRY};
use rusqlite::Connection;
use sources::SourceCodePayload;
use store::{M, Migrations, OrgDb, Store, StoreConfig};

const ANN: i64 = 1;

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    jo: String,
    street: String,
    phone: String,
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
        M::up(giving::MIGRATION_DIRECT_DEBIT),
        M::up(giving::MIGRATION_UNIFIED),
        M::up(giving::terms::MIGRATION),
    ])
}

/// Midday UTC on `date`, in ms.
fn at(date: &str) -> i64 {
    day_number(date).unwrap() * 86_400_000 + 12 * 3_600_000
}

fn tx_at<T>(
    db: &OrgDb,
    date: &str,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    contracts::transact(db, Some(ANN), |ctx| {
        f(&Ctx {
            tx: ctx.tx,
            actor: ctx.actor,
            at: at(date),
        })
    })
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    db.read(|c| f(c)).unwrap()
}

fn code(db: &OrgDb, category: &str, detail: &str) -> String {
    let category = read(db, sources::tree)
        .into_iter()
        .find(|p| p.parent_id.is_none() && p.name == category)
        .unwrap()
        .id;
    tx_at(db, "2026-01-01", |ctx| {
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
    .unwrap()
    .version_id
    .unwrap()
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
    contracts::transact(&a, Some(ANN), sources::seed_new_org).unwrap();
    let jo = tx_at(&a, "2026-01-01", |ctx| {
        create_contact(
            ctx,
            NewContact {
                create: CreateContact {
                    id: None,
                    details: Details {
                        client_key: None,
                        kind: Kind::Individual,
                        title: String::new(),
                        first_name: "Jo".into(),
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
    .id;
    let street = code(&a, "Street", "Wesser");
    let phone = code(&a, "Online", "Phone");
    World {
        _tmp: tmp,
        a,
        jo,
        street,
        phone,
    }
}

/// £10 a month on the 5th from `Street`, set up on 1 September 2026.
fn regular(w: &World) -> String {
    let id = contracts::new_id();
    tx_at(&w.a, "2026-09-01", |ctx| {
        create_regular_gift(
            ctx,
            &id,
            SetUp {
                contact_id: w.jo.clone(),
                amount: 1000,
                frequency: Frequency::Monthly,
                day_of_month: 5,
                month: None,
                source_code_id: w.street.clone(),
                client_key: None,
            },
            MandatePayload::default(),
            Source::Ui,
        )
    })
    .unwrap()
}

fn upgrade(w: &World, from: &str, amount: i64) -> TermChange {
    TermChange {
        effective_from: from.into(),
        amount,
        frequency: None,
        day_of_month: None,
        month: None,
        change_code_id: Some(w.phone.clone()),
        allocations: None,
        note: Some("phone call".into()),
    }
}

fn chain(w: &World, id: &str) -> Vec<TermView> {
    read(&w.a, |c| terms::chain(c, id))
}

fn split(t: &TermView) -> Vec<(String, i64)> {
    t.allocations
        .iter()
        .map(|a| (a.source_code_id.clone(), a.amount))
        .collect()
}

fn rejected(e: ContractError) -> String {
    match e {
        ContractError::Rejected { reason, .. } => reason,
        ContractError::Invalid(p) => format!("invalid {}", p[0].field),
        other => panic!("{other:?}"),
    }
}

fn pay(w: &World, regular: &str, pm: &str, amount: i64, date: &str) -> String {
    let change = tx_at(&w.a, date, |ctx| {
        record_payment(
            ctx,
            PaymentReport {
                payment_id: pm.into(),
                amount,
                charge_date: date.into(),
                status: PaymentStatus::Pending,
                reason: None,
                mandate_id: None,
                subscription_id: Some("SB1".into()),
            },
            PaymentOwner::Regular(regular.to_owned()),
        )
    })
    .unwrap();
    match change {
        GiftChange::Recorded(g) => g,
        other => panic!("{other:?}"),
    }
}

fn gift_split(w: &World, gift: &str) -> Vec<(String, i64)> {
    read(&w.a, |c| giving::get(c, gift))
        .unwrap()
        .gift
        .allocations
        .into_iter()
        .map(|a| (a.source_code_id, a.amount))
        .collect()
}

#[test]
fn set_up_writes_the_first_row_one_code_for_the_whole_amount() {
    let w = world();
    let id = regular(&w);
    let c = chain(&w, &id);
    assert_eq!(c.len(), 1);
    assert_eq!(
        (c[0].effective_from.as_str(), c[0].status, c[0].amount),
        ("2026-09-01", TermStatus::Applied, 1000)
    );
    assert_eq!(split(&c[0]), [(w.street.clone(), 1000)]);
}

#[test]
fn an_upgrade_adds_a_scheduled_row_with_the_difference_on_its_code() {
    let w = world();
    let id = regular(&w);
    let row = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-12-05", 1200), Source::Ui)
    })
    .unwrap();
    let c = chain(&w, &id);
    let t = c.iter().find(|t| t.id == row).unwrap();
    assert_eq!(t.status, TermStatus::Scheduled);
    assert_eq!(split(t), [(w.street.clone(), 1000), (w.phone.clone(), 200)]);
    assert_eq!(t.change_code_id.as_deref(), Some(w.phone.as_str()));
    assert_eq!(t.change_kind, giving::terms_rules::ChangeKind::Upgrade);
    // An upgrade with no code is refused; a downgrade needs none.
    let mut no_code = upgrade(&w, "2027-01-05", 1500);
    no_code.change_code_id = None;
    let err = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, no_code, Source::Ui)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "invalid changeCodeId");
    let mut down = upgrade(&w, "2027-01-05", 1100);
    down.change_code_id = None;
    let down = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, down, Source::Ui)
    })
    .unwrap();
    let c = chain(&w, &id);
    let t = c.iter().find(|t| t.id == down).unwrap();
    assert_eq!(split(t), [(w.street.clone(), 1000), (w.phone.clone(), 100)]);
    // A date already past, or one another live row starts on, is refused.
    let err = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-10-05", 1300), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "invalid effectiveFrom");
    let err = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-12-05", 1300), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "term_clash");
}

#[test]
fn a_row_is_edited_or_withdrawn_only_while_scheduled() {
    let w = world();
    let id = regular(&w);
    let row = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-12-05", 1200), Source::Ui)
    })
    .unwrap();
    // Edited while scheduled.
    let done = tx_at(&w.a, "2026-11-02", |ctx| {
        edit_terms(ctx, &row, 0, upgrade(&w, "2026-12-05", 1300), Source::Ui)
    })
    .unwrap();
    assert_eq!(done.counter, 1);
    // Sent: neither an edit nor a withdraw.
    tx_at(&w.a, "2026-11-21", |ctx| {
        update_sync(ctx, &row, None, |s| {
            s.state = SyncState::Sent;
            s.subscription_id = Some("SB1".into());
        })
    })
    .unwrap();
    let err = tx_at(&w.a, "2026-11-22", |ctx| {
        edit_terms(ctx, &row, 1, upgrade(&w, "2026-12-05", 1400), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "term_sent");
    let err = tx_at(&w.a, "2026-11-22", |ctx| {
        withdraw(ctx, &row, Some(1), Source::Ui, None)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "term_sent");
    // Its code can still be fixed.
    tx_at(&w.a, "2026-11-22", |ctx| {
        set_code(ctx, &row, 1, Some(w.street.clone()), Source::Ui)
    })
    .unwrap();
    // A later change must come after the sent row's date.
    let err = tx_at(&w.a, "2026-11-22", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-11-30", 1500), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "term_too_early");
    // Staff never write the sync slice.
    let err = tx_at(&w.a, "2026-11-22", |ctx| {
        execute(
            ctx,
            &terms::REGULAR_GIFT_TERM_SYNC,
            terms::SyncPayload::default(),
            Exec::update(&row, None, Source::Ui),
        )
    })
    .unwrap_err();
    assert_eq!(rejected(err), "not_restorable");
}

#[test]
fn restoring_a_scheduled_rows_revision_works_and_a_sent_rows_is_refused() {
    let w = world();
    let id = regular(&w);
    let row = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-12-05", 1200), Source::Ui)
    })
    .unwrap();
    tx_at(&w.a, "2026-11-02", |ctx| {
        edit_terms(ctx, &row, 0, upgrade(&w, "2026-12-05", 1500), Source::Ui)
    })
    .unwrap();
    let first: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT min(id) FROM revisions WHERE entity_id = ?1
             AND contract = 'giving.regularGiftTerms'",
            [&row],
            |r| r.get(0),
        )
    });
    tx_at(&w.a, "2026-11-03", |ctx| {
        restore(ctx, &REGISTRY, first, None)
    })
    .unwrap();
    let c = chain(&w, &id);
    assert_eq!(c.iter().find(|t| t.id == row).unwrap().amount, 1200);
    tx_at(&w.a, "2026-11-21", |ctx| {
        update_sync(ctx, &row, None, |s| s.state = SyncState::Sent)
    })
    .unwrap();
    let err = tx_at(&w.a, "2026-11-22", |ctx| {
        restore(ctx, &REGISTRY, first, None)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "term_sent");
}

/// The controller's ask: a v1 `giving.regularGift` revision held the
/// terms. Restoring it upcasts to v2 (the terms dropped) and leaves the
/// chain, where they live now, as it is.
#[test]
fn restoring_a_v1_regular_gift_revision_keeps_the_terms_in_the_chain() {
    let w = world();
    let id = regular(&w);
    let rev: i64 =
        w.a.write_raw(|raw| {
            let c = raw.conn();
            c.execute(
                "INSERT INTO revisions (entity, entity_id, contract, version, counter, payload,
                     actor, source, at)
                 VALUES ('regular_gifts', ?1, 'giving.regularGift', 1, 1, ?2, 1, 'ui', 1)",
                rusqlite::params![
                    id,
                    serde_json::json!({
                        "contactId": w.jo,
                        "amount": 500,
                        "frequency": "yearly",
                        "dayOfMonth": 9,
                        "month": 4,
                        "sourceCodeId": w.phone
                    })
                    .to_string()
                ],
            )?;
            Ok::<_, rusqlite::Error>(c.last_insert_rowid())
        })
        .unwrap();
    let before = chain(&w, &id);
    tx_at(&w.a, "2026-11-01", |ctx| restore(ctx, &REGISTRY, rev, None)).unwrap();
    let after = chain(&w, &id);
    assert_eq!(after.len(), 1);
    assert_eq!(
        (after[0].amount, after[0].frequency, split(&after[0])),
        (before[0].amount, before[0].frequency, split(&before[0]))
    );
}

#[test]
fn a_payment_copies_the_split_in_force_on_its_scheduled_date() {
    let w = world();
    let id = regular(&w);
    tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-12-05", 1200), Source::Ui)
    })
    .unwrap();
    let nov = pay(&w, &id, "PM1", 1000, "2026-11-05");
    assert_eq!(gift_split(&w, &nov), [(w.street.clone(), 1000)]);
    let dec = pay(&w, &id, "PM2", 1200, "2026-12-05");
    assert_eq!(
        gift_split(&w, &dec),
        [(w.street.clone(), 1000), (w.phone.clone(), 200)]
    );
    // Collected less under the new row: the newest layer absorbs it.
    let jan = pay(&w, &id, "PM3", 1000, "2027-01-05");
    assert_eq!(gift_split(&w, &jan), [(w.street.clone(), 1000)]);
    let scheduled: String = read(&w.a, |c| {
        c.query_row(
            "SELECT scheduled_on FROM gifts WHERE id = ?1 /* any status: one gift */",
            [&dec],
            |r| r.get(0),
        )
    });
    assert_eq!(scheduled, "2026-12-05");
}

#[test]
fn a_retry_collected_later_keeps_its_period() {
    let w = world();
    let id = regular(&w);
    let gift = pay(&w, &id, "PM1", 1000, "2026-11-05");
    tx_at(&w.a, "2026-11-12", |ctx| {
        record_payment(
            ctx,
            PaymentReport {
                payment_id: "PM1".into(),
                amount: 1000,
                charge_date: "2026-11-12".into(),
                status: PaymentStatus::Confirmed,
                reason: None,
                mandate_id: None,
                subscription_id: Some("SB1".into()),
            },
            PaymentOwner::Regular(id.clone()),
        )
    })
    .unwrap();
    let g = read(&w.a, |c| giving::get(c, &gift)).unwrap().gift;
    assert_eq!(g.received_on, "2026-11-12");
    let scheduled: String = read(&w.a, |c| {
        c.query_row(
            "SELECT scheduled_on FROM gifts WHERE id = ?1 /* any status: one gift */",
            [&gift],
            |r| r.get(0),
        )
    });
    assert_eq!(scheduled, "2026-11-05");
}

#[test]
fn editing_one_gifts_split_leaves_the_chain_alone() {
    let w = world();
    let id = regular(&w);
    let gift = pay(&w, &id, "PM1", 1000, "2026-11-05");
    let g = read(&w.a, |c| giving::get(c, &gift)).unwrap().gift;
    tx_at(&w.a, "2026-11-06", |ctx| {
        execute(
            ctx,
            &GIFT,
            GiftPayload {
                contact_id: g.contact_id.clone(),
                received_on: g.received_on.clone(),
                amount: g.amount,
                method: g.method,
                reference: g.reference.clone(),
                allocations: vec![
                    AllocationRow {
                        key: None,
                        source_code_id: w.street.clone(),
                        amount: 600,
                    },
                    AllocationRow {
                        key: None,
                        source_code_id: w.phone.clone(),
                        amount: 400,
                    },
                ],
                client_key: None,
                origin: None,
            },
            Exec::update(&gift, None, Source::Ui),
        )
    })
    .unwrap();
    let c = chain(&w, &id);
    assert_eq!(c.len(), 1);
    assert_eq!(split(&c[0]), [(w.street.clone(), 1000)]);
}

#[test]
fn a_change_too_late_for_its_payment_moves_to_the_next_one() {
    let w = world();
    let id = regular(&w);
    let row = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-12-05", 1200), Source::Ui)
    })
    .unwrap();
    tx_at(&w.a, "2026-11-21", |ctx| {
        update_sync(ctx, &row, None, |s| s.state = SyncState::Sent)
    })
    .unwrap();
    // GoCardless had already made December's payment at £10.
    let dec = pay(&w, &id, "PM2", 1000, "2026-12-05");
    let c = chain(&w, &id);
    let t = c.iter().find(|t| t.id == row).unwrap();
    assert_eq!(
        (
            t.effective_from.as_str(),
            t.applies_from.as_deref(),
            t.status
        ),
        ("2026-12-05", Some("2027-01-05"), TermStatus::Sent)
    );
    assert_eq!(gift_split(&w, &dec), [(w.street.clone(), 1000)]);
    // January's at £12 applies it.
    let jan = pay(&w, &id, "PM3", 1200, "2027-01-05");
    let c = chain(&w, &id);
    assert_eq!(
        c.iter().find(|t| t.id == row).unwrap().status,
        TermStatus::Applied
    );
    assert_eq!(
        gift_split(&w, &jan),
        [(w.street.clone(), 1000), (w.phone.clone(), 200)]
    );
}

#[test]
fn a_cancelled_gifts_scheduled_rows_are_withdrawn() {
    let w = world();
    let id = regular(&w);
    let row = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2026-12-05", 1200), Source::Ui)
    })
    .unwrap();
    tx_at(&w.a, "2026-11-10", |ctx| {
        end_regular_gift(
            ctx,
            &id,
            None,
            RegularStatus::Cancelled,
            Some("Cancelled by staff".into()),
            Source::Ui,
        )
    })
    .unwrap();
    let c = chain(&w, &id);
    assert_eq!(
        c.iter().find(|t| t.id == row).unwrap().status,
        TermStatus::Withdrawn
    );
    // And no new change on an ended gift.
    let err = tx_at(&w.a, "2026-11-11", |ctx| {
        change_terms(ctx, &id, None, upgrade(&w, "2027-01-05", 1200), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "regular_gift_ended");
}

#[test]
fn a_change_made_in_gocardless_is_an_uncoded_row_until_staff_code_it() {
    let w = world();
    let id = regular(&w);
    let row = tx_at(&w.a, "2026-11-20", |ctx| {
        terms::record_outside_change(ctx, &id, "SB1", 1500, "2026-12-05")
    })
    .unwrap()
    .unwrap();
    let c = chain(&w, &id);
    let t = c.iter().find(|t| t.id == row).unwrap();
    assert!(t.uncoded);
    assert_eq!(t.note.as_deref(), Some(terms::CHANGED_IN_GOCARDLESS));
    assert_eq!(t.status, TermStatus::Applied);
    // The difference on the newest layer.
    assert_eq!(split(t), [(w.street.clone(), 1500)]);
    tx_at(&w.a, "2026-11-21", |ctx| {
        set_code(ctx, &row, 0, Some(w.phone.clone()), Source::Ui)
    })
    .unwrap();
    let c = chain(&w, &id);
    assert!(!c.iter().any(|t| t.uncoded));
    // A repeat of the same amount records nothing.
    let again = tx_at(&w.a, "2026-11-22", |ctx| {
        terms::record_outside_change(ctx, &id, "SB1", 1500, "2026-12-05")
    })
    .unwrap();
    assert_eq!(again, None);
}

#[test]
fn a_frequency_change_needs_its_split_and_never_divides() {
    let w = world();
    let id = regular(&w);
    let change = TermChange {
        frequency: Some(Frequency::Yearly),
        month: Some(3),
        ..upgrade(&w, "2027-03-05", 12_000)
    };
    let err = tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, change.clone(), Source::Ui)
    })
    .unwrap_err();
    assert_eq!(rejected(err), "invalid allocations");
    let with_split = TermChange {
        allocations: Some(vec![TermAllocationRow {
            key: None,
            source_code_id: w.street.clone(),
            amount: 12_000,
        }]),
        change_code_id: None,
        ..change
    };
    tx_at(&w.a, "2026-11-01", |ctx| {
        change_terms(ctx, &id, None, with_split, Source::Ui)
    })
    .unwrap();
    let c = chain(&w, &id);
    assert_eq!(
        c.last().unwrap().change_kind,
        giving::terms_rules::ChangeKind::Schedule
    );
}
