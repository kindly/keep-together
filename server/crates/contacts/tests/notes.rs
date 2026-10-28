//! Contact notes (Convex `notes.test.ts`, `notes.gaps.test.ts`): two
//! contracts that never conflict, author and editor, ordering, the 200
//! cap, restore, and two organisations kept apart.

mod common;

use common::*;
use contacts::notes::{
    CreateNote, Flag, NOTE_MAX_BYTES, NoteView, SaveNote, archived_notes, create_note, note,
    notes_for_contact, restore_note, save_note, set_flag,
};
use contracts::ContractError;
use store::OrgDb;

fn new_note(db: &OrgDb, contact: &str, body: &str, pinned: bool) -> String {
    w(db, |ctx| {
        create_note(
            ctx,
            CreateNote {
                id: None,
                contact_id: contact.into(),
                body: body.into(),
                pinned: Some(pinned),
            },
        )
    })
    .unwrap()
    .id
}

fn get(db: &OrgDb, id: &str) -> NoteView {
    r(db, |c| Ok(note(c, id)?)).unwrap()
}

fn edit(db: &OrgDb, user: i64, id: &str, expected: i64, body: &str) -> Result<i64, ContractError> {
    as_user(db, user, |ctx| {
        Ok(save_note(
            ctx,
            id,
            SaveNote {
                expected,
                body: body.into(),
            },
        )?
        .counter)
    })
}

fn flag(db: &OrgDb, id: &str, f: Flag, value: bool) -> Result<i64, ContractError> {
    w(db, |ctx| Ok(set_flag(ctx, id, f, value, None)?.counter))
}

fn live(db: &OrgDb, contact: &str) -> Vec<String> {
    r(db, |c| Ok(notes_for_contact(c, contact)?))
        .notes
        .into_iter()
        .map(|n| n.body)
        .collect()
}

fn archived(db: &OrgDb, contact: &str) -> Vec<String> {
    r(db, |c| Ok(archived_notes(c, contact)?))
        .notes
        .into_iter()
        .map(|n| n.body)
        .collect()
}

fn note_revisions(db: &OrgDb, id: &str) -> Vec<contracts::Revision> {
    r(db, |c| contracts::history(c, "contact_notes", id, 50))
}

fn invalid(e: Result<impl std::fmt::Debug, ContractError>) -> bool {
    matches!(e, Err(ContractError::Invalid(_)))
}

fn reason(e: Result<impl std::fmt::Debug, ContractError>) -> String {
    match e {
        Err(ContractError::Rejected { reason, .. }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn create_and_edit_store_the_author_and_the_editor() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = as_user(&world.a, 7, |ctx| {
        create_note(
            ctx,
            CreateNote {
                id: None,
                contact_id: ann.clone(),
                body: " Met at the fair\n\nKeen ".into(),
                pinned: None,
            },
        )
    })
    .unwrap()
    .id;
    let v = get(&world.a, &n);
    // Never edited: editedAt is its creation, editedBy its author.
    assert_eq!(v.body, "Met at the fair\n\nKeen");
    assert_eq!((v.created_by, v.edited_by), (Some(7), Some(7)));
    assert_eq!(v.edited_at, v.created_at);
    assert_eq!((v.body_version, v.flags_version), (0, 0));
    edit(&world.a, 8, &n, 0, "Met at the summer fair").unwrap();
    let v = get(&world.a, &n);
    assert_eq!(
        (v.created_by, v.edited_by, v.body_version),
        (Some(7), Some(8), 1)
    );
    // A pin is not an edit.
    flag(&world.a, &n, Flag::Pinned, true).unwrap();
    let after = get(&world.a, &n);
    assert_eq!(
        (after.edited_by, after.edited_at),
        (v.edited_by, v.edited_at)
    );
}

#[test]
fn bodies_are_trimmed_never_blank_and_capped_in_utf8_bytes() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    for blank in ["", "  ", "\n\t"] {
        assert!(invalid(w(&world.a, |ctx| create_note(
            ctx,
            CreateNote {
                id: None,
                contact_id: ann.clone(),
                body: blank.into(),
                pinned: None
            }
        ))));
    }
    let n = new_note(&world.a, &ann, "x", false);
    assert!(invalid(edit(&world.a, 1, &n, 0, "  ")));
    assert!(invalid(edit(
        &world.a,
        1,
        &n,
        0,
        &"é".repeat(NOTE_MAX_BYTES / 2 + 1)
    )));
    assert!(edit(&world.a, 1, &n, 0, &"é".repeat(NOTE_MAX_BYTES / 2)).is_ok());
    // Invalid saves changed nothing.
    assert_eq!(note_revisions(&world.a, &n).len(), 2);
}

#[test]
fn a_stale_edit_conflicts_and_leaves_no_trace_two_notes_never_conflict() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let one = new_note(&world.a, &ann, "one", false);
    let two = new_note(&world.a, &ann, "two", false);
    edit(&world.a, 1, &one, 0, "one, edited").unwrap();
    match edit(&world.a, 1, &one, 0, "one, mine") {
        Err(ContractError::Stale {
            counter, current, ..
        }) => {
            assert_eq!(counter, 1);
            assert_eq!(current["body"], "one, edited");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(get(&world.a, &one).body, "one, edited");
    edit(&world.a, 1, &two, 0, "two, edited").unwrap();
}

#[test]
fn a_note_on_an_unknown_contact_is_refused() {
    let world = world();
    let bea = add(&world.b, person("Bea", "Brown"));
    // Another organisation's contact is unknown here.
    let e = w(&world.a, |ctx| {
        create_note(
            ctx,
            CreateNote {
                id: None,
                contact_id: bea.clone(),
                body: "hello".into(),
                pinned: Some(true),
            },
        )
    });
    assert_eq!(reason(e), "unknown_contact");
}

#[test]
fn pinned_first_then_newest_first_and_a_pin_never_reorders_a_section() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let first = new_note(&world.a, &ann, "first", false);
    new_note(&world.a, &ann, "second", false);
    new_note(&world.a, &ann, "third", true);
    let fourth = new_note(&world.a, &ann, "fourth", false);
    assert_eq!(live(&world.a, &ann), ["third", "fourth", "second", "first"]);
    // Pin order is creation order, not pin time.
    flag(&world.a, &fourth, Flag::Pinned, true).unwrap();
    flag(&world.a, &first, Flag::Pinned, true).unwrap();
    assert_eq!(live(&world.a, &ann), ["fourth", "third", "first", "second"]);
}

#[test]
fn notes_made_in_one_transaction_come_back_last_made_first() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    w(&world.a, |ctx| {
        for body in ["a", "b", "c"] {
            create_note(
                ctx,
                CreateNote {
                    id: None,
                    contact_id: ann.clone(),
                    body: body.into(),
                    pinned: None,
                },
            )?;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(live(&world.a, &ann), ["c", "b", "a"]);
}

#[test]
fn create_pinned_is_one_command_group_of_two_contracts() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = new_note(&world.a, &ann, "pinned", true);
    let revs = note_revisions(&world.a, &n);
    let names: Vec<_> = revs.iter().map(|r| r.contract.as_str()).collect();
    assert_eq!(names, ["contacts.noteFlags", "contacts.note"]);
    assert_eq!(revs[0].group, revs[1].group);
    assert_eq!(revs[0].group_name.as_deref(), Some("add pinned note"));
    assert!(get(&world.a, &n).pinned);
}

#[test]
fn archive_hides_and_restores_on_the_flags_counter_and_no_op_toggles_write_nothing() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = new_note(&world.a, &ann, "hello", false);
    assert_eq!(flag(&world.a, &n, Flag::Archived, true).unwrap(), 1);
    assert!(live(&world.a, &ann).is_empty());
    assert_eq!(archived(&world.a, &ann), ["hello"]);
    // No-op: the counter it has, no revision.
    assert_eq!(flag(&world.a, &n, Flag::Archived, true).unwrap(), 1);
    assert_eq!(note_revisions(&world.a, &n).len(), 2);
    assert_eq!(flag(&world.a, &n, Flag::Archived, false).unwrap(), 2);
    assert_eq!(live(&world.a, &ann), ["hello"]);
    assert_eq!(get(&world.a, &n).body_version, 0);
}

#[test]
fn a_pin_never_makes_a_body_edit_stale_and_both_survive() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = new_note(&world.a, &ann, "v0", false);
    // Pin, then a body save opened before the pin.
    flag(&world.a, &n, Flag::Pinned, true).unwrap();
    edit(&world.a, 1, &n, 0, "v1").unwrap();
    // Body save, then archive: the archived note keeps the new body.
    flag(&world.a, &n, Flag::Archived, true).unwrap();
    let v = get(&world.a, &n);
    assert_eq!((v.body.as_str(), v.pinned, v.archived), ("v1", true, true));
}

#[test]
fn an_archived_note_refuses_edits_and_pinning_until_restored() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = new_note(&world.a, &ann, "v0", false);
    flag(&world.a, &n, Flag::Archived, true).unwrap();
    assert_eq!(reason(edit(&world.a, 1, &n, 0, "v1")), "archived");
    assert_eq!(reason(flag(&world.a, &n, Flag::Pinned, true)), "archived");
    flag(&world.a, &n, Flag::Archived, false).unwrap();
    edit(&world.a, 1, &n, 0, "v1").unwrap();
    flag(&world.a, &n, Flag::Pinned, true).unwrap();
}

#[test]
fn restoring_a_body_revision_leaves_the_flags_and_makes_an_open_edit_stale() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = new_note(&world.a, &ann, "v0", false);
    edit(&world.a, 1, &n, 0, "v1").unwrap();
    flag(&world.a, &n, Flag::Pinned, true).unwrap();
    let create = note_revisions(&world.a, &n)
        .into_iter()
        .find(|r| r.contract == "contacts.note" && r.counter == 0)
        .unwrap();
    // The create revision brings back the body only.
    w(&world.a, |ctx| restore_note(ctx, &n, create.id)).unwrap();
    let v = get(&world.a, &n);
    assert_eq!((v.body.as_str(), v.pinned, v.body_version), ("v0", true, 2));
    assert!(matches!(
        edit(&world.a, 1, &n, 1, "v2"),
        Err(ContractError::Stale { .. })
    ));
    // Restoring the pin revision re-pins an unpinned note.
    let pin = note_revisions(&world.a, &n)
        .into_iter()
        .find(|r| r.contract == "contacts.noteFlags")
        .unwrap();
    flag(&world.a, &n, Flag::Pinned, false).unwrap();
    w(&world.a, |ctx| restore_note(ctx, &n, pin.id)).unwrap();
    assert!(get(&world.a, &n).pinned);
    // Onto an archived note, a body revision is refused.
    flag(&world.a, &n, Flag::Archived, true).unwrap();
    assert_eq!(
        reason(w(&world.a, |ctx| restore_note(ctx, &n, create.id))),
        "archived"
    );
    // Another note's revision is not this note's to restore.
    let other = new_note(&world.a, &ann, "other", false);
    assert!(matches!(
        w(&world.a, |ctx| restore_note(ctx, &other, create.id)),
        Err(ContractError::NotFound)
    ));
}

#[test]
fn notes_on_an_archived_contact_stay_listed_and_editable() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = new_note(&world.a, &ann, "kept", false);
    w(&world.a, |ctx| {
        contacts::form::set_archived(ctx, &ann, 0, true)
    })
    .unwrap();
    new_note(&world.a, &ann, "new", false);
    edit(&world.a, 1, &n, 0, "kept, edited").unwrap();
    flag(&world.a, &n, Flag::Pinned, true).unwrap();
    assert_eq!(live(&world.a, &ann), ["kept, edited", "new"]);
}

// ── the 200 cap ────────────────────────────────────────────────────────────

fn many(db: &OrgDb, contact: &str, n: usize, pinned: bool, from: usize) {
    w(db, |ctx| {
        for i in from..from + n {
            create_note(
                ctx,
                CreateNote {
                    id: None,
                    contact_id: contact.into(),
                    body: format!("{}{i}", if pinned { "p" } else { "u" }),
                    pinned: Some(pinned),
                },
            )?;
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn the_live_list_keeps_every_pinned_note_then_the_newest_rest_up_to_200() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    many(&world.a, &ann, 150, true, 0);
    many(&world.a, &ann, 100, false, 0);
    let page = r(&world.a, |c| Ok(notes_for_contact(c, &ann)?));
    assert!(page.truncated);
    assert_eq!(page.notes.len(), 200);
    assert_eq!(page.notes.iter().filter(|n| n.pinned).count(), 150);
    assert_eq!(page.notes[150].body, "u99");
    assert_eq!(page.notes[199].body, "u50");

    let bob = add(&world.a, person("Bob", "Jones"));
    many(&world.a, &bob, 210, true, 0);
    let page = r(&world.a, |c| Ok(notes_for_contact(c, &bob)?));
    assert!(page.truncated && page.notes.iter().all(|n| n.pinned));
}

#[test]
fn archived_notes_dont_count_against_the_live_cap_and_their_list_is_by_creation() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    many(&world.a, &ann, 200, false, 0);
    let gone = new_note(&world.a, &ann, "gone", true);
    flag(&world.a, &gone, Flag::Archived, true).unwrap();
    let page = r(&world.a, |c| Ok(notes_for_contact(c, &ann)?));
    assert!(!page.truncated);
    // The archived list mixes pinned and unpinned by creation time only.
    let a = new_note(&world.a, &ann, "a", false);
    let b = new_note(&world.a, &ann, "b", true);
    flag(&world.a, &b, Flag::Archived, true).unwrap();
    flag(&world.a, &a, Flag::Archived, true).unwrap();
    assert_eq!(archived(&world.a, &ann), ["b", "a", "gone"]);
}

// ── isolation ──────────────────────────────────────────────────────────────

#[test]
fn another_organisations_notes_cant_be_reached_or_changed() {
    let world = world();
    let ann = add(&world.a, person("Ann", "Smith"));
    let n = new_note(&world.a, &ann, "secret", false);
    assert!(r(&world.b, |c| Ok(note(c, &n)?)).is_none());
    assert!(
        r(&world.b, |c| Ok(notes_for_contact(c, &ann)?))
            .notes
            .is_empty()
    );
    for e in [
        edit(&world.b, 1, &n, 0, "mine"),
        flag(&world.b, &n, Flag::Pinned, true),
        flag(&world.b, &n, Flag::Archived, true),
    ] {
        assert!(matches!(e, Err(ContractError::NotFound)), "{e:?}");
    }
    let rev = note_revisions(&world.a, &n)[0].id;
    assert!(matches!(
        w(&world.b, |ctx| restore_note(ctx, &n, rev)),
        Err(ContractError::NotFound)
    ));
    assert_eq!(get(&world.a, &n).body, "secret");
}
