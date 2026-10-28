//! `/api/t/{slug}/…notes…`: a contact's notes. Each write answers the note
//! as it is now, read in the same transaction.

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contacts::notes::{
    CreateNote, Flag, NoteView, NotesPage, SaveNote, SetFlag, archived_notes, create_note, note,
    notes_for_contact, restore_note, save_note, set_flag,
};
use rusqlite::Connection;
use serde::Deserialize;
use ts_rs::TS;

use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/contacts/{id}/notes", get(live))
        .route("/contacts/{id}/notes/archived", get(archived))
        .route("/notes", post(create))
        .route("/notes/{id}/save", post(save))
        .route("/notes/{id}/pin", post(pin))
        .route("/notes/{id}/archive", post(archive))
        .route("/notes/{id}/restore", post(restore))
}

fn contact_exists(conn: &Connection, id: &str) -> Result<(), ApiError> {
    let found: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM contacts WHERE id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    if found {
        Ok(())
    } else {
        Err(ApiError::NotFound)
    }
}

fn view(conn: &Connection, id: &str) -> Result<NoteView, ApiError> {
    note(conn, id)?.ok_or(ApiError::NotFound)
}

/// `GET contacts/{id}/notes`: pinned first, then the rest, each newest
/// first, at most 200.
async fn live(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<NotesPage>, ApiError> {
    t.read(move |r| {
        contact_exists(r, &id)?;
        Ok(notes_for_contact(r, &id)?)
    })
    .await
    .map(Json)
}

/// `GET contacts/{id}/notes/archived`: newest first, at most 200.
async fn archived(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<NotesPage>, ApiError> {
    t.read(move |r| {
        contact_exists(r, &id)?;
        Ok(archived_notes(r, &id)?)
    })
    .await
    .map(Json)
}

/// `POST notes {id?, contactId, body, pinned?}`
async fn create(
    Extension(t): Extension<Tenant>,
    Body(req): Body<CreateNote>,
) -> Result<Json<NoteView>, ApiError> {
    t.write(move |ctx| {
        let done = create_note(ctx, req)?;
        view(ctx.tx.read(), &done.id)
    })
    .await
    .map(Json)
}

/// `POST notes/{id}/save {expected, body}`: `409 stale` if the body
/// changed since `expected`.
async fn save(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SaveNote>,
) -> Result<Json<NoteView>, ApiError> {
    t.write(move |ctx| {
        save_note(ctx, &id, req)?;
        view(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

async fn flag(t: Tenant, id: String, flag: Flag, value: bool) -> Result<Json<NoteView>, ApiError> {
    t.write(move |ctx| {
        set_flag(ctx, &id, flag, value, None)?;
        view(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// `POST notes/{id}/pin {value}`
async fn pin(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SetFlag>,
) -> Result<Json<NoteView>, ApiError> {
    flag(t, id, Flag::Pinned, req.value).await
}

/// `POST notes/{id}/archive {value}`: remove = archive; `false` restores.
async fn archive(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SetFlag>,
) -> Result<Json<NoteView>, ApiError> {
    flag(t, id, Flag::Archived, req.value).await
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoreNote {
    #[ts(type = "number")]
    pub revision_id: i64,
}

/// `POST notes/{id}/restore {revisionId}`: one of this note's revisions,
/// as a new command.
async fn restore(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<RestoreNote>,
) -> Result<Json<NoteView>, ApiError> {
    t.write(move |ctx| {
        restore_note(ctx, &id, req.revision_id)?;
        view(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}
