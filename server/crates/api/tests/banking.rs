//! Bank accounts and statement imports on real org files, two
//! organisations (plan `bank-transfers.sv`, step 2): re-importing adds
//! nothing, an overlapping file adds only its new days, identical lines
//! in one file stay two, a bank id is used when present, a malformed file
//! stores nothing, and one organisation's lines never count for another.
//! The routes (and their roles) come with the import page.

use std::sync::Arc;

use api::schema;
use banking::{
    AccountPayload, CsvLayout, FileLayout, ImportError, ImportRequest, Imported, accounts,
    create_account, import_file, import_lines, imports, save_account,
};
use contracts::{ContractError, Ctx, Source};
use rusqlite::Connection;
use store::{OrgDb, Store, StoreConfig};

const ANN: i64 = 1;

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open_with(
        StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: schema::org_migrations(),
            readers: 2,
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
        },
        schema::PLATFORM_SCHEMAS,
    )
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
    World { _tmp: tmp, a, b }
}

fn tx<T, E: From<rusqlite::Error>>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, E>) -> Result<T, E> {
    contracts::transact(db, Some(ANN), f)
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    db.read(|c| f(c).map_err(ContractError::from)).unwrap()
}

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/../banking/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn payload(name: &str) -> AccountPayload {
    AccountPayload {
        name: name.into(),
        sort_code: "60-00-01".into(),
        account_last4: "5678".into(),
        default_source_code_id: None,
        csv_layout: Some(CsvLayout::Preset {
            id: "natwest-bankline-statement".into(),
        }),
        active: true,
    }
}

fn new_account(db: &OrgDb, name: &str) -> String {
    tx(db, |ctx| create_account(ctx, payload(name), Source::Ui))
        .unwrap()
        .id
}

fn import(
    db: &OrgDb,
    account: &str,
    bytes: &[u8],
    layout: Option<FileLayout>,
) -> Result<Imported, ImportError> {
    tx(db, |ctx| {
        import_file(
            ctx,
            ImportRequest {
                account_id: account.into(),
                file_name: "Acc_Stmt_03-11-26.csv".into(),
                layout,
            },
            bytes,
            Source::Ui,
            None,
        )
    })
}

fn count(db: &OrgDb, table: &str) -> i64 {
    read(db, |c| {
        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
    })
}

/// A Lloyds-layout CSV with one £10 credit on each of these November days.
fn lloyds_days(days: impl IntoIterator<Item = u32>) -> Vec<u8> {
    let mut text = String::from(
        "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance,\n",
    );
    for d in days {
        text.push_str(&format!("{d:02}/11/2026,SO,'30-00-00,12345678,J SMITH SO,,10.00,0,\n"));
    }
    text.into_bytes()
}

fn lloyds() -> Option<FileLayout> {
    Some(FileLayout::Preset { id: "lloyds".into() })
}

#[test]
fn an_account_saves_with_its_counter_and_keeps_who_created_it() {
    let w = world();
    let id = new_account(&w.a, "NatWest current");
    let mut p = payload("NatWest current");
    p.active = false;
    tx(&w.a, |ctx| save_account(ctx, &id, 0, p.clone(), Source::Ui)).unwrap();
    let stale = tx(&w.a, |ctx| save_account(ctx, &id, 0, p.clone(), Source::Ui)).unwrap_err();
    assert!(matches!(stale, ContractError::Stale { .. }), "{stale:?}");
    let rows = read(&w.a, |c| Ok(accounts(c).unwrap()));
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].version, rows[0].account.payload.active), (1, false));
    assert_eq!(rows[0].account.created_by, Some(ANN));
    assert_eq!(rows[0].account.payload.sort_code, "600001");
}

#[test]
fn account_names_are_unique_and_a_default_code_must_be_a_version() {
    let w = world();
    new_account(&w.a, "CAF current");
    let clash = tx(&w.a, |ctx| create_account(ctx, payload("caf CURRENT"), Source::Ui)).unwrap_err();
    assert!(
        matches!(&clash, ContractError::Rejected { reason, .. } if reason == "duplicate_account_name"),
        "{clash:?}"
    );
    let mut p = payload("Unity deposit");
    p.default_source_code_id = Some("0".repeat(32));
    let bad = tx(&w.a, |ctx| create_account(ctx, p.clone(), Source::Ui)).unwrap_err();
    assert!(matches!(bad, ContractError::Invalid(_)), "{bad:?}");
    let part = |parent_id: Option<String>, name: &str| sources::SourceCodePayload {
        parent_id,
        name: name.into(),
        description: None,
        start_date: None,
        end_date: None,
        is_active: true,
    };
    let version = tx(&w.a, |ctx| {
        let category = sources::create_part(ctx, part(None, "Unsolicited"), Source::Ui, None)?.id;
        sources::create_part(ctx, part(Some(category), "Bank transfer"), Source::Ui, None)
    })
    .unwrap()
    .version_id;
    // A category is not a version.
    p.default_source_code_id = Some(read(&w.a, |c| {
        c.query_row("SELECT id FROM source_codes WHERE level = 'category'", [], |r| r.get(0))
    }));
    let bad = tx(&w.a, |ctx| create_account(ctx, p.clone(), Source::Ui)).unwrap_err();
    assert!(matches!(bad, ContractError::Invalid(_)), "{bad:?}");
    p.default_source_code_id = version;
    tx(&w.a, |ctx| create_account(ctx, p, Source::Ui)).unwrap();
    // The same name in another organisation is no clash.
    new_account(&w.b, "CAF current");
}

#[test]
fn reimporting_the_same_file_adds_nothing() {
    let w = world();
    let acc = new_account(&w.a, "NatWest current");
    let file = fixture("natwest-bankline-statement.csv");
    let first = import(&w.a, &acc, &file, None).unwrap();
    assert_eq!(
        (first.new_lines, first.duplicate_lines, first.debits_dropped),
        (4, 0, 1)
    );
    assert_eq!(first.first_date.as_deref(), Some("2026-11-02"));
    assert_eq!(first.last_date.as_deref(), Some("2026-11-04"));
    let again = import(&w.a, &acc, &file, None).unwrap();
    assert_eq!((again.new_lines, again.duplicate_lines), (0, 4));
    assert_eq!(count(&w.a, "bank_lines"), 4);
    // Both imports are recorded: "0 new, 4 already imported".
    let list = read(&w.a, |c| Ok(imports(c, &acc).unwrap()));
    let counts: Vec<(i64, i64)> = list.iter().map(|i| (i.new_lines, i.duplicate_lines)).collect();
    assert_eq!(counts, [(0, 4), (4, 0)]);
    assert_eq!(list[1].preset.as_deref(), Some("natwest-bankline-statement"));
}

#[test]
fn identical_lines_in_one_file_are_both_kept_and_stay_two() {
    let w = world();
    let acc = new_account(&w.a, "NatWest current");
    let file = fixture("natwest-bankline-statement.csv");
    let id = import(&w.a, &acc, &file, None).unwrap().id;
    import(&w.a, &acc, &file, None).unwrap();
    let lines = read(&w.a, |c| Ok(import_lines(c, &id).unwrap()));
    let jones: Vec<(&str, i64, u32)> = lines
        .iter()
        .filter(|l| l.narrative.starts_with("A JONES"))
        .map(|l| (l.posted_on.as_str(), l.amount, l.occurrence))
        .collect();
    assert_eq!(jones, [("2026-11-03", 1000, 1), ("2026-11-03", 1000, 2)]);
    // No payer column in this layout: stored as '', never NULL.
    assert!(lines.iter().all(|l| l.payer.is_empty() && l.id.is_some()));
}

#[test]
fn an_overlapping_file_adds_only_the_new_days() {
    let w = world();
    let acc = new_account(&w.a, "Lloyds");
    import(&w.a, &acc, &lloyds_days(1..=10), lloyds()).unwrap();
    let overlap = import(&w.a, &acc, &lloyds_days(5..=15), lloyds()).unwrap();
    assert_eq!((overlap.new_lines, overlap.duplicate_lines), (5, 6));
    let days: Vec<String> = read(&w.a, |c| {
        c.prepare("SELECT posted_on FROM bank_lines WHERE import_id = ?1 ORDER BY posted_on")?
            .query_map([&overlap.id], |r| r.get(0))?
            .collect()
    });
    assert_eq!(days.first().map(String::as_str), Some("2026-11-11"));
    assert_eq!(days.last().map(String::as_str), Some("2026-11-15"));
}

#[test]
fn a_bank_id_is_used_when_the_file_has_one() {
    let w = world();
    let acc = new_account(&w.a, "Barclays");
    let ofx = fixture("statement.ofx");
    assert_eq!(import(&w.a, &acc, &ofx, Some(FileLayout::Ofx)).unwrap().new_lines, 2);
    // The bank rewords a narrative between downloads but keeps its FITID.
    let reworded = String::from_utf8(ofx)
        .unwrap()
        .replace("<MEMO>100016 DONATION", "<MEMO>REF 100016 DONATION FP");
    let again = import(&w.a, &acc, reworded.as_bytes(), Some(FileLayout::Ofx)).unwrap();
    assert_eq!((again.new_lines, again.duplicate_lines), (0, 2));
    let ids: Vec<Option<String>> = read(&w.a, |c| {
        c.prepare("SELECT bank_id FROM bank_lines ORDER BY seq")?
            .query_map([], |r| r.get(0))?
            .collect()
    });
    assert_eq!(ids[0].as_deref(), Some("202611020001"));
}

#[test]
fn a_malformed_file_stores_nothing() {
    let w = world();
    let acc = new_account(&w.a, "Lloyds");
    let mut file = lloyds_days(1..=3);
    file.extend_from_slice(b"31/02/2026,SO,'30-00-00,12345678,BAD,,10.00,0,\n");
    let Err(ImportError::File(errors)) = import(&w.a, &acc, &file, lloyds()) else {
        panic!("a malformed row must refuse the file");
    };
    assert_eq!(errors[0].line, 5);
    assert_eq!((count(&w.a, "bank_imports"), count(&w.a, "bank_lines")), (0, 0));
    assert_eq!(count(&w.a, "revisions WHERE contract = 'banking.import'"), 0);
}

#[test]
fn the_saved_layout_is_used_unless_another_is_asked_for() {
    let w = world();
    let acc = new_account(&w.a, "Lloyds");
    // Saved: NatWest's statement layout. A Lloyds file read with it finds
    // no transactions.
    let wrong = import(&w.a, &acc, &lloyds_days([1]), None);
    assert!(matches!(wrong, Err(ImportError::File(_))));
    assert_eq!(import(&w.a, &acc, &lloyds_days([1]), lloyds()).unwrap().new_lines, 1);
    let mut p = payload("Lloyds");
    p.csv_layout = None;
    tx(&w.a, |ctx| save_account(ctx, &acc, 0, p, Source::Ui)).unwrap();
    let Err(ImportError::File(errors)) = import(&w.a, &acc, &lloyds_days([2]), None) else {
        panic!("no layout saved or chosen");
    };
    assert_eq!(errors[0].line, 0);
}

#[test]
fn an_archived_account_takes_no_imports() {
    let w = world();
    let acc = new_account(&w.a, "Old account");
    let mut p = payload("Old account");
    p.active = false;
    tx(&w.a, |ctx| save_account(ctx, &acc, 0, p, Source::Ui)).unwrap();
    let refused = import(&w.a, &acc, &lloyds_days([1]), lloyds()).unwrap_err();
    assert!(
        matches!(&refused, ImportError::Contract(ContractError::Rejected { reason, .. }) if reason == "account_inactive"),
        "{refused:?}"
    );
    assert_eq!(count(&w.a, "bank_lines"), 0);
}

#[test]
fn an_import_is_one_revision_and_never_restored() {
    let w = world();
    let acc = new_account(&w.a, "NatWest current");
    let id = import(&w.a, &acc, &fixture("natwest-bankline-statement.csv"), None)
        .unwrap()
        .id;
    let rev: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT id FROM revisions WHERE contract = 'banking.import' AND entity_id = ?1",
            [&id],
            |r| r.get(0),
        )
    });
    let refused = tx(&w.a, |ctx| {
        contracts::restore(ctx, &banking::REGISTRY, rev, None)
    })
    .unwrap_err();
    assert!(
        matches!(&refused, ContractError::Rejected { reason, .. } if reason == "not_restorable"),
        "{refused:?}"
    );
    assert_eq!(count(&w.a, "bank_lines"), 4);
}

#[test]
fn another_organisations_lines_never_count() {
    let w = world();
    let file = fixture("natwest-bankline-statement.csv");
    let a = new_account(&w.a, "NatWest current");
    let b = new_account(&w.b, "NatWest current");
    import(&w.a, &a, &file, None).unwrap();
    // The same file in B: all of it is new there.
    assert_eq!(import(&w.b, &b, &file, None).unwrap().new_lines, 4);
    // A's account under B's file is not found, and writes nothing.
    let missing = import(&w.b, &a, &file, None).unwrap_err();
    assert!(
        matches!(missing, ImportError::Contract(ContractError::NotFound)),
        "{missing:?}"
    );
    assert_eq!((count(&w.a, "bank_lines"), count(&w.b, "bank_lines")), (4, 4));
    assert_eq!(read(&w.b, |c| Ok(imports(c, &a).unwrap())).len(), 0);
    assert_eq!(read(&w.b, |c| Ok(accounts(c).unwrap())).len(), 1);
}
