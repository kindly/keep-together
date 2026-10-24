//! Contact lookups and relationships (the rest of Convex
//! `contacts.test.ts`): find by email, "also used by", byClientKey, the
//! relationship contracts and their seed; two organisations kept apart.

mod common;

use common::*;
use contacts::form::{create, set_archived};
use contacts::queries::{EMAIL_LOOKUP_LIMIT, also_used_by, by_client_key, find_by_email};
use contacts::relationships::{
    RELATIONSHIP, RelationshipPayload, UK_RELATIONSHIP_TYPES, relationship_types,
    relationships_for, seed_new_org,
};
use contacts::types::*;
use contracts::{ContractError, Exec, Source, execute};
use store::OrgDb;

fn found(db: &OrgDb, address: &str) -> Vec<String> {
    r(db, |c| Ok(find_by_email(c, address)?)).ids
}

fn sharer_warnings(db: &OrgDb, id: &str) -> Vec<Warning> {
    view(db, id)
        .warnings
        .into_iter()
        .filter(|w| w.anchor.starts_with("emails#"))
        .collect()
}

// ── email lookup ───────────────────────────────────────────────────────────

#[test]
fn lookup_ignores_case_and_surrounding_whitespace_and_a_blank_finds_nothing() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    set_emails(&world.a, &ann, &[" Ann@Example.com "]);
    assert_eq!(
        view(&world.a, &ann).methods.emails[0].address,
        "Ann@Example.com"
    );
    assert_eq!(
        found(&world.a, "  ANN@example.COM "),
        std::slice::from_ref(&ann)
    );
    assert!(found(&world.a, "nobody@example.com").is_empty());
    assert!(found(&world.a, "   ").is_empty());
}

#[test]
fn remove_plus_add_moves_the_lookup_and_a_kept_key_keeps_it() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    set_emails(&world.a, &ann, &["old@x.com"]);
    // A kept key with a new label keeps its lookup.
    let mut m = view(&world.a, &ann).methods;
    m.emails[0].label = ChannelLabel::Work;
    w(&world.a, |ctx| {
        execute(
            ctx,
            &contacts::METHODS,
            m,
            Exec::update(&ann, Some(1), Source::Test),
        )
    })
    .unwrap();
    assert_eq!(found(&world.a, "OLD@x.com"), std::slice::from_ref(&ann));
    set_emails(&world.a, &ann, &["new@x.com"]);
    assert!(found(&world.a, "old@x.com").is_empty());
    assert_eq!(found(&world.a, "NEW@x.com"), std::slice::from_ref(&ann));
}

#[test]
fn a_shared_address_saves_on_both_each_warned_naming_the_other() {
    let world = world();
    let ada = add(&world.a, person("Ada", "Lovelace"));
    let ann = add(&world.a, person("Ann", "Smith"));
    set_emails(&world.a, &ada, &["ann@example.com"]);
    set_emails(&world.a, &ann, &["ANN@example.com"]);
    let ada_key = view(&world.a, &ada).methods.emails[0].key.clone().unwrap();
    assert_eq!(
        sharer_warnings(&world.a, &ada),
        [Warning {
            anchor: format!("emails#{ada_key}"),
            label: "email 1".into(),
            message: "Also used by Ann Smith".into(),
        }]
    );
    assert_eq!(
        sharer_warnings(&world.a, &ann)[0].message,
        "Also used by Ada Lovelace"
    );
    let mut both = found(&world.a, "ann@example.com");
    both.sort();
    let mut want = vec![ada.clone(), ann.clone()];
    want.sort();
    assert_eq!(both, want);
    // The data the form's email context carries: by key, with each sharer.
    let methods = view(&world.a, &ada).methods;
    let shared = r(&world.a, |c| Ok(also_used_by(c, &ada, &methods)?));
    assert_eq!(shared[&ada_key].contacts[0].id, ann);
}

#[test]
fn an_archived_sharer_is_named_and_marked_and_find_includes_archived() {
    let world = world();
    let ada = add(&world.a, person("Ada", "Lovelace"));
    let ann = add(&world.a, person("Ann", "Smith"));
    set_emails(&world.a, &ada, &["a@x.org"]);
    set_emails(&world.a, &ann, &["a@x.org"]);
    w(&world.a, |ctx| set_archived(ctx, &ann, 0, true)).unwrap();
    assert_eq!(
        sharer_warnings(&world.a, &ada)[0].message,
        "Also used by Ann Smith (archived)"
    );
    assert_eq!(found(&world.a, "a@x.org").len(), 2);
    // The list hides an archived contact unless asked.
    assert_eq!(find(&world.a, "a@x.org"), ["Ada Lovelace"]);
}

#[test]
fn two_contacts_with_one_name_are_two_sharers() {
    let world = world();
    let me = add(&world.a, person("Me", "Myself"));
    let one = add(&world.a, person("Ann", "Smith"));
    let two = add(&world.a, person("Ann", "Smith"));
    for id in [&me, &one, &two] {
        set_emails(&world.a, id, &["family@x.org"]);
    }
    assert_eq!(
        sharer_warnings(&world.a, &me)[0].message,
        "Also used by Ann Smith, Ann Smith"
    );
}

#[test]
fn find_by_email_returns_the_oldest_fifty_and_flags_the_rest() {
    let world = world();
    let mut ids = Vec::new();
    for i in 0..EMAIL_LOOKUP_LIMIT + 2 {
        let id = add(&world.a, person("Ann", &format!("Smith{i}")));
        set_emails(&world.a, &id, &["shared@x.org"]);
        ids.push(id);
    }
    let got = r(&world.a, |c| Ok(find_by_email(c, "shared@x.org")?));
    assert!(got.truncated);
    assert_eq!(got.ids, ids[..EMAIL_LOOKUP_LIMIT]);
    // 51 others: more than are read, so the count is a lower bound.
    assert_eq!(
        sharer_warnings(&world.a, &ids[0])[0].message,
        "Also used by Ann Smith1, Ann Smith2, Ann Smith3 and at least 47 others"
    );
}

#[test]
fn the_same_address_in_another_organisation_is_invisible() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let bea = add(&world.b, person("Bea", "Brown"));
    set_emails(&world.a, &ann, &["Ann@Example.com"]);
    set_emails(&world.b, &bea, &["ann@example.com"]);
    assert_eq!(
        found(&world.a, "ann@example.com"),
        std::slice::from_ref(&ann)
    );
    assert_eq!(
        found(&world.b, "ann@example.com"),
        std::slice::from_ref(&bea)
    );
    assert!(sharer_warnings(&world.a, &ann).is_empty());
    assert_eq!(find(&world.b, "ann@example.com"), ["Bea Brown"]);
}

// ── byClientKey ────────────────────────────────────────────────────────────

#[test]
fn by_client_key_finds_the_contact_a_form_created_in_its_own_organisation_only() {
    let world = world();
    let key = contracts::new_id();
    let made = w(&world.a, |ctx| {
        create(
            ctx,
            CreateContact {
                id: None,
                details: Details {
                    client_key: Some(key.clone()),
                    ..person("Ann", "Smith")
                },
            },
            Source::Ui,
        )
    })
    .unwrap();
    assert_eq!(r(&world.a, |c| Ok(by_client_key(c, &key)?)), Some(made.id));
    assert_eq!(r(&world.b, |c| Ok(by_client_key(c, &key)?)), None);
    assert_eq!(r(&world.a, |c| Ok(by_client_key(c, "nope")?)), None);
}

// ── relationships ──────────────────────────────────────────────────────────

fn relate(db: &OrgDb, a: &str, b: &str, type_id: &str) -> Result<String, ContractError> {
    w(db, |ctx| {
        Ok(execute(
            ctx,
            &RELATIONSHIP,
            RelationshipPayload {
                contact_a: a.into(),
                contact_b: b.into(),
                type_id: type_id.into(),
                start_date: None,
                end_date: None,
                is_active: true,
                description: String::new(),
            },
            Exec::create(Source::Test),
        )?
        .id)
    })
}

fn reason(e: Result<impl std::fmt::Debug, ContractError>) -> String {
    match e {
        Err(ContractError::Rejected { reason, .. }) => reason,
        Err(ContractError::Invalid(p)) => format!("invalid {}", p[0].field),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_uk_types_are_seeded_once_under_one_group() {
    let world = world();
    assert_eq!(
        w(&world.a, seed_new_org).unwrap(),
        UK_RELATIONSHIP_TYPES.len()
    );
    assert_eq!(w(&world.a, seed_new_org).unwrap(), 0);
    let types = r(&world.a, |c| Ok(relationship_types(c)?));
    assert_eq!(types.len(), UK_RELATIONSHIP_TYPES.len());
    assert_eq!(types[0].payload.label_ab, "Employee of");
    assert!(r(&world.b, |c| Ok(relationship_types(c)?)).is_empty());
}

#[test]
fn a_relationship_checks_both_contacts_the_type_and_each_sides_kind() {
    let world = world();
    w(&world.a, seed_new_org).unwrap();
    let types = r(&world.a, |c| Ok(relationship_types(c)?));
    let employee = &types[0].id;
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    let trust = add(&world.a, org("Leeds Trust"));
    let rel = relate(&world.a, &ann, &trust, employee).unwrap();
    assert_eq!(
        reason(relate(&world.a, &ann, &ann, employee)),
        "invalid contactB"
    );
    assert_eq!(
        reason(relate(&world.a, &ann, &bob, employee)),
        "kind_mismatch"
    );
    assert_eq!(
        reason(relate(&world.a, &trust, &ann, employee)),
        "kind_mismatch"
    );
    assert_eq!(
        reason(relate(&world.a, &ann, &trust, "nope")),
        "unknown_type"
    );
    // Seen from either side, with that side's label.
    let mine = r(&world.a, |c| Ok(relationships_for(c, &ann)?));
    assert_eq!(
        (mine[0].id.as_str(), mine[0].label.as_deref()),
        (rel.as_str(), Some("Employee of"))
    );
    assert_eq!(mine[0].other_name, "Leeds Trust");
    let theirs = r(&world.a, |c| Ok(relationships_for(c, &trust)?));
    assert_eq!(theirs[0].label.as_deref(), Some("Employer of"));
    // Another organisation's contacts and types are unknown here.
    let bea = add(&world.b, person("Bea", "Brown"));
    assert_eq!(
        reason(relate(&world.a, &ann, &bea, employee)),
        "unknown_contact"
    );
    assert!(r(&world.b, |c| Ok(relationships_for(c, &ann)?)).is_empty());
}
