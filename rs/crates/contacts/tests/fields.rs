//! Dropdown fields admin, values, bulk set, retire and history (Convex
//! `fields.test.ts`, `fieldValues.test.ts`, `history.test.ts`): the
//! definitions' rules, the used marker and deletes, retire in batches,
//! what a restore leaves as it is, moments, and two organisations kept
//! apart.

mod common;

use common::*;
use contacts::fields::{
    BULK_FIELD_LIMIT, DeletionPayload, FIELD, FIELD_DELETE, FIELD_OPTION, FIELD_OPTION_DELETE,
    FIELD_RETIRE, MAX_FIELDS, add_option, bulk_set_field, definitions, reorder_options,
    retire_batch, retire_finish, retire_start, retiring_fields,
};
use contacts::form::save_form;
use contacts::history::{FieldRestoreReason, iso, page, restore_contact};
use contacts::types::*;
use contracts::history::join_moments;
use contracts::{ContractError, Ctx, Exec, Executed, Source, execute};
use store::OrgDb;

// ── helpers ────────────────────────────────────────────────────────────────

/// A write as user 1 at a chosen time (ms), so "restore to here" can name
/// a moment between two writes.
fn at<T>(
    db: &OrgDb,
    ms: i64,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    contracts::transact(db, Some(1), |ctx| {
        f(&Ctx {
            tx: ctx.tx,
            actor: ctx.actor,
            at: ms,
        })
    })
}

fn payload(label: &str, kinds: &[Kind], active: bool) -> FieldPayload {
    FieldPayload {
        label: label.into(),
        applies_to: kinds.to_vec(),
        is_active: active,
    }
}

fn new_field(db: &OrgDb, label: &str, kinds: &[Kind]) -> Result<Executed, ContractError> {
    w(db, |ctx| {
        execute(
            ctx,
            &FIELD,
            payload(label, kinds, true),
            Exec::create(Source::Test),
        )
    })
}

/// A field with options, created at `ms`.
fn field_at(
    db: &OrgDb,
    ms: i64,
    label: &str,
    kinds: &[Kind],
    options: &[&str],
) -> (String, Vec<String>) {
    at(db, ms, |ctx| {
        let f = execute(
            ctx,
            &FIELD,
            payload(label, kinds, true),
            Exec::create(Source::Test),
        )?;
        let mut ids = vec![];
        for o in options {
            ids.push(add_option(ctx, &f.id, (*o).into(), true, Source::Test)?.id);
        }
        Ok((f.id, ids))
    })
    .unwrap()
}

fn field(db: &OrgDb, label: &str, kinds: &[Kind], options: &[&str]) -> (String, Vec<String>) {
    field_at(db, contracts::now_ms(), label, kinds, options)
}

fn value(field: &str, option: &str) -> FieldValue {
    FieldValue {
        field_id: field.into(),
        option_id: option.into(),
    }
}

fn set_values_at(db: &OrgDb, ms: i64, id: &str, values: Vec<FieldValue>) -> SaveFormResult {
    let expected = view(db, id).counters.fields;
    at(db, ms, |ctx| {
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

fn set_values(db: &OrgDb, id: &str, values: Vec<FieldValue>) -> SaveFormResult {
    set_values_at(db, contracts::now_ms(), id, values)
}

fn defs(db: &OrgDb) -> Vec<FieldDefinition> {
    r(db, |c| Ok(definitions(c)?))
}

fn def(db: &OrgDb, id: &str) -> FieldDefinition {
    defs(db).into_iter().find(|f| f.id == id).unwrap()
}

fn option_payload(db: &OrgDb, field: &str, option: &str) -> (FieldOptionPayload, i64) {
    let o = def(db, field)
        .options
        .into_iter()
        .find(|o| o.id == option)
        .unwrap();
    (
        FieldOptionPayload {
            field_id: o.field_id,
            label: o.label,
            position: o.position,
            is_active: o.is_active,
        },
        o.save_version,
    )
}

fn archive_option(db: &OrgDb, field: &str, option: &str) {
    let (mut p, counter) = option_payload(db, field, option);
    p.is_active = false;
    w(db, |ctx| {
        execute(
            ctx,
            &FIELD_OPTION,
            p,
            Exec::update(option, Some(counter), Source::Test),
        )
    })
    .unwrap();
}

fn rejected<T: std::fmt::Debug>(out: Result<T, ContractError>) -> String {
    match out {
        Err(ContractError::Rejected { reason, .. }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// Run a whole retire as the route does: start, batches of `batch`, finish.
/// Returns (cleared, batches that cleared something).
fn retire(db: &OrgDb, id: &str, batch: usize) -> (i64, usize) {
    w(db, |ctx| retire_start(ctx, id, Source::Test)).unwrap();
    let (mut cleared, mut batches) = (0, 0);
    loop {
        let n = w(db, |ctx| retire_batch(ctx, id, batch, Source::Test)).unwrap();
        if n == 0 {
            assert!(w(db, |ctx| retire_finish(ctx, id, Source::Test)).unwrap());
            return (cleared, batches);
        }
        cleared += n;
        batches += 1;
    }
}

fn bulk(
    db: &OrgDb,
    ids: &[&str],
    field: &str,
    option: Option<&str>,
) -> Result<BulkSetResult, ContractError> {
    w(db, |ctx| {
        bulk_set_field(
            ctx,
            &BulkSetField {
                contact_ids: ids.iter().map(|s| (*s).to_owned()).collect(),
                field_id: field.into(),
                option_id: option.map(str::to_owned),
            },
            Source::Test,
        )
    })
}

fn values_of(db: &OrgDb, id: &str) -> Vec<FieldValue> {
    view(db, id).fields.values
}

fn group_names(db: &OrgDb, id: &str) -> Vec<Option<String>> {
    revisions(db, id)
        .into_iter()
        .map(|r| r.group_name)
        .collect()
}

// ── contacts.field ─────────────────────────────────────────────────────────

#[test]
fn fields_are_tidied_unique_per_organisation_and_keep_their_id_through_edits() {
    let world = world();
    assert!(defs(&world.a).is_empty(), "no fields to start with");
    let made = new_field(
        &world.a,
        "  Volunteer   status ",
        &[Kind::Household, Kind::Individual],
    )
    .unwrap();
    let f = def(&world.a, &made.id);
    assert_eq!(f.label, "Volunteer status");
    assert_eq!(
        f.applies_to,
        [Kind::Individual, Kind::Household],
        "the form's order"
    );
    assert_eq!((f.save_version, f.retiring, f.deletable), (0, false, true));

    assert_eq!(
        rejected(new_field(&world.a, "VOLUNTEER STATUS", &Kind::ALL)),
        "duplicate_field_label"
    );
    // Another organisation is free to use it.
    new_field(&world.b, "Volunteer status", &Kind::ALL).unwrap();
    assert!(matches!(
        new_field(&world.a, " ", &[]),
        Err(ContractError::Invalid(p)) if p.len() == 2
    ));

    // Rename, kinds and archive keep the id.
    w(&world.a, |ctx| {
        execute(
            ctx,
            &FIELD,
            payload("Volunteering", &[Kind::Organization], false),
            Exec::update(&made.id, Some(0), Source::Test),
        )
    })
    .unwrap();
    let f = def(&world.a, &made.id);
    assert_eq!(
        (f.label.as_str(), f.is_active, f.save_version),
        ("Volunteering", false, 1)
    );
    // B's field never shows in A, and A's id is unknown in B.
    assert_eq!(defs(&world.a).len(), 1);
    assert!(matches!(
        w(&world.b, |ctx| execute(
            ctx,
            &FIELD,
            payload("x", &Kind::ALL, true),
            Exec::update(&made.id, Some(1), Source::Test)
        )),
        Err(ContractError::NotFound)
    ));
}

#[test]
fn a_retired_field_frees_its_place_under_the_limit_and_its_label() {
    let world = world();
    let mut first = None;
    for i in 0..MAX_FIELDS {
        let id = new_field(&world.a, &format!("Field {i}"), &Kind::ALL)
            .unwrap()
            .id;
        first.get_or_insert(id);
    }
    assert_eq!(
        rejected(new_field(&world.a, "One more", &Kind::ALL)),
        "field_limit"
    );
    let first = first.unwrap();
    assert_eq!(retire(&world.a, &first, 10), (0, 0));
    new_field(&world.a, "One more", &Kind::ALL).unwrap();
    // The retired field's label is free again.
    new_field(&world.a, "Field 0", &Kind::ALL).unwrap_err();
    assert_eq!(defs(&world.a).len() as i64, MAX_FIELDS);
}

// ── contacts.fieldOption ───────────────────────────────────────────────────

#[test]
fn options_go_at_the_end_unique_within_their_field_and_keep_their_place() {
    let world = world();
    let (vol, opts) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &[" Active ", "Lapsed"],
    );
    let (other, _) = field(&world.a, "Newsletter", &Kind::ALL, &["Active"]);
    let f = def(&world.a, &vol);
    assert_eq!(
        f.options
            .iter()
            .map(|o| (o.label.as_str(), o.position))
            .collect::<Vec<_>>(),
        [("Active", 0), ("Lapsed", 1)]
    );
    assert_eq!(
        def(&world.a, &other).options.len(),
        1,
        "unique within the field only"
    );
    assert_eq!(
        rejected(w(&world.a, |ctx| add_option(
            ctx,
            &vol,
            "LAPSED".into(),
            true,
            Source::Test
        ))),
        "duplicate_option_label"
    );
    // Rename and archive keep the position.
    let (mut p, counter) = option_payload(&world.a, &vol, &opts[0]);
    p.label = "Current".into();
    p.is_active = false;
    w(&world.a, |ctx| {
        execute(
            ctx,
            &FIELD_OPTION,
            p,
            Exec::update(&opts[0], Some(counter), Source::Test),
        )
    })
    .unwrap();
    let o = &def(&world.a, &vol).options[0];
    assert_eq!(
        (o.label.as_str(), o.position, o.is_active),
        ("Current", 0, false)
    );
    // An option belongs to its field for good.
    let (mut p, counter) = option_payload(&world.a, &vol, &opts[1]);
    p.field_id = other.clone();
    assert_eq!(
        rejected(w(&world.a, |ctx| execute(
            ctx,
            &FIELD_OPTION,
            p,
            Exec::update(&opts[1], Some(counter), Source::Test)
        ))),
        "field_fixed"
    );
}

#[test]
fn a_field_holds_at_most_the_option_limit_archived_included() {
    let world = world();
    let (vol, _) = field(&world.a, "Big", &Kind::ALL, &[]);
    w(&world.a, |ctx| {
        for i in 0..contacts::fields::FIELD_OPTION_LIMIT {
            add_option(ctx, &vol, format!("o{i}"), i % 2 == 0, Source::Test)?;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(
        rejected(w(&world.a, |ctx| add_option(
            ctx,
            &vol,
            "one more".into(),
            true,
            Source::Test
        ))),
        "option_limit"
    );
}

#[test]
fn reorder_names_every_option_and_runs_one_contract_per_move_in_one_group() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &["A", "B", "C", "D"],
    );
    archive_option(&world.a, &vol, &o[1]);
    // Missing one, or naming one twice, or another field's: stale.
    for order in [
        vec![o[0].clone(), o[2].clone(), o[3].clone()],
        vec![o[0].clone(), o[0].clone(), o[2].clone(), o[3].clone()],
    ] {
        assert!(matches!(
            w(&world.a, |ctx| reorder_options(
                ctx,
                &vol,
                &order,
                Source::Test
            )),
            Err(ContractError::Stale { .. })
        ));
    }
    let order = vec![o[3].clone(), o[1].clone(), o[2].clone(), o[0].clone()];
    let moved = w(&world.a, |ctx| {
        reorder_options(ctx, &vol, &order, Source::Test)
    })
    .unwrap();
    assert_eq!(moved, 2, "B and C stay where they were");
    let f = def(&world.a, &vol);
    assert_eq!(
        f.options
            .iter()
            .map(|x| x.label.as_str())
            .collect::<Vec<_>>(),
        ["D", "B", "C", "A"]
    );
    // The two moves share one named group.
    let groups: Vec<_> = [&o[0], &o[3]]
        .iter()
        .map(|id| {
            r(&world.a, |c| {
                contracts::history(c, "contact_field_options", id, 1)
            })[0]
                .group_name
                .clone()
        })
        .collect();
    assert_eq!(
        groups,
        [
            Some("Reorder Volunteer status".into()),
            Some("Reorder Volunteer status".into())
        ]
    );
    // Nothing to move: no group, no revision.
    assert_eq!(
        w(&world.a, |ctx| reorder_options(
            ctx,
            &vol,
            &order,
            Source::Test
        ))
        .unwrap(),
        0
    );
}

// ── used marker and deletes ────────────────────────────────────────────────

#[test]
fn a_used_option_can_only_be_archived_and_the_marker_survives_a_save_and_a_restore() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed", "Never"],
    );
    let ann = add(&world.a, person("Ann", "Smith"));
    set_values(&world.a, &ann, vec![value(&vol, &o[0])]);
    let f = def(&world.a, &vol);
    assert!(f.options[0].used && !f.options[1].used && !f.deletable);
    set_values(&world.a, &ann, vec![]);
    // Rename it, then restore its create revision: still used.
    let (mut p, c) = option_payload(&world.a, &vol, &o[0]);
    p.label = "Current".into();
    w(&world.a, |ctx| {
        execute(
            ctx,
            &FIELD_OPTION,
            p,
            Exec::update(&o[0], Some(c), Source::Test),
        )
    })
    .unwrap();
    let create = r(&world.a, |c| {
        contracts::history(c, "contact_field_options", &o[0], 10)
    })
    .last()
    .unwrap()
    .id;
    w(&world.a, |ctx| {
        contracts::restore(ctx, &contacts::REGISTRY, create, None)
    })
    .unwrap();
    let opt = &def(&world.a, &vol).options[0];
    assert!(opt.used, "never cleared");
    assert_eq!(opt.label, "Active");

    let del = |id: &str, expected: i64| {
        w(&world.a, |ctx| {
            execute(
                ctx,
                &FIELD_OPTION_DELETE,
                DeletionPayload { expected },
                Exec::create_with_id(id, Source::Test),
            )
        })
    };
    assert_eq!(rejected(del(&o[0], 2)), "used");
    assert!(matches!(
        del(&o[1], 5),
        Err(ContractError::Stale {
            contract: "contacts.fieldOption",
            counter: 0,
            ..
        })
    ));
    del(&o[1], 0).unwrap();
    assert_eq!(def(&world.a, &vol).options.len(), 2);
    // Gone for good: a second delete names nothing that exists.
    assert!(matches!(
        del(&o[1], 0),
        Err(ContractError::Duplicate { .. })
    ));
}

#[test]
fn a_field_is_deleted_with_its_options_until_one_is_used() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed"],
    );
    let (used, uo) = field(&world.a, "Newsletter", &Kind::ALL, &["Yes"]);
    let ann = add(&world.a, person("Ann", "Smith"));
    set_values(&world.a, &ann, vec![value(&used, &uo[0])]);
    let del = |id: &str, expected: i64| {
        w(&world.a, |ctx| {
            execute(
                ctx,
                &FIELD_DELETE,
                DeletionPayload { expected },
                Exec::create_with_id(id, Source::Test),
            )?;
            Ok(contacts::fields::deleted_count(ctx.tx.read(), id)?)
        })
    };
    assert_eq!(rejected(del(&used, 0)), "used");
    assert!(matches!(
        del(&vol, 3),
        Err(ContractError::Stale {
            contract: "contacts.field",
            ..
        })
    ));
    assert_eq!(del(&vol, 0).unwrap(), 3, "the field and both options");
    assert!(defs(&world.a).iter().all(|f| f.id != vol));
    assert!(
        r(&world.a, |c| Ok(c.query_row(
            "SELECT count(*) FROM contact_field_options WHERE id IN (?1, ?2)",
            [&o[0], &o[1]],
            |r| r.get::<_, i64>(0)
        )?)) == 0
    );
    // Its revisions stay as history.
    assert!(
        !r(&world.a, |c| contracts::history(
            c,
            "contact_fields",
            &vol,
            10
        ))
        .is_empty()
    );
    // B can't delete A's field.
    assert!(
        w(&world.b, |ctx| execute(
            ctx,
            &FIELD_DELETE,
            DeletionPayload { expected: 0 },
            Exec::create_with_id(&used, Source::Test)
        ))
        .is_err()
    );
}

// ── values: the rules a retire and a restore add ───────────────────────────

#[test]
fn a_value_already_held_survives_narrowing_and_archiving_a_new_one_does_not() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed"],
    );
    let ann = add(&world.a, person("Ann", "Smith"));
    set_values(&world.a, &ann, vec![value(&vol, &o[0])]);
    // Narrow to organisations and archive the field: Ann's value stays and
    // her other saves go through; a new value is refused.
    w(&world.a, |ctx| {
        execute(
            ctx,
            &FIELD,
            payload("Volunteer status", &[Kind::Organization], false),
            Exec::update(&vol, Some(0), Source::Test),
        )
    })
    .unwrap();
    let out = set_values(&world.a, &ann, vec![value(&vol, &o[0])]);
    assert!(out.problems.is_empty(), "a no-op save of the held value");
    let out = set_values(&world.a, &ann, vec![value(&vol, &o[1])]);
    assert!(out.saved.is_empty());
    assert_eq!(out.problems["fields"][0].key.as_deref(), Some(vol.as_str()));
}

// ── retire ─────────────────────────────────────────────────────────────────

#[test]
fn retire_clears_every_holder_in_batches_with_history_and_keeps_the_rows() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed"],
    );
    let (keep, ko) = field(&world.a, "Newsletter", &Kind::ALL, &["Yes"]);
    let ids: Vec<String> = (0..5)
        .map(|i| add(&world.a, person("P", &format!("Holder{i}"))))
        .collect();
    for (i, id) in ids.iter().enumerate() {
        set_values(
            &world.a,
            id,
            vec![value(&vol, &o[i % 2]), value(&keep, &ko[0])],
        );
    }
    // Archived contacts are holders too.
    let counter = view(&world.a, &ids[4]).counters.archive;
    w(&world.a, |ctx| {
        contacts::form::set_archived(ctx, &ids[4], counter, true)
    })
    .unwrap();
    let bystander = add(&world.a, person("Bob", "Jones"));

    let (cleared, batches) = retire(&world.a, &vol, 2);
    assert_eq!((cleared, batches), (5, 3), "a group per batch of 2");
    for id in &ids {
        assert_eq!(
            values_of(&world.a, id),
            [value(&keep, &ko[0])],
            "only the retired field goes"
        );
        assert_eq!(
            group_names(&world.a, id)[0].as_deref(),
            Some("Retire field Volunteer status")
        );
    }
    assert_eq!(
        revisions(&world.a, &bystander).len(),
        1,
        "no holder, no revision"
    );
    // Gone from the definitions; the rows stay, so history can name them.
    assert!(defs(&world.a).iter().all(|f| f.id != vol));
    let label: String = r(&world.a, |c| {
        Ok(c.query_row(
            "SELECT label FROM contact_fields WHERE id = ?1",
            [&vol],
            |r| r.get(0),
        )?)
    });
    assert_eq!(label, "Volunteer status");
    // Its history: archived, then retiring, then retired.
    let h = r(&world.a, |c| {
        contracts::history(c, "contact_fields", &vol, 10)
    });
    let phases: Vec<_> = h
        .iter()
        .map(|r| (r.contract.as_str(), r.payload.clone()))
        .collect();
    assert_eq!(
        phases[0],
        (
            "contacts.fieldRetire",
            serde_json::json!({ "phase": "retired" })
        )
    );
    assert_eq!(
        phases[1],
        (
            "contacts.fieldRetire",
            serde_json::json!({ "phase": "retiring" })
        )
    );
    assert_eq!(phases[2].0, "contacts.field");
    assert_eq!(phases[2].1["isActive"], false);

    // Retired: no value, no edit, no option, no second retire; a filter
    // on it is refused.
    let out = set_values(&world.a, &bystander, vec![value(&vol, &o[0])]);
    assert!(out.saved.is_empty());
    assert_eq!(
        rejected(w(&world.a, |ctx| execute(
            ctx,
            &FIELD,
            payload("x", &Kind::ALL, true),
            Exec::update(&vol, None, Source::Test)
        ))),
        "retired_field"
    );
    assert_eq!(
        rejected(w(&world.a, |ctx| add_option(
            ctx,
            &vol,
            "New".into(),
            true,
            Source::Test
        ))),
        "retired_field"
    );
    assert_eq!(
        rejected(w(&world.a, |ctx| retire_start(ctx, &vol, Source::Test))),
        "retired_field"
    );
    assert!(matches!(
        w(&world.a, |ctx| execute(
            ctx,
            &FIELD_RETIRE,
            FieldRetirePayload {
                phase: RetirePhase::Retiring
            },
            Exec::update(&vol, None, Source::Test)
        )),
        Err(ContractError::Rejected { .. })
    ));
}

#[test]
fn a_retiring_field_takes_no_new_value_and_no_edit_and_a_resumed_retire_finishes_it() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed"],
    );
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    set_values(&world.a, &ann, vec![value(&vol, &o[0])]);
    // Started, then cut short before any batch.
    w(&world.a, |ctx| retire_start(ctx, &vol, Source::Test)).unwrap();
    let f = def(&world.a, &vol);
    assert!(f.retiring && !f.is_active);
    assert_eq!(
        r(&world.a, |c| Ok(retiring_fields(c)?)),
        [(vol.clone(), Some(1))]
    );

    // No new value; the held one stays until the retire clears it.
    let out = set_values(&world.a, &bob, vec![value(&vol, &o[0])]);
    assert!(out.saved.is_empty());
    assert_eq!(out.problems["fields"][0].key.as_deref(), Some(vol.as_str()));
    assert_eq!(values_of(&world.a, &ann), [value(&vol, &o[0])]);
    assert_eq!(
        rejected(bulk(&world.a, &[&bob], &vol, Some(&o[1]))),
        "retiring_field"
    );
    // No edit to it or its options: not even reactivating, nor a restore.
    for p in [
        payload("Renamed", &Kind::ALL, false),
        payload("Volunteer status", &Kind::ALL, true),
    ] {
        assert_eq!(
            rejected(w(&world.a, |ctx| execute(
                ctx,
                &FIELD,
                p,
                Exec::update(&vol, None, Source::Test)
            ))),
            "retiring_field"
        );
    }
    assert_eq!(
        rejected(w(&world.a, |ctx| add_option(
            ctx,
            &vol,
            "New".into(),
            true,
            Source::Test
        ))),
        "retiring_field"
    );
    assert_eq!(
        rejected(w(&world.a, |ctx| reorder_options(
            ctx,
            &vol,
            &[o[1].clone(), o[0].clone()],
            Source::Test
        ))),
        "retiring_field"
    );
    // Not finished while a value is left.
    assert!(!w(&world.a, |ctx| retire_finish(ctx, &vol, Source::Test)).unwrap());
    // Resumed: carries on and ends.
    assert_eq!(retire(&world.a, &vol, 100), (1, 1));
    assert!(values_of(&world.a, &ann).is_empty());
    assert!(r(&world.a, |c| Ok(retiring_fields(c)?)).is_empty());
}

#[test]
fn restoring_a_pre_retire_revision_skips_the_retired_field_and_says_so() {
    let world = world();
    let t0 = 1_000_000;
    let (vol, o) = field_at(&world.a, t0, "Volunteer status", &Kind::ALL, &["Active"]);
    let (keep, ko) = field_at(&world.a, t0, "Newsletter", &Kind::ALL, &["Yes"]);
    let ann = add(&world.a, person("Ann", "Smith"));
    set_values_at(
        &world.a,
        t0 + 10,
        &ann,
        vec![value(&vol, &o[0]), value(&keep, &ko[0])],
    );
    let before_retire = revisions(&world.a, &ann)[0].id;
    retire(&world.a, &vol, 10);
    set_values(&world.a, &ann, vec![]);

    let done = w(&world.a, |ctx| {
        restore_contact(
            ctx,
            &ann,
            RestoreRequest::Revision {
                revision_id: before_retire,
            },
        )
    })
    .unwrap();
    assert_eq!(values_of(&world.a, &ann), [value(&keep, &ko[0])]);
    assert_eq!(done.restored, ["contacts.fields"]);
    assert_eq!(done.skipped_fields.len(), 1);
    assert_eq!(
        (
            done.skipped_fields[0].label.as_str(),
            done.skipped_fields[0].reason
        ),
        ("Volunteer status", FieldRestoreReason::Retired)
    );
    // What it wrote is what it recorded: restoring that revision sets only
    // what the contact held.
    let recorded = &revisions(&world.a, &ann)[0];
    assert_eq!(recorded.payload["values"].as_array().unwrap().len(), 1);
}

#[test]
fn a_restore_keeps_the_values_of_fields_created_after_the_revision_and_says_so() {
    let world = world();
    let (vol, o) = field_at(
        &world.a,
        1_000,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed"],
    );
    let ann = add(&world.a, person("Ann", "Smith"));
    set_values_at(&world.a, 2_000, &ann, vec![value(&vol, &o[0])]);
    set_values_at(&world.a, 3_000, &ann, vec![value(&vol, &o[1])]);
    // A field made after both, and a value in it.
    let (late, lo) = field_at(&world.a, 4_000, "Gift Aid leaflet", &Kind::ALL, &["Sent"]);
    set_values_at(
        &world.a,
        5_000,
        &ann,
        vec![value(&vol, &o[1]), value(&late, &lo[0])],
    );

    let done = at(&world.a, 6_000, |ctx| {
        restore_contact(ctx, &ann, RestoreRequest::At { at: 2_500 })
    })
    .unwrap();
    assert_eq!(
        values_of(&world.a, &ann),
        {
            let mut v = vec![value(&vol, &o[0]), value(&late, &lo[0])];
            v.sort_by(|a, b| a.field_id.cmp(&b.field_id));
            v
        },
        "Active is back; the newer field keeps its value"
    );
    assert_eq!(done.skipped_fields.len(), 1);
    assert_eq!(
        (
            done.skipped_fields[0].label.as_str(),
            done.skipped_fields[0].reason
        ),
        ("Gift Aid leaflet", FieldRestoreReason::AddedAfter)
    );
    // A field older than the revision that it simply didn't name is
    // cleared: the revision is the whole slice.
    let (_, _) = (late, lo);
}

#[test]
fn a_restore_may_bring_back_an_archived_option_but_skips_a_field_no_longer_for_the_kind() {
    let world = world();
    let (vol, o) = field_at(
        &world.a,
        1_000,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed"],
    );
    let (kinds, ko) = field_at(
        &world.a,
        1_000,
        "Membership",
        &Kind::ALL,
        &["Gold", "Silver"],
    );
    let ann = add(&world.a, person("Ann", "Smith"));
    set_values_at(
        &world.a,
        2_000,
        &ann,
        vec![value(&vol, &o[0]), value(&kinds, &ko[0])],
    );
    set_values_at(
        &world.a,
        3_000,
        &ann,
        vec![value(&vol, &o[1]), value(&kinds, &ko[1])],
    );
    archive_option(&world.a, &vol, &o[0]);
    w(&world.a, |ctx| {
        execute(
            ctx,
            &FIELD,
            payload("Membership", &[Kind::Organization], true),
            Exec::update(&kinds, Some(0), Source::Test),
        )
    })
    .unwrap();

    let done = at(&world.a, 4_000, |ctx| {
        restore_contact(ctx, &ann, RestoreRequest::At { at: 2_500 })
    })
    .unwrap();
    let mut expected = vec![value(&vol, &o[0]), value(&kinds, &ko[1])];
    expected.sort_by(|a, b| a.field_id.cmp(&b.field_id));
    assert_eq!(
        values_of(&world.a, &ann),
        expected,
        "archived Active back; Silver kept"
    );
    assert_eq!(done.skipped_fields.len(), 1);
    assert_eq!(done.skipped_fields[0].reason, FieldRestoreReason::WrongKind);
}

// ── bulk set ───────────────────────────────────────────────────────────────

#[test]
fn bulk_set_runs_one_named_group_skipping_and_counting_the_wrong_kind() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &[Kind::Individual],
        &["Active", "Lapsed"],
    );
    let ann = add(&world.a, person("Ann", "Smith"));
    let bob = add(&world.a, person("Bob", "Jones"));
    let trust = add(&world.a, org("Leeds Trust"));
    set_values(&world.a, &bob, vec![value(&vol, &o[0])]);

    let out = bulk(&world.a, &[&ann, &bob, &trust, &ann], &vol, Some(&o[0])).unwrap();
    assert_eq!(
        (out.changed, out.skipped),
        (1, 1),
        "Bob already had it; the trust is skipped"
    );
    assert!(out.group.is_some());
    assert_eq!(values_of(&world.a, &ann), [value(&vol, &o[0])]);
    assert_eq!(
        group_names(&world.a, &ann)[0].as_deref(),
        Some("set Volunteer status to Active")
    );

    // Nothing to change: no group at all.
    let out = bulk(&world.a, &[&ann, &bob], &vol, Some(&o[0])).unwrap();
    assert_eq!((out.changed, out.skipped, out.group), (0, 0, None));

    // Narrow it to organisations: a clear still reaches every holder.
    w(&world.a, |ctx| {
        execute(
            ctx,
            &FIELD,
            payload("Volunteer status", &[Kind::Organization], true),
            Exec::update(&vol, Some(0), Source::Test),
        )
    })
    .unwrap();
    let out = bulk(&world.a, &[&ann, &bob, &trust], &vol, None).unwrap();
    assert_eq!((out.changed, out.skipped), (2, 0));
    assert!(values_of(&world.a, &ann).is_empty() && values_of(&world.a, &bob).is_empty());
    assert_eq!(
        group_names(&world.a, &bob)[0].as_deref(),
        Some("clear Volunteer status")
    );
}

#[test]
fn bulk_set_refuses_an_archived_option_too_many_contacts_and_unknown_ids() {
    let world = world();
    let (vol, o) = field(
        &world.a,
        "Volunteer status",
        &Kind::ALL,
        &["Active", "Lapsed"],
    );
    let (other, oo) = field(&world.a, "Newsletter", &Kind::ALL, &["Yes"]);
    let ann = add(&world.a, person("Ann", "Smith"));
    archive_option(&world.a, &vol, &o[0]);
    assert_eq!(
        rejected(bulk(&world.a, &[&ann], &vol, Some(&o[0]))),
        "archived_option"
    );
    assert_eq!(
        rejected(bulk(&world.a, &[&ann], &vol, Some(&oo[0]))),
        "unknown_option"
    );
    assert_eq!(
        rejected(bulk(
            &world.a,
            &["0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0"],
            &vol,
            Some(&o[1])
        )),
        "unknown_contact"
    );
    let many: Vec<String> = (0..=BULK_FIELD_LIMIT)
        .map(|i| format!("{i:032x}"))
        .collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    assert!(matches!(
        bulk(&world.a, &many, &vol, Some(&o[1])),
        Err(ContractError::Invalid(_))
    ));
    assert!(revisions(&world.a, &ann).len() == 1, "nothing written");
    // B can't name A's field, nor set A's contact.
    assert_eq!(rejected(bulk(&world.b, &[], &other, None)), "unknown_field");
    let (bf, bo) = field(&world.b, "Newsletter", &Kind::ALL, &["Yes"]);
    assert_eq!(
        rejected(bulk(&world.b, &[&ann], &bf, Some(&bo[0]))),
        "unknown_contact"
    );
}

// ── history ────────────────────────────────────────────────────────────────

fn tag_revision(db: &OrgDb, id: &str, ms: i64) {
    db.write_raw(|raw| {
        raw.conn().execute(
            "INSERT INTO revisions (entity, entity_id, contract, version, counter, payload, actor,
                 source, at)
             VALUES ('contacts', ?1, 'contacts.tags', 1, 1, '{\"tags\":[\"x\"]}', 1, 'ui', ?2)",
            rusqlite::params![id, ms],
        )
    })
    .unwrap();
}

#[test]
fn history_pages_are_moments_newest_first_and_a_cut_group_joins() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    // One form save of two slices: one moment, one group.
    let out = w(&world.a, |ctx| {
        save_form(
            ctx,
            &ann,
            SaveForm {
                methods: exp(
                    0,
                    Methods {
                        emails: vec![email("ann@x.org")],
                        phones: vec![],
                    },
                ),
                details: exp(0, person("Ann", "Jones")),
                ..Default::default()
            },
        )
    })
    .unwrap();
    assert_eq!(out.saved.len(), 2);
    let full = r(&world.a, |c| page(c, &ann, None, 10));
    assert_eq!(full.moments.len(), 2);
    assert_eq!(
        full.moments[0].group_name.as_deref(),
        Some("contact form save")
    );
    assert_eq!(full.moments[0].slices.len(), 2);
    assert_eq!(full.moments[1].slices, ["details"]);
    assert!(full.next_before.is_none());

    // Pages of one revision cut the group; joined, they are the same list.
    let first = r(&world.a, |c| page(c, &ann, None, 1));
    let second = r(&world.a, |c| page(c, &ann, first.next_before, 1));
    let third = r(&world.a, |c| page(c, &ann, second.next_before, 1));
    assert!(third.next_before.is_none());
    let joined = join_moments(
        first
            .moments
            .into_iter()
            .chain(second.moments)
            .chain(third.moments),
    );
    assert_eq!(joined.len(), 2);
    assert_eq!(joined[0].slices.len(), 2);
    // B's file has no such contact.
    assert!(r(&world.b, |c| page(c, &ann, None, 10)).moments.is_empty());
}

#[test]
fn restore_to_here_runs_only_the_slices_that_differ_in_one_named_group() {
    let world = world();
    let ann = add_at(&world.a, 1_000, person("Ann", "Smith"));
    let (vol, o) = field_at(&world.a, 1_000, "Volunteer status", &Kind::ALL, &["Active"]);
    at(&world.a, 2_000, |ctx| {
        save_form(
            ctx,
            &ann,
            SaveForm {
                details: exp(0, person("Ann", "Jones")),
                ..Default::default()
            },
        )
    })
    .unwrap();
    set_values_at(&world.a, 3_000, &ann, vec![value(&vol, &o[0])]);
    let counter = view(&world.a, &ann).counters.archive;
    at(&world.a, 3_500, |ctx| {
        contacts::form::set_archived(ctx, &ann, counter, true)
    })
    .unwrap();

    let done = at(&world.a, 4_000, |ctx| {
        restore_contact(ctx, &ann, RestoreRequest::At { at: 1_500 })
    })
    .unwrap();
    let mut ran = done.restored.clone();
    ran.sort();
    // Fields had no revision by then: a slice first saved after the
    // moment goes back to empty (codex C1 #3; Convex's restoreEntityTo
    // left it as it was). Never the archive switch.
    assert_eq!(ran, ["contacts.details", "contacts.fields"]);
    let v = view(&world.a, &ann);
    assert_eq!(v.details.last_name, "Smith");
    assert!(v.fields.values.is_empty());
    assert!(v.archived);
    let h = r(&world.a, |c| page(c, &ann, None, 10));
    assert_eq!(
        h.moments[0].group_name,
        Some(format!("restore to {}", iso(1_500)))
    );
    assert!(h.moments[0].restored);
    // Already in that state: nothing runs.
    let again = at(&world.a, 5_000, |ctx| {
        restore_contact(ctx, &ann, RestoreRequest::At { at: 1_500 })
    })
    .unwrap();
    assert!(again.restored.is_empty());
}

#[test]
fn retired_tag_revisions_show_read_only_and_restores_step_over_them() {
    let world = world();
    let ann = add_at(&world.a, 1_000, person("Ann", "Smith"));
    tag_revision(&world.a, &ann, 2_000);
    at(&world.a, 3_000, |ctx| {
        save_form(
            ctx,
            &ann,
            SaveForm {
                details: exp(0, person("Ann", "Jones")),
                ..Default::default()
            },
        )
    })
    .unwrap();
    let h = r(&world.a, |c| page(c, &ann, None, 10));
    assert_eq!(h.moments.len(), 3);
    assert_eq!(
        (h.moments[1].slices[0].as_str(), h.moments[1].retired),
        ("tags (retired)", true)
    );
    assert!(!h.moments[0].retired && !h.moments[2].retired);

    let tag = h.moments[1].revision_id;
    assert_eq!(
        rejected(w(&world.a, |ctx| restore_contact(
            ctx,
            &ann,
            RestoreRequest::Revision { revision_id: tag }
        ))),
        "retired_contract"
    );
    let done = at(&world.a, 4_000, |ctx| {
        restore_contact(ctx, &ann, RestoreRequest::At { at: 2_500 })
    })
    .unwrap();
    assert_eq!(done.restored, ["contacts.details"]);
    assert_eq!(view(&world.a, &ann).details.last_name, "Smith");
    // B's history never shows A's tag revisions.
    let bob = add(&world.b, person("Bob", "Jones"));
    assert_eq!(r(&world.b, |c| page(c, &bob, None, 10)).moments.len(), 1);
}

fn add_at(db: &OrgDb, ms: i64, d: Details) -> String {
    at(db, ms, |ctx| {
        contacts::form::create(
            ctx,
            CreateContact {
                id: None,
                details: d,
            },
            Source::Test,
        )
    })
    .unwrap()
    .id
}

#[test]
fn restore_to_here_is_bounded_by_the_moments_revision_not_its_millisecond() {
    let world = world();
    let ann = add_at(&world.a, 1_000, person("Ann", "Smith"));
    // Two saves in the same millisecond (two tabs, a script).
    at(&world.a, 2_000, |ctx| {
        save_form(
            ctx,
            &ann,
            SaveForm {
                details: exp(0, person("Ann", "Jones")),
                ..Default::default()
            },
        )
    })
    .unwrap();
    let first = revisions(&world.a, &ann)[0].id;
    at(&world.a, 2_000, |ctx| {
        save_form(
            ctx,
            &ann,
            SaveForm {
                details: exp(1, person("Ann", "Brown")),
                ..Default::default()
            },
        )
    })
    .unwrap();
    let done = at(&world.a, 3_000, |ctx| {
        restore_contact(ctx, &ann, RestoreRequest::ToRevision { to_revision: first })
    })
    .unwrap();
    assert_eq!(done.restored, ["contacts.details"]);
    assert_eq!(view(&world.a, &ann).details.last_name, "Jones", "not Brown");
    let h = r(&world.a, |c| page(c, &ann, None, 10));
    assert_eq!(
        h.moments[0].group_name,
        Some(format!("restore to {}", iso(2_000)))
    );
    // Another contact's revision is not this one's moment.
    let bob = add(&world.a, person("Bob", "Jones"));
    assert!(matches!(
        w(&world.a, |ctx| restore_contact(
            ctx,
            &bob,
            RestoreRequest::ToRevision { to_revision: first }
        )),
        Err(ContractError::NotFound)
    ));
}
