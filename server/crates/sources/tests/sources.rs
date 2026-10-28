//! Source codes on real org files (Convex `sources/sources.test.ts`): the
//! `sources.code` contract, the used marker and delete, archive hiding,
//! the picker and the seeds. Two organisations throughout; each case
//! names the Convex test it ports. List management (who may write) is a
//! route rule: `api/tests/sources_routes.rs`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use contracts::{ContractError, Ctx, Exec, Executed, Source, execute, restore};
use rusqlite::Connection;
use sources::rules::{Level, SEED_CATEGORIES, SOURCE_CODE_LIMIT};
use sources::types::{Part, SourceCodePayload};
use sources::{CODE, DELETION, DeletionPayload, REGISTRY};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

const TODAY: &str = "2026-10-19";

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
}

/// Two organisations, each seeded as a new one is.
fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(StoreConfig {
        dir: tmp.path().to_path_buf(),
        org_migrations: Migrations::new(vec![
            M::up(contracts::MIGRATION),
            M::up(sources::MIGRATION),
            M::up(ASSIGNMENTS),
        ]),
        readers: 2,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap();
    let a = store.create_tenant("alpha", "Alpha").unwrap();
    let b = store.create_tenant("beta", "Beta").unwrap();
    let w = World {
        a: store.org(&a.id).unwrap(),
        b: store.org(&b.id).unwrap(),
        _tmp: tmp,
    };
    for db in [&w.a, &w.b] {
        assert_eq!(
            tx(db, sources::seed_new_org).unwrap(),
            SEED_CATEGORIES.len()
        );
    }
    w
}

fn tx<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    contracts::transact(db, Some(1), f)
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    db.read(|c| f(c)).unwrap()
}

fn tree(db: &OrgDb) -> Vec<Part> {
    read(db, sources::tree)
}

fn part(db: &OrgDb, id: &str) -> Part {
    tree(db).into_iter().find(|p| p.id == id).unwrap()
}

fn payload(name: &str, parent: Option<&str>) -> SourceCodePayload {
    SourceCodePayload {
        parent_id: parent.map(Into::into),
        name: name.into(),
        description: None,
        start_date: None,
        end_date: None,
        is_active: true,
    }
}

fn create_with(db: &OrgDb, p: SourceCodePayload) -> Result<sources::Created, ContractError> {
    tx(db, |ctx| sources::create_part(ctx, p, Source::Ui, None))
}

fn create(db: &OrgDb, name: &str, parent: Option<&str>) -> sources::Created {
    create_with(db, payload(name, parent)).unwrap()
}

/// Save a part with some fields changed, at its current counter.
fn save(
    db: &OrgDb,
    id: &str,
    change: impl FnOnce(&mut SourceCodePayload),
) -> Result<Executed, ContractError> {
    let p = part(db, id);
    let mut next = SourceCodePayload {
        parent_id: None,
        name: p.name,
        description: p.description,
        start_date: p.start_date,
        end_date: p.end_date,
        is_active: p.is_active,
    };
    change(&mut next);
    tx(db, |ctx| {
        execute(
            ctx,
            &CODE,
            next,
            Exec::update(id, Some(p.save_version), Source::Ui),
        )
    })
}

fn remove_at(db: &OrgDb, id: &str, expected: i64) -> Result<i64, ContractError> {
    tx(db, |ctx| {
        execute(
            ctx,
            &DELETION,
            DeletionPayload { expected },
            Exec::create_with_id(id, Source::Ui),
        )?;
        Ok(sources::deleted_count(ctx.tx.read(), id)?)
    })
}

fn remove(db: &OrgDb, id: &str) -> Result<i64, ContractError> {
    remove_at(db, id, part(db, id).save_version)
}

fn category(db: &OrgDb, name: &str) -> String {
    tree(db)
        .into_iter()
        .find(|p| p.level == Level::Category && p.name == name)
        .unwrap()
        .id
}

struct Street {
    category: String,
    detail: String,
    version: String,
}

/// Street → Wesser (→ 001), the plan's example.
fn street(db: &OrgDb) -> Street {
    let category = category(db, "Street");
    let made = create(db, "Wesser", Some(&category));
    Street {
        category,
        detail: made.id,
        version: made.version_id.unwrap(),
    }
}

/// A toy assigning entity (as a contact's acquisition or a gift is): its
/// contract's `write` is where `mark_used` runs.
const ASSIGNMENTS: &str = "CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    code_id TEXT NOT NULL,
    assign_version INTEGER NOT NULL DEFAULT 0
) STRICT;";

#[derive(serde::Serialize)]
struct Assignment {
    code_id: String,
    allow_archived: bool,
}

/// Assign `id` the way a contract's `write` does: `mark_used`, then the
/// assigning row.
fn mark(db: &OrgDb, id: &str, allow_archived: bool) -> Result<(), ContractError> {
    struct Writes<'a>(&'a Assignment);
    impl contracts::Contract for Writes<'static> {
        const NAME: &'static str = "test.assign";
        const VERSION: u32 = 1;
        const ENTITY: &'static str = "assignments";
        const COUNTER: &'static str = "assign_version";
        type Payload = ();
        type State = ();
        fn load(&self, _: &contracts::OrgTx, _: &str) -> Result<(), ContractError> {
            Ok(())
        }
        fn apply(
            &self,
            _: Option<&()>,
            _: &(),
            _: &contracts::Command,
        ) -> Result<(), ContractError> {
            Ok(())
        }
        fn write(
            &self,
            tx: &contracts::WriteTx,
            id: &str,
            _: Option<&()>,
            _: &(),
        ) -> Result<(), ContractError> {
            sources::mark_used(tx, &self.0.code_id, self.0.allow_archived)?;
            tx.execute(
                "INSERT INTO assignments (id, code_id) VALUES (?1, ?2)",
                [id, &self.0.code_id],
            )?;
            Ok(())
        }
    }
    let a: &'static Assignment = Box::leak(Box::new(Assignment {
        code_id: id.to_owned(),
        allow_archived,
    }));
    tx(db, |ctx| {
        execute(ctx, &Writes(a), (), Exec::create(Source::Test)).map(|_| ())
    })
}

/// Rows of every table in a file, for "B never changed".
fn snapshot(db: &OrgDb) -> String {
    read(db, |c| {
        let mut out = String::new();
        for table in ["source_codes", "source_code_deletions", "revisions"] {
            let mut s = c.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
            let n = s.column_count();
            let rows = s.query_map([], |r| {
                (0..n)
                    .map(|i| {
                        r.get::<_, rusqlite::types::Value>(i)
                            .map(|v| format!("{v:?}"))
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?;
            for row in rows {
                out.push_str(&row?.join("|"));
                out.push('\n');
            }
        }
        Ok(out)
    })
}

fn reason(e: ContractError) -> String {
    match e {
        ContractError::Invalid(p) => p[0].field.clone(),
        ContractError::Rejected { reason, .. } => reason,
        other => format!("{other:?}"),
    }
}

// ── seeds ──────────────────────────────────────────────────────────────────

// seeds › each tenant starts with the seven categories; a rerun adds nothing
#[test]
fn each_org_starts_with_the_seven_categories_and_a_rerun_adds_nothing() {
    let w = world();
    for db in [&w.a, &w.b] {
        let parts = tree(db);
        let mut names: Vec<_> = parts.iter().map(|p| (p.level, p.name.clone())).collect();
        names.sort_by(|x, y| x.1.cmp(&y.1));
        let mut want: Vec<_> = SEED_CATEGORIES
            .iter()
            .map(|n| (Level::Category, n.to_string()))
            .collect();
        want.sort_by(|x, y| x.1.cmp(&y.1));
        assert_eq!(names, want);
        assert_eq!(tx(db, sources::seed_new_org).unwrap(), 0);
        assert_eq!(tree(db), parts);
        let seeded: i64 = read(db, |c| {
            c.query_row(
                "SELECT count(*) FROM revisions WHERE contract = 'sources.code' AND source = 'seed'",
                [],
                |r| r.get(0),
            )
        });
        assert_eq!(seeded, SEED_CATEGORIES.len() as i64);
    }
}

// seeds › an unused seed can be deleted, and stays deleted
#[test]
fn an_unused_seed_can_be_deleted_and_stays_deleted() {
    let w = world();
    let b_before = snapshot(&w.b);
    remove(&w.a, &category(&w.a, "Telephone")).unwrap();
    tx(&w.a, sources::seed_new_org).unwrap();
    let names: Vec<_> = tree(&w.a).into_iter().map(|p| p.name).collect();
    assert!(!names.contains(&"Telephone".to_owned()));
    assert_eq!(names.len(), SEED_CATEGORIES.len() - 1);
    assert_eq!(snapshot(&w.b), b_before);
}

// ── the contract ───────────────────────────────────────────────────────────

// sources.code › a new detail comes with version 001, in one command group
#[test]
fn a_new_detail_comes_with_version_001_in_one_command_group() {
    let w = world();
    let s = street(&w.a);
    let parts: Vec<_> = tree(&w.a)
        .into_iter()
        .filter(|p| [&s.category, &s.detail, &s.version].contains(&&p.id))
        .map(|p| (p.level, p.code, p.used))
        .collect();
    assert_eq!(
        parts,
        [
            (Level::Category, "Street".to_owned(), false),
            (Level::Detail, "Street-Wesser".to_owned(), false),
            (Level::Version, "Street-Wesser-001".to_owned(), false),
        ]
    );
    let groups: Vec<Option<String>> = read(&w.a, |c| {
        c.prepare("SELECT group_name FROM revisions WHERE entity_id IN (?1, ?2) ORDER BY id")?
            .query_map([&s.detail, &s.version], |r| r.get(0))?
            .collect()
    });
    assert_eq!(
        groups,
        [
            Some("create Wesser".to_owned()),
            Some("create Wesser".to_owned())
        ]
    );
    // A version added by hand is just itself.
    let made = create(&w.a, "002", Some(&s.detail));
    assert_eq!(made.version_id, None);
    assert_eq!(part(&w.a, &made.id).code, "Street-Wesser-002");
}

// sources.code › names: required, no hyphen, unique among siblings in any case
#[test]
fn names_are_required_hyphen_free_and_unique_among_siblings() {
    let w = world();
    let s = street(&w.a);
    let refused = |name: &str, parent: Option<&str>, description: Option<&str>| {
        reason(
            create_with(
                &w.a,
                SourceCodePayload {
                    description: description.map(Into::into),
                    ..payload(name, parent)
                },
            )
            .unwrap_err(),
        )
    };
    let cat = Some(s.category.as_str());
    assert_eq!(refused("  ", cat, None), "name");
    assert_eq!(refused("Wes-ser", cat, None), "name");
    assert_eq!(refused(&"x".repeat(41), cat, None), "name");
    assert_eq!(refused("Long", cat, Some(&"x".repeat(1001))), "description");
    let wordy = create_with(
        &w.a,
        SourceCodePayload {
            description: Some(format!(" {} ", "x".repeat(1000))),
            ..payload("Wordy", cat)
        },
    )
    .unwrap();
    assert_eq!(part(&w.a, &wordy.id).description.unwrap().len(), 1000);
    assert_eq!(refused(" wESSER ", cat, None), "duplicate_source_name");
    assert_eq!(refused("street", None, None), "duplicate_source_name");
    assert_eq!(
        refused("001", Some(&s.detail), None),
        "duplicate_source_name"
    );
    // The same name under another parent is fine, so full codes stay unique.
    let online = category(&w.a, "Online");
    let other = create(&w.a, "Wesser", Some(&online));
    assert_eq!(
        part(&w.a, &other.version_id.unwrap()).code,
        "Online-Wesser-001"
    );
    // Renaming onto a sibling's name is refused too.
    let fundraisers = create(&w.a, "Fundraisers", cat);
    assert_eq!(
        reason(save(&w.a, &fundraisers.id, |p| p.name = "WESSER".into()).unwrap_err()),
        "duplicate_source_name"
    );
    // Inner whitespace is tidied.
    let big = create(&w.a, " Big   Day ", None);
    assert_eq!(part(&w.a, &big.id).name, "Big Day");
}

// sources.code › levels: three deep, dates only below a category, parent of this tenant
#[test]
fn levels_are_three_deep_with_dates_below_a_category_and_a_parent_of_this_org() {
    let w = world();
    let s = street(&w.a);
    let dated = |name: &str, parent: Option<&str>, start: Option<&str>, end: Option<&str>| {
        create_with(
            &w.a,
            SourceCodePayload {
                start_date: start.map(Into::into),
                end_date: end.map(Into::into),
                ..payload(name, parent)
            },
        )
    };
    assert_eq!(
        reason(create_with(&w.a, payload("Deeper", Some(&s.version))).unwrap_err()),
        "too_deep"
    );
    assert!(matches!(
        dated("Dated", None, Some(TODAY), None),
        Err(ContractError::Invalid(_))
    ));
    assert!(matches!(
        save(&w.a, &s.category, |p| p.end_date = Some(TODAY.into())),
        Err(ContractError::Invalid(_))
    ));
    assert!(matches!(
        dated(
            "Backwards",
            Some(&s.category),
            Some("2026-10-19"),
            Some("2026-10-01")
        ),
        Err(ContractError::Invalid(_))
    ));
    assert!(matches!(
        dated("Sloppy", Some(&s.category), Some("19/10"), None),
        Err(ContractError::Invalid(_))
    ));
    // Organisation A's category, in B's file, doesn't exist.
    assert_eq!(
        reason(create_with(&w.b, payload("Sneaky", Some(&s.category))).unwrap_err()),
        "unknown_parent"
    );
    // A part stays under its parent: a save naming another is refused.
    let online = category(&w.a, "Online");
    assert_eq!(
        reason(save(&w.a, &s.detail, |p| p.parent_id = Some(online)).unwrap_err()),
        "parent_fixed"
    );
}

// sources.code › a rename changes every code under the part; ids and history stay
#[test]
fn a_rename_changes_every_code_under_the_part_and_history_stays() {
    let w = world();
    let s = street(&w.a);
    save(&w.a, &s.category, |p| p.name = "Face to face".into()).unwrap();
    assert_eq!(part(&w.a, &s.version).code, "Face to face-Wesser-001");
    assert_eq!(part(&w.a, &s.detail).save_version, 0);
    let d = read(&w.a, |c| sources::describe(c, &s.version)).unwrap();
    assert_eq!(
        (
            d.code.as_str(),
            d.category_id.as_str(),
            d.category_name.as_str()
        ),
        (
            "Face to face-Wesser-001",
            s.category.as_str(),
            "Face to face"
        )
    );
    // The old name is in history, and restoring it reads as before.
    let (first, name): (i64, String) = read(&w.a, |c| {
        c.query_row(
            "SELECT id, json_extract(payload, '$.name') FROM revisions
             WHERE entity_id = ?1 AND counter = 0",
            [&s.category],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    });
    assert_eq!(name, "Street");
    tx(&w.a, |ctx| restore(ctx, &REGISTRY, first, None)).unwrap();
    assert_eq!(part(&w.a, &s.version).code, "Street-Wesser-001");
}

// sources.code › a stale save is refused
#[test]
fn a_stale_save_is_refused() {
    let w = world();
    let s = street(&w.a);
    save(&w.a, &s.detail, |p| p.description = Some("Agency".into())).unwrap();
    let stale = tx(&w.a, |ctx| {
        execute(
            ctx,
            &CODE,
            payload("Wesser", None),
            Exec::update(&s.detail, Some(0), Source::Ui),
        )
    })
    .unwrap_err();
    match stale {
        ContractError::Stale {
            contract,
            counter,
            current,
        } => {
            assert_eq!((contract, counter), ("sources.code", 1));
            assert_eq!(current["description"], "Agency");
        }
        other => panic!("{other:?}"),
    }
}

// ── describe and mark_used ─────────────────────────────────────────────────

// describe › a version, its parents and its own dates; null for anything else
#[test]
fn describe_a_version_its_parents_and_dates_and_none_otherwise() {
    let w = world();
    let s = street(&w.a);
    save(&w.a, &s.version, |p| {
        p.start_date = Some("2026-01-01".into());
        p.end_date = Some("2026-12-31".into());
    })
    .unwrap();
    let describe = |db: &OrgDb, id: &str| read(db, |c| sources::describe(c, id));
    assert_eq!(
        describe(&w.a, &s.version),
        Some(sources::CodeDescription {
            code: "Street-Wesser-001".into(),
            version_id: s.version.clone(),
            detail_id: s.detail.clone(),
            category_id: s.category.clone(),
            version_name: "001".into(),
            detail_name: "Wesser".into(),
            category_name: "Street".into(),
            is_active: true,
            start_date: Some("2026-01-01".into()),
            end_date: Some("2026-12-31".into()),
        })
    );
    // Undated, a version shows its detail's dates, bound by bound.
    save(&w.a, &s.detail, |p| {
        p.start_date = Some("2025-06-01".into());
        p.end_date = Some("2027-01-31".into());
    })
    .unwrap();
    save(&w.a, &s.version, |p| {
        p.start_date = Some(String::new());
        p.end_date = Some("2026-11-30".into());
    })
    .unwrap();
    let d = describe(&w.a, &s.version).unwrap();
    assert_eq!(
        (d.start_date.as_deref(), d.end_date.as_deref()),
        (Some("2025-06-01"), Some("2026-11-30"))
    );
    assert_eq!(describe(&w.a, &s.detail), None);
    assert_eq!(describe(&w.a, &s.category), None);
    assert_eq!(describe(&w.b, &s.version), None);
    save(&w.a, &s.category, |p| p.is_active = false).unwrap();
    assert!(!describe(&w.a, &s.version).unwrap().is_active);
}

// describe › within one call, a write is seen by the next describe
// (Convex memoised reads per call; here every read is the transaction's.)
#[test]
fn within_one_transaction_a_write_is_seen_by_the_next_describe() {
    let w = world();
    let s = street(&w.a);
    let (before, after) = tx(&w.a, |ctx| {
        let before = sources::describe(ctx.tx.read(), &s.version)?.unwrap();
        execute(
            ctx,
            &CODE,
            SourceCodePayload {
                is_active: false,
                ..payload("Wessex", None)
            },
            Exec::update(&s.detail, Some(0), Source::Ui),
        )?;
        let after = sources::describe(ctx.tx.read(), &s.version)?.unwrap();
        Ok((before, after))
    })
    .unwrap();
    assert_eq!(
        (before.code.as_str(), before.is_active),
        ("Street-Wesser-001", true)
    );
    assert_eq!(
        (after.code.as_str(), after.is_active),
        ("Street-Wessex-001", false)
    );
}

// markUsed › marks the version and both parents, once, and is idempotent
#[test]
fn mark_used_marks_the_version_and_both_parents_once() {
    let w = world();
    let s = street(&w.a);
    let sibling = create(&w.a, "002", Some(&s.detail));
    let b_before = snapshot(&w.b);
    mark(&w.a, &s.version, false).unwrap();
    let used = |id: &str| part(&w.a, id).used;
    assert!(used(&s.category) && used(&s.detail) && used(&s.version));
    assert!(!used(&sibling.id));
    let marked: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT count(*) FROM source_codes WHERE used = 1",
            [],
            |r| r.get(0),
        )
    });
    mark(&w.a, &s.version, false).unwrap();
    let again: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT count(*) FROM source_codes WHERE used = 1",
            [],
            |r| r.get(0),
        )
    });
    assert_eq!((marked, again), (3, 3));
    // No revision of its own: a system-owned field.
    let revisions: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT count(*) FROM revisions WHERE entity_id = ?1",
            [&s.version],
            |r| r.get(0),
        )
    });
    assert_eq!(revisions, 1);
    assert_eq!(snapshot(&w.b), b_before);
}

// markUsed › only a version of this tenant, not archived or under an archived parent; out of date is fine
#[test]
fn mark_used_takes_only_an_active_version_of_this_org() {
    let w = world();
    let s = street(&w.a);
    let field = |r: Result<(), ContractError>| match r {
        Err(ContractError::Invalid(p)) => p[0].field.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(field(mark(&w.a, &s.category, false)), "sourceCode");
    assert_eq!(field(mark(&w.a, &s.detail, false)), "sourceCode");
    assert_eq!(field(mark(&w.b, &s.version, false)), "sourceCode");

    save(&w.a, &s.version, |p| p.end_date = Some("2020-01-01".into())).unwrap();
    mark(&w.a, &s.version, false).unwrap();

    let old = create(&w.a, "Old", Some(&s.category)).version_id.unwrap();
    save(&w.a, &old, |p| p.is_active = false).unwrap();
    assert_eq!(field(mark(&w.a, &old, false)), "sourceCode");
    save(&w.a, &s.category, |p| p.is_active = false).unwrap();
    let v2 = create(&w.a, "002", Some(&s.detail)).id;
    assert_eq!(field(mark(&w.a, &v2, false)), "sourceCode");
    // Restore may put back a code archived since.
    mark(&w.a, &v2, true).unwrap();
    assert!(part(&w.a, &v2).used);
}

// markUsed › the marker survives a save and a restore
#[test]
fn the_used_marker_survives_a_save_and_a_restore() {
    let w = world();
    let s = street(&w.a);
    mark(&w.a, &s.version, false).unwrap();
    save(&w.a, &s.category, |p| {
        p.name = "Face to face".into();
        p.is_active = false;
    })
    .unwrap();
    save(&w.a, &s.version, |p| {
        p.description = Some("First run".into())
    })
    .unwrap();
    let first: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT id FROM revisions WHERE entity_id = ?1 AND counter = 0",
            [&s.version],
            |r| r.get(0),
        )
    });
    tx(&w.a, |ctx| restore(ctx, &REGISTRY, first, None)).unwrap();
    assert!(part(&w.a, &s.category).used);
    assert!(part(&w.a, &s.version).used);
    assert_eq!(part(&w.a, &s.version).description, None);
}

// ── delete ─────────────────────────────────────────────────────────────────

// remove › an unused part goes with everything under it
#[test]
fn an_unused_part_goes_with_everything_under_it() {
    let w = world();
    let s = street(&w.a);
    let extra = create(&w.a, "002", Some(&s.detail));
    let b_before = snapshot(&w.b);
    assert_eq!(remove(&w.a, &extra.id).unwrap(), 1);
    assert_eq!(remove(&w.a, &s.category).unwrap(), 3);
    let ids: Vec<_> = tree(&w.a).into_iter().map(|p| p.id).collect();
    for id in [&s.category, &s.detail, &s.version, &extra.id] {
        assert!(!ids.contains(id));
    }
    // The delete is a recorded command: who and when, under the part's id.
    let deletions: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT count(*) FROM revisions WHERE contract = 'sources.delete' AND entity_id = ?1",
            [&s.category],
            |r| r.get(0),
        )
    });
    assert_eq!(deletions, 1);
    assert_eq!(snapshot(&w.b), b_before);
}

// remove › once used, a part and its parents can only be archived
#[test]
fn once_used_a_part_and_its_parents_can_only_be_archived() {
    let w = world();
    let s = street(&w.a);
    let unused = create(&w.a, "002", Some(&s.detail));
    mark(&w.a, &s.version, false).unwrap();
    for id in [&s.version, &s.detail, &s.category] {
        assert_eq!(reason(remove(&w.a, id).unwrap_err()), "used");
    }
    // Its unused sibling still goes.
    assert_eq!(remove(&w.a, &unused.id).unwrap(), 1);
    save(&w.a, &s.version, |p| p.is_active = false).unwrap();
    assert!(!part(&w.a, &s.version).is_active);
}

// remove › stale, missing and other-tenant deletes are refused
#[test]
fn stale_missing_and_other_org_deletes_are_refused() {
    let w = world();
    let s = street(&w.a);
    save(&w.a, &s.detail, |p| p.description = Some("Agency".into())).unwrap();
    match remove_at(&w.a, &s.detail, 0).unwrap_err() {
        ContractError::Stale {
            contract, counter, ..
        } => assert_eq!((contract, counter), ("sources.code", 1)),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        remove_at(&w.b, &s.detail, 1),
        Err(ContractError::NotFound)
    ));
    remove_at(&w.a, &s.detail, 1).unwrap();
    // Gone (the route answers 404 before the command runs).
    assert!(remove_at(&w.a, &s.detail, 1).is_err());
    // A deletion is no state to restore.
    let deletion: i64 = read(&w.a, |c| {
        c.query_row(
            "SELECT id FROM revisions WHERE contract = 'sources.delete'",
            [],
            |r| r.get(0),
        )
    });
    assert_eq!(
        reason(tx(&w.a, |ctx| restore(ctx, &REGISTRY, deletion, None)).unwrap_err()),
        "not_restorable"
    );
}

// ── archive hiding and the picker ──────────────────────────────────────────

fn codes(db: &OrgDb, search: &str, today: &str) -> Vec<String> {
    read(db, |c| sources::picker(c, today, search))
        .codes
        .into_iter()
        .map(|c| c.code)
        .collect()
}

// picker › archiving a parent hides its codes; reactivating restores their own state
#[test]
fn archiving_a_parent_hides_its_codes_and_reactivating_restores_them() {
    let w = world();
    let s = street(&w.a);
    let v2 = create(&w.a, "002", Some(&s.detail)).id;
    save(&w.a, &v2, |p| p.is_active = false).unwrap();
    assert_eq!(codes(&w.a, "", TODAY), ["Street-Wesser-001"]);

    save(&w.a, &s.category, |p| p.is_active = false).unwrap();
    assert!(codes(&w.a, "", TODAY).is_empty());
    let shown: Vec<_> = tree(&w.a)
        .into_iter()
        .filter(|p| [&s.detail, &s.version, &v2].contains(&&p.id))
        .map(|p| (p.code, p.is_active, p.visible))
        .collect();
    assert_eq!(
        shown,
        [
            ("Street-Wesser".to_owned(), true, false),
            ("Street-Wesser-001".to_owned(), true, false),
            ("Street-Wesser-002".to_owned(), false, false),
        ]
    );

    save(&w.a, &s.category, |p| p.is_active = true).unwrap();
    assert_eq!(codes(&w.a, "", TODAY), ["Street-Wesser-001"]);
    // B never sees A's codes.
    assert!(codes(&w.b, "", TODAY).is_empty());
    assert!(!tree(&w.b).iter().any(|p| p.code == "Street-Wesser"));
}

// picker › versions only, in date first, searched anywhere in the code
#[test]
fn the_picker_lists_versions_in_date_first_searched_anywhere() {
    let w = world();
    let online = category(&w.a, "Online");
    let event = category(&w.a, "Event");
    let dated =
        |name: &str, parent: &str, start: Option<&str>, end: Option<&str>, desc: Option<&str>| {
            create_with(
                &w.a,
                SourceCodePayload {
                    start_date: start.map(Into::into),
                    end_date: end.map(Into::into),
                    description: desc.map(Into::into),
                    ..payload(name, Some(parent))
                },
            )
            .unwrap()
        };
    // Detail dates cover its versions unless a version has its own.
    let xmas = dated(
        "Xmas",
        &online,
        Some("2026-12-01"),
        Some("2026-12-31"),
        Some("Christmas appeal"),
    );
    let gala = dated("Gala", &event, None, Some("2026-06-30"), None);
    let gala_late = dated("Late", &gala.id, None, Some("2026-12-31"), None).id;
    create(&w.a, "Web", Some(&online));

    let result = read(&w.a, |c| sources::picker(c, TODAY, ""));
    let shown: Vec<_> = result
        .codes
        .iter()
        .map(|c| (c.code.as_str(), c.status, c.description.as_deref()))
        .collect();
    use sources::rules::DateStatus::*;
    assert_eq!(
        shown,
        [
            ("Event-Gala-Late", Current, None),
            ("Online-Web-001", Current, None),
            ("Online-Xmas-001", NotStarted, Some("Christmas appeal")),
            ("Event-Gala-001", Ended, None),
        ]
    );
    assert!(!result.truncated);
    assert_eq!(result.codes[0].version_id, gala_late);
    assert_eq!(
        (
            result.codes[2].version_id.as_str(),
            result.codes[2].start_date.as_deref(),
            result.codes[2].end_date.as_deref()
        ),
        (
            xmas.version_id.as_deref().unwrap(),
            Some("2026-12-01"),
            Some("2026-12-31")
        )
    );
    assert_eq!(
        codes(&w.a, "GALA", TODAY),
        ["Event-Gala-Late", "Event-Gala-001"]
    );
    assert_eq!(codes(&w.a, "line-x", TODAY), ["Online-Xmas-001"]);
    // Another day, another order.
    let statuses: Vec<_> = read(&w.a, |c| sources::picker(c, "2026-12-10", "xmas"))
        .codes
        .into_iter()
        .map(|c| c.status)
        .collect();
    assert_eq!(statuses, [Current]);
}

// picker.timing › the picker at SOURCE_CODE_LIMIT parts: its own work stays under 50 ms
// (here the whole read: rows and the pass, which is what a request pays)
#[test]
fn the_picker_at_the_part_limit_stays_under_budget() {
    const BUDGET: Duration = Duration::from_millis(50);
    let w = world();
    // Through the contract, in one transaction; dates and archived parts
    // so every branch of the order and the visibility walk runs.
    tx(&w.a, |ctx| {
        let total = std::cell::Cell::new(SEED_CATEGORIES.len() as i64);
        let make = |p: SourceCodePayload| -> Result<String, ContractError> {
            total.set(total.get() + 1);
            Ok(execute(ctx, &CODE, p, Exec::create(Source::Test))?.id)
        };
        let mut c = 0;
        while total.get() < SOURCE_CODE_LIMIT {
            let cat = make(SourceCodePayload {
                is_active: c % 7 != 6,
                ..payload(&format!("Cat{c}"), None)
            })?;
            let mut d = 0;
            while d < 8 && total.get() < SOURCE_CODE_LIMIT {
                let detail = make(SourceCodePayload {
                    end_date: (d % 3 == 0).then(|| "2026-01-01".into()),
                    ..payload(&format!("Det{d}"), Some(&cat))
                })?;
                let mut v = 0;
                while v < 6 && total.get() < SOURCE_CODE_LIMIT {
                    make(SourceCodePayload {
                        start_date: (v % 4 == 0).then(|| "2027-01-01".into()),
                        is_active: v % 5 != 4,
                        ..payload(&format!("{v:03}"), Some(&detail))
                    })?;
                    v += 1;
                }
                d += 1;
            }
            c += 1;
        }
        Ok(())
    })
    .unwrap();
    let held: i64 = read(&w.a, |c| {
        c.query_row("SELECT count(*) FROM source_codes", [], |r| r.get(0))
    });
    assert_eq!(held, SOURCE_CODE_LIMIT);
    // One more is refused.
    assert_eq!(
        reason(create_with(&w.a, payload("Overflow", None)).unwrap_err()),
        "source_code_limit"
    );
    let best = (0..3)
        .map(|_| {
            let start = Instant::now();
            let picked = read(&w.a, |c| sources::picker(c, TODAY, ""));
            assert!(picked.truncated);
            assert_eq!(picked.codes.len(), sources::PICKER_LIMIT);
            start.elapsed()
        })
        .min()
        .unwrap();
    assert!(best < BUDGET, "picker took {best:?}");
}
