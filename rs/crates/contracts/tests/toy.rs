//! Contract semantics on a toy entity: a `toys` root with two slices,
//! `toys.details` (v2: v1 called the name `title`) and `toys.emails`
//! (child rows with ids; the address is the identity).

use contracts::{
    ChildRow, Command, Contract, ContractError, Ctx, Exec, Registry, Source, command_group,
    execute, history, mint_ids, reconcile, restore, restore_entity_to,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use store::{M, Migrations, OrgDb, OrgTx, Store, StoreConfig};

const TOY_SCHEMA: &str = "
CREATE TABLE toys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    colour TEXT,
    details_version INTEGER NOT NULL DEFAULT 0,
    emails_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE toy_emails (
    id TEXT PRIMARY KEY,
    toy_id TEXT NOT NULL REFERENCES toys(id),
    address TEXT NOT NULL,
    label TEXT NOT NULL
) STRICT;
CREATE TABLE toy_search (toy_id TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT;
";

struct Details;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct DetailsSlice {
    name: String,
    colour: Option<String>,
}

impl Contract for Details {
    const NAME: &'static str = "toys.details";
    const VERSION: u32 = 2;
    const ENTITY: &'static str = "toys";
    const COUNTER: &'static str = "details_version";
    type Payload = DetailsSlice;
    type State = DetailsSlice;

    fn prepare(&self, mut p: DetailsSlice) -> Result<DetailsSlice, ContractError> {
        p.name = p.name.trim().to_owned();
        if p.name.is_empty() {
            return Err(ContractError::invalid("name", "required"));
        }
        Ok(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<DetailsSlice, ContractError> {
        Ok(
            tx.query_row("SELECT name, colour FROM toys WHERE id = ?1", [id], |r| {
                Ok(DetailsSlice {
                    name: r.get(0)?,
                    colour: r.get(1)?,
                })
            })?,
        )
    }

    fn apply(
        &self,
        _: Option<&DetailsSlice>,
        p: &DetailsSlice,
        _: &Command,
    ) -> Result<DetailsSlice, ContractError> {
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &OrgTx,
        id: &str,
        before: Option<&DetailsSlice>,
        next: &DetailsSlice,
    ) -> Result<(), ContractError> {
        if before.is_none() {
            tx.execute(
                "INSERT INTO toys (id, name, colour) VALUES (?1, ?2, ?3)",
                params![id, next.name, next.colour],
            )?;
        } else {
            tx.execute(
                "UPDATE toys SET name = ?2, colour = ?3 WHERE id = ?1",
                params![id, next.name, next.colour],
            )?;
        }
        Ok(())
    }

    fn project(&self, tx: &OrgTx, id: &str) -> Result<(), ContractError> {
        tx.execute(
            "INSERT OR REPLACE INTO toy_search (toy_id, text)
             SELECT id, lower(name) FROM toys WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    fn upcast(&self, from: u32, payload: Value) -> Option<Value> {
        match from {
            1 => Some(json!({ "name": payload["title"], "colour": null })),
            _ => None,
        }
    }
}

struct Emails;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct EmailIn {
    id: Option<String>,
    address: String,
    label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct EmailRow {
    id: String,
    address: String,
    label: String,
}

impl ChildRow for EmailRow {
    fn id(&self) -> &str {
        &self.id
    }
    fn identity(&self) -> Option<&str> {
        Some(&self.address)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct EmailsSlice {
    emails: Vec<EmailIn>,
}

impl Contract for Emails {
    const NAME: &'static str = "toys.emails";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "toys";
    const COUNTER: &'static str = "emails_version";
    type Payload = EmailsSlice;
    type State = Vec<EmailRow>;

    fn prepare(&self, mut p: EmailsSlice) -> Result<EmailsSlice, ContractError> {
        mint_ids(&mut p.emails, |e| &mut e.id);
        Ok(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Vec<EmailRow>, ContractError> {
        let mut stmt =
            tx.prepare("SELECT id, address, label FROM toy_emails WHERE toy_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map([id], |r| {
            Ok(EmailRow {
                id: r.get(0)?,
                address: r.get(1)?,
                label: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn apply(
        &self,
        _: Option<&Vec<EmailRow>>,
        p: &EmailsSlice,
        _: &Command,
    ) -> Result<Vec<EmailRow>, ContractError> {
        Ok(p.emails
            .iter()
            .map(|e| EmailRow {
                id: e.id.clone().expect("minted in prepare"),
                address: e.address.clone(),
                label: e.label.clone(),
            })
            .collect())
    }

    fn write(
        &self,
        tx: &OrgTx,
        id: &str,
        before: Option<&Vec<EmailRow>>,
        next: &Vec<EmailRow>,
    ) -> Result<(), ContractError> {
        let before = before.map(Vec::as_slice).unwrap_or(&[]);
        let diff = reconcile("emails", before, next)?;
        for row in diff.removed {
            tx.execute("DELETE FROM toy_emails WHERE id = ?1", [&row.id])?;
        }
        for row in diff.added {
            tx.execute(
                "INSERT INTO toy_emails (id, toy_id, address, label) VALUES (?1, ?2, ?3, ?4)",
                params![row.id, id, row.address, row.label],
            )?;
        }
        for row in diff.changed {
            tx.execute(
                "UPDATE toy_emails SET label = ?2 WHERE id = ?1",
                params![row.id, row.label],
            )?;
        }
        Ok(())
    }
}

fn registry() -> Registry {
    Registry::new(&[&Details, &Emails])
}

fn org() -> (tempfile::TempDir, std::sync::Arc<OrgDb>) {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(StoreConfig {
        dir: tmp.path().to_path_buf(),
        org_migrations: Migrations::new(vec![M::up(contracts::MIGRATION), M::up(TOY_SCHEMA)]),
        readers: 2,
    })
    .unwrap();
    let tenant = store.create_tenant("toys", "Toys").unwrap();
    let db = store.org(&tenant.id).unwrap();
    (tmp, db)
}

fn details(name: &str) -> DetailsSlice {
    DetailsSlice {
        name: name.into(),
        colour: None,
    }
}

fn email(id: Option<&str>, address: &str, label: &str) -> EmailIn {
    EmailIn {
        id: id.map(Into::into),
        address: address.into(),
        label: label.into(),
    }
}

/// Run `f` in one write transaction as user 7.
fn write<T>(
    db: &OrgDb,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    db.write(|tx| f(&Ctx::new(tx, Some(7))))
}

fn create(db: &OrgDb, name: &str) -> String {
    write(db, |ctx| {
        execute(ctx, &Details, details(name), Exec::create(Source::Ui))
    })
    .unwrap()
    .id
}

fn at<'t, 'c>(tx: &'t OrgTx<'c>, ms: i64) -> Ctx<'t, 'c> {
    Ctx {
        tx,
        actor: Some(7),
        at: ms,
    }
}

fn revision_count(db: &OrgDb) -> i64 {
    db.read(|r| r.query_row("SELECT count(*) FROM revisions", [], |row| row.get(0)))
        .unwrap()
}

#[test]
fn create_then_update_with_the_expected_counter() {
    let (_tmp, db) = org();
    let id = create(&db, "  Bear ");
    let out = write(&db, |ctx| {
        execute(
            ctx,
            &Details,
            details("Big bear"),
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    assert_eq!(out.counter, 1);
    let name: String = db
        .read(|r| {
            r.query_row("SELECT name FROM toys WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(name, "Big bear");
    // The projection ran in the same transaction.
    let text: String = db
        .read(|r| {
            r.query_row(
                "SELECT text FROM toy_search WHERE toy_id = ?1",
                [&id],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(text, "big bear");
}

#[test]
fn stale_counter_is_refused_with_the_current_state_and_writes_nothing() {
    let (_tmp, db) = org();
    let id = create(&db, "Bear");
    write(&db, |ctx| {
        execute(
            ctx,
            &Details,
            details("Second"),
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    let before = revision_count(&db);

    let err = write(&db, |ctx| {
        execute(
            ctx,
            &Details,
            details("Lost update"),
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap_err();
    match err {
        ContractError::Stale {
            contract,
            counter,
            current,
        } => {
            assert_eq!(contract, "toys.details");
            assert_eq!(counter, 1);
            assert_eq!(current, json!({ "name": "Second", "colour": null }));
        }
        other => panic!("expected stale, got {other:?}"),
    }
    assert_eq!(revision_count(&db), before);
}

#[test]
fn slices_never_falsely_conflict() {
    let (_tmp, db) = org();
    let id = create(&db, "Bear");
    // Both forms loaded at details 0 / emails 0.
    write(&db, |ctx| {
        execute(
            ctx,
            &Details,
            details("Renamed"),
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    let out = write(&db, |ctx| {
        execute(
            ctx,
            &Emails,
            EmailsSlice {
                emails: vec![email(None, "a@x.org", "home")],
            },
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    assert_eq!(out.counter, 1);
}

#[test]
fn revisions_record_the_prepared_payload_name_version_and_actor() {
    let (_tmp, db) = org();
    let id = create(&db, "  Bear  ");
    write(&db, |ctx| {
        execute(
            ctx,
            &Emails,
            EmailsSlice {
                emails: vec![email(None, "a@x.org", "home")],
            },
            Exec::update(&id, Some(0), Source::Autosave),
        )
    })
    .unwrap();
    let revs = db.read(|r| history(r, "toys", &id, 10)).unwrap();
    assert_eq!(revs.len(), 2);
    let (emails, created) = (&revs[0], &revs[1]);

    assert_eq!(created.contract, "toys.details");
    assert_eq!(created.version, 2);
    assert_eq!(created.counter, 0);
    assert_eq!(created.payload, json!({ "name": "Bear", "colour": null }));
    assert_eq!(created.actor, Some(7));
    assert_eq!(created.source, Source::Ui);

    assert_eq!(emails.contract, "toys.emails");
    assert_eq!(emails.source, Source::Autosave);
    // The minted child id is in the stored payload.
    let minted = emails.payload["emails"][0]["id"].as_str().unwrap();
    assert_eq!(minted.len(), 32);
}

#[test]
fn invalid_payloads_and_failed_commands_leave_nothing_behind() {
    let (_tmp, db) = org();
    let err = write(&db, |ctx| {
        execute(ctx, &Details, details("   "), Exec::create(Source::Ui))
    })
    .unwrap_err();
    assert!(matches!(err, ContractError::Invalid(ref p) if p[0].field == "name"));

    // A group whose second command fails rolls the first back too.
    let id = create(&db, "Bear");
    let before = revision_count(&db);
    let err = write(&db, |ctx| {
        let group = command_group(ctx, "form save")?;
        execute(
            ctx,
            &Details,
            details("Changed"),
            Exec::update(&id, Some(0), Source::Ui).in_group(&group),
        )?;
        execute(
            ctx,
            &Details,
            details("Again"),
            Exec::update(&id, Some(0), Source::Ui).in_group(&group),
        )
    })
    .unwrap_err();
    assert!(matches!(err, ContractError::Stale { .. }));
    assert_eq!(revision_count(&db), before);
    let groups: i64 = db
        .read(|r| r.query_row("SELECT count(*) FROM command_groups", [], |row| row.get(0)))
        .unwrap();
    assert_eq!(groups, 0);
}

#[test]
fn not_found_and_duplicate_ids() {
    let (_tmp, db) = org();
    let err = write(&db, |ctx| {
        execute(
            ctx,
            &Details,
            details("x"),
            Exec::update("nope", Some(0), Source::Ui),
        )
    })
    .unwrap_err();
    assert!(matches!(err, ContractError::NotFound));

    let id = contracts::new_id();
    write(&db, |ctx| {
        execute(
            ctx,
            &Details,
            details("x"),
            Exec::create_with_id(&id, Source::Import),
        )
    })
    .unwrap();
    // A retried import can't duplicate the entity.
    let err = write(&db, |ctx| {
        execute(
            ctx,
            &Details,
            details("x"),
            Exec::create_with_id(&id, Source::Import),
        )
    })
    .unwrap_err();
    assert!(matches!(err, ContractError::Duplicate { .. }));
}

#[test]
fn command_groups_label_every_revision_they_contain() {
    let (_tmp, db) = org();
    let id = create(&db, "Bear");
    write(&db, |ctx| {
        let group = command_group(ctx, "contact form save")?;
        execute(
            ctx,
            &Details,
            details("Renamed"),
            Exec::update(&id, Some(0), Source::Ui).in_group(&group),
        )?;
        execute(
            ctx,
            &Emails,
            EmailsSlice {
                emails: vec![email(None, "a@x.org", "home")],
            },
            Exec::update(&id, Some(0), Source::Ui).in_group(&group),
        )
    })
    .unwrap();
    let revs = db.read(|r| history(r, "toys", &id, 10)).unwrap();
    assert_eq!(revs[0].group, revs[1].group);
    assert!(revs[0].group.is_some());
    assert_eq!(revs[0].group_name.as_deref(), Some("contact form save"));
    assert_eq!(revs[2].group, None);
}

#[test]
fn child_rows_reconcile_by_id_and_identity_is_immutable() {
    let (_tmp, db) = org();
    let id = create(&db, "Bear");
    let save = |emails: Vec<EmailIn>, expected: i64| {
        write(&db, |ctx| {
            execute(
                ctx,
                &Emails,
                EmailsSlice { emails },
                Exec::update(&id, Some(expected), Source::Ui),
            )
        })
    };
    let rows = |db: &OrgDb| -> Vec<(String, String, String)> {
        db.read(|r| {
            let mut s = r.prepare("SELECT id, address, label FROM toy_emails ORDER BY address")?;
            s.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap()
    };

    save(
        vec![
            email(None, "a@x.org", "home"),
            email(None, "b@x.org", "work"),
        ],
        0,
    )
    .unwrap();
    let first = rows(&db);
    let (a_id, b_id) = (first[0].0.clone(), first[1].0.clone());

    // Kept id, non-identity field changed: updated in place, same id.
    save(
        vec![
            email(Some(&a_id), "a@x.org", "personal"),
            email(Some(&b_id), "b@x.org", "work"),
        ],
        1,
    )
    .unwrap();
    assert_eq!(
        rows(&db)[0],
        (a_id.clone(), "a@x.org".into(), "personal".into())
    );

    // Kept id, identity changed: rejected, nothing written.
    let err = save(vec![email(Some(&a_id), "changed@x.org", "personal")], 2).unwrap_err();
    assert!(
        matches!(err, ContractError::Rejected { ref reason, .. } if reason == "identity_immutable")
    );
    assert_eq!(rows(&db).len(), 2);

    // Duplicate ids in one payload: invalid.
    let err = save(
        vec![
            email(Some(&a_id), "a@x.org", "x"),
            email(Some(&a_id), "a@x.org", "y"),
        ],
        2,
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Invalid(_)));

    // Remove b, add c (identity change done properly: remove + add).
    save(
        vec![
            email(Some(&a_id), "a@x.org", "personal"),
            email(None, "c@x.org", "work"),
        ],
        2,
    )
    .unwrap();
    let now = rows(&db);
    assert_eq!(now.len(), 2);
    assert_eq!(now[0].0, a_id);
    assert_eq!(now[1].1, "c@x.org");
    assert_ne!(now[1].0, b_id);
}

#[test]
fn restore_upcasts_old_revisions_and_records_a_new_command() {
    let (_tmp, db) = org();
    let id = create(&db, "Current");
    // A revision written by an older build, at v1 (the name was `title`).
    let old: i64 = db
        .write(|tx| {
            tx.execute(
                "INSERT INTO revisions (entity, entity_id, contract, version, counter, payload, source, at)
                 VALUES ('toys', ?1, 'toys.details', 1, 0, '{\"title\":\"From v1\"}', 'ui', 0)",
                [&id],
            )?;
            Ok::<_, rusqlite::Error>(tx.last_insert_rowid())
        })
        .unwrap();

    let out = write(&db, |ctx| restore(ctx, &registry(), old, None)).unwrap();
    assert_eq!(out.counter, 1);
    let state = db.write(|tx| Details.load(tx, &id)).unwrap();
    assert_eq!(state, details("From v1"));

    let latest = &db.read(|r| history(r, "toys", &id, 1)).unwrap()[0];
    assert_eq!(latest.source, Source::Restore);
    assert_eq!(latest.restored_from, Some(old));
    // Recorded at the code's version, in the new shape.
    assert_eq!(latest.version, 2);
    assert_eq!(latest.payload, json!({ "name": "From v1", "colour": null }));
}

#[test]
fn restore_refuses_what_it_cannot_upcast() {
    let (_tmp, db) = org();
    let id = create(&db, "Current");
    let insert = |contract: &str, version: u32| -> i64 {
        db.write(|tx| {
            tx.execute(
                "INSERT INTO revisions (entity, entity_id, contract, version, counter, payload, source, at)
                 VALUES ('toys', ?1, ?2, ?3, 0, '{}', 'ui', 0)",
                params![id, contract, version],
            )?;
            Ok::<_, rusqlite::Error>(tx.last_insert_rowid())
        })
        .unwrap()
    };
    let newer = insert("toys.details", 3);
    let unknown = insert("toys.gone", 1);
    let reg = registry();
    assert!(matches!(
        write(&db, |ctx| restore(ctx, &reg, newer, None)),
        Err(ContractError::NewerThanCode {
            stored: 3,
            code: 2,
            ..
        })
    ));
    assert!(matches!(
        write(&db, |ctx| restore(ctx, &reg, unknown, None)),
        Err(ContractError::UnknownContract(_))
    ));
    // Emails is at v1 with no upcasters: a v0 payload has no path forward.
    let ancient = insert("toys.emails", 0);
    assert!(matches!(
        write(&db, |ctx| restore(ctx, &reg, ancient, None)),
        Err(ContractError::MissingUpcaster { from: 0, .. })
    ));
}

#[test]
fn restore_brings_back_a_removed_child_with_its_id() {
    let (_tmp, db) = org();
    let id = create(&db, "Bear");
    write(&db, |ctx| {
        execute(
            ctx,
            &Emails,
            EmailsSlice {
                emails: vec![email(None, "a@x.org", "home")],
            },
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    let with_email = db.read(|r| history(r, "toys", &id, 1)).unwrap()[0].clone();
    let a_id = with_email.payload["emails"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    write(&db, |ctx| {
        execute(
            ctx,
            &Emails,
            EmailsSlice { emails: vec![] },
            Exec::update(&id, Some(1), Source::Ui),
        )
    })
    .unwrap();

    write(&db, |ctx| restore(ctx, &registry(), with_email.id, None)).unwrap();
    let back: Option<String> = db
        .read(|r| {
            r.query_row(
                "SELECT id FROM toy_emails WHERE address = 'a@x.org'",
                [],
                |row| row.get(0),
            )
            .optional()
        })
        .unwrap();
    assert_eq!(back, Some(a_id));
}

#[test]
fn restore_entity_to_a_time_restores_only_slices_that_differ() {
    let (_tmp, db) = org();
    let id = db
        .write(|tx| {
            execute(
                &at(tx, 1_000),
                &Details,
                details("Original"),
                Exec::create(Source::Ui),
            )
        })
        .unwrap()
        .id;
    db.write(|tx| {
        execute(
            &at(tx, 1_000),
            &Emails,
            EmailsSlice {
                emails: vec![email(None, "a@x.org", "home")],
            },
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    // Later: details changed, emails changed then changed back to the same state.
    db.write(|tx| {
        execute(
            &at(tx, 2_000),
            &Details,
            details("Vandalised"),
            Exec::update(&id, Some(0), Source::Ui),
        )
    })
    .unwrap();
    let a = db.write(|tx| Emails.load(tx, &id)).unwrap()[0].clone();
    let same = || EmailsSlice {
        emails: vec![email(Some(&a.id), &a.address, &a.label)],
    };
    db.write(|tx| {
        execute(
            &at(tx, 2_000),
            &Emails,
            same(),
            Exec::update(&id, Some(1), Source::Ui),
        )
    })
    .unwrap();

    let restored = db
        .write(|tx| restore_entity_to(&at(tx, 3_000), &registry(), "toys", &id, 1_500, &[], None))
        .unwrap();
    assert_eq!(restored, vec!["toys.details".to_owned()]);
    assert_eq!(
        db.write(|tx| Details.load(tx, &id)).unwrap(),
        details("Original")
    );
    let latest = &db.read(|r| history(r, "toys", &id, 1)).unwrap()[0];
    assert_eq!(latest.group_name.as_deref(), Some("restore to 1500"));

    // Nothing differs any more: no group, no revisions.
    let before = revision_count(&db);
    let again = db
        .write(|tx| restore_entity_to(&at(tx, 4_000), &registry(), "toys", &id, 1_500, &[], None))
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(revision_count(&db), before);
}

#[test]
fn canonical_ignores_key_order_child_order_and_nulls() {
    let a = json!({ "b": 1, "a": [{ "id": "2", "x": null }, { "id": "1" }] });
    let b = json!({ "a": [{ "id": "1" }, { "id": "2" }], "b": 1, "c": null });
    assert_eq!(contracts::canonical(&a), contracts::canonical(&b));
}
