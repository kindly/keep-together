//! Bank transfers on the giving side (ADR 0027, plan
//! `factory/plans/bank-transfers.sv` b6): money, cheques, gifts from
//! statement lines, paying-in batches. On a real org file. The statement
//! side (accounts, imports, lines) is `banking`'s, which this crate can't
//! name, so its rows are written raw here, as an import would leave them.

use std::sync::Arc;

use contacts::acquisition::{NewContact, create_contact};
use contacts::types::{CreateContact, Details, Kind};
use contracts::{ContractError, Ctx, Exec, Executed, Source, command_group, execute};
use giving::bank::{
    BATCH_UNMATCHED_REASON, LINE_UNMATCHED_REASON, gifts_on_line, match_batch, release_line,
    set_line, transfers_not_on_a_statement, unmatch_batch,
};
use giving::types::{
    AllocationRow, BatchStatus, GiftPayload, GiftRow, Method, PayingInBatchPayload,
    PayingInBatchRow, Status,
};
use giving::{GIFT, PAYING_IN_BATCH, PENCE_MAX};
use rusqlite::Connection;
use sources::SourceCodePayload;
use store::{M, Migrations, OrgDb, Store, StoreConfig};

const ANN: i64 = 1;
const CLAIM: &str = "0190f0c0a0b0c0d0e0f0a0b0c0d0ea01";

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    jo: String,
    code: String,
    account: String,
    import: String,
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
        // On an empty file: no rows for the rebuilds to carry.
        M::up(giving::MIGRATION_DIRECT_DEBIT),
        M::up(giving::MIGRATION_UNIFIED),
        M::up(giving::terms::MIGRATION),
        M::up(giving::bank::MIGRATION),
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
    tx(&a, sources::seed_new_org).unwrap();
    let jo = contact(&a);
    let code = code(&a, "Unsolicited transfer");
    let (account, import) = (contracts::new_id(), contracts::new_id());
    raw(
        &a,
        "INSERT INTO bank_accounts (id, name, created_at) VALUES (?1, 'CAF current', 1)",
        &[&account],
    );
    raw(
        &a,
        "INSERT INTO bank_imports (id, account_id, file_name, format, imported_at)
         VALUES (?1, ?2, 'oct.csv', 'csv', 1)",
        &[&import, &account],
    );
    World {
        _tmp: tmp,
        a,
        jo,
        code,
        account,
        import,
    }
}

fn tx<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    contracts::transact(db, Some(ANN), f)
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    db.read(|c| f(c)).unwrap()
}

/// What `banking` writes, written by hand.
fn raw(db: &OrgDb, sql: &str, params: &[&dyn rusqlite::ToSql]) {
    db.write_raw(|r| r.conn().execute(sql, params).map(|_| ()))
        .unwrap();
}

fn contact(db: &OrgDb) -> String {
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
    .id
}

/// A version under a seeded category: what a gift is coded to.
fn code(db: &OrgDb, name: &str) -> String {
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
                name: name.into(),
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

/// A credit line on the account's statement, as an import leaves it.
fn line(w: &World, amount: i64, posted_on: &str) -> String {
    let id = contracts::new_id();
    raw(
        &w.a,
        "INSERT INTO bank_lines (id, account_id, import_id, posted_on, amount, payer,
             reference, narrative, dedupe_key, occurrence)
         VALUES (?1, ?2, ?3, ?4, ?5, 'J BLOGGS', '100016', 'FASTER PAYMENT', ?1, 1)",
        &[&id, &w.account, &w.import, &posted_on, &amount],
    );
    id
}

fn payload(w: &World, method: Method, amount: i64) -> GiftPayload {
    GiftPayload {
        contact_id: w.jo.clone(),
        received_on: "2026-10-14".into(),
        amount,
        method,
        reference: None,
        allocations: vec![AllocationRow {
            key: None,
            source_code_id: w.code.clone(),
            amount,
        }],
        client_key: None,
        origin: None,
        from_line: None,
        paying_in_batch_id: None,
    }
}

fn record(w: &World, p: GiftPayload) -> Result<String, ContractError> {
    tx(&w.a, |ctx| giving::create_gift(ctx, p, Source::Ui, None))
}

fn gift(w: &World, id: &str) -> GiftRow {
    read(&w.a, |c| giving::get(c, id)).unwrap().gift
}

fn set_status(w: &World, id: &str, status: Status) -> Result<Executed, ContractError> {
    let expected = gift(w, id).status_version;
    tx(&w.a, |ctx| {
        giving::set_status(ctx, id, expected, status, None, Source::Ui)
    })
}

/// Save the gift's slice with `f` applied to it as it is stored.
fn save(w: &World, id: &str, f: impl FnOnce(&mut GiftPayload)) -> Result<Executed, ContractError> {
    let g = gift(w, id);
    let mut p = GiftPayload {
        contact_id: g.contact_id,
        received_on: g.received_on,
        amount: g.amount,
        method: g.method,
        reference: g.reference,
        allocations: g
            .allocations
            .into_iter()
            .map(|a| AllocationRow {
                key: Some(a.key),
                source_code_id: a.source_code_id,
                amount: a.amount,
            })
            .collect(),
        client_key: None,
        origin: None,
        from_line: None,
        paying_in_batch_id: None,
    };
    f(&mut p);
    tx(&w.a, |ctx| {
        execute(
            ctx,
            &GIFT,
            p,
            Exec::update(id, Some(g.gift_version), Source::Ui),
        )
    })
}

fn link(w: &World, id: &str, line: Option<&str>) -> Result<Executed, ContractError> {
    let expected = gift(w, id).line_version;
    tx(&w.a, |ctx| {
        let group = command_group(ctx, "match line")?;
        set_line(ctx, id, expected, line, Source::Ui, &group)
    })
}

fn unmatch_line(w: &World, line: &str) -> Vec<String> {
    tx(&w.a, |ctx| {
        let group = command_group(ctx, "unmatch line")?;
        release_line(ctx, line, LINE_UNMATCHED_REASON, Source::Ui, &group)
    })
    .unwrap()
}

fn batch_payload(w: &World) -> PayingInBatchPayload {
    PayingInBatchPayload {
        account_id: w.account.clone(),
        slip_number: "000123".into(),
        banked_on: None,
        total: None,
        status: BatchStatus::Open,
    }
}

fn open_batch(w: &World) -> String {
    tx(&w.a, |ctx| {
        execute(
            ctx,
            &PAYING_IN_BATCH,
            batch_payload(w),
            Exec::create(Source::Ui),
        )
    })
    .unwrap()
    .id
}

fn batch(w: &World, id: &str) -> PayingInBatchRow {
    read(&w.a, |c| giving::bank::get_batch(c, id)).unwrap()
}

fn save_batch(
    w: &World,
    id: &str,
    f: impl FnOnce(&mut PayingInBatchPayload),
) -> Result<Executed, ContractError> {
    let b = batch(w, id);
    let mut p = b.batch;
    f(&mut p);
    tx(&w.a, |ctx| {
        execute(
            ctx,
            &PAYING_IN_BATCH,
            p,
            Exec::update(id, Some(b.version), Source::Ui),
        )
    })
}

fn close_batch(w: &World, id: &str, total: i64) {
    save_batch(w, id, |p| {
        p.status = BatchStatus::Closed;
        p.total = Some(total);
        p.banked_on = Some("2026-10-19".into());
    })
    .unwrap();
}

fn match_to(w: &World, id: &str, line: &str) -> Result<Executed, ContractError> {
    let expected = batch(w, id).line_version;
    tx(&w.a, |ctx| {
        let group = command_group(ctx, "match batch")?;
        match_batch(ctx, id, expected, line, Source::Ui, &group)
    })
}

fn unmatch(w: &World, id: &str) -> Result<Executed, ContractError> {
    let expected = batch(w, id).line_version;
    tx(&w.a, |ctx| {
        let group = command_group(ctx, "unmatch batch")?;
        unmatch_batch(ctx, id, expected, Source::Ui, &group)
    })
}

fn cheque_in(w: &World, batch: &str, amount: i64) -> String {
    record(
        w,
        GiftPayload {
            reference: Some("000456".into()),
            paying_in_batch_id: Some(batch.into()),
            ..payload(w, Method::Cheque, amount)
        },
    )
    .unwrap()
}

fn claim(w: &World, id: &str) -> Result<Executed, ContractError> {
    tx(&w.a, |ctx| {
        let group = command_group(ctx, "Gift Aid claim")?;
        giving::lock_for_claim(ctx, id, CLAIM, Source::Ui, &group)
    })
}

fn received(w: &World) -> i64 {
    read(&w.a, |c| {
        giving::received_total(c, "2026-01-01", "2026-12-31")
    })
}

fn claimable(w: &World) -> Vec<String> {
    read(&w.a, |c| {
        giving::unclaimed_between(c, "2026-01-01", "2026-12-31")
    })
    .into_iter()
    .map(|g| g.id)
    .collect()
}

fn reason(err: ContractError) -> String {
    match err {
        ContractError::Rejected { reason, .. } => reason,
        other => format!("{other:?}"),
    }
}

fn fields(err: ContractError) -> Vec<String> {
    match err {
        ContractError::Invalid(p) => p.into_iter().map(|p| p.field).collect(),
        other => panic!("expected invalid, got {other:?}"),
    }
}

// ── money ──────────────────────────────────────────────────────────────────

/// Rule 7: pence are integers end to end. A batch's total arrives as a
/// JSON integer (a fraction is refused before any rule runs), must be
/// over 0 and at most what JSON carries exactly, and what its gifts add
/// up to is summed in pence.
#[test]
fn batch_totals_and_gift_amounts_are_integer_pence() {
    let w = world();
    let fraction = serde_json::from_value::<PayingInBatchPayload>(serde_json::json!({
        "accountId": w.account, "slipNumber": "1", "status": "closed",
        "bankedOn": "2026-10-19", "total": 10.5,
    }));
    assert!(fraction.is_err());

    let id = open_batch(&w);
    for (total, field) in [(0, "total"), (-1, "total"), (PENCE_MAX + 1, "total")] {
        let err = save_batch(&w, &id, |p| p.total = Some(total)).unwrap_err();
        assert_eq!(fields(err), [field], "{total}");
    }
    cheque_in(&w, &id, 1);
    record(
        &w,
        GiftPayload {
            paying_in_batch_id: Some(id.clone()),
            ..payload(&w, Method::Cash, 2_000_002)
        },
    )
    .unwrap();
    let b = batch(&w, &id);
    assert_eq!((b.gift_count, b.gifts_total), (2, 2_000_003));
    // A pending cheque was paid in, but isn't money received.
    assert_eq!(received(&w), 2_000_002);
}

// ── cheques ────────────────────────────────────────────────────────────────

/// HMRC counts a cheque once it clears (g2q4): pending on entry, staff
/// can't clear it while its batch waits for its line, and matching the
/// batch to its statement line clears it.
#[test]
fn a_cheque_is_pending_until_its_batch_is_matched_to_a_line() {
    let w = world();
    let b = open_batch(&w);
    let cheque = cheque_in(&w, &b, 3000);
    assert_eq!(gift(&w, &cheque).status, Status::Pending);
    assert_eq!(
        reason(set_status(&w, &cheque, Status::Completed).unwrap_err()),
        "cheque_not_cleared"
    );
    close_batch(&w, &b, 3000);
    assert_eq!(
        reason(set_status(&w, &cheque, Status::Completed).unwrap_err()),
        "cheque_not_cleared"
    );
    assert_eq!(received(&w), 0);

    let slip = line(&w, 3000, "2026-10-20");
    match_to(&w, &b, &slip).unwrap();
    let after = batch(&w, &b);
    assert_eq!(after.batch.status, BatchStatus::Closed);
    assert_eq!(after.line_id.as_deref(), Some(slip.as_str()));
    assert_eq!(gift(&w, &cheque).status, Status::Completed);
    assert_eq!(received(&w), 3000);
    assert_eq!(
        read(&w.a, |c| giving::bank::batch_for_line(c, &slip)),
        Some(b)
    );
}

/// A cheque that bounces is `failed`, staff's word on a cheque, and
/// counts for nothing.
#[test]
fn a_bounced_cheque_is_failed_and_counts_for_nothing() {
    let w = world();
    let b = open_batch(&w);
    let cheque = cheque_in(&w, &b, 3000);
    close_batch(&w, &b, 3000);
    match_to(&w, &b, &line(&w, 3000, "2026-10-20")).unwrap();
    assert_eq!(received(&w), 3000);
    set_status(&w, &cheque, Status::Failed).unwrap();
    assert_eq!(gift(&w, &cheque).status, Status::Failed);
    assert_eq!(received(&w), 0);
    assert!(claimable(&w).is_empty());
    // Only a cheque bounces.
    let cash = record(&w, payload(&w, Method::Cash, 500)).unwrap();
    assert_eq!(
        reason(set_status(&w, &cash, Status::Failed).unwrap_err()),
        "provider_status"
    );
}

/// `giving::RECEIVED` is the only "money received": a pending cheque is in
/// no total, no claim's eligibility and no declaration's evidence, and a
/// claim can't take it.
#[test]
fn a_pending_cheque_is_never_counted_or_claimable() {
    let w = world();
    let b = open_batch(&w);
    let cheque = cheque_in(&w, &b, 3000);
    assert_eq!(received(&w), 0);
    assert!(claimable(&w).is_empty());
    assert!(read(&w.a, |c| giving::received_gifts(c, &w.jo)).is_empty());
    assert_eq!(reason(claim(&w, &cheque).unwrap_err()), "not_received");

    close_batch(&w, &b, 3000);
    match_to(&w, &b, &line(&w, 3000, "2026-10-20")).unwrap();
    assert_eq!(claimable(&w), std::slice::from_ref(&cheque));
    claim(&w, &cheque).unwrap();
}

/// A cheque outside a batch is cleared by hand, and can be un-cleared.
#[test]
fn a_cheque_outside_a_batch_is_cleared_by_hand() {
    let w = world();
    let cheque = record(&w, payload(&w, Method::Cheque, 2500)).unwrap();
    assert_eq!(gift(&w, &cheque).status, Status::Pending);
    set_status(&w, &cheque, Status::Completed).unwrap();
    assert_eq!(received(&w), 2500);
    set_status(&w, &cheque, Status::Pending).unwrap();
    assert_eq!(received(&w), 0);
    // Pending is a cheque's alone among gifts entered by hand.
    let cash = record(&w, payload(&w, Method::Cash, 500)).unwrap();
    assert_eq!(
        reason(set_status(&w, &cash, Status::Pending).unwrap_err()),
        "provider_status"
    );
}

/// Unmatching a batch puts its cleared cheques back to pending, with a
/// reason: one already claimed goes into the next claim as an adjustment.
/// A bounced one stays failed.
#[test]
fn unmatching_a_batch_pends_its_cleared_cheques_again() {
    let w = world();
    let b = open_batch(&w);
    let claimed = cheque_in(&w, &b, 3000);
    let bounced = cheque_in(&w, &b, 1000);
    let cash = record(
        &w,
        GiftPayload {
            paying_in_batch_id: Some(b.clone()),
            ..payload(&w, Method::Cash, 500)
        },
    )
    .unwrap();
    close_batch(&w, &b, 4500);
    let slip = line(&w, 4500, "2026-10-20");
    match_to(&w, &b, &slip).unwrap();
    claim(&w, &claimed).unwrap();
    set_status(&w, &bounced, Status::Failed).unwrap();

    unmatch(&w, &b).unwrap();
    let after = batch(&w, &b);
    assert_eq!(
        (after.batch.status, after.line_id),
        (BatchStatus::Closed, None)
    );
    let g = gift(&w, &claimed);
    assert_eq!(g.status, Status::Pending);
    assert_eq!(g.void_reason.as_deref(), Some(BATCH_UNMATCHED_REASON));
    assert_eq!(
        read(&w.a, |c| giving::voided_in_claim(c, CLAIM))
            .into_iter()
            .map(|v| v.id)
            .collect::<Vec<_>>(),
        [claimed]
    );
    assert_eq!(gift(&w, &bounced).status, Status::Failed);
    assert_eq!(gift(&w, &cash).status, Status::Completed);
    // The line is free again.
    assert_eq!(read(&w.a, |c| giving::bank::batch_for_line(c, &slip)), None);
}

/// Un-voiding a cheque gives back `completed` only if it may clear (its
/// batch matched); otherwise `pending`.
#[test]
fn unvoiding_a_cheque_gives_pending_until_it_may_clear() {
    let w = world();
    let b = open_batch(&w);
    let cheque = cheque_in(&w, &b, 3000);
    set_status(&w, &cheque, Status::Void).unwrap();
    set_status(&w, &cheque, Status::Completed).unwrap();
    assert_eq!(gift(&w, &cheque).status, Status::Pending);

    close_batch(&w, &b, 3000);
    match_to(&w, &b, &line(&w, 3000, "2026-10-20")).unwrap();
    set_status(&w, &cheque, Status::Void).unwrap();
    set_status(&w, &cheque, Status::Completed).unwrap();
    assert_eq!(gift(&w, &cheque).status, Status::Completed);
}

/// A cheque's status follows its clearing, so a gift neither becomes a
/// cheque nor stops being one after it is recorded.
#[test]
fn a_cheque_stays_a_cheque() {
    let w = world();
    let cheque = record(&w, payload(&w, Method::Cheque, 2500)).unwrap();
    assert_eq!(
        reason(save(&w, &cheque, |p| p.method = Method::Cash).unwrap_err()),
        "cheque_fixed"
    );
    let cash = record(&w, payload(&w, Method::Cash, 2500)).unwrap();
    assert_eq!(
        reason(save(&w, &cash, |p| p.method = Method::Cheque).unwrap_err()),
        "cheque_fixed"
    );
}

// ── paying-in batches ──────────────────────────────────────────────────────

/// A batch opens empty on an account, closes with the slip's total and
/// date (and may reopen), and is matched only once closed. Its account
/// never changes; while matched nothing changes.
#[test]
fn a_batch_opens_closes_with_its_total_and_date_and_then_matches() {
    let w = world();
    let closed_at_once = tx(&w.a, |ctx| {
        execute(
            ctx,
            &PAYING_IN_BATCH,
            PayingInBatchPayload {
                status: BatchStatus::Closed,
                total: Some(100),
                banked_on: Some("2026-10-19".into()),
                ..batch_payload(&w)
            },
            Exec::create(Source::Ui),
        )
    });
    assert_eq!(reason(closed_at_once.unwrap_err()), "batch_not_open");
    let unknown = tx(&w.a, |ctx| {
        execute(
            ctx,
            &PAYING_IN_BATCH,
            PayingInBatchPayload {
                account_id: contracts::new_id(),
                ..batch_payload(&w)
            },
            Exec::create(Source::Ui),
        )
    });
    assert_eq!(reason(unknown.unwrap_err()), "unknown_account");

    let id = open_batch(&w);
    let opened = batch(&w, &id);
    assert_eq!(opened.opened_by, Some(ANN));
    assert_eq!(opened.closed_at, None);
    let err = save_batch(&w, &id, |p| p.status = BatchStatus::Closed).unwrap_err();
    assert_eq!(fields(err), ["total", "bankedOn"]);
    let err = save_batch(&w, &id, |p| p.account_id = contracts::new_id()).unwrap_err();
    assert_eq!(reason(err), "account_fixed");
    let slip = line(&w, 900, "2026-10-20");
    assert_eq!(reason(match_to(&w, &id, &slip).unwrap_err()), "close_first");

    close_batch(&w, &id, 900);
    let closed = batch(&w, &id);
    assert_eq!(closed.closed_by, Some(ANN));
    assert!(closed.closed_at.is_some());
    // Reopened, then closed again.
    save_batch(&w, &id, |p| p.status = BatchStatus::Open).unwrap();
    assert_eq!(batch(&w, &id).closed_at, None);
    close_batch(&w, &id, 900);

    match_to(&w, &id, &slip).unwrap();
    let err = save_batch(&w, &id, |p| p.total = Some(901)).unwrap_err();
    assert_eq!(reason(err), "batch_matched");
    let err = save_batch(&w, &id, |p| p.status = BatchStatus::Open).unwrap_err();
    assert_eq!(reason(err), "batch_matched");
    // A difference between the slip and its line is shown, not refused:
    // that's the caller's to read from the batch and the line.
    let other = open_batch(&w);
    close_batch(&w, &other, 1000);
    match_to(&w, &other, &line(&w, 999, "2026-10-21")).unwrap();
}

/// Only cash and cheques go into a batch, and only while it's open. A
/// gift's batch is set when it is recorded: a save may leave it out, and
/// can't move it.
#[test]
fn gifts_go_into_an_open_batch_only_and_stay_there() {
    let w = world();
    let b = open_batch(&w);
    let card = record(
        &w,
        GiftPayload {
            paying_in_batch_id: Some(b.clone()),
            ..payload(&w, Method::Card, 500)
        },
    );
    assert_eq!(fields(card.unwrap_err()), ["payingInBatchId"]);
    let cash = record(
        &w,
        GiftPayload {
            paying_in_batch_id: Some(b.clone()),
            ..payload(&w, Method::Cash, 500)
        },
    )
    .unwrap();
    // A save from a page that knows nothing of batches keeps it.
    save(&w, &cash, |p| {
        p.amount = 600;
        p.allocations[0].amount = 600;
    })
    .unwrap();
    assert_eq!(gift(&w, &cash).paying_in_batch_id, Some(b.clone()));
    let other = open_batch(&w);
    let err = save(&w, &cash, |p| p.paying_in_batch_id = Some(other.clone())).unwrap_err();
    assert_eq!(reason(err), "batch_fixed");
    let err = save(&w, &cash, |p| p.method = Method::Card).unwrap_err();
    assert_eq!(reason(err), "batch_method");

    close_batch(&w, &b, 600);
    let late = record(
        &w,
        GiftPayload {
            paying_in_batch_id: Some(b.clone()),
            ..payload(&w, Method::Cash, 500)
        },
    );
    assert_eq!(reason(late.unwrap_err()), "batch_closed");
    let nowhere = record(
        &w,
        GiftPayload {
            paying_in_batch_id: Some(contracts::new_id()),
            ..payload(&w, Method::Cash, 500)
        },
    );
    assert_eq!(reason(nowhere.unwrap_err()), "unknown_batch");
    // Batches are optional: cash outside one works as it always has.
    let loose = record(&w, payload(&w, Method::Cash, 500)).unwrap();
    assert_eq!(gift(&w, &loose).status, Status::Completed);
}

/// A statement line holds gifts or one paying-in batch, never both.
#[test]
fn a_line_holds_gifts_or_one_batch_never_both() {
    let w = world();
    let slip = line(&w, 3000, "2026-10-20");
    let b = open_batch(&w);
    close_batch(&w, &b, 3000);
    match_to(&w, &b, &slip).unwrap();
    let made = record(
        &w,
        GiftPayload {
            from_line: Some(slip.clone()),
            ..payload(&w, Method::BankTransfer, 3000)
        },
    );
    assert_eq!(reason(made.unwrap_err()), "line_taken");
    let by_hand = record(&w, payload(&w, Method::BankTransfer, 3000)).unwrap();
    assert_eq!(
        reason(link(&w, &by_hand, Some(&slip)).unwrap_err()),
        "line_taken"
    );
    let other = open_batch(&w);
    close_batch(&w, &other, 3000);
    assert_eq!(
        reason(match_to(&w, &other, &slip).unwrap_err()),
        "line_taken"
    );

    let transfer = line(&w, 2000, "2026-10-21");
    link(&w, &by_hand, Some(&transfer)).unwrap();
    assert_eq!(
        reason(match_to(&w, &other, &transfer).unwrap_err()),
        "line_taken"
    );
}

// ── gifts from lines ───────────────────────────────────────────────────────

/// A gift made from a line takes the line's amount and date (the caller
/// copies them; the posted date is when the money reached the bank), and
/// staff can't change them, nor its method or reference, as on a
/// provider's gift. Its split across codes stays theirs.
#[test]
fn a_gift_made_from_a_line_keeps_the_lines_amount_and_date() {
    let w = world();
    let l = line(&w, 5000, "2026-10-14");
    let id = record(
        &w,
        GiftPayload {
            reference: Some("100016".into()),
            from_line: Some(l.clone()),
            ..payload(&w, Method::BankTransfer, 5000)
        },
    )
    .unwrap();
    let g = gift(&w, &id);
    assert_eq!(g.status, Status::Completed);
    assert_eq!(
        (g.bank_line_id.as_deref(), g.made_from_line),
        (Some(l.as_str()), true)
    );
    assert!(!g.not_on_a_statement);

    for f in [
        (|p: &mut GiftPayload| {
            p.amount = 4000;
            p.allocations[0].amount = 4000;
        }) as fn(&mut GiftPayload),
        |p| p.received_on = "2026-10-15".into(),
        |p| p.reference = Some("OTHER".into()),
    ] {
        assert_eq!(reason(save(&w, &id, f).unwrap_err()), "line_fixed");
    }
    let err = save(&w, &id, |p| {
        p.from_line = Some(line(&w, 5000, "2026-10-14"))
    })
    .unwrap_err();
    assert_eq!(reason(err), "identity_immutable");
    // A save that leaves the line out keeps it; the split is staff's.
    let second = code(&w.a, "Spring appeal");
    save(&w, &id, |p| {
        p.allocations[0].source_code_id = second.clone()
    })
    .unwrap();
    let g = gift(&w, &id);
    assert_eq!(g.bank_line_id.as_deref(), Some(l.as_str()));
    assert_eq!(g.allocations[0].source_code_id, second);
    // A page may post the row it read back as its save: it reads as one.
    let posted = serde_json::to_value(gift(&w, &id)).unwrap();
    let back: GiftPayload = serde_json::from_value(posted).unwrap();
    assert_eq!(back.from_line, None);
    assert_eq!(back.paying_in_batch_id, None);
    // Its line is its for good.
    assert_eq!(reason(link(&w, &id, None).unwrap_err()), "line_made");
    // Only a bank transfer comes from a line.
    let cash = record(
        &w,
        GiftPayload {
            from_line: Some(l.clone()),
            ..payload(&w, Method::Cash, 5000)
        },
    );
    assert_eq!(fields(cash.unwrap_err()), ["method"]);
}

/// Voiding a gift made from a line frees the line; it can't be un-voided,
/// since the line may be matched again since.
#[test]
fn voiding_a_gift_made_from_a_line_frees_the_line() {
    let w = world();
    let l = line(&w, 5000, "2026-10-14");
    let id = record(
        &w,
        GiftPayload {
            from_line: Some(l.clone()),
            ..payload(&w, Method::BankTransfer, 5000)
        },
    )
    .unwrap();
    assert_eq!(read(&w.a, |c| gifts_on_line(c, &l)).len(), 1);
    set_status(&w, &id, Status::Void).unwrap();
    assert!(read(&w.a, |c| gifts_on_line(c, &l)).is_empty());
    assert_eq!(
        reason(set_status(&w, &id, Status::Completed).unwrap_err()),
        "line_gift_void"
    );
    // The freed line can become a gift again, or a batch's.
    let b = open_batch(&w);
    close_batch(&w, &b, 5000);
    match_to(&w, &b, &l).unwrap();
}

/// g1q1: a transfer entered by hand is completed at once, and "not on a
/// statement yet" until a line is matched to it.
#[test]
fn a_transfer_entered_by_hand_is_received_at_once_and_not_on_a_statement_yet() {
    let w = world();
    let id = record(
        &w,
        GiftPayload {
            reference: Some("100016 JO".into()),
            ..payload(&w, Method::BankTransfer, 20_000)
        },
    )
    .unwrap();
    let g = gift(&w, &id);
    assert_eq!(g.status, Status::Completed);
    assert_eq!(g.reference.as_deref(), Some("100016 JO"));
    assert!(g.not_on_a_statement && !g.made_from_line);
    assert_eq!(received(&w), 20_000);
    let waiting = || {
        read(&w.a, |c| {
            transfers_not_on_a_statement(c, "2026-10-01", "2026-10-31")
        })
        .into_iter()
        .map(|t| t.id)
        .collect::<Vec<_>>()
    };
    assert_eq!(waiting(), std::slice::from_ref(&id));

    let l = line(&w, 20_000, "2026-10-15");
    link(&w, &id, Some(&l)).unwrap();
    let g = gift(&w, &id);
    assert_eq!(
        (g.bank_line_id.as_deref(), g.made_from_line),
        (Some(l.as_str()), false)
    );
    assert!(!g.not_on_a_statement);
    assert!(waiting().is_empty());
    // Re-sending the same line is a no-op.
    let before = gift(&w, &id).line_version;
    assert_eq!(link(&w, &id, Some(&l)).unwrap().counter, before);
    // Still staff's to edit, but a bank transfer while it's on the line.
    assert_eq!(
        reason(save(&w, &id, |p| p.method = Method::Card).unwrap_err()),
        "line_method"
    );
    // A void gift stops waiting.
    link(&w, &id, None).unwrap();
    set_status(&w, &id, Status::Void).unwrap();
    assert!(waiting().is_empty());
}

/// A reference is kept on a transfer and a cheque (its number), and cash
/// has none.
#[test]
fn a_reference_is_allowed_on_a_transfer_and_a_cheque() {
    let w = world();
    for method in [Method::BankTransfer, Method::Cheque] {
        let id = record(
            &w,
            GiftPayload {
                reference: Some(" 000456 ".into()),
                ..payload(&w, method, 1000)
            },
        )
        .unwrap();
        assert_eq!(gift(&w, &id).reference.as_deref(), Some("000456"));
    }
    let cash = record(
        &w,
        GiftPayload {
            reference: Some("000456".into()),
            ..payload(&w, Method::Cash, 1000)
        },
    );
    assert_eq!(fields(cash.unwrap_err()), ["reference"]);
}

/// Only a bank transfer that isn't void is matched to a line, one line at
/// a time.
#[test]
fn only_a_bank_transfer_that_isnt_void_is_matched_to_a_line() {
    let w = world();
    let l = line(&w, 1000, "2026-10-15");
    let cash = record(&w, payload(&w, Method::Cash, 1000)).unwrap();
    assert_eq!(
        reason(link(&w, &cash, Some(&l)).unwrap_err()),
        "line_method"
    );
    let void = record(&w, payload(&w, Method::BankTransfer, 1000)).unwrap();
    set_status(&w, &void, Status::Void).unwrap();
    assert_eq!(reason(link(&w, &void, Some(&l)).unwrap_err()), "void_gift");
    let id = record(&w, payload(&w, Method::BankTransfer, 1000)).unwrap();
    link(&w, &id, Some(&l)).unwrap();
    let other = line(&w, 1000, "2026-10-16");
    assert_eq!(
        reason(link(&w, &id, Some(&other)).unwrap_err()),
        "line_linked"
    );
}

/// Unmatching a line voids the gifts made from it and only unlinks the
/// ones entered by hand, which go back to "not on a statement yet". The
/// gifts are kept (rule 3).
#[test]
fn unmatching_a_line_voids_the_gifts_made_from_it_and_unlinks_the_rest() {
    let w = world();
    let l = line(&w, 6000, "2026-10-14");
    let made = record(
        &w,
        GiftPayload {
            from_line: Some(l.clone()),
            ..payload(&w, Method::BankTransfer, 5000)
        },
    )
    .unwrap();
    let by_hand = record(&w, payload(&w, Method::BankTransfer, 1000)).unwrap();
    link(&w, &by_hand, Some(&l)).unwrap();
    let before = read(&w.a, |c| gifts_on_line(c, &l));
    assert_eq!(
        before
            .iter()
            .map(|g| (g.id.clone(), g.from_line))
            .collect::<Vec<_>>(),
        [(made.clone(), true), (by_hand.clone(), false)]
    );

    assert_eq!(unmatch_line(&w, &l), [made.clone(), by_hand.clone()]);
    let m = gift(&w, &made);
    assert_eq!(m.status, Status::Void);
    assert_eq!(m.void_reason.as_deref(), Some(LINE_UNMATCHED_REASON));
    assert_eq!((m.amount, m.received_on.as_str()), (5000, "2026-10-14"));
    let h = gift(&w, &by_hand);
    assert_eq!((h.status, h.bank_line_id), (Status::Completed, None));
    assert!(h.not_on_a_statement);
    assert!(read(&w.a, |c| gifts_on_line(c, &l)).is_empty());
    assert_eq!(received(&w), 1000);
}

/// A claimed gift voided by its line's unmatch goes into the next claim
/// as an adjustment, as any void of a claimed gift does.
#[test]
fn a_claimed_gift_voided_by_an_unmatch_is_an_adjustment_in_the_next_claim() {
    let w = world();
    let l = line(&w, 5000, "2026-10-14");
    let made = record(
        &w,
        GiftPayload {
            from_line: Some(l.clone()),
            ..payload(&w, Method::BankTransfer, 5000)
        },
    )
    .unwrap();
    claim(&w, &made).unwrap();
    unmatch_line(&w, &l);
    let adjustments = read(&w.a, |c| giving::voided_in_claim(c, CLAIM));
    assert_eq!(adjustments.len(), 1);
    assert_eq!(adjustments[0].id, made);
    assert_eq!(
        adjustments[0].void_reason.as_deref(),
        Some(LINE_UNMATCHED_REASON)
    );
}

// ── review round 1 (reviewer-bk2r): voids, batch lines, restores ───────────

/// A revision of `contract` on `entity` `id`, by the counter it wrote.
fn revision(w: &World, entity: &str, id: &str, contract: &str, counter: i64) -> i64 {
    read(&w.a, |c| {
        c.query_row(
            "SELECT id FROM revisions
             WHERE entity = ?1 AND entity_id = ?2 AND contract = ?3 AND counter = ?4",
            rusqlite::params![entity, id, contract, counter],
            |r| r.get(0),
        )
    })
}

fn restore(w: &World, revision: i64) -> Result<Executed, ContractError> {
    tx(&w.a, |ctx| {
        contracts::restore(ctx, &giving::REGISTRY, revision, None)
    })
}

/// Another bank account of the group's, with an import to put lines in.
fn other_account(w: &World) -> (String, String) {
    let (account, import) = (contracts::new_id(), contracts::new_id());
    raw(
        &w.a,
        "INSERT INTO bank_accounts (id, name, created_at) VALUES (?1, 'Unity deposit', 1)",
        &[&account],
    );
    raw(
        &w.a,
        "INSERT INTO bank_imports (id, account_id, file_name, format, imported_at)
         VALUES (?1, ?2, 'unity.csv', 'csv', 1)",
        &[&import, &account],
    );
    (account, import)
}

/// M1: voiding a transfer matched by hand unlinks it in the same command,
/// so its line is free; matching the line to a batch, then un-voiding the
/// gift, brings it back unlinked ("not on a statement yet"), and the line
/// never holds a batch and a gift. A void that didn't unlink (the system,
/// a restore) can't be undone while the line is held elsewhere.
#[test]
fn voiding_a_matched_transfer_unlinks_it_and_the_line_never_holds_both() {
    let w = world();
    let l = line(&w, 2000, "2026-10-15");
    let g = record(&w, payload(&w, Method::BankTransfer, 2000)).unwrap();
    link(&w, &g, Some(&l)).unwrap();
    let before = gift(&w, &g).line_version;
    set_status(&w, &g, Status::Void).unwrap();
    let voided = gift(&w, &g);
    assert_eq!(voided.bank_line_id, None);
    assert_eq!(voided.line_version, before + 1);
    let b = open_batch(&w);
    close_batch(&w, &b, 2000);
    match_to(&w, &b, &l).unwrap();
    set_status(&w, &g, Status::Completed).unwrap();
    let back = gift(&w, &g);
    assert_eq!((back.status, back.bank_line_id), (Status::Completed, None));
    assert!(back.not_on_a_statement);
    assert!(read(&w.a, |c| gifts_on_line(c, &l)).is_empty());
    assert_eq!(read(&w.a, |c| giving::bank::batch_for_line(c, &l)), Some(b));

    // The system's void keeps the link; the line goes to a batch; staff
    // can't then revive the gift onto it.
    let l2 = line(&w, 1500, "2026-10-16");
    let h = record(&w, payload(&w, Method::BankTransfer, 1500)).unwrap();
    link(&w, &h, Some(&l2)).unwrap();
    let expected = gift(&w, &h).status_version;
    tx(&w.a, |ctx| {
        execute(
            ctx,
            &giving::STATUS,
            giving::StatusPayload {
                status: Status::Void,
                reason: None,
            },
            Exec::update(&h, Some(expected), Source::System),
        )
    })
    .unwrap();
    assert_eq!(gift(&w, &h).bank_line_id, Some(l2.clone()));
    let b2 = open_batch(&w);
    close_batch(&w, &b2, 1500);
    match_to(&w, &b2, &l2).unwrap();
    assert_eq!(
        reason(set_status(&w, &h, Status::Completed).unwrap_err()),
        "line_taken"
    );
}

/// M2: a batch's line is its own slice, so no batch save matches or
/// unmatches it: `matched` isn't a status a payload can carry (the wire
/// refuses it), a matched batch can't be reopened or edited by a save or
/// a restore, and only match/unmatch move the line, its cheques with it.
#[test]
fn a_batch_save_never_matches_or_unmatches_it_and_its_cheques_follow_the_line() {
    let w = world();
    let named_matched = serde_json::from_value::<PayingInBatchPayload>(serde_json::json!({
        "accountId": w.account, "slipNumber": "1", "status": "matched",
        "bankedOn": "2026-10-19", "total": 3000,
    }));
    assert!(named_matched.is_err());

    let b = open_batch(&w);
    let cheque = cheque_in(&w, &b, 3000);
    close_batch(&w, &b, 3000);
    let slip = line(&w, 3000, "2026-10-20");
    // Closed is not matched: the cheque waits.
    assert_eq!(gift(&w, &cheque).status, Status::Pending);
    match_to(&w, &b, &slip).unwrap();
    assert_eq!(gift(&w, &cheque).status, Status::Completed);
    let closed_rev = revision(&w, "paying_in_batches", &b, "giving.payingInBatch", 1);

    // Leaving matched by a save or a restore is refused, the cheque kept.
    let err = save_batch(&w, &b, |p| p.status = BatchStatus::Open).unwrap_err();
    assert_eq!(reason(err), "batch_matched");
    let open_rev = revision(&w, "paying_in_batches", &b, "giving.payingInBatch", 0);
    assert_eq!(reason(restore(&w, open_rev).unwrap_err()), "batch_matched");
    // Restoring the closed slip it already is changes nothing.
    restore(&w, closed_rev).unwrap();
    assert_eq!(gift(&w, &cheque).status, Status::Completed);
    assert_eq!(batch(&w, &b).line_id.as_deref(), Some(slip.as_str()));

    unmatch(&w, &b).unwrap();
    assert_eq!(gift(&w, &cheque).status, Status::Pending);
    // Nor does a restore of the line slice match it again.
    let matched_rev = revision(&w, "paying_in_batches", &b, "giving.batchLine", 1);
    assert_eq!(
        reason(restore(&w, matched_rev).unwrap_err()),
        "not_restorable"
    );
    assert_eq!(batch(&w, &b).line_id, None);
    assert_eq!(gift(&w, &cheque).status, Status::Pending);
}

/// L1 (a): a gift made from a line, voided, isn't revived by restoring
/// its `completed` status either.
#[test]
fn restoring_a_line_gifts_status_doesnt_revive_it() {
    let w = world();
    let l = line(&w, 5000, "2026-10-14");
    let id = record(
        &w,
        GiftPayload {
            from_line: Some(l),
            ..payload(&w, Method::BankTransfer, 5000)
        },
    )
    .unwrap();
    set_status(&w, &id, Status::Void).unwrap();
    let completed = revision(&w, "gifts", &id, "giving.status", 1);
    assert_eq!(
        reason(restore(&w, completed).unwrap_err()),
        "line_gift_void"
    );
    assert_eq!(gift(&w, &id).status, Status::Void);
}

/// L1 (c): a cheque's `completed` status isn't restored while its batch
/// is no longer matched.
#[test]
fn restoring_a_cheques_cleared_status_waits_for_its_batch() {
    let w = world();
    let b = open_batch(&w);
    let cheque = cheque_in(&w, &b, 3000);
    close_batch(&w, &b, 3000);
    match_to(&w, &b, &line(&w, 3000, "2026-10-20")).unwrap();
    unmatch(&w, &b).unwrap();
    let cleared = revision(&w, "gifts", &cheque, "giving.status", 2);
    assert_eq!(
        reason(restore(&w, cleared).unwrap_err()),
        "cheque_not_cleared"
    );
    assert_eq!(gift(&w, &cheque).status, Status::Pending);
}

/// L1 (d): restoring a gift's own slice, made from a line or matched by
/// hand, leaves its line as it is (the line isn't that slice's), and the
/// lock still holds a made gift's amount.
#[test]
fn restoring_a_gifts_slice_keeps_its_line() {
    let w = world();
    let second = code(&w.a, "Spring appeal");
    let l = line(&w, 2000, "2026-10-15");
    let by_hand = record(&w, payload(&w, Method::BankTransfer, 2000)).unwrap();
    link(&w, &by_hand, Some(&l)).unwrap();
    save(&w, &by_hand, |p| {
        p.allocations[0].source_code_id = second.clone()
    })
    .unwrap();
    let first = revision(&w, "gifts", &by_hand, "giving.gift", 0);
    restore(&w, first).unwrap();
    let g = gift(&w, &by_hand);
    assert_eq!(g.allocations[0].source_code_id, w.code);
    assert_eq!(g.bank_line_id.as_deref(), Some(l.as_str()));

    let m = line(&w, 5000, "2026-10-14");
    let made = record(
        &w,
        GiftPayload {
            from_line: Some(m.clone()),
            ..payload(&w, Method::BankTransfer, 5000)
        },
    )
    .unwrap();
    save(&w, &made, |p| {
        p.allocations[0].source_code_id = second.clone()
    })
    .unwrap();
    restore(&w, revision(&w, "gifts", &made, "giving.gift", 0)).unwrap();
    let g = gift(&w, &made);
    assert_eq!(
        (g.bank_line_id.as_deref(), g.made_from_line),
        (Some(m.as_str()), true)
    );
    assert_eq!(g.allocations[0].source_code_id, w.code);
}

/// L2: restoring a gift's link relinks only a line that no batch and no
/// other gift holds now.
#[test]
fn restoring_a_link_relinks_only_a_line_nothing_else_holds() {
    let w = world();
    let l = line(&w, 2000, "2026-10-15");
    let g = record(&w, payload(&w, Method::BankTransfer, 2000)).unwrap();
    link(&w, &g, Some(&l)).unwrap();
    let linked = revision(&w, "gifts", &g, "giving.line", 1);
    link(&w, &g, None).unwrap();

    let other = record(&w, payload(&w, Method::BankTransfer, 2000)).unwrap();
    link(&w, &other, Some(&l)).unwrap();
    assert_eq!(reason(restore(&w, linked).unwrap_err()), "line_taken");
    link(&w, &other, None).unwrap();

    let b = open_batch(&w);
    close_batch(&w, &b, 2000);
    match_to(&w, &b, &l).unwrap();
    assert_eq!(reason(restore(&w, linked).unwrap_err()), "line_taken");
    unmatch(&w, &b).unwrap();

    // Free again: the restore relinks it.
    restore(&w, linked).unwrap();
    assert_eq!(gift(&w, &g).bank_line_id.as_deref(), Some(l.as_str()));
}

/// L3: a batch matches only a line on its own bank account: a CAF slip
/// never clears its cheques against a Unity line.
#[test]
fn a_batch_matches_only_a_line_on_its_own_account() {
    let w = world();
    let (account, import) = other_account(&w);
    let unity = contracts::new_id();
    raw(
        &w.a,
        "INSERT INTO bank_lines (id, account_id, import_id, posted_on, amount, dedupe_key,
             occurrence)
         VALUES (?1, ?2, ?3, '2026-10-20', 3000, ?1, 1)",
        &[&unity, &account, &import],
    );
    let b = open_batch(&w);
    let cheque = cheque_in(&w, &b, 3000);
    close_batch(&w, &b, 3000);
    assert_eq!(
        reason(match_to(&w, &b, &unity).unwrap_err()),
        "line_account"
    );
    assert_eq!(gift(&w, &cheque).status, Status::Pending);
    assert_eq!(batch(&w, &b).line_id, None);
}

/// L4: an id that isn't a statement line is refused by name (a 422), not
/// left to the foreign key (a 500), wherever a line is named.
#[test]
fn an_unknown_line_is_refused_by_name() {
    let w = world();
    let nowhere = contracts::new_id();
    let made = record(
        &w,
        GiftPayload {
            from_line: Some(nowhere.clone()),
            ..payload(&w, Method::BankTransfer, 1000)
        },
    );
    assert_eq!(reason(made.unwrap_err()), "unknown_line");
    let by_hand = record(&w, payload(&w, Method::BankTransfer, 1000)).unwrap();
    assert_eq!(
        reason(link(&w, &by_hand, Some(&nowhere)).unwrap_err()),
        "unknown_line"
    );
    let b = open_batch(&w);
    close_batch(&w, &b, 1000);
    assert_eq!(
        reason(match_to(&w, &b, &nowhere).unwrap_err()),
        "unknown_line"
    );
}
