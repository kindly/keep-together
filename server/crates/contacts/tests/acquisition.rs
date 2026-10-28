//! A contact's acquisition code (Convex `contacts/acquisition.test.ts`)
//! and the contacts list's source filter (`contacts/sourceFilter.test.ts`),
//! on real org files with two organisations. Each case names the Convex
//! test it ports.

use std::sync::Arc;

use contacts::acquisition::{NewContact, create_contact, set_acquisition};
use contacts::form::{restore_contact, save_form, set_archived};
use contacts::number::format_number;
use contacts::queries::{ListQuery, SearchQuery, get, list, search};
use contacts::types::*;
use contracts::{ContractError, Ctx, Exec, Executed, Source, execute};
use sources::types::SourceCodePayload;
use sources::{CODE, SourceCodePayload as Payload};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

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
            M::up(sources::MIGRATION),
            M::up(contacts::acquisition::MIGRATION),
            // B1: a field's retire phase, the delete logs.
            M::up(contacts::fields::MIGRATION_RETIRE),
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
        tx(db, sources::seed_new_org).unwrap();
    }
    w
}

fn tx<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    contracts::transact(db, Some(1), f)
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&rusqlite::Connection) -> Result<T, ContractError>) -> T {
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

fn add_with(db: &OrgDb, d: Details, code: Option<&str>) -> Result<Created, ContractError> {
    tx(db, |ctx| {
        create_contact(
            ctx,
            NewContact {
                create: CreateContact {
                    id: None,
                    details: d,
                },
                acquisition_code_id: code.map(Into::into),
            },
            Source::Ui,
        )
    })
}

fn add(db: &OrgDb, first: &str, last: &str, code: Option<&str>) -> String {
    add_with(db, person(first, last), code).unwrap().id
}

#[derive(Clone)]
struct Code {
    category: String,
    detail: String,
    version: String,
}

fn category(db: &OrgDb, name: &str) -> String {
    read(db, |c| Ok(sources::tree(c)?))
        .into_iter()
        .find(|p| p.parent_id.is_none() && p.name == name)
        .unwrap()
        .id
}

fn new_part(db: &OrgDb, p: Payload) -> sources::Created {
    tx(db, |ctx| sources::create_part(ctx, p, Source::Ui, None)).unwrap()
}

fn named(name: &str, parent: Option<&str>) -> Payload {
    SourceCodePayload {
        parent_id: parent.map(Into::into),
        name: name.into(),
        description: None,
        start_date: None,
        end_date: None,
        is_active: true,
    }
}

/// A seeded category, a detail under it and its version `001`.
fn code(db: &OrgDb, category_name: &str, detail: &str) -> Code {
    let category = category(db, category_name);
    let made = new_part(db, named(detail, Some(&category)));
    Code {
        category,
        detail: made.id,
        version: made.version_id.unwrap(),
    }
}

/// Save a part through its contract with some fields changed.
fn change_part(db: &OrgDb, id: &str, f: impl FnOnce(&mut Payload)) {
    let p = read(db, |c| Ok(sources::tree(c)?))
        .into_iter()
        .find(|p| p.id == id)
        .unwrap();
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

fn set(db: &OrgDb, id: &str, code: Option<&str>, expected: i64) -> Result<Executed, ContractError> {
    tx(db, |ctx| {
        set_acquisition(ctx, id, expected, code.map(Into::into))
    })
}

fn view(db: &OrgDb, id: &str) -> ContactView {
    read(db, |c| get(c, id)).unwrap()
}

fn used(db: &OrgDb, c: &Code) -> [bool; 3] {
    read(db, |conn| {
        let one = |id: &str| -> rusqlite::Result<bool> {
            conn.query_row("SELECT used FROM source_codes WHERE id = ?1", [id], |r| {
                r.get(0)
            })
        };
        Ok([one(&c.version)?, one(&c.detail)?, one(&c.category)?])
    })
}

/// `(counter, payload)` of the contact's acquisition revisions, oldest first.
fn revisions(db: &OrgDb, id: &str) -> Vec<(i64, i64, serde_json::Value, Option<String>)> {
    read(db, |c| {
        Ok(c.prepare(
            "SELECT id, counter, payload, group_name FROM revisions
             WHERE entity = 'contacts' AND entity_id = ?1 AND contract = 'contacts.acquisition'
             ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                serde_json::from_str(&r.get::<_, String>(2)?).unwrap(),
                r.get(3)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?)
    })
}

fn snapshot(db: &OrgDb) -> String {
    read(db, |c| {
        let mut out = String::new();
        for table in ["contacts", "source_codes", "revisions"] {
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
        ContractError::Rejected { reason, .. } => reason,
        other => format!("{other:?}"),
    }
}

struct Acq {
    w: World,
    street: Code,
    online: Code,
    ada: String,
}

fn acq() -> Acq {
    let w = world();
    let street = code(&w.a, "Street", "Wesser");
    let online = code(&w.a, "Online", "Website");
    let ada = add(&w.a, "Ada", "Lovelace", None);
    Acq {
        w,
        street,
        online,
        ada,
    }
}

// ── setting and clearing ───────────────────────────────────────────────────

// setting and clearing › set: one revision, the code described on the contact, marked used
#[test]
fn set_writes_one_revision_describes_the_code_and_marks_it_used() {
    let Acq { w, street, ada, .. } = acq();
    let b_before = snapshot(&w.b);
    assert_eq!(view(&w.a, &ada).acquisition, None);
    assert_eq!(used(&w.a, &street), [false; 3]);

    let done = set(&w.a, &ada, Some(&street.version), 0).unwrap();
    assert_eq!(
        done,
        Executed {
            id: ada.clone(),
            counter: 1
        }
    );

    let v = view(&w.a, &ada);
    assert_eq!(v.counters.acquisition, 1);
    let d = v.acquisition.unwrap();
    assert_eq!(
        (
            d.code.as_str(),
            d.version_id.as_str(),
            d.detail_id.as_str(),
            d.category_id.as_str(),
            d.category_name.as_str(),
            d.detail_name.as_str(),
            d.version_name.as_str(),
            d.is_active
        ),
        (
            "Street-Wesser-001",
            street.version.as_str(),
            street.detail.as_str(),
            street.category.as_str(),
            "Street",
            "Wesser",
            "001",
            true
        )
    );
    assert_eq!(used(&w.a, &street), [true; 3]);
    let revs: Vec<_> = revisions(&w.a, &ada)
        .into_iter()
        .map(|r| (r.1, r.2))
        .collect();
    assert_eq!(revs, [(1, serde_json::json!({ "codeId": street.version }))]);
    assert_eq!(snapshot(&w.b), b_before);
}

// setting and clearing › change and clear; re-sending the current code is a no-op
#[test]
fn change_and_clear_and_resending_the_current_code_is_a_no_op() {
    let Acq {
        w,
        street,
        online,
        ada,
    } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    let same = Executed {
        id: ada.clone(),
        counter: 1,
    };
    assert_eq!(set(&w.a, &ada, Some(&street.version), 1).unwrap(), same);
    // Even with a stale counter: nothing would change.
    assert_eq!(set(&w.a, &ada, Some(&street.version), 0).unwrap(), same);
    assert_eq!(revisions(&w.a, &ada).len(), 1);

    set(&w.a, &ada, Some(&online.version), 1).unwrap();
    assert_eq!(
        view(&w.a, &ada).acquisition.unwrap().code,
        "Online-Website-001"
    );
    set(&w.a, &ada, None, 2).unwrap();
    assert_eq!(view(&w.a, &ada).acquisition, None);
    let payloads: Vec<_> = revisions(&w.a, &ada).into_iter().map(|r| r.2).collect();
    assert_eq!(
        payloads,
        [
            serde_json::json!({ "codeId": street.version }),
            serde_json::json!({ "codeId": online.version }),
            serde_json::json!({ "codeId": null }),
        ]
    );
    // Clearing a never-set code is a no-op too.
    let bea = add(&w.a, "Bea", "Lovelace", None);
    assert_eq!(
        set(&w.a, &bea, None, 0).unwrap(),
        Executed {
            id: bea,
            counter: 0
        }
    );
}

// setting and clearing › stale: a counter behind is refused with the current one
#[test]
fn a_stale_counter_is_refused_with_the_current_code() {
    let Acq {
        w,
        street,
        online,
        ada,
    } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    match set(&w.a, &ada, Some(&online.version), 0).unwrap_err() {
        ContractError::Stale {
            contract,
            counter,
            current,
        } => {
            assert_eq!((contract, counter), ("contacts.acquisition", 1));
            assert_eq!(current, serde_json::json!({ "codeId": street.version }));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        view(&w.a, &ada).acquisition.unwrap().version_id,
        street.version
    );
    // The refused command's group rolled back with it.
    let groups: i64 = read(&w.a, |c| {
        Ok(c.query_row(
            "SELECT count(*) FROM command_groups WHERE name LIKE 'acquisition code Online%'",
            [],
            |r| r.get(0),
        )?)
    });
    assert_eq!(groups, 0);
}

// setting and clearing › the new-contact form sets it in the same action
#[test]
fn the_new_contact_form_sets_it_in_the_same_group() {
    let Acq { w, street, .. } = acq();
    let bea = add(&w.a, "Bea", "Lovelace", Some(&street.version));
    let v = view(&w.a, &bea);
    assert_eq!(v.acquisition.unwrap().code, "Street-Wesser-001");
    assert_eq!(v.counters.acquisition, 1);
    let groups: Vec<(String, Option<String>)> = read(&w.a, |c| {
        Ok(c.prepare(
            "SELECT contract, group_name FROM revisions WHERE entity_id = ?1 ORDER BY id",
        )?
        .query_map([&bea], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
    });
    let moment = Some("new contact, acquisition code Street-Wesser-001".to_owned());
    assert_eq!(
        groups,
        [
            ("contacts.details".to_owned(), moment.clone()),
            ("contacts.acquisition".to_owned(), moment),
        ]
    );
    // Without a code, a create is just its details.
    let cy = add(&w.a, "Cy", "Lovelace", None);
    assert_eq!(view(&w.a, &cy).counters.acquisition, 0);
}

// setting and clearing › getAcquisition: the page's view equals get's; nothing across tenants
// (the view carries it; `GET sources/{id}` describes a code: api/tests/sources_routes.rs)
#[test]
fn the_view_describes_the_code_and_another_org_has_no_such_code() {
    let Acq { w, street, ada, .. } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    let described = read(&w.a, |c| Ok(sources::describe(c, &street.version)?));
    assert_eq!(view(&w.a, &ada).acquisition, described);
    assert_eq!(
        read(&w.b, |c| Ok(sources::describe(c, &street.version)?)),
        None
    );
}

// setting and clearing › a viewer cannot set it → api/tests/sources_routes.rs (roles are a route rule)

// ── validation ─────────────────────────────────────────────────────────────

// validation › another tenant's code is refused, and nothing is marked
#[test]
fn another_orgs_code_is_refused_and_nothing_is_marked() {
    let Acq { w, street, .. } = acq();
    let bea = add(&w.b, "Bea", "Lovelace", None);
    assert_eq!(
        reason(set(&w.b, &bea, Some(&street.version), 0).unwrap_err()),
        "unknown_source_code"
    );
    assert_eq!(
        reason(add_with(&w.b, person("Cy", "Lovelace"), Some(&street.version)).unwrap_err()),
        "unknown_source_code"
    );
    // The refused create left no contact behind.
    let contacts: i64 = read(&w.b, |c| {
        Ok(c.query_row("SELECT count(*) FROM contacts", [], |r| r.get(0))?)
    });
    assert_eq!(contacts, 1);
    assert_eq!(used(&w.a, &street), [false; 3]);
    assert_eq!(view(&w.b, &bea).acquisition, None);
}

// validation › only a version: a category or a detail is refused
#[test]
fn only_a_version_can_be_assigned() {
    let Acq { w, street, ada, .. } = acq();
    assert_eq!(
        reason(set(&w.a, &ada, Some(&street.category), 0).unwrap_err()),
        "unknown_source_code"
    );
    assert_eq!(
        reason(set(&w.a, &ada, Some(&street.detail), 0).unwrap_err()),
        "unknown_source_code"
    );
    assert!(revisions(&w.a, &ada).is_empty());
}

// validation › archived (the version or a parent) is refused; out of date is fine
#[test]
fn an_archived_code_is_refused_and_out_of_date_is_fine() {
    let Acq { w, street, ada, .. } = acq();
    change_part(&w.a, &street.version, |p| p.is_active = false);
    assert_eq!(
        reason(set(&w.a, &ada, Some(&street.version), 0).unwrap_err()),
        "archived_source_code"
    );
    change_part(&w.a, &street.version, |p| p.is_active = true);
    change_part(&w.a, &street.category, |p| p.is_active = false);
    assert_eq!(
        reason(set(&w.a, &ada, Some(&street.version), 0).unwrap_err()),
        "archived_source_code"
    );
    assert_eq!(used(&w.a, &street), [false; 3]);

    let event = category(&w.a, "Event");
    let gala = new_part(&w.a, named("Gala", Some(&event)));
    let ended = new_part(
        &w.a,
        SourceCodePayload {
            start_date: Some("2019-01-01".into()),
            end_date: Some("2019-12-31".into()),
            ..named("2019", Some(&gala.id))
        },
    );
    set(&w.a, &ada, Some(&ended.id), 0).unwrap();
    let d = view(&w.a, &ada).acquisition.unwrap();
    assert_eq!(
        (d.code.as_str(), d.end_date.as_deref()),
        ("Event-Gala-2019", Some("2019-12-31"))
    );
}

// validation › a kept code stays once archived, and shows as archived
#[test]
fn a_kept_code_stays_once_archived_and_shows_as_archived() {
    let Acq { w, street, ada, .. } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    change_part(&w.a, &street.detail, |p| p.is_active = false);
    // Other slices still save, and so does re-sending the same code.
    let saved = tx(&w.a, |ctx| {
        save_form(
            ctx,
            &ada,
            serde_json::from_value(serde_json::json!({
                "details": {
                    "expected": 0, "kind": "individual", "title": "", "firstName": "Ada",
                    "lastName": "Lovelace", "nickname": "Countess", "name": "",
                    "isDeceased": false
                }
            }))
            .unwrap(),
        )
    })
    .unwrap();
    assert_eq!(saved.saved, ["details"]);
    assert_eq!(
        set(&w.a, &ada, Some(&street.version), 1).unwrap(),
        Executed {
            id: ada.clone(),
            counter: 1
        }
    );
    let d = view(&w.a, &ada).acquisition.unwrap();
    assert_eq!((d.code.as_str(), d.is_active), ("Street-Wesser-001", false));
}

// the contactSearch projection › carries the version, detail and category ids
// → dropped: no projection. The filter joins `source_codes` (the cases
//   under "source filter" below prove it finds each level).
// the contactSearch projection › a save of another slice keeps the ids, and a rebuild finds them
// → dropped: nothing derived to keep or rebuild; another slice's save
//   leaves `acquisition_code_id` alone (the case above).

// the contactSearch projection › a rename changes the code shown, with no write to the contact or its row
#[test]
fn a_rename_changes_the_code_shown_with_no_write_to_the_contact() {
    let Acq { w, street, ada, .. } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    let row = |db: &OrgDb| {
        read(db, |c| {
            Ok(c.query_row(
                "SELECT * FROM contacts c JOIN contact_search_words s ON s.rowid = c.number
                 WHERE c.id = ?1",
                [&ada],
                |r| {
                    (0..r.as_ref().column_count())
                        .map(|i| {
                            r.get::<_, rusqlite::types::Value>(i)
                                .map(|v| format!("{v:?}"))
                        })
                        .collect::<rusqlite::Result<Vec<_>>>()
                },
            )?)
        })
    };
    let before = row(&w.a);
    change_part(&w.a, &street.category, |p| p.name = "Streets".into());
    assert_eq!(
        view(&w.a, &ada).acquisition.unwrap().code,
        "Streets-Wesser-001"
    );
    assert_eq!(row(&w.a), before);
}

// ── history and restore ────────────────────────────────────────────────────

// history and restore › a moment names the code as it read then, and the slice "acquisition code"
// (the slice's label is the history panel's: B1)
#[test]
fn a_change_is_named_after_the_code_as_it_read_then() {
    let Acq { w, street, ada, .. } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    change_part(&w.a, &street.detail, |p| p.name = "Wessex".into());
    set(&w.a, &ada, None, 1).unwrap();
    let names: Vec<_> = revisions(&w.a, &ada).into_iter().map(|r| r.3).collect();
    assert_eq!(
        names,
        [
            Some("acquisition code Street-Wesser-001".to_owned()),
            Some("acquisition code cleared".to_owned()),
        ]
    );
}

// history and restore › restore brings a code back, even an archived one, with no new marking
#[test]
fn restore_brings_a_code_back_even_an_archived_one() {
    let Acq {
        w,
        street,
        online,
        ada,
    } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    set(&w.a, &ada, Some(&online.version), 1).unwrap();
    change_part(&w.a, &street.version, |p| p.is_active = false);
    let first = revisions(&w.a, &ada)[0].0;
    let marked_before = snapshot(&w.a).matches("|Integer(1)|").count();
    tx(&w.a, |ctx| {
        restore_contact(ctx, &ada, RestoreRequest::Revision { revision_id: first })
    })
    .unwrap();
    let v = view(&w.a, &ada);
    let d = v.acquisition.unwrap();
    assert_eq!(
        (d.version_id.as_str(), d.is_active),
        (street.version.as_str(), false)
    );
    assert_eq!(v.counters.acquisition, 3);
    let last: (String, Option<i64>) = read(&w.a, |c| {
        Ok(c.query_row(
            "SELECT source, restored_from FROM revisions WHERE contract = 'contacts.acquisition'
             ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    });
    assert_eq!(last, ("restore".to_owned(), Some(first)));
    let _ = marked_before;
    assert_eq!(used(&w.a, &street), [true; 3]);
}

// history and restore › restore to a moment includes the acquisition slice
#[test]
fn restore_to_a_moment_includes_the_acquisition_slice() {
    let Acq {
        w,
        street,
        online,
        ada,
    } = acq();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    let at: i64 = read(&w.a, |c| {
        Ok(c.query_row(
            "SELECT max(at) FROM revisions WHERE entity_id = ?1",
            [&ada],
            |r| r.get(0),
        )?)
    });
    std::thread::sleep(std::time::Duration::from_millis(5));
    set(&w.a, &ada, Some(&online.version), 1).unwrap();
    let done = tx(&w.a, |ctx| {
        restore_contact(ctx, &ada, RestoreRequest::At { at })
    })
    .unwrap();
    assert_eq!(done.restored, ["contacts.acquisition"]);
    assert_eq!(
        view(&w.a, &ada).acquisition.unwrap().version_id,
        street.version
    );
}

// history and restore › restoring a revision onto another tenant's code is refused
#[test]
fn restoring_a_revision_naming_another_orgs_code_is_refused() {
    let Acq { w, ada, .. } = acq();
    // A forged revision in A naming B's code.
    let foreign = code(&w.b, "Street", "Other");
    let forged =
        w.a.write_raw(|raw| {
            raw.conn().execute(
                "INSERT INTO revisions (entity, entity_id, contract, version, counter, payload,
                     source, at)
                 VALUES ('contacts', ?1, 'contacts.acquisition', 1, 1, ?2, 'ui', 0)",
                [&ada, &format!("{{\"codeId\":\"{}\"}}", foreign.version)],
            )?;
            Ok::<_, rusqlite::Error>(raw.conn().last_insert_rowid())
        })
        .unwrap();
    assert_eq!(
        reason(
            tx(&w.a, |ctx| {
                restore_contact(
                    ctx,
                    &ada,
                    RestoreRequest::Revision {
                        revision_id: forged,
                    },
                )
            })
            .unwrap_err()
        ),
        "unknown_source_code"
    );
}

// ── the list's source filter ───────────────────────────────────────────────

struct Filter {
    w: World,
    street: Code,
    wesser2: String,
    online: Code,
    ada: String,
    bob: String,
    cara: String,
    dan: String,
    b_street: String,
    b_contact: String,
}

fn filter_world() -> Filter {
    let w = world();
    let street = code(&w.a, "Street", "Wesser");
    let wesser2 = new_part(&w.a, named("002", Some(&street.detail))).id;
    let online = code(&w.a, "Online", "Website");
    // Names chosen so name order differs from creation order.
    let bob = add(&w.a, "Bob", "Zebra", Some(&wesser2));
    let ada = add(&w.a, "Ada", "Lovelace", Some(&street.version));
    tx(&w.a, |ctx| {
        save_form(
            ctx,
            &ada,
            serde_json::from_value(serde_json::json!({
                "methods": {
                    "expected": 0,
                    "emails": [{ "label": "home", "address": "ada@example.com", "isPrimary": true }],
                    "phones": []
                }
            }))
            .unwrap(),
        )
    })
    .unwrap();
    let cara = add(&w.a, "Cara", "Lovelace", Some(&online.version));
    let dan = add(&w.a, "Dan", "Lovelace", None);
    let b_code = code(&w.b, "Street", "Wesser");
    let b_contact = add(&w.b, "Ada", "Lovelace", Some(&b_code.version));
    Filter {
        w,
        street,
        wesser2,
        online,
        ada,
        bob,
        cara,
        dan,
        b_street: b_code.category,
        b_contact,
    }
}

fn source(level: &str, id: &str) -> Option<String> {
    Some(format!("{level}:{id}"))
}

fn listed(db: &OrgDb, q: ListQuery) -> Vec<String> {
    read(db, |c| list(c, &q))
        .rows
        .into_iter()
        .map(|r| r.id)
        .collect()
}

fn by(level: &str, id: &str) -> ListQuery {
    ListQuery {
        source: source(level, id),
        ..ListQuery::default()
    }
}

fn found(db: &OrgDb, level: &str, id: &str, q: &str) -> SearchResult {
    read(db, |c| {
        search(
            c,
            &SearchQuery {
                q: q.into(),
                source: source(level, id),
                ..SearchQuery::default()
            },
        )
    })
}

fn found_ids(db: &OrgDb, level: &str, id: &str, q: &str) -> Vec<String> {
    found(db, level, id, q)
        .rows
        .into_iter()
        .map(|r| r.id)
        .collect()
}

// sourceFilter › without search text › category, detail and version, each in name order
#[test]
fn the_filter_by_category_detail_and_version_in_name_order() {
    let f = filter_world();
    let a = &f.w.a;
    assert_eq!(
        listed(a, by("category", &f.street.category)),
        [f.ada.as_str(), f.bob.as_str()]
    );
    assert_eq!(
        listed(a, by("detail", &f.street.detail)),
        [f.ada.as_str(), f.bob.as_str()]
    );
    assert_eq!(listed(a, by("version", &f.wesser2)), [f.bob.as_str()]);
    assert_eq!(
        listed(a, by("category", &f.online.category)),
        [f.cara.as_str()]
    );
    // Unfiltered still lists everyone, coded or not.
    let all = listed(a, ListQuery::default());
    for id in [&f.ada, &f.bob, &f.cara, &f.dan] {
        assert!(all.contains(id));
    }
    // An empty search is the list, filter included.
    assert_eq!(
        found_ids(a, "detail", &f.street.detail, ""),
        [f.ada.as_str(), f.bob.as_str()]
    );
}

// sourceFilter › without search text › with kind and archived filters
#[test]
fn the_filter_with_kind_and_archived() {
    let f = filter_world();
    let a = &f.w.a;
    tx(a, |ctx| set_archived(ctx, &f.bob, 0, true)).unwrap();
    assert_eq!(
        listed(a, by("category", &f.street.category)),
        [f.ada.as_str()]
    );
    assert_eq!(
        listed(
            a,
            ListQuery {
                include_archived: Some(true),
                ..by("category", &f.street.category)
            }
        ),
        [f.ada.as_str(), f.bob.as_str()]
    );
    assert!(
        listed(
            a,
            ListQuery {
                kind: Some(Kind::Organization),
                ..by("category", &f.street.category)
            }
        )
        .is_empty()
    );
}

// sourceFilter › without search text › a contact keeps matching once its code is archived
#[test]
fn a_contact_keeps_matching_once_its_code_is_archived() {
    let f = filter_world();
    change_part(&f.w.a, &f.street.detail, |p| p.is_active = false);
    assert_eq!(
        listed(&f.w.a, by("detail", &f.street.detail)),
        [f.ada.as_str(), f.bob.as_str()]
    );
}

// sourceFilter › without search text › a code changed or cleared moves the contact between filters
#[test]
fn a_code_changed_or_cleared_moves_the_contact_between_filters() {
    let f = filter_world();
    let a = &f.w.a;
    set(a, &f.ada, Some(&f.online.version), 1).unwrap();
    assert_eq!(
        listed(a, by("category", &f.street.category)),
        [f.bob.as_str()]
    );
    assert_eq!(
        listed(a, by("version", &f.online.version)),
        [f.ada.as_str(), f.cara.as_str()]
    );
    set(a, &f.ada, None, 2).unwrap();
    assert_eq!(
        listed(a, by("category", &f.online.category)),
        [f.cara.as_str()]
    );
}

// sourceFilter › with search text › the filter narrows the full-text hits
#[test]
fn the_filter_narrows_full_text_hits() {
    let f = filter_world();
    let a = &f.w.a;
    let all = read(a, |c| {
        search(
            c,
            &SearchQuery {
                q: "lovelace".into(),
                ..SearchQuery::default()
            },
        )
    });
    assert_eq!(all.rows.len(), 3);
    assert_eq!(
        found_ids(a, "category", &f.street.category, "lovelace"),
        [f.ada.as_str()]
    );
    assert_eq!(
        found_ids(a, "version", &f.online.version, "lovelace"),
        [f.cara.as_str()]
    );
    assert!(found_ids(a, "version", &f.wesser2, "lovelace").is_empty());
}

// sourceFilter › with search text › an exact email match obeys the filter at every level
#[test]
fn an_exact_email_match_obeys_the_filter_at_every_level() {
    let f = filter_world();
    let a = &f.w.a;
    let q = "ada@example.com";
    for (level, id) in [
        ("category", &f.street.category),
        ("detail", &f.street.detail),
        ("version", &f.street.version),
    ] {
        assert_eq!(found_ids(a, level, id, q), [f.ada.as_str()], "{level}");
    }
    assert!(found_ids(a, "category", &f.online.category, q).is_empty());
    assert!(found_ids(a, "version", &f.wesser2, q).is_empty());
}

// sourceFilter › with search text › a contact number match obeys the filter at every level
#[test]
fn a_contact_number_match_obeys_the_filter_at_every_level() {
    let f = filter_world();
    let a = &f.w.a;
    let number = view(a, &f.ada).number;
    for q in [format_number(number), number.to_string()] {
        for (level, id) in [
            ("category", &f.street.category),
            ("detail", &f.street.detail),
            ("version", &f.street.version),
        ] {
            let r = found(a, level, id, &q);
            assert_eq!(
                r.rows.into_iter().map(|r| r.id).collect::<Vec<_>>(),
                [f.ada.as_str()],
                "{q} {level}"
            );
            assert_eq!(r.number_match.as_ref(), Some(&f.ada), "{q} {level}");
        }
        for (level, id) in [("category", &f.online.category), ("version", &f.wesser2)] {
            let r = found(a, level, id, &q);
            assert!(r.rows.is_empty(), "{q} {level}");
            assert_eq!(r.number_match, None, "{q} {level}");
        }
    }
}

// sourceFilter › tenancy › another tenant's code finds nothing, either way
#[test]
fn another_orgs_code_finds_nothing_either_way() {
    let f = filter_world();
    assert!(listed(&f.w.a, by("category", &f.b_street)).is_empty());
    assert!(found_ids(&f.w.a, "category", &f.b_street, "lovelace").is_empty());
    assert!(listed(&f.w.b, by("category", &f.street.category)).is_empty());
    assert_eq!(
        listed(&f.w.b, by("category", &f.b_street)),
        [f.b_contact.as_str()]
    );
}

// A malformed filter is refused, never matched against nothing.
#[test]
fn a_malformed_source_filter_is_invalid() {
    let f = filter_world();
    for raw in ["street", "group:abc", "version:"] {
        let q = ListQuery {
            source: Some(raw.into()),
            ..ListQuery::default()
        };
        let r = f.w.a.read(|c| list(c, &q));
        assert!(matches!(r, Err(ContractError::Invalid(_))), "{raw}");
    }
}

// sourceFilter › filter options › every part, archived too, with only what the selects show; per tenant
#[test]
fn filter_options_list_every_part_archived_too_per_org() {
    let f = filter_world();
    change_part(&f.w.a, &f.wesser2, |p| p.is_active = false);
    let options = read(&f.w.a, |c| Ok(sources::filter_options(c)?));
    let ids: Vec<_> = options.iter().map(|o| o.id.as_str()).collect();
    for id in [
        f.street.category.as_str(),
        f.street.detail.as_str(),
        f.street.version.as_str(),
        f.wesser2.as_str(),
    ] {
        assert!(ids.contains(&id));
    }
    let archived = options.iter().find(|o| o.id == f.wesser2).unwrap();
    assert!(!archived.is_active);
    assert_eq!(
        archived.parent_id.as_deref(),
        Some(f.street.detail.as_str())
    );
    let theirs = read(&f.w.b, |c| Ok(sources::filter_options(c)?));
    assert!(!theirs.iter().any(|o| o.id == f.street.category));
}

// codex C1 #3: a slice first written after the moment goes back to empty.
// Creation records only details (no code here), so the email, address and
// code added since have no revision at or before it: they were skipped,
// and "restore to creation" left them all in place.
#[test]
fn restore_to_creation_empties_the_slices_written_since() {
    let Acq { w, street, ada, .. } = acq();
    let created: i64 = read(&w.a, |c| {
        Ok(c.query_row(
            "SELECT max(id) FROM revisions WHERE entity_id = ?1",
            [&ada],
            |r| r.get(0),
        )?)
    });
    tx(&w.a, |ctx| {
        save_form(
            ctx,
            &ada,
            serde_json::from_value(serde_json::json!({
                "methods": {
                    "expected": 0,
                    "emails": [{ "label": "home", "address": "ada@example.com", "isPrimary": true }],
                    "phones": []
                },
                "addresses": {
                    "expected": 0,
                    "addresses": [{
                        "label": "home", "line1": "1 Analytical Row", "line2": "", "line3": "",
                        "town": "London", "postcode": "N1 1AA", "country": "GB", "isPrimary": true
                    }]
                }
            }))
            .unwrap(),
        )
    })
    .unwrap();
    set(&w.a, &ada, Some(&street.version), 0).unwrap();
    // B's contact is untouched by A's restore.
    let b = add(&w.b, "Bea", "Other", None);

    let done = tx(&w.a, |ctx| {
        restore_contact(
            ctx,
            &ada,
            RestoreRequest::ToRevision {
                to_revision: created,
            },
        )
    })
    .unwrap();
    let mut restored = done.restored.clone();
    restored.sort();
    assert_eq!(
        restored,
        [
            "contacts.acquisition",
            "contacts.addresses",
            "contacts.methods"
        ]
    );
    let v = view(&w.a, &ada);
    assert_eq!(v.methods, Methods::default());
    assert_eq!(v.addresses, Addresses::default());
    assert!(v.acquisition.is_none());
    assert_eq!(v.details.first_name, "Ada");
    // A second restore to the same moment has nothing left to do.
    let again = tx(&w.a, |ctx| {
        restore_contact(
            ctx,
            &ada,
            RestoreRequest::ToRevision {
                to_revision: created,
            },
        )
    })
    .unwrap();
    assert!(again.restored.is_empty(), "{:?}", again.restored);
    assert_eq!(view(&w.b, &b).details.first_name, "Bea");
}
