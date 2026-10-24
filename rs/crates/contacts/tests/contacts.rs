//! The contacts domain on real org files: every slice's contract
//! semantics (counters, stale per slice, revisions, child ids), the form
//! save, dropdown fields, restore, list paging and filters, search rules
//! on both FTS variants, and two organisations kept apart.

use std::sync::Arc;

use contacts::form::{create, restore_contact, save_form, set_archived};
use contacts::queries::{ListQuery, SearchQuery, get, history, list, search};
use contacts::types::*;
use contacts::{ADDRESSES, DETAILS, METHODS};
use contracts::{ContractError, Ctx, Exec, Source, execute};
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
        ]),
        readers: 2,
    })
    .unwrap();
    let a = store.create_tenant("alpha", "Alpha").unwrap();
    let b = store.create_tenant("beta", "Beta").unwrap();
    World {
        a: store.org(&a.id).unwrap(),
        b: store.org(&b.id).unwrap(),
        _tmp: tmp,
    }
}

fn w<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> Result<T, ContractError> {
    db.write(|tx| f(&Ctx::new(tx, Some(1))))
}

fn r<T>(db: &OrgDb, f: impl FnOnce(&rusqlite::Connection) -> Result<T, ContractError>) -> T {
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

fn org(name: &str) -> Details {
    Details {
        kind: Kind::Organization,
        first_name: String::new(),
        last_name: String::new(),
        name: name.into(),
        ..person("", "")
    }
}

fn add(db: &OrgDb, d: Details) -> Created {
    w(db, |ctx| {
        create(
            ctx,
            CreateContact {
                id: None,
                details: d,
            },
            Source::Test,
        )
    })
    .unwrap()
}

fn email(address: &str) -> EmailRow {
    EmailRow {
        key: None,
        label: ChannelLabel::Home,
        address: address.into(),
        is_primary: false,
    }
}

fn phone(number: &str) -> PhoneRow {
    PhoneRow {
        key: None,
        label: ChannelLabel::Home,
        number: number.into(),
        is_primary: false,
    }
}

fn address(line1: &str, town: &str, postcode: &str) -> AddressRow {
    AddressRow {
        key: None,
        label: ChannelLabel::Home,
        line1: line1.into(),
        line2: String::new(),
        line3: String::new(),
        town: town.into(),
        postcode: postcode.into(),
        country: "GB".into(),
        is_primary: false,
    }
}

fn save_methods(db: &OrgDb, id: &str, expected: i64, m: Methods) -> Result<i64, ContractError> {
    w(db, |ctx| {
        Ok(execute(
            ctx,
            &METHODS,
            m,
            Exec::update(id, Some(expected), Source::Test),
        )?
        .counter)
    })
}

fn view(db: &OrgDb, id: &str) -> ContactView {
    r(db, |c| get(c, id)).unwrap()
}

fn revisions(db: &OrgDb, id: &str) -> Vec<contracts::Revision> {
    r(db, |c| history(c, id, None, 50)).revisions
}

fn find(db: &OrgDb, q: &str) -> Vec<String> {
    find_with(
        db,
        SearchQuery {
            q: q.into(),
            ..Default::default()
        },
    )
}

fn find_with(db: &OrgDb, q: SearchQuery) -> Vec<String> {
    let words = r(db, |c| search(c, &q));
    let trigram = r(db, |c| {
        search(
            c,
            &SearchQuery {
                fts: Some("trigram".into()),
                ..q.clone()
            },
        )
    });
    let names = |res: SearchResult| -> Vec<String> {
        res.rows.into_iter().map(|r| r.display_name).collect()
    };
    let (words, trigram) = (names(words), names(trigram));
    // Same matching rules either way; only the order of equal-rank hits
    // may differ.
    let (mut a, mut b) = (words.clone(), trigram.clone());
    a.sort();
    b.sort();
    assert_eq!(a, b, "{:?}: words vs trigram", q.q);
    words
}

// ── create, numbers, details ───────────────────────────────────────────────

#[test]
fn create_takes_the_next_number_and_client_keys_are_idempotent() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    assert_eq!((ann.number, bob.number), (10001, 10002));
    // Numbers are per organisation.
    assert_eq!(add(&world.b, person("Cy", "Young")).number, 10001);

    let keyed = Details {
        client_key: Some("form-1".into()),
        ..person("Cat", "Kay")
    };
    let first = add(&world.a, keyed.clone());
    let again = w(&world.a, |ctx| {
        create(
            ctx,
            CreateContact {
                id: None,
                details: keyed,
            },
            Source::Test,
        )
    });
    assert!(matches!(again, Err(ContractError::Duplicate { id }) if id == first.id));
    // The refused create took no number.
    assert_eq!(add(&world.a, person("Dee", "Lee")).number, 10004);
}

#[test]
fn details_are_validated_and_kind_cannot_change() {
    let world = world();
    let invalid = w(&world.a, |ctx| {
        create(
            ctx,
            CreateContact {
                id: None,
                details: person("Ann", " "),
            },
            Source::Test,
        )
    });
    assert!(matches!(invalid, Err(ContractError::Invalid(p)) if p[0].field == "lastName"));
    let bad_org = Details {
        first_name: "X".into(),
        ..org("Trust")
    };
    assert!(matches!(
        w(&world.a, |ctx| create(
            ctx,
            CreateContact {
                id: None,
                details: bad_org
            },
            Source::Test
        )),
        Err(ContractError::Invalid(_))
    ));

    let ann = add(&world.a, person("  Ann ", "Smith"));
    let v = view(&world.a, &ann.id);
    assert_eq!(
        (v.display_name.as_str(), v.sort_name.as_str()),
        ("Ann Smith", "Smith, Ann")
    );
    let refused = w(&world.a, |ctx| {
        execute(
            ctx,
            &DETAILS,
            org("Smith Ltd"),
            Exec::update(&ann.id, Some(0), Source::Test),
        )
    });
    assert!(
        matches!(refused, Err(ContractError::Rejected { reason, .. }) if reason == "kind_change")
    );
}

// ── counters, stale, revisions ─────────────────────────────────────────────

#[test]
fn each_slice_has_its_own_counter_and_never_falsely_conflicts() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    // Two editors loaded counter 0 of every slice. One saves details …
    w(&world.a, |ctx| {
        execute(
            ctx,
            &DETAILS,
            person("Anne", "Smith"),
            Exec::update(&ann.id, Some(0), Source::Test),
        )
    })
    .unwrap();
    // … the other's methods and addresses save is not stale.
    assert_eq!(
        save_methods(
            &world.a,
            &ann.id,
            0,
            Methods {
                emails: vec![email("ann@x.org")],
                phones: vec![]
            }
        )
        .unwrap(),
        1
    );
    w(&world.a, |ctx| {
        execute(
            ctx,
            &ADDRESSES,
            Addresses {
                addresses: vec![address("1 High St", "Leeds", "LS6 2AB")],
            },
            Exec::update(&ann.id, Some(0), Source::Test),
        )
    })
    .unwrap();
    // A second details save from the stale editor is refused, with the
    // slice's state now, and writes nothing.
    let stale = w(&world.a, |ctx| {
        execute(
            ctx,
            &DETAILS,
            person("Annie", "Smith"),
            Exec::update(&ann.id, Some(0), Source::Test),
        )
    });
    match stale {
        Err(ContractError::Stale {
            contract,
            counter,
            current,
        }) => {
            assert_eq!((contract, counter), ("contacts.details", 1));
            assert_eq!(current["firstName"], "Anne");
        }
        other => panic!("{other:?}"),
    }
    let v = view(&world.a, &ann.id);
    assert_eq!(v.details.first_name, "Anne");
    assert_eq!(
        v.counters,
        Counters {
            details: 1,
            methods: 1,
            addresses: 1,
            archive: 0,
            fields: 0
        }
    );
    // One revision per command, with contract name, version and the
    // prepared payload (minted keys included).
    let revs = revisions(&world.a, &ann.id);
    let names: Vec<_> = revs
        .iter()
        .map(|r| (r.contract.as_str(), r.version, r.counter))
        .collect();
    assert_eq!(
        names,
        [
            ("contacts.addresses", 1, 1),
            ("contacts.methods", 1, 1),
            ("contacts.details", 1, 1),
            ("contacts.details", 1, 0)
        ]
    );
    let key = revs[1].payload["emails"][0]["key"].as_str().unwrap();
    assert_eq!(v.methods.emails[0].key.as_deref(), Some(key));
    assert_eq!(revs[1].payload["emails"][0]["isPrimary"], true);
}

#[test]
fn archive_is_a_slice_and_never_deletes() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    w(&world.a, |ctx| set_archived(ctx, &ann.id, 0, true)).unwrap();
    assert!(matches!(
        w(&world.a, |ctx| set_archived(ctx, &ann.id, 0, false)),
        Err(ContractError::Stale { counter: 1, .. })
    ));
    assert!(view(&world.a, &ann.id).archived);
    assert!(find(&world.a, "smith").is_empty());
    assert_eq!(
        find_with(
            &world.a,
            SearchQuery {
                q: "smith".into(),
                include_archived: Some(true),
                ..Default::default()
            }
        ),
        ["Ann Smith"]
    );
}

// ── child rows (ADR 0014) ──────────────────────────────────────────────────

#[test]
fn child_rows_are_reconciled_by_key_and_identity_is_immutable() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    save_methods(
        &world.a,
        &ann.id,
        0,
        Methods {
            emails: vec![email(" ann@x.org "), email("work@x.org")],
            phones: vec![phone("07700 900123")],
        },
    )
    .unwrap();
    let m = view(&world.a, &ann.id).methods;
    assert_eq!(m.emails[0].address, "ann@x.org");
    assert!(m.emails[0].is_primary && !m.emails[1].is_primary);

    // Relabel in place: the key stays.
    let mut next = m.clone();
    next.emails[1].label = ChannelLabel::Work;
    save_methods(&world.a, &ann.id, 1, next.clone()).unwrap();
    let after = view(&world.a, &ann.id).methods;
    assert_eq!(after.emails[1].key, m.emails[1].key);
    assert_eq!(after.emails[1].label, ChannelLabel::Work);

    // Editing the address under the same key is refused, nothing written.
    let mut edit = after.clone();
    edit.emails[1].address = "other@x.org".into();
    assert!(matches!(
        save_methods(&world.a, &ann.id, 2, edit),
        Err(ContractError::Rejected { reason, .. }) if reason == "identity_immutable"
    ));
    // Remove + add is the way.
    let mut swap = after.clone();
    swap.emails.pop();
    swap.emails.push(email("other@x.org"));
    save_methods(&world.a, &ann.id, 2, swap).unwrap();
    let swapped = view(&world.a, &ann.id).methods;
    assert_eq!(swapped.emails[1].address, "other@x.org");
    assert_ne!(swapped.emails[1].key, after.emails[1].key);

    // Duplicates and two primaries are invalid.
    let dup = Methods {
        emails: vec![email("a@x.org"), email("A@x.org ")],
        phones: vec![],
    };
    assert!(matches!(
        save_methods(&world.a, &ann.id, 3, dup),
        Err(ContractError::Invalid(_))
    ));
    let mut two = swapped.clone();
    two.emails[1].is_primary = true;
    assert!(matches!(
        save_methods(&world.a, &ann.id, 3, two),
        Err(ContractError::Invalid(_))
    ));

    // Another contact's key can't be claimed.
    let bob = add(&world.a, person("Bob", "Jones"));
    let stolen = Methods {
        emails: vec![swapped.emails[0].clone()],
        phones: vec![],
    };
    assert!(matches!(
        save_methods(&world.a, &bob.id, 0, stolen),
        Err(ContractError::Rejected { reason, .. }) if reason == "child_ownership"
    ));
}

#[test]
fn addresses_are_editable_in_place() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let save = |expected, a: Addresses| {
        w(&world.a, |ctx| {
            execute(
                ctx,
                &ADDRESSES,
                a,
                Exec::update(&ann.id, Some(expected), Source::Test),
            )
        })
    };
    save(
        0,
        Addresses {
            addresses: vec![address("1 High St", "Leeds", " ls6 2ab")],
        },
    )
    .unwrap();
    let mut a = view(&world.a, &ann.id).addresses;
    assert_eq!(a.addresses[0].postcode, "LS6 2AB");
    let key = a.addresses[0].key.clone();
    a.addresses[0].line1 = "2 Low St".into();
    a.addresses[0].postcode = "M14 5AB".into();
    save(1, a).unwrap();
    let after = view(&world.a, &ann.id).addresses.addresses;
    assert_eq!(
        (after[0].key.clone(), after[0].line1.as_str()),
        (key, "2 Low St")
    );
    assert_eq!(find(&world.a, "m14"), ["Ann Smith"]);
    assert!(find(&world.a, "ls6").is_empty());
    let bad = Addresses {
        addresses: vec![AddressRow {
            country: "GBR".into(),
            ..address("x", "y", "z")
        }],
    };
    assert!(matches!(save(2, bad), Err(ContractError::Invalid(_))));
}

// ── the form save ──────────────────────────────────────────────────────────

fn exp<T>(expected: i64, slice: T) -> Option<Expected<T>> {
    Some(Expected { expected, slice })
}

#[test]
fn form_save_runs_only_changed_slices_and_reports_the_rest() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let form = |f: SaveForm| w(&world.a, |ctx| save_form(ctx, &ann.id, f)).unwrap();

    // A no-op save writes nothing.
    let out = form(SaveForm {
        details: exp(0, person("Ann", "Smith")),
        methods: exp(0, Methods::default()),
        ..Default::default()
    });
    assert!(out.saved.is_empty());
    assert_eq!(revisions(&world.a, &ann.id).len(), 1);

    // Two changed slices: one command group.
    let out = form(SaveForm {
        details: exp(0, person("Anne", "Smith")),
        methods: exp(
            0,
            Methods {
                emails: vec![email("ann@x.org")],
                phones: vec![],
            },
        ),
        addresses: exp(0, Addresses::default()),
        ..Default::default()
    });
    assert_eq!(out.saved, ["details", "methods"]);
    assert_eq!((out.counters.details, out.counters.methods), (1, 1));
    let revs = revisions(&world.a, &ann.id);
    assert_eq!(revs[0].group_name.as_deref(), Some("contact form save"));
    assert_eq!(revs[0].group, revs[1].group);

    // Stale details (with their state now) and invalid methods are
    // reported; the addresses still save.
    let out = form(SaveForm {
        details: exp(0, person("Annie", "Smith")),
        methods: exp(
            1,
            Methods {
                emails: vec![email("a@x.org"), email("A@X.org")],
                phones: vec![],
            },
        ),
        addresses: exp(
            0,
            Addresses {
                addresses: vec![address("1 High St", "Leeds", "LS6 2AB")],
            },
        ),
        ..Default::default()
    });
    assert_eq!(out.saved, ["addresses"]);
    assert_eq!(out.stale.get("details"), Some(&1));
    assert_eq!(out.current["details"]["firstName"], "Anne");
    assert_eq!(out.problems["methods"][0].field, "emails");
    assert_eq!(out.counters.addresses, 1);
    // A single changed slice runs without a group.
    assert_eq!(revisions(&world.a, &ann.id)[0].group, None);
}

// ── dropdown fields ────────────────────────────────────────────────────────

fn field(db: &OrgDb, label: &str, kinds: &[Kind], options: &[&str]) -> (String, Vec<String>) {
    w(db, |ctx| {
        let f = execute(
            ctx,
            &contacts::fields::FIELD,
            FieldPayload {
                label: label.into(),
                applies_to: kinds.to_vec(),
                is_active: true,
            },
            Exec::create(Source::Test),
        )?;
        let mut ids = vec![];
        for (i, o) in options.iter().enumerate() {
            ids.push(
                execute(
                    ctx,
                    &contacts::fields::FIELD_OPTION,
                    FieldOptionPayload {
                        field_id: f.id.clone(),
                        label: (*o).into(),
                        position: i as u32,
                        is_active: true,
                    },
                    Exec::create(Source::Test),
                )?
                .id,
            );
        }
        Ok((f.id, ids))
    })
    .unwrap()
}

fn set_field(db: &OrgDb, id: &str, expected: i64, values: Vec<FieldValue>) -> SaveFormResult {
    w(db, |ctx| {
        save_form(
            ctx,
            id,
            SaveForm {
                fields: exp(expected, FieldValues { values }),
                ..Default::default()
            },
        )
    })
    .unwrap()
}

fn value(field: &str, option: &str) -> FieldValue {
    FieldValue {
        field_id: field.into(),
        option_id: option.into(),
    }
}

#[test]
fn dropdown_values_follow_the_field_rules() {
    let world = world();
    let (vol, opts) = field(
        &world.a,
        "Volunteer status",
        &[Kind::Individual],
        &["Active", "Lapsed"],
    );
    let dup = w(&world.a, |ctx| {
        execute(
            ctx,
            &contacts::fields::FIELD,
            FieldPayload {
                label: "volunteer  STATUS".into(),
                applies_to: vec![Kind::Household],
                is_active: true,
            },
            Exec::create(Source::Test),
        )
    });
    assert!(
        matches!(dup, Err(ContractError::Rejected { reason, .. }) if reason == "duplicate_field_label")
    );

    let ann = add(&world.a, person("Ann", "Smith"));
    let trust = add(&world.a, org("Leeds Trust"));
    let out = set_field(&world.a, &ann.id, 0, vec![value(&vol, &opts[0])]);
    assert_eq!(out.saved, ["fields"]);
    let defs = r(&world.a, |c| Ok(contacts::fields::definitions(c)?));
    assert!(defs[0].options[0].used && !defs[0].options[1].used);

    // Not for organisations: refused on its field, nothing saved.
    let out = set_field(&world.a, &trust.id, 0, vec![value(&vol, &opts[0])]);
    assert!(out.saved.is_empty());
    assert_eq!(out.problems["fields"][0].key.as_deref(), Some(vol.as_str()));
    // Another field's option is refused.
    let (other, other_opts) = field(&world.a, "Newsletter", &Kind::ALL, &["Yes"]);
    let out = set_field(&world.a, &ann.id, 1, vec![value(&vol, &other_opts[0])]);
    assert!(out.saved.is_empty() && out.problems.contains_key("fields"));

    // Archive "Active": a new value of it is refused, a held one stays.
    w(&world.a, |ctx| {
        execute(
            ctx,
            &contacts::fields::FIELD_OPTION,
            FieldOptionPayload {
                field_id: vol.clone(),
                label: "Active".into(),
                position: 0,
                is_active: false,
            },
            Exec::update(&opts[0], Some(0), Source::Test),
        )
    })
    .unwrap();
    let bob = add(&world.a, person("Bob", "Jones"));
    let out = set_field(&world.a, &bob.id, 0, vec![value(&vol, &opts[0])]);
    assert!(out.saved.is_empty());
    let out = set_field(
        &world.a,
        &ann.id,
        1,
        vec![value(&vol, &opts[0]), value(&other, &other_opts[0])],
    );
    assert_eq!(out.saved, ["fields"]);
    assert_eq!(view(&world.a, &ann.id).fields.values.len(), 2);

    // List filters: set, not set, and both together.
    let rows = |fields: String| -> Vec<String> {
        r(&world.a, |c| {
            list(
                c,
                &ListQuery {
                    fields: Some(fields),
                    ..Default::default()
                },
            )
        })
        .rows
        .into_iter()
        .map(|r| r.display_name)
        .collect()
    };
    assert_eq!(rows(format!("{vol}:{}", opts[0])), ["Ann Smith"]);
    assert_eq!(rows(format!("{vol}:none")), ["Bob Jones", "Leeds Trust"]);
    assert_eq!(
        rows(format!("{vol}:{},{other}:none", opts[0])),
        Vec::<String>::new()
    );
    assert!(matches!(
        world.a.read(|c| list(c, &ListQuery { fields: Some(format!("{vol}:{}", other_opts[0])), ..Default::default() })),
        Err(ContractError::Rejected { reason, .. }) if reason == "unknown_option"
    ));
    // Search takes the same filters.
    assert_eq!(
        find_with(
            &world.a,
            SearchQuery {
                q: "smith".into(),
                fields: Some(format!("{vol}:{}", opts[1])),
                ..Default::default()
            }
        ),
        Vec::<String>::new()
    );
}

// ── restore ────────────────────────────────────────────────────────────────

#[test]
fn restore_re_executes_history_as_new_commands() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    save_methods(
        &world.a,
        &ann.id,
        0,
        Methods {
            emails: vec![email("ann@x.org")],
            phones: vec![],
        },
    )
    .unwrap();
    let with_email = view(&world.a, &ann.id).methods;
    let at = contracts::now_ms();
    std::thread::sleep(std::time::Duration::from_millis(5));
    save_methods(&world.a, &ann.id, 1, Methods::default()).unwrap();
    w(&world.a, |ctx| {
        execute(
            ctx,
            &DETAILS,
            person("Anne", "Smythe"),
            Exec::update(&ann.id, Some(0), Source::Test),
        )
    })
    .unwrap();
    assert!(find(&world.a, "ann@x.org").is_empty());

    // One revision: the removed email comes back with its key.
    let rev = revisions(&world.a, &ann.id)
        .into_iter()
        .find(|r| r.contract == "contacts.methods" && r.counter == 1)
        .unwrap();
    let out = w(&world.a, |ctx| {
        restore_contact(
            ctx,
            &ann.id,
            RestoreRequest::Revision {
                revision_id: rev.id,
            },
        )
    })
    .unwrap();
    assert_eq!(out.restored, ["contacts.methods"]);
    let v = view(&world.a, &ann.id);
    assert_eq!(v.methods.emails[0].key, with_email.emails[0].key);
    assert_eq!(v.counters.methods, 3);
    let latest = &revisions(&world.a, &ann.id)[0];
    assert_eq!(
        (latest.source, latest.restored_from),
        (Source::Restore, Some(rev.id))
    );
    assert_eq!(find(&world.a, "ann@x.org"), ["Anne Smythe"]);

    // Another contact's revision isn't this contact's to restore.
    let bob = add(&world.a, person("Bob", "Jones"));
    assert!(matches!(
        w(&world.a, |ctx| restore_contact(
            ctx,
            &bob.id,
            RestoreRequest::Revision {
                revision_id: rev.id
            }
        )),
        Err(ContractError::NotFound)
    ));

    // The whole contact as it was at `at`: details back; methods already
    // match, so only details runs.
    let out = w(&world.a, |ctx| {
        restore_contact(ctx, &ann.id, RestoreRequest::At { at })
    })
    .unwrap();
    assert_eq!(out.restored, ["contacts.details"]);
    assert_eq!(view(&world.a, &ann.id).display_name, "Ann Smith");
}

// ── list ───────────────────────────────────────────────────────────────────

#[test]
fn list_pages_by_keyset_in_name_order() {
    let world = world();
    for i in 0..250 {
        add(
            &world.a,
            person(
                &format!("n{i:04}"),
                if i % 2 == 0 { "Smith" } else { "Ávila" },
            ),
        );
    }
    add(&world.a, org("Zeta Trust"));
    let archived = add(&world.a, person("Old", "Aardvark"));
    w(&world.a, |ctx| set_archived(ctx, &archived.id, 0, true)).unwrap();

    let mut cursor = None;
    let mut all = vec![];
    loop {
        let page = r(&world.a, |c| {
            list(
                c,
                &ListQuery {
                    cursor: cursor.clone(),
                    ..Default::default()
                },
            )
        });
        assert!(page.rows.len() <= 100);
        all.extend(page.rows.into_iter().map(|r| r.sort_name));
        if page.is_done {
            assert!(page.next_cursor.is_none());
            break;
        }
        cursor = page.next_cursor;
    }
    assert_eq!(all.len(), 251);
    // Accents fold for the order: Ávila sorts with the As.
    assert_eq!(all[0], "Ávila, n0001");
    assert_eq!(all.last().unwrap(), "Zeta Trust");
    let mut sorted = all.clone();
    sorted.sort_by_key(|s| contacts::rules::fold(s));
    assert_eq!(all, sorted);

    let count = |q: ListQuery| r(&world.a, |c| list(c, &q)).rows.len();
    assert_eq!(
        count(ListQuery {
            kind: Some(Kind::Organization),
            ..Default::default()
        }),
        1
    );
    assert_eq!(
        count(ListQuery {
            include_archived: Some(true),
            limit: Some(1),
            ..Default::default()
        }),
        1
    );
    let first = r(&world.a, |c| {
        list(
            c,
            &ListQuery {
                include_archived: Some(true),
                ..Default::default()
            },
        )
    });
    assert_eq!(first.rows[0].sort_name, "Aardvark, Old");
    assert!(
        world
            .a
            .read(|c| list(
                c,
                &ListQuery {
                    cursor: Some("zz".into()),
                    ..Default::default()
                }
            ))
            .is_err()
    );
}

// ── search ─────────────────────────────────────────────────────────────────

#[test]
fn search_matches_like_convex() {
    let world = world();
    let ann = add(&world.a, person("Ann-Marie", "O'Brien"));
    save_methods(
        &world.a,
        &ann.id,
        0,
        Methods {
            emails: vec![email("am.obrien@gmail.com")],
            phones: vec![phone("+44 (0)7700 900123")],
        },
    )
    .unwrap();
    w(&world.a, |ctx| {
        execute(
            ctx,
            &ADDRESSES,
            Addresses {
                addresses: vec![address("12 Cardigan Road", "Leeds", "LS6 1AB")],
            },
            Exec::update(&ann.id, Some(0), Source::Test),
        )
    })
    .unwrap();
    add(&world.a, person("John", "Smith"));
    add(&world.a, person("Johnny", "Smithers"));
    add(&world.a, person("Zoë", "de la Cruz"));
    add(&world.a, org("Smith & Sons Ltd"));

    // Names: words, prefixes, joined forms, accents folded.
    for q in [
        "ann",
        "annmarie",
        "obrien",
        "o'brien",
        "Ann-Marie O'Brien",
        "ann o",
    ] {
        assert_eq!(find(&world.a, q), ["Ann-Marie O'Brien"], "{q}");
    }
    assert_eq!(find(&world.a, "delacruz"), ["Zoë de la Cruz"]);
    assert_eq!(find(&world.a, "zoe"), ["Zoë de la Cruz"]);
    let mut smiths = find(&world.a, "smith");
    smiths.sort();
    assert_eq!(
        smiths,
        ["John Smith", "Johnny Smithers", "Smith & Sons Ltd"]
    );
    // Every word but the last is whole.
    assert_eq!(find(&world.a, "john smith"), ["John Smith"]);
    assert_eq!(find(&world.a, "joh smith"), Vec::<String>::new());

    // Emails whole and in parts, phones in any spelling and by tail,
    // postcodes compact and spaced, street and town.
    for q in [
        "am.obrien@gmail.com",
        "AM.OBrien@Gmail.com",
        "gmail",
        "07700 900123",
        "+447700900123",
        "900123",
        "LS6 1AB",
        "ls61ab",
        "cardigan",
        "leeds",
    ] {
        assert_eq!(find(&world.a, q), ["Ann-Marie O'Brien"], "{q}");
    }
    assert!(find(&world.a, "zzqx").is_empty());

    // Kind filter.
    assert_eq!(
        find_with(
            &world.a,
            SearchQuery {
                q: "smith".into(),
                kind: Some(Kind::Organization),
                ..Default::default()
            }
        ),
        ["Smith & Sons Ltd"]
    );
}

#[test]
fn exact_matches_come_first() {
    let world = world();
    // Many contacts whose text matches "gmail"; one whose address is the
    // exact entry, created last.
    for i in 0..30 {
        let c = add(&world.a, person(&format!("p{i}"), "Gmailson"));
        save_methods(
            &world.a,
            &c.id,
            0,
            Methods {
                emails: vec![email(&format!("p{i}@gmail.com"))],
                phones: vec![],
            },
        )
        .unwrap();
    }
    let zed = add(&world.a, person("Zed", "Zulu"));
    save_methods(
        &world.a,
        &zed.id,
        0,
        Methods {
            emails: vec![email("zed@gmail.com")],
            phones: vec![phone("07700 111222")],
        },
    )
    .unwrap();

    let res = r(&world.a, |c| {
        search(
            c,
            &SearchQuery {
                q: " ZED@gmail.com ".into(),
                ..Default::default()
            },
        )
    });
    assert_eq!(res.rows[0].display_name, "Zed Zulu");

    // A written contact number (check digit holds) leads, and is badged.
    let number = view(&world.a, &zed.id).number;
    let written = contacts::number::format_number(number);
    let res = r(&world.a, |c| {
        search(
            c,
            &SearchQuery {
                q: written.clone(),
                ..Default::default()
            },
        )
    });
    assert_eq!(res.rows[0].id, zed.id);
    assert_eq!(res.number_match.as_deref(), Some(zed.id.as_str()));
    // A wrong check digit with nothing else matching: the hint.
    let wrong = format!(
        "{number}{}",
        (contacts::number::check_digit(number) + 1) % 10
    );
    let res = r(&world.a, |c| {
        search(
            c,
            &SearchQuery {
                q: wrong,
                ..Default::default()
            },
        )
    });
    assert!(res.rows.is_empty() && res.invalid_number.is_some());
    // A phone number exactly.
    let res = r(&world.a, |c| {
        search(
            c,
            &SearchQuery {
                q: "07700111222".into(),
                ..Default::default()
            },
        )
    });
    assert_eq!(res.rows[0].id, zed.id);
}

#[test]
fn search_windows_are_capped_and_say_so() {
    let world = world();
    world
        .a
        .write(|tx| {
            let ctx = Ctx::new(tx, None);
            for i in 0..120 {
                create(
                    &ctx,
                    CreateContact {
                        id: None,
                        details: person(&format!("p{i}"), "Smith"),
                    },
                    Source::Seed,
                )?;
            }
            Ok::<_, ContractError>(())
        })
        .unwrap();
    for fts in ["words", "trigram"] {
        let res = r(&world.a, |c| {
            search(
                c,
                &SearchQuery {
                    q: "smi".into(),
                    fts: Some(fts.into()),
                    ..Default::default()
                },
            )
        });
        assert_eq!(res.rows.len(), 100, "{fts}");
        assert!(res.truncated && !res.too_broad, "{fts}");
        // One-letter entries work on trigram too (by scan).
        let res = r(&world.a, |c| {
            search(
                c,
                &SearchQuery {
                    q: "s".into(),
                    fts: Some(fts.into()),
                    ..Default::default()
                },
            )
        });
        assert_eq!(res.rows.len(), 100, "{fts}");
    }
}

// ── isolation ──────────────────────────────────────────────────────────────

#[test]
fn two_organisations_never_see_each_other() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    add(&world.b, person("Bea", "Smith"));
    assert_eq!(find(&world.a, "smith"), ["Ann Smith"]);
    assert_eq!(find(&world.b, "smith"), ["Bea Smith"]);
    // A's id asked of B's file: nothing there.
    assert!(r(&world.b, |c| get(c, &ann.id)).is_none());
    assert!(matches!(
        save_methods(&world.b, &ann.id, 0, Methods::default()),
        Err(ContractError::NotFound)
    ));
    let rows = |db: &OrgDb| r(db, |c| list(c, &ListQuery::default())).rows.len();
    assert_eq!((rows(&world.a), rows(&world.b)), (1, 1));
    // No tenant column in the domain: the file is the scope (only the
    // store's `_org` stamp names its tenant).
    let has_tenant_column: bool = world
        .a
        .read(|c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM sqlite_master m, pragma_table_info(m.name) p
                 WHERE m.type = 'table' AND m.name != '_org' AND p.name LIKE '%tenant%')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!has_tenant_column);
}

#[test]
fn money_rule_no_real_columns() {
    let world = world();
    let reals: i64 = world
        .a
        .read(|c| {
            c.query_row(
                "SELECT count(*) FROM sqlite_master m, pragma_table_info(m.name) p
                 WHERE m.type = 'table' AND upper(p.type) IN ('REAL', 'FLOAT', 'DOUBLE')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(reals, 0);
}
