//! External identifiers and their types (Convex `identifiers.test.ts`,
//! `identifierTypes.test.ts`): the slice's rules, uniqueness, archived
//! types, lookups, restore, and two organisations kept apart.

mod common;

use common::*;
use contacts::form::{restore_contact, save_form};
use contacts::identifiers::{
    IDENTIFIER_TYPE, IDENTIFIER_TYPE_LIMIT, IDENTIFIERS, IdentifierTypePayload, Identifiers,
    find_by_identifier, identifier_types,
};
use contacts::types::*;
use contracts::{ContractError, Exec, Source, execute};

fn rename(
    db: &store::OrgDb,
    id: &str,
    expected: i64,
    name: &str,
    active: bool,
) -> Result<i64, ContractError> {
    w(db, |ctx| {
        Ok(execute(
            ctx,
            &IDENTIFIER_TYPE,
            IdentifierTypePayload {
                name: name.into(),
                is_active: active,
            },
            Exec::update(id, Some(expected), Source::Test),
        )?
        .counter)
    })
}

fn rejected(e: Result<impl std::fmt::Debug, ContractError>) -> String {
    match e {
        Err(ContractError::Rejected { reason, .. }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

// ── identifier types ───────────────────────────────────────────────────────

#[test]
fn no_types_are_seeded_and_a_type_starts_tidied_at_zero_with_a_revision() {
    let world = world();
    assert!(r(&world.a, |c| Ok(identifier_types(c, true)?)).is_empty());
    let t = id_type(&world.a, "  Member   no ");
    let types = r(&world.a, |c| Ok(identifier_types(c, true)?));
    assert_eq!(
        (
            types[0].id.as_str(),
            types[0].name.as_str(),
            types[0].save_version
        ),
        (t.as_str(), "Member no", 0)
    );
    let revs = r(&world.a, |c| {
        contracts::history(c, "identifier_types", &t, 10)
    });
    assert_eq!(revs[0].contract, "contacts.identifierType");
}

#[test]
fn names_are_unique_per_organisation_case_insensitively() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    for clash in ["member NO", " Member  no "] {
        let e = w(&world.a, |ctx| {
            execute(
                ctx,
                &IDENTIFIER_TYPE,
                IdentifierTypePayload {
                    name: clash.into(),
                    is_active: true,
                },
                Exec::create(Source::Test),
            )
        });
        assert_eq!(rejected(e), "duplicate_identifier_type_name");
    }
    // Its own name, re-cased, is a rename, not a clash.
    assert_eq!(rename(&world.a, &t, 0, "MEMBER NO", true).unwrap(), 1);
    // The other organisation has its own names.
    id_type(&world.b, "Member no");
}

#[test]
fn rename_archive_and_reactivate_keep_the_id_and_every_row() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    rename(&world.a, &t, 0, "Old member no", true).unwrap();
    rename(&world.a, &t, 1, "Old member no", false).unwrap();
    // Archived leaves the default list, not the settings page's.
    assert!(r(&world.a, |c| Ok(identifier_types(c, false)?)).is_empty());
    assert_eq!(r(&world.a, |c| Ok(identifier_types(c, true)?)).len(), 1);
    let v = view(&world.a, &ann);
    assert_eq!(
        (
            v.identifiers[0].type_name.as_str(),
            v.identifiers[0].type_active
        ),
        ("Old member no", false)
    );
    rename(&world.a, &t, 2, "Old member no", true).unwrap();
    assert!(view(&world.a, &ann).identifiers[0].type_active);
}

#[test]
fn a_stale_type_save_conflicts_and_another_organisations_type_is_not_found() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    rename(&world.a, &t, 0, "Member number", true).unwrap();
    assert!(matches!(
        rename(&world.a, &t, 0, "Membership", true),
        Err(ContractError::Stale { counter: 1, .. })
    ));
    assert!(matches!(
        rename(&world.b, &t, 0, "Mine now", true),
        Err(ContractError::NotFound)
    ));
    assert!(r(&world.b, |c| Ok(identifier_types(c, true)?)).is_empty());
}

#[test]
fn an_organisation_holds_at_most_the_limit_archived_included_and_edits_still_work() {
    let world = world();
    let mut first = None;
    for i in 0..IDENTIFIER_TYPE_LIMIT {
        let t = id_type(&world.a, &format!("Type {i}"));
        first.get_or_insert(t);
    }
    let first = first.unwrap();
    rename(&world.a, &first, 0, "Type 0", false).unwrap();
    let e = w(&world.a, |ctx| {
        execute(
            ctx,
            &IDENTIFIER_TYPE,
            IdentifierTypePayload {
                name: "One more".into(),
                is_active: true,
            },
            Exec::create(Source::Test),
        )
    });
    assert_eq!(rejected(e), "identifier_type_limit");
    rename(&world.a, &first, 1, "Type zero", true).unwrap();
}

// ── the slice ──────────────────────────────────────────────────────────────

#[test]
fn rows_save_trimmed_normalised_and_shown_as_typed_several_of_a_type() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    assert_eq!(view(&world.a, &ann).counters.identifiers, 0);
    let out = save_identifiers(
        &world.a,
        &ann,
        0,
        vec![ident(&t, "  M-12a "), ident(&t, "M-13")],
    );
    assert_eq!(out.saved, ["identifiers"]);
    let v = view(&world.a, &ann);
    assert_eq!(v.counters.identifiers, 1);
    let values: Vec<_> = v.identifiers.iter().map(|i| i.value.as_str()).collect();
    assert_eq!(values, ["M-12a", "M-13"]);
    // Found trimmed and case-insensitively.
    assert_eq!(
        r(&world.a, |c| Ok(find_by_identifier(c, &t, " m-12A")?)),
        Some(ann.clone())
    );
}

#[test]
fn a_pair_listed_twice_or_a_blank_value_is_a_problem_on_the_slice() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    for rows in [
        vec![ident(&t, "M1"), ident(&t, "m1 ")],
        vec![ident(&t, " ")],
    ] {
        let out = save_identifiers(&world.a, &ann, 0, rows);
        assert!(out.saved.is_empty());
        assert_eq!(out.problems["identifiers"][0].field, "identifiers");
    }
}

#[test]
fn identifiers_and_details_never_bump_each_other() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let out = w(&world.a, |ctx| {
        save_form(
            ctx,
            &ann,
            SaveForm {
                details: exp(0, person("Anne", "Smith")),
                identifiers: exp(
                    0,
                    Identifiers {
                        identifiers: vec![ident(&t, "M1")],
                    },
                ),
                ..Default::default()
            },
        )
    })
    .unwrap();
    assert_eq!(out.saved, ["details", "identifiers"]);
    assert_eq!((out.counters.details, out.counters.identifiers), (1, 1));
    // A stale details save leaves identifiers saving.
    let out = w(&world.a, |ctx| {
        save_form(
            ctx,
            &ann,
            SaveForm {
                details: exp(0, person("Annie", "Smith")),
                identifiers: exp(1, Identifiers::default()),
                ..Default::default()
            },
        )
    })
    .unwrap();
    assert_eq!(out.saved, ["identifiers"]);
    assert_eq!(out.stale.get("details"), Some(&1));
}

#[test]
fn type_and_value_are_immutable_per_key_and_remove_plus_add_works() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let u = id_type(&world.a, "Gift Aid ref");
    let ann = add(&world.a, person("Ann", "Smith"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    let key = view(&world.a, &ann).identifiers[0].key.clone();
    for changed in [ident(&t, "M2"), ident(&u, "M1")] {
        let e = w(&world.a, |ctx| {
            execute(
                ctx,
                &IDENTIFIERS,
                Identifiers {
                    identifiers: vec![contacts::identifiers::IdentifierRow {
                        key: Some(key.clone()),
                        ..changed
                    }],
                },
                Exec::update(&ann, Some(1), Source::Test),
            )
        });
        assert_eq!(rejected(e), "identity_immutable");
    }
    // Change = remove + add (a new key), in one save.
    let out = save_identifiers(&world.a, &ann, 1, vec![ident(&t, "M2")]);
    assert_eq!(out.saved, ["identifiers"]);
    let v = view(&world.a, &ann);
    assert_ne!(v.identifiers[0].key, key);
    assert_eq!(v.identifiers[0].value, "M2");
}

#[test]
fn another_contacts_row_key_and_another_organisations_type_are_refused() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    let key = view(&world.a, &ann).identifiers[0].key.clone();
    let e = w(&world.a, |ctx| {
        execute(
            ctx,
            &IDENTIFIERS,
            Identifiers {
                identifiers: vec![contacts::identifiers::IdentifierRow {
                    key: Some(key),
                    ..ident(&t, "M9")
                }],
            },
            Exec::update(&bob, Some(0), Source::Test),
        )
    });
    assert_eq!(rejected(e), "child_ownership");
    // B's contact, A's type: unknown in B's file.
    let bea = add(&world.b, person("Bea", "Brown"));
    let out = save_identifiers(&world.b, &bea, 0, vec![ident(&t, "M1")]);
    assert!(out.saved.is_empty());
    assert_eq!(
        out.problems["identifiers"][0].message,
        "Identifier type must exist and be active"
    );
}

// ── uniqueness ─────────────────────────────────────────────────────────────

#[test]
fn a_pair_another_contact_holds_is_to_fix_on_the_row_naming_it_and_other_slices_save() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    let out = w(&world.a, |ctx| {
        save_form(
            ctx,
            &bob,
            SaveForm {
                details: exp(0, person("Robert", "Jones")),
                identifiers: exp(
                    0,
                    Identifiers {
                        identifiers: vec![ident(&t, " m1")],
                    },
                ),
                ..Default::default()
            },
        )
    })
    .unwrap();
    assert_eq!(out.saved, ["details"]);
    let p = &out.problems["identifiers"][0];
    assert_eq!(p.message, "m1 is already used by Ann Smith");
    assert_eq!(p.contact_id.as_deref(), Some(ann.as_str()));
    assert!(p.key.is_some());
    // The same value under another type is a different pair.
    let u = id_type(&world.a, "Old CRM id");
    assert_eq!(
        save_identifiers(&world.a, &bob, 0, vec![ident(&u, "M1")]).saved,
        ["identifiers"]
    );
}

#[test]
fn the_contract_refuses_a_clash_on_every_path() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    let e = w(&world.a, |ctx| {
        execute(
            ctx,
            &IDENTIFIERS,
            Identifiers {
                identifiers: vec![ident(&t, "M1")],
            },
            Exec::update(&bob, Some(0), Source::Test),
        )
    });
    assert_eq!(rejected(e), "duplicate_identifier");
    assert_eq!(view(&world.a, &bob).counters.identifiers, 0);
}

#[test]
fn behind_kept_rows_the_clash_names_its_own_row() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    save_identifiers(&world.a, &bob, 0, vec![ident(&t, "B1"), ident(&t, "B2")]);
    let mut rows: Vec<_> = view(&world.a, &bob)
        .identifiers
        .into_iter()
        .map(|i| contacts::identifiers::IdentifierRow {
            key: Some(i.key),
            type_id: i.type_id,
            value: i.value,
        })
        .collect();
    let mut clash = ident(&t, "M1");
    clash.key = Some(contracts::new_id());
    rows.push(clash.clone());
    let out = save_identifiers(&world.a, &bob, 1, rows);
    assert_eq!(out.problems["identifiers"].len(), 1);
    assert_eq!(out.problems["identifiers"][0].key, clash.key);
}

#[test]
fn a_removed_pair_is_free_for_another_contact_but_restore_cannot_take_it_back() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    let held = revisions(&world.a, &ann)
        .into_iter()
        .find(|r| r.contract == "contacts.identifiers")
        .unwrap();
    save_identifiers(&world.a, &ann, 1, vec![]);
    assert_eq!(
        save_identifiers(&world.a, &bob, 0, vec![ident(&t, "M1")]).saved,
        ["identifiers"]
    );
    let e = w(&world.a, |ctx| {
        restore_contact(
            ctx,
            &ann,
            RestoreRequest::Revision {
                revision_id: held.id,
            },
        )
    });
    assert_eq!(rejected(e), "duplicate_identifier");
    assert!(view(&world.a, &ann).identifiers.is_empty());
}

// ── archived types ─────────────────────────────────────────────────────────

#[test]
fn an_archived_type_cannot_be_newly_added_but_kept_rows_stay_marked_and_found() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    rename(&world.a, &t, 0, "Member no", false).unwrap();
    // Archived mid-edit: "to fix" on the row, the other slices save.
    let out = w(&world.a, |ctx| {
        save_form(
            ctx,
            &bob,
            SaveForm {
                details: exp(0, person("Robert", "Jones")),
                identifiers: exp(
                    0,
                    Identifiers {
                        identifiers: vec![ident(&t, "M2")],
                    },
                ),
                ..Default::default()
            },
        )
    })
    .unwrap();
    assert_eq!(out.saved, ["details"]);
    assert_eq!(
        out.problems["identifiers"][0].message,
        "That type has been archived: choose another"
    );
    let e = w(&world.a, |ctx| {
        execute(
            ctx,
            &IDENTIFIERS,
            Identifiers {
                identifiers: vec![ident(&t, "M2")],
            },
            Exec::update(&bob, Some(0), Source::Test),
        )
    });
    assert_eq!(rejected(e), "unknown_identifier_type");
    // Ann's row stays, marked, still found; she can save other rows.
    let v = view(&world.a, &ann);
    assert!(!v.identifiers[0].type_active);
    assert_eq!(find(&world.a, "M1"), ["Ann Smith"]);
    let u = id_type(&world.a, "Old CRM id");
    let mut rows: Vec<_> = v
        .identifiers
        .into_iter()
        .map(|i| contacts::identifiers::IdentifierRow {
            key: Some(i.key),
            type_id: i.type_id,
            value: i.value,
        })
        .collect();
    rows.push(ident(&u, "X9"));
    assert_eq!(
        save_identifiers(&world.a, &ann, 1, rows).saved,
        ["identifiers"]
    );
}

#[test]
fn restore_re_adds_a_row_of_an_archived_type() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "M1")]);
    let held = revisions(&world.a, &ann)[0].clone();
    save_identifiers(&world.a, &ann, 1, vec![]);
    rename(&world.a, &t, 0, "Member no", false).unwrap();
    w(&world.a, |ctx| {
        restore_contact(
            ctx,
            &ann,
            RestoreRequest::Revision {
                revision_id: held.id,
            },
        )
    })
    .unwrap();
    assert_eq!(view(&world.a, &ann).identifiers[0].value, "M1");
}

// ── lookup and search ──────────────────────────────────────────────────────

#[test]
fn find_by_identifier_includes_archived_contacts_and_the_list_finds_any_type_exactly() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let u = id_type(&world.a, "Old CRM id");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&t, "12345")]);
    save_identifiers(&world.a, &bob, 0, vec![ident(&u, "12345")]);
    w(&world.a, |ctx| {
        contacts::form::set_archived(ctx, &ann, 0, true)
    })
    .unwrap();
    assert_eq!(
        r(&world.a, |c| Ok(find_by_identifier(c, &t, "12345")?)),
        Some(ann.clone())
    );
    assert_eq!(r(&world.a, |c| Ok(find_by_identifier(c, &t, "  ")?)), None);
    // Any type, exact; archived hidden from the list unless asked.
    assert_eq!(find(&world.a, "12345"), ["Bob Jones"]);
    // An identifier's words are in the search text too.
    save_identifiers(
        &world.a,
        &bob,
        1,
        vec![ident(&u, "12345"), ident(&u, "LEGACY-77")],
    );
    assert_eq!(find(&world.a, "legacy"), ["Bob Jones"]);
}

#[test]
fn an_identifier_outranks_a_bare_five_digit_number_a_written_one_leads() {
    let world = world();
    let t = id_type(&world.a, "Member no");
    let first = add(&world.a, person("Ann", "Smith"));
    let number = view(&world.a, &first).number;
    let bob = add(&world.a, person("Bob", "Jones"));
    save_identifiers(&world.a, &bob, 0, vec![ident(&t, &number.to_string())]);
    assert_eq!(
        find(&world.a, &number.to_string()),
        ["Bob Jones", "Ann Smith"]
    );
}

// ── isolation ──────────────────────────────────────────────────────────────

#[test]
fn the_same_type_name_and_value_save_in_both_organisations_and_never_cross() {
    let world = world();
    let ta = id_type(&world.a, "Member no");
    let tb = id_type(&world.b, "Member no");
    let ann = add(&world.a, person("Ann", "Smith"));
    let bea = add(&world.b, person("Bea", "Brown"));
    save_identifiers(&world.a, &ann, 0, vec![ident(&ta, "M1")]);
    assert_eq!(
        save_identifiers(&world.b, &bea, 0, vec![ident(&tb, "M1")]).saved,
        ["identifiers"]
    );
    assert_eq!(find(&world.a, "M1"), ["Ann Smith"]);
    assert_eq!(find(&world.b, "M1"), ["Bea Brown"]);
    assert_eq!(r(&world.b, |c| Ok(find_by_identifier(c, &ta, "M1")?)), None);
}
