//! Scanned Gift Aid declarations (plan `declaration-scans.sv`): the three
//! contracts' rules on real org files with two organisations. The blobs
//! are the api's (`api/tests/scans.rs`); here a page names any SHA-256.

#![allow(dead_code)]

use std::sync::Arc;

use contacts::acquisition::{NewContact, create_contact};
use contacts::types::{CreateContact, Details, Kind};
use contracts::{ContractError, Ctx, Source};
use giftaid::scans::{self, DeletionReason, Match, Page, ScanView, Status, Via};
use giftaid::types::{Declaration, DeclarationPayload, Method, Scope};
use giftaid::{HMRC_MODEL_WORDING_VERSION, uk_date};
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
        M::up(giftaid::MIGRATION_DETAILS),
        M::up(giftaid::MIGRATION_CLAIMS),
        M::up(giving::MIGRATION_CLAIM_LOCK),
        // On an empty file: no rows for the rebuild to carry.
        M::up(giving::MIGRATION_DIRECT_DEBIT),
        M::up(giving::MIGRATION_UNIFIED),
        M::up(giftaid::MIGRATION_SCANS),
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
                origin: None,
            },
            Source::Ui,
            None,
        )?;
        if void {
            giving::set_status(ctx, &id, 1, giving::Status::Void, None, Source::Ui)?;
        }
        Ok(id)
    })
    .unwrap()
}

const DAY: i64 = 24 * 60 * 60 * 1000;

fn page(n: u8) -> Page {
    Page {
        id: None,
        sha256: format!("{:064x}", n),
        width: 1240,
        height: 1754,
        size: 150_000,
    }
}

impl World {
    fn scan(&self) -> String {
        self.scan_in(&self.a)
    }

    fn scan_in(&self, db: &OrgDb) -> String {
        tx(db, |ctx| {
            scans::create_scan(
                ctx,
                None,
                Via::Phone,
                Some("0190f0c0a0b0c0d0e0f0a0b0c0d0e0c6".into()),
                page(1),
                Source::Ui,
            )
        })
        .unwrap()
        .id
    }

    fn get(&self, id: &str) -> ScanView {
        read(&self.a, |c| Ok(scans::get(c, id)?)).unwrap()
    }

    fn declare(&self, method: Method) -> String {
        let p = DeclarationPayload {
            contact_id: self.jo.clone(),
            scope: Scope::FutureAndPast4y,
            gift_id: None,
            made_on: "2026-03-03".into(),
            method,
            wording_version: HMRC_MODEL_WORDING_VERSION.into(),
            first_name: "Jo".into(),
            last_name: "Bloggs".into(),
            address_line1: "12".into(),
            postcode: "SW1A 1AA".into(),
        };
        tx(&self.a, |ctx| {
            giftaid::make_declaration(ctx, p, Source::Ui, None)
        })
        .unwrap()
        .id
    }

    fn accept(&self, scan: &str, with: Match) -> Result<String, ContractError> {
        let expected = self.get(scan).review_version;
        tx(&self.a, |ctx| {
            scans::accept_scan(ctx, scan, expected, &self.jo, with, Source::Ui)
        })
    }

    fn accept_existing(&self, scan: &str, declaration_id: &str) -> Result<String, ContractError> {
        self.accept(
            scan,
            Match::Existing {
                declaration_id: declaration_id.into(),
            },
        )
    }

    fn declaration(&self, id: &str) -> Declaration {
        read(&self.a, |c| Ok(giftaid::declarations::load(c, id)?)).unwrap()
    }
}

fn reason(err: ContractError) -> String {
    match err {
        ContractError::Rejected { reason, .. } => reason,
        ContractError::Invalid(_) => "invalid".into(),
        ContractError::NotFound => "not_found".into(),
        ContractError::Stale { .. } => "stale".into(),
        ContractError::Duplicate { .. } => "duplicate".into(),
        other => format!("{other:?}"),
    }
}

#[test]
fn an_upload_makes_a_draft_with_who_and_when_and_pages_add_up_to_six() {
    let w = world();
    let id = w.scan();
    let s = w.get(&id);
    assert_eq!(
        (s.status, s.via, s.scanned_by, s.pages.len()),
        (Status::Draft, Via::Phone, Some(ANN), 1)
    );
    assert!(w.inbox().iter().any(|s| s.id == id));
    for n in 2..=6 {
        tx(&w.a, |ctx| scans::add_page(ctx, &id, page(n), Source::Ui)).unwrap();
    }
    let s = w.get(&id);
    assert_eq!(
        s.pages.iter().map(|p| p.page_no).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6]
    );
    let seventh = tx(&w.a, |ctx| scans::add_page(ctx, &id, page(7), Source::Ui));
    assert_eq!(reason(seventh.unwrap_err()), "page_limit");
    // A retried page (same id) is the same upload: nothing changes.
    let again = Page {
        id: Some(s.pages[1].id.clone()),
        ..page(2)
    };
    let out = tx(&w.a, |ctx| scans::add_page(ctx, &id, again, Source::Ui)).unwrap();
    assert_eq!(out.counter, s.scan_version);
}

#[test]
fn a_retried_create_with_the_same_id_is_a_duplicate_not_a_second_scan() {
    let w = world();
    let key = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1";
    let make = || {
        tx(&w.a, |ctx| {
            scans::create_scan(ctx, Some(key), Via::Direct, None, page(1), Source::Ui)
        })
    };
    make().unwrap();
    assert_eq!(reason(make().unwrap_err()), "duplicate");
    assert_eq!(w.inbox().len(), 1);
}

#[test]
fn pages_are_checked_a_phone_scan_names_its_pairing_and_the_size_is_capped() {
    let w = world();
    let bad = |p: Page, via: Via, pairing: Option<String>| {
        tx(&w.a, |ctx| {
            scans::create_scan(ctx, None, via, pairing, p, Source::Ui)
        })
        .unwrap_err()
    };
    assert_eq!(
        reason(bad(
            Page {
                sha256: "x".into(),
                ..page(1)
            },
            Via::Direct,
            None
        )),
        "invalid"
    );
    assert_eq!(
        reason(bad(
            Page {
                size: scans::MAX_PAGE_BYTES + 1,
                ..page(1)
            },
            Via::Direct,
            None
        )),
        "invalid"
    );
    assert_eq!(reason(bad(page(1), Via::Phone, None)), "invalid");
    assert_eq!(
        reason(bad(page(1), Via::Phone, Some("nope".into()))),
        "invalid"
    );
}

#[test]
fn a_draft_reorders_and_removes_its_pages_and_a_reviewed_scan_cant() {
    let w = world();
    let id = w.scan();
    tx(&w.a, |ctx| scans::add_page(ctx, &id, page(2), Source::Ui)).unwrap();
    let s = w.get(&id);
    let (first, second) = (s.pages[0].id.clone(), s.pages[1].id.clone());
    tx(&w.a, |ctx| {
        scans::set_pages(
            ctx,
            &id,
            s.scan_version,
            &[second.clone(), first.clone()],
            Source::Ui,
        )
    })
    .unwrap();
    let s = w.get(&id);
    assert_eq!(
        s.pages.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
        [second.clone(), first.clone()]
    );
    // Stale, someone else's page, nothing left: refused.
    let stale = tx(&w.a, |ctx| {
        scans::set_pages(ctx, &id, 0, std::slice::from_ref(&first), Source::Ui)
    });
    assert_eq!(reason(stale.unwrap_err()), "stale");
    let foreign = tx(&w.a, |ctx| {
        scans::set_pages(
            ctx,
            &id,
            s.scan_version,
            &["0190f0c0a0b0c0d0e0f0a0b0c0d0e0a9".into()],
            Source::Ui,
        )
    });
    assert_eq!(reason(foreign.unwrap_err()), "invalid");
    let empty = tx(&w.a, |ctx| {
        scans::set_pages(ctx, &id, s.scan_version, &[], Source::Ui)
    });
    assert_eq!(reason(empty.unwrap_err()), "invalid");
    tx(&w.a, |ctx| {
        scans::set_pages(
            ctx,
            &id,
            s.scan_version,
            std::slice::from_ref(&first),
            Source::Ui,
        )
    })
    .unwrap();
    assert_eq!(w.get(&id).pages.len(), 1);

    let review = w.get(&id).review_version;
    tx(&w.a, |ctx| {
        scans::discard_scan(ctx, &id, review, Some(" blurred ".into()), Source::Ui)
    })
    .unwrap();
    let s = w.get(&id);
    assert_eq!(
        (s.status, s.discard_reason.as_deref()),
        (Status::Discarded, Some("blurred"))
    );
    let late = tx(&w.a, |ctx| scans::add_page(ctx, &id, page(3), Source::Ui));
    assert_eq!(reason(late.unwrap_err()), "not_draft");
    let again = tx(&w.a, |ctx| {
        scans::discard_scan(ctx, &id, s.review_version, None, Source::Ui)
    });
    assert_eq!(reason(again.unwrap_err()), "reviewed");
}

#[test]
fn accept_only_onto_a_paper_form_of_the_same_contact_not_void_and_without_a_scan() {
    let w = world();
    let paper = w.declare(Method::PaperForm);
    let ticked = w.declare(Method::StaffTickedNoEvidence);
    let voided = w.declare(Method::PaperForm);
    tx(&w.a, |ctx| {
        giftaid::void_declaration(ctx, &voided, "typo".into(), Source::Ui)
    })
    .unwrap();
    let other = contact(&w.a, person("Al", "Other"));
    let scan = w.scan();
    assert_eq!(
        reason(w.accept_existing(&scan, &ticked).unwrap_err()),
        "not_paper_form"
    );
    assert_eq!(
        reason(w.accept_existing(&scan, &voided).unwrap_err()),
        "voided_declaration"
    );
    assert_eq!(
        reason(
            w.accept_existing(&scan, "0190f0c0a0b0c0d0e0f0a0b0c0d0e0a9")
                .unwrap_err()
        ),
        "unknown_declaration"
    );
    // The declaration is Jo's; the screen says Al's.
    let expected = w.get(&scan).review_version;
    let mismatch = tx(&w.a, |ctx| {
        scans::accept_scan(
            ctx,
            &scan,
            expected,
            &other,
            Match::Existing {
                declaration_id: paper.clone(),
            },
            Source::Ui,
        )
    });
    assert_eq!(reason(mismatch.unwrap_err()), "unknown_declaration");
    // Refusals left the draft as it was.
    assert_eq!(w.get(&scan).status, Status::Draft);

    w.accept_existing(&scan, &paper).unwrap();
    let s = w.get(&scan);
    assert_eq!(
        (s.status, s.declaration_id.as_deref(), s.reviewed_by),
        (Status::Accepted, Some(paper.as_str()), Some(ANN))
    );
    assert!(!w.inbox().iter().any(|s| s.id == scan));
    let evidence = read(&w.a, |c| Ok(scans::by_declaration(c, &paper)?));
    assert_eq!(
        evidence.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        [scan.as_str()]
    );
    // A second scan onto the same declaration: merge instead.
    let second = w.scan();
    assert_eq!(
        reason(w.accept_existing(&second, &paper).unwrap_err()),
        "declaration_has_scan"
    );
    // Once accepted, not reviewed again.
    assert_eq!(
        reason(w.accept_existing(&scan, &paper).unwrap_err()),
        "reviewed"
    );
}

#[test]
fn accepting_writes_nothing_on_the_declaration_and_never_changes_coverage() {
    let w = world();
    let paper = w.declare(Method::PaperForm);
    let gift = gift_for(&w.a, &w.jo, "2026-04-01", false);
    let before = w.declaration(&paper);
    let covering = |c: &Connection| giftaid::coverage(c, &w.jo, "2026-04-01", Some(&gift));
    let covered_before = read(&w.a, |c| Ok(covering(c)?));
    let revisions = |c: &Connection| -> rusqlite::Result<i64> {
        c.query_row(
            "SELECT count(*) FROM revisions WHERE entity = 'gift_aid_declarations'",
            [],
            |r| r.get(0),
        )
    };
    let n = read(&w.a, |c| Ok(revisions(c)?));
    let scan = w.scan();
    w.accept_existing(&scan, &paper).unwrap();
    let after = w.declaration(&paper);
    assert_eq!(
        (
            before.declaration_version,
            before.details_version,
            before.cancellation_version,
            before.void_version
        ),
        (
            after.declaration_version,
            after.details_version,
            after.cancellation_version,
            after.void_version
        )
    );
    assert_eq!(read(&w.a, |c| Ok(revisions(c)?)), n);
    assert_eq!(read(&w.a, |c| Ok(covering(c)?)), covered_before);
}

#[test]
fn accept_with_a_new_declaration_is_one_command_group_both_or_neither() {
    let w = world();
    let scan = w.scan();
    let mut p = DeclarationPayload {
        contact_id: w.jo.clone(),
        scope: Scope::Future,
        gift_id: None,
        made_on: "2026-05-05".into(),
        method: Method::PaperForm,
        wording_version: HMRC_MODEL_WORDING_VERSION.into(),
        first_name: "Jo".into(),
        last_name: "Bloggs".into(),
        address_line1: "12".into(),
        postcode: "SW1A 1AA".into(),
    };
    // Neither: a staff-ticked declaration can't carry a scan, so the new
    // declaration doesn't stay either.
    p.method = Method::StaffTickedNoEvidence;
    let refused = w.accept(
        &scan,
        Match::New {
            declaration: p.clone(),
        },
    );
    assert_eq!(reason(refused.unwrap_err()), "not_paper_form");
    let held = read(&w.a, |c| Ok(giftaid::declarations::chain(c, &w.jo)?));
    assert!(held.is_empty());
    assert_eq!(w.get(&scan).status, Status::Draft);
    // Both, in one group.
    p.method = Method::PaperForm;
    let declaration = w.accept(&scan, Match::New { declaration: p }).unwrap();
    assert_eq!(
        w.get(&scan).declaration_id.as_deref(),
        Some(declaration.as_str())
    );
    let groups: Vec<Option<String>> = read(&w.a, |c| {
        Ok(c.prepare(
            "SELECT group_name FROM revisions WHERE contract IN ('giftaid.declaration', 'giftaid.scanReview')",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?)
    });
    assert_eq!(groups.len(), 2);
    assert!(
        groups
            .iter()
            .all(|g| g.as_deref() == Some("Gift Aid declaration scan matched"))
    );
}

#[test]
fn merging_moves_the_pages_and_discards_the_other_draft_in_one_group() {
    let w = world();
    let into = w.scan();
    let from = w.scan();
    let (a, b) = (w.get(&into), w.get(&from));
    tx(&w.a, |ctx| {
        scans::merge_scans(
            ctx,
            &into,
            a.scan_version,
            &from,
            b.review_version,
            Source::Ui,
        )
    })
    .unwrap();
    let (a, b) = (w.get(&into), w.get(&from));
    assert_eq!(a.pages.len(), 2);
    assert_eq!(
        (b.status, b.discard_reason.as_deref()),
        (Status::Discarded, Some("Merged into another scan"))
    );
    // Both page rows name the same blob: the discarded one's purge must
    // not take it (the sweep keeps every blob a live page names).
    let referenced = read(&w.a, |c| Ok(scans::referenced_blobs(c)?));
    assert!(referenced.contains(&page(1).sha256));
    let again = tx(&w.a, |ctx| {
        scans::merge_scans(
            ctx,
            &into,
            a.scan_version,
            &from,
            b.review_version,
            Source::Ui,
        )
    });
    assert_eq!(reason(again.unwrap_err()), "not_draft");
}

#[test]
fn a_discarded_scans_images_go_after_30_days_and_its_row_stays() {
    let w = world();
    let id = w.scan();
    let t0 = contracts::now_ms();
    let review = w.get(&id).review_version;
    tx_at(&w.a, t0, |ctx| {
        scans::discard_scan(ctx, &id, review, None, Source::Ui)
    })
    .unwrap();
    let due = |at: i64| read(&w.a, |c| Ok(scans::discarded_due(c, at)?));
    assert!(due(t0 + 29 * DAY).is_empty());
    assert_eq!(due(t0 + 30 * DAY), std::slice::from_ref(&id));
    let early = tx_at(&w.a, t0 + 29 * DAY, |ctx| {
        scans::delete_images(ctx, &id, None, DeletionReason::Discarded, Source::System)
    });
    assert_eq!(reason(early.unwrap_err()), "not_due");
    tx_at(&w.a, t0 + 30 * DAY, |ctx| {
        scans::delete_images(ctx, &id, None, DeletionReason::Discarded, Source::System)
    })
    .unwrap();
    let s = w.get(&id);
    assert_eq!(
        (s.image_deleted_at, s.deletion_reason),
        (Some(t0 + 30 * DAY), Some(DeletionReason::Discarded))
    );
    assert_eq!(s.pages.len(), 1, "the row and its pages stay");
    assert!(read(&w.a, |c| Ok(scans::page_blob(c, &id, 1)?)).is_none());
    assert!(!read(&w.a, |c| Ok(scans::referenced_blobs(c)?)).contains(&page(1).sha256));
    let twice = tx(&w.a, |ctx| {
        scans::delete_images(ctx, &id, None, DeletionReason::Discarded, Source::System)
    });
    assert_eq!(reason(twice.unwrap_err()), "already_deleted");
}

#[test]
fn nothing_deletes_an_accepted_scan_automatically() {
    let w = world();
    let paper = w.declare(Method::PaperForm);
    let id = w.scan();
    w.accept_existing(&id, &paper).unwrap();
    let far = contracts::now_ms() + 20 * 365 * DAY;
    assert!(read(&w.a, |c| Ok(scans::discarded_due(c, far)?)).is_empty());
    let purge = tx_at(&w.a, far, |ctx| {
        scans::delete_images(ctx, &id, None, DeletionReason::Discarded, Source::System)
    });
    assert_eq!(reason(purge.unwrap_err()), "not_due");
}

#[test]
fn the_report_lists_a_scan_only_after_7_years_without_a_covered_gift() {
    let w = world();
    let paper = w.declare(Method::PaperForm); // made 2026-03-03
    let id = w.scan();
    w.accept_existing(&id, &paper).unwrap();
    gift_for(&w.a, &w.jo, "2027-06-01", false);
    // A void gift is no money received: it doesn't keep the scan.
    gift_for(&w.a, &w.jo, "2029-01-01", true);
    let listed = |today: &str| read(&w.a, |c| Ok(scans::deletable(c, today)?));
    assert!(listed("2034-06-01").is_empty());
    let rows = listed("2034-06-02");
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0].last_covered_on.as_deref(),
            rows[0].contact_id.as_str()
        ),
        (Some("2027-06-01"), w.jo.as_str())
    );
    // Deleting from the report checks the same rule on the command's day.
    let at = |date: &str| {
        let (y, m, d): (i32, u8, u8) = (
            date[..4].parse().unwrap(),
            date[5..7].parse().unwrap(),
            date[8..].parse().unwrap(),
        );
        let day = time_ms(y, m, d);
        day + 12 * 60 * 60 * 1000
    };
    let early = tx_at(&w.a, at("2034-06-01"), |ctx| {
        scans::delete_images(ctx, &id, None, DeletionReason::Retention, Source::Ui)
    });
    assert_eq!(reason(early.unwrap_err()), "retention_running");
    tx_at(&w.a, at("2034-06-02"), |ctx| {
        scans::delete_images(ctx, &id, None, DeletionReason::Retention, Source::Ui)
    })
    .unwrap();
    assert!(listed("2034-06-02").is_empty());
    let s = w.get(&id);
    assert_eq!(
        (s.status, s.deletion_reason),
        (Status::Accepted, Some(DeletionReason::Retention))
    );
}

/// Days from the epoch to a civil date, in ms (Howard Hinnant's).
fn time_ms(y: i32, m: u8, d: u8) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146097 + doe - 719468) * DAY
}

#[test]
fn a_declaration_that_covered_no_gift_counts_from_when_it_was_made() {
    let w = world();
    let paper = w.declare(Method::PaperForm); // made 2026-03-03, no gifts
    let id = w.scan();
    w.accept_existing(&id, &paper).unwrap();
    let listed = |today: &str| read(&w.a, |c| Ok(scans::deletable(c, today)?));
    assert!(listed("2033-03-03").is_empty());
    assert_eq!(listed("2033-03-04").len(), 1);
    assert_eq!(listed("2033-03-04")[0].last_covered_on, None);
}

#[test]
fn erasure_keeps_a_scan_whose_declaration_covers_a_claimed_gift_and_deletes_the_rest() {
    let w = world();
    let paper = w.declare(Method::PaperForm);
    let claimed = w.scan();
    w.accept_existing(&claimed, &paper).unwrap();
    let draft = w.scan();
    let today = uk_date(contracts::now_ms());
    let deletes = |id: &str| {
        let s = w.get(id);
        read(&w.a, |c| Ok(scans::erasure_deletes(c, &s, &today)?))
    };
    // Covered no claimed gift (none at all yet): erasure deletes it.
    assert!(deletes(&claimed));
    // A draft matched to nothing is no tax record.
    assert!(deletes(&draft));
    gift_for(&w.a, &w.jo, &today, false);
    tx(&w.a, |ctx| {
        contracts::execute(
            ctx,
            &contacts::ADDRESSES,
            contacts::types::Addresses {
                addresses: vec![contacts::types::AddressRow {
                    key: None,
                    label: contacts::types::ChannelLabel::Home,
                    line1: "12 High Street".into(),
                    line2: String::new(),
                    line3: String::new(),
                    town: "London".into(),
                    postcode: "SW1A 1AA".into(),
                    country: "GB".into(),
                    is_primary: true,
                }],
            },
            contracts::Exec::update(&w.jo, None, Source::Ui),
        )
    })
    .unwrap();
    tx(&w.a, |ctx| {
        giftaid::claims::create_claim(
            ctx,
            giftaid::claim_types::CreateClaim {
                period_end: today.clone(),
                expected_lines: None,
                expected_donations: None,
                expected_adjustment: None,
            },
            Source::Ui,
        )
    })
    .unwrap();
    assert!(!deletes(&claimed), "the claim's evidence stays");
    let refused = tx(&w.a, |ctx| {
        scans::delete_images(ctx, &claimed, None, DeletionReason::Erasure, Source::Ui)
    });
    assert_eq!(reason(refused.unwrap_err()), "retention_running");
    tx(&w.a, |ctx| {
        scans::delete_images(ctx, &draft, None, DeletionReason::Erasure, Source::Ui)
    })
    .unwrap();
}

#[test]
fn no_scan_contract_can_be_restored() {
    let w = world();
    let id = w.scan();
    let revision: i64 = read(&w.a, |c| {
        Ok(c.query_row(
            "SELECT id FROM revisions WHERE entity = 'declaration_scans' AND entity_id = ?1",
            [&id],
            |r| r.get(0),
        )?)
    });
    let out = tx(&w.a, |ctx| {
        contracts::restore(ctx, &giftaid::REGISTRY, revision, None)
    });
    assert_eq!(reason(out.unwrap_err()), "not_restorable");
}

#[test]
fn another_organisation_sees_none_of_it_and_cant_review_it() {
    let w = world();
    let id = w.scan();
    assert!(read(&w.b, |c| Ok(scans::get(c, &id)?)).is_none());
    assert!(read(&w.b, |c| Ok(scans::inbox(c)?)).is_empty());
    let review = tx(&w.b, |ctx| {
        scans::discard_scan(ctx, &id, 0, None, Source::Ui)
    });
    assert_eq!(reason(review.unwrap_err()), "not_found");
    let add = tx(&w.b, |ctx| scans::add_page(ctx, &id, page(2), Source::Ui));
    assert_eq!(reason(add.unwrap_err()), "not_found");
    assert_eq!(w.get(&id).pages.len(), 1);
}

impl World {
    fn inbox(&self) -> Vec<ScanView> {
        read(&self.a, |c| Ok(scans::inbox(c)?))
    }
}
