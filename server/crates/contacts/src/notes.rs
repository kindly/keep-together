//! Contact notes (Convex `contacts/notes.ts`): one `contact_notes` root per
//! note, so two people writing notes on one contact never conflict,
//! written only through two contracts that partition it:
//!
//!   contacts.note      → body (body_version)
//!   contacts.noteFlags → pinned, archived (flags_version)
//!
//! A pin never makes a body edit stale. `contact_id` is stamped at create
//! and owned by no slice. System-owned: `created_by` / `created_at`, and
//! `edited_by` / `edited_at`, which only body saves move. Remove = archive:
//! hidden from the live list, restorable.

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx,
    command_group, execute, restore,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::REGISTRY;

/// UTF-8 bytes. 200 notes (the panel's cap) at this size stay one cheap
/// read whatever the script.
pub const NOTE_MAX_BYTES: usize = 20_000;

/// The most notes one list answers.
pub const NOTES_LIMIT: usize = 200;

// ── wire types ─────────────────────────────────────────────────────────────

/// `contacts.note`. `contactId` is create-only (ignored on an edit), so any
/// revision restores onto the note wherever it lives now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoteBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contact_id: Option<String>,
    pub body: String,
}

/// `contacts.noteFlags`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NoteFlags {
    pub pinned: bool,
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoteView {
    pub id: String,
    pub contact_id: String,
    pub body: String,
    pub pinned: bool,
    pub archived: bool,
    /// Platform user ids; null = the system.
    #[ts(type = "number | null")]
    pub created_by: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub edited_by: Option<i64>,
    #[ts(type = "number")]
    pub edited_at: i64,
    #[ts(type = "number")]
    pub body_version: i64,
    #[ts(type = "number")]
    pub flags_version: i64,
}

/// `GET contacts/{id}/notes` (live: pinned first, then the rest, each
/// newest first) and `…/notes/archived` (newest first).
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct NotesPage {
    pub notes: Vec<NoteView>,
    /// There were more than NOTES_LIMIT.
    pub truncated: bool,
}

/// `POST notes`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateNote {
    /// A pre-generated id makes the create idempotent.
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    pub contact_id: String,
    pub body: String,
    #[serde(default)]
    #[ts(optional)]
    pub pinned: Option<bool>,
}

/// `POST notes/{id}/save`: stale only if the body changed since `expected`.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SaveNote {
    #[ts(type = "number")]
    pub expected: i64,
    pub body: String,
}

/// `POST notes/{id}/pin` and `…/archive`: toggles built from the note's
/// flags inside the transaction, so they carry no `expected`.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct SetFlag {
    pub value: bool,
}

// ── rules ──────────────────────────────────────────────────────────────────

/// Trimmed at the ends (inner line breaks kept), never empty, at most
/// NOTE_MAX_BYTES bytes of UTF-8.
pub fn prepare_note(mut p: NoteBody) -> Result<NoteBody, ContractError> {
    let t = p.body.trim();
    if t.len() != p.body.len() {
        p.body = t.to_owned();
    }
    if p.body.is_empty() {
        return Err(ContractError::invalid("body", "A note needs some text"));
    }
    if p.body.len() > NOTE_MAX_BYTES {
        return Err(ContractError::invalid(
            "body",
            format!(
                "A note can be at most {NOTE_MAX_BYTES} bytes (fewer characters if it uses accents, symbols or emoji)"
            ),
        ));
    }
    Ok(p)
}

// ── contracts ──────────────────────────────────────────────────────────────

pub struct ContactNote;
pub struct ContactNoteFlags;
pub static NOTE: ContactNote = ContactNote;
pub static NOTE_FLAGS: ContactNoteFlags = ContactNoteFlags;

/// `contacts.note` as stored. Only the body is its own; the rest is what
/// apply needs (serialised, a stale refusal's `current` is `{body}`).
#[derive(Clone, Debug, Serialize)]
pub struct NoteState {
    pub body: String,
    #[serde(skip)]
    contact_id: String,
    #[serde(skip)]
    archived: bool,
    #[serde(skip)]
    created_by: Option<i64>,
    #[serde(skip)]
    created_at: i64,
    #[serde(skip)]
    edited_by: Option<i64>,
    #[serde(skip)]
    edited_at: i64,
}

impl Contract for ContactNote {
    const NAME: &'static str = "contacts.note";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_notes";
    const COUNTER: &'static str = "body_version";
    type Payload = NoteBody;
    type State = NoteState;

    fn prepare(&self, payload: NoteBody) -> Result<NoteBody, ContractError> {
        prepare_note(payload)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<NoteState, ContractError> {
        Ok(tx.read().query_row(
            "SELECT body, contact_id, archived, created_by, created_at, edited_by, edited_at
             FROM contact_notes WHERE id = ?1",
            [id],
            |r| {
                Ok(NoteState {
                    body: r.get(0)?,
                    contact_id: r.get(1)?,
                    archived: r.get(2)?,
                    created_by: r.get(3)?,
                    created_at: r.get(4)?,
                    edited_by: r.get(5)?,
                    edited_at: r.get(6)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        current: Option<&NoteState>,
        p: &NoteBody,
        command: &Command,
    ) -> Result<NoteState, ContractError> {
        let Some(current) = current else {
            let Some(contact_id) = p.contact_id.clone() else {
                return Err(ContractError::invalid(
                    "contactId",
                    "A note needs a contact",
                ));
            };
            return Ok(NoteState {
                body: p.body.clone(),
                contact_id,
                archived: false,
                created_by: command.actor,
                created_at: command.at,
                edited_by: command.actor,
                edited_at: command.at,
            });
        };
        if current.archived {
            return Err(ContractError::rejected(
                "archived",
                "Restore the note before editing it",
            ));
        }
        Ok(NoteState {
            body: p.body.clone(),
            edited_by: command.actor,
            edited_at: command.at,
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&NoteState>,
        n: &NoteState,
    ) -> Result<(), ContractError> {
        if before.is_some() {
            tx.execute(
                "UPDATE contact_notes SET body = ?2, edited_by = ?3, edited_at = ?4 WHERE id = ?1",
                params![id, n.body, n.edited_by, n.edited_at],
            )?;
            return Ok(());
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM contacts WHERE id = ?1)",
            [&n.contact_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(ContractError::rejected(
                "unknown_contact",
                "Contact must exist",
            ));
        }
        tx.execute(
            "INSERT INTO contact_notes (id, contact_id, body, created_by, created_at, edited_by,
                 edited_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                n.contact_id,
                n.body,
                n.created_by,
                n.created_at,
                n.edited_by,
                n.edited_at
            ],
        )?;
        Ok(())
    }
}

impl Contract for ContactNoteFlags {
    const NAME: &'static str = "contacts.noteFlags";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contact_notes";
    const COUNTER: &'static str = "flags_version";
    type Payload = NoteFlags;
    type State = NoteFlags;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<NoteFlags, ContractError> {
        Ok(tx.read().query_row(
            "SELECT pinned, archived FROM contact_notes WHERE id = ?1",
            [id],
            |r| {
                Ok(NoteFlags {
                    pinned: r.get(0)?,
                    archived: r.get(1)?,
                })
            },
        )?)
    }

    /// Archive and unarchive are always allowed; nothing else changes on
    /// an archived note. Not an edit: body and editedBy/At stay.
    fn apply(
        &self,
        current: Option<&NoteFlags>,
        p: &NoteFlags,
        _: &Command,
    ) -> Result<NoteFlags, ContractError> {
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "contacts.noteFlags targets an existing note",
            ));
        };
        if current.archived && p.archived && current.pinned != p.pinned {
            return Err(ContractError::rejected(
                "archived",
                "Restore the note before pinning it",
            ));
        }
        Ok(*p)
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&NoteFlags>,
        n: &NoteFlags,
    ) -> Result<(), ContractError> {
        tx.execute(
            "UPDATE contact_notes SET pinned = ?2, archived = ?3 WHERE id = ?1",
            params![id, n.pinned, n.archived],
        )?;
        Ok(())
    }
}

// ── commands ───────────────────────────────────────────────────────────────

/// A note on `contact_id`; pinned as it is made (one command group of two
/// contracts) when asked.
pub fn create_note(ctx: &Ctx, req: CreateNote) -> Result<Executed, ContractError> {
    let pinned = req.pinned.unwrap_or(false);
    let group = if pinned {
        Some(command_group(ctx, "add pinned note")?)
    } else {
        None
    };
    let mut opts = match &req.id {
        Some(id) => Exec::create_with_id(id, Source::Ui),
        None => Exec::create(Source::Ui),
    };
    if let Some(g) = &group {
        opts = opts.in_group(g);
    }
    let created = execute(
        ctx,
        &NOTE,
        NoteBody {
            contact_id: Some(req.contact_id),
            body: req.body,
        },
        opts,
    )?;
    if pinned {
        set_flag(ctx, &created.id, Flag::Pinned, true, group.as_ref())?;
    }
    Ok(created)
}

/// Edit the text, against the body counter it was opened at.
pub fn save_note(ctx: &Ctx, id: &str, req: SaveNote) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &NOTE,
        NoteBody {
            contact_id: None,
            body: req.body,
        },
        Exec::update(id, Some(req.expected), Source::Ui),
    )
}

#[derive(Clone, Copy, Debug)]
pub enum Flag {
    Pinned,
    Archived,
}

/// Set one flag from the note's flags now. A no-op toggle writes nothing
/// (no revision, no counter bump).
pub fn set_flag(
    ctx: &Ctx,
    id: &str,
    flag: Flag,
    value: bool,
    group: Option<&CommandGroup>,
) -> Result<Executed, ContractError> {
    let now: Option<(NoteFlags, i64)> = ctx
        .tx
        .read()
        .query_row(
            "SELECT pinned, archived, flags_version FROM contact_notes WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    NoteFlags {
                        pinned: r.get(0)?,
                        archived: r.get(1)?,
                    },
                    r.get(2)?,
                ))
            },
        )
        .optional()?;
    let Some((mut flags, counter)) = now else {
        return Err(ContractError::NotFound);
    };
    let slot = match flag {
        Flag::Pinned => &mut flags.pinned,
        Flag::Archived => &mut flags.archived,
    };
    if *slot == value {
        return Ok(Executed {
            id: id.to_owned(),
            counter,
        });
    }
    *slot = value;
    let mut opts = Exec::update(id, None, Source::Ui);
    if let Some(g) = group {
        opts = opts.in_group(g);
    }
    execute(ctx, &NOTE_FLAGS, flags, opts)
}

/// Restore one of this note's revisions as a new command; another
/// entity's revision is not found.
pub fn restore_note(ctx: &Ctx, id: &str, revision_id: i64) -> Result<(), ContractError> {
    let owner: Option<(String, String)> = ctx
        .tx
        .read()
        .query_row(
            "SELECT entity, entity_id FROM revisions WHERE id = ?1",
            [revision_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if owner != Some((<ContactNote as Contract>::ENTITY.into(), id.to_owned())) {
        return Err(ContractError::NotFound);
    }
    restore(ctx, &REGISTRY, revision_id, None)?;
    Ok(())
}

// ── reads ──────────────────────────────────────────────────────────────────

const NOTE_COLUMNS: &str = "id, contact_id, body, pinned, archived, created_by, created_at, \
     edited_by, edited_at, body_version, flags_version";

fn note_row(r: &rusqlite::Row) -> rusqlite::Result<NoteView> {
    Ok(NoteView {
        id: r.get(0)?,
        contact_id: r.get(1)?,
        body: r.get(2)?,
        pinned: r.get(3)?,
        archived: r.get(4)?,
        created_by: r.get(5)?,
        created_at: r.get(6)?,
        edited_by: r.get(7)?,
        edited_at: r.get(8)?,
        body_version: r.get(9)?,
        flags_version: r.get(10)?,
    })
}

pub fn note(conn: &Connection, id: &str) -> rusqlite::Result<Option<NoteView>> {
    conn.prepare_cached(&format!(
        "SELECT {NOTE_COLUMNS} FROM contact_notes WHERE id = ?1"
    ))?
    .query_row([id], note_row)
    .optional()
}

fn capped(mut notes: Vec<NoteView>) -> NotesPage {
    let truncated = notes.len() > NOTES_LIMIT;
    notes.truncate(NOTES_LIMIT);
    NotesPage { notes, truncated }
}

/// Live notes: pinned first, then the rest, each newest first (creation
/// order: a pin never moves a note within its section).
pub fn notes_for_contact(conn: &Connection, contact_id: &str) -> rusqlite::Result<NotesPage> {
    let notes = conn
        .prepare_cached(&format!(
            "SELECT {NOTE_COLUMNS} FROM contact_notes
             WHERE contact_id = ?1 AND archived = 0
             ORDER BY pinned DESC, seq DESC LIMIT ?2"
        ))?
        .query_map(params![contact_id, NOTES_LIMIT as i64 + 1], note_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(capped(notes))
}

/// Archived notes, newest first regardless of pin, so they can be restored.
pub fn archived_notes(conn: &Connection, contact_id: &str) -> rusqlite::Result<NotesPage> {
    let notes = conn
        .prepare_cached(&format!(
            "SELECT {NOTE_COLUMNS} FROM contact_notes
             WHERE contact_id = ?1 AND archived = 1
             ORDER BY seq DESC LIMIT ?2"
        ))?
        .query_map(params![contact_id, NOTES_LIMIT as i64 + 1], note_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(capped(notes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(s: &str) -> NoteBody {
        NoteBody {
            contact_id: None,
            body: s.into(),
        }
    }

    #[test]
    fn bodies_are_trimmed_at_the_ends_only() {
        assert_eq!(prepare_note(body("  a\n\nb \n")).unwrap().body, "a\n\nb");
        for blank in ["", "   ", "\n\t "] {
            assert!(prepare_note(body(blank)).is_err(), "{blank:?}");
        }
    }

    #[test]
    fn the_cap_counts_utf8_bytes_not_characters() {
        assert!(prepare_note(body(&"a".repeat(NOTE_MAX_BYTES))).is_ok());
        assert!(prepare_note(body(&"a".repeat(NOTE_MAX_BYTES + 1))).is_err());
        // 'é' is two bytes: half the cap in characters fills it.
        assert!(prepare_note(body(&"é".repeat(NOTE_MAX_BYTES / 2))).is_ok());
        assert!(prepare_note(body(&"é".repeat(NOTE_MAX_BYTES / 2 + 1))).is_err());
    }
}
