//! `/api/t/{slug}/sources…`: source codes, and a contact's acquisition
//! code. Managing the list is for admins, and staff while the
//! organisation's switch is on; assigning a code to a contact is ordinary
//! staff editing. A create or a save answers the tree after it.

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contacts::acquisition::{SetAcquisition, set_acquisition};
use contacts::queries;
use contacts::types::ContactView;
use contracts::{ContractError, Exec, Executed, Source, execute};
use platform::{ListKind, Role, may_manage_list};
use rusqlite::Connection;
use serde::Serialize;
use sources::types::{
    CodeDescription, DeleteSourceCode, Deleted, FilterOption, Picker, PickerQuery, SaveSourceCode,
    SourceCodePayload, Tree,
};
use sources::{CODE, Created, DELETION, DeletionPayload};
use ts_rs::TS;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/sources", get(tree).post(create))
        .route("/sources/filter-options", get(filter_options))
        .route("/sources/picker", get(picker))
        .route("/sources/{id}", get(describe))
        .route("/sources/{id}/save", post(save))
        .route("/sources/{id}/delete", post(delete))
        .route("/contacts/{id}/acquisition", post(acquisition))
}

/// Managing the list is for admins, and staff while the organisation's
/// "staff can manage source codes" switch is on (`platform`). Checked by
/// these routes, not by the contract (Convex's `managesList` covered
/// restore too): a route that restores `sources.*` revisions must call
/// it as well.
fn require_manager(conn: &Connection, role: Role) -> Result<(), ApiError> {
    if may_manage_list(conn, role, ListKind::SourceCodes)? {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

fn tree_of(conn: &Connection, role: Role) -> Result<Tree, ApiError> {
    Ok(Tree {
        parts: sources::tree(conn)?,
        can_manage: may_manage_list(conn, role, ListKind::SourceCodes)?,
    })
}

/// `GET sources`: every part in tree order, archived included, and
/// whether the caller may change them.
async fn tree(Extension(t): Extension<Tenant>) -> Result<Json<Tree>, ApiError> {
    let role = t.role;
    t.read(move |r| tree_of(r, role)).await.map(Json)
}

/// A create's answer: the new part (and its first version), and the tree
/// as `GET sources` answers it after the create (Settings shows it).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceCodeCreated {
    #[serde(flatten)]
    #[ts(flatten)]
    pub created: Created,
    pub tree: Tree,
}

/// A save's answer: what it executed, and the tree after it.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceCodeSaved {
    pub id: String,
    #[ts(type = "number")]
    pub counter: i64,
    pub tree: Tree,
}

/// `GET sources/filter-options`: what the contacts list's filter shows.
async fn filter_options(
    Extension(t): Extension<Tenant>,
) -> Result<Json<Vec<FilterOption>>, ApiError> {
    t.read(|r| Ok(sources::filter_options(r)?)).await.map(Json)
}

/// `GET sources/picker?today&search`: assignable codes, at most 50.
async fn picker(
    Extension(t): Extension<Tenant>,
    Params(q): Params<PickerQuery>,
) -> Result<Json<Picker>, ApiError> {
    t.read(move |r| {
        Ok(sources::picker(
            r,
            &q.today,
            q.search.as_deref().unwrap_or(""),
        )?)
    })
    .await
    .map(Json)
}

/// `GET sources/{id}`: one code by its version id; 404 for anything else.
async fn describe(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<CodeDescription>, ApiError> {
    t.read(move |r| sources::describe(r, &id)?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}

/// `POST sources {parentId?, name, description?, startDate?, endDate?,
/// isActive}`: a category, a detail (with version `001`) or a version.
async fn create(
    Extension(t): Extension<Tenant>,
    Body(payload): Body<SourceCodePayload>,
) -> Result<Json<SourceCodeCreated>, ApiError> {
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        let created = sources::create_part(ctx, payload, Source::Ui, None)?;
        Ok(SourceCodeCreated {
            created,
            tree: tree_of(ctx.tx.read(), role)?,
        })
    })
    .await
    .map(Json)
}

/// `POST sources/{id}/save {expected, …}`: rename, describe, date,
/// archive or reactivate a part; `409 stale` on a counter mismatch.
async fn save(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SaveSourceCode>,
) -> Result<Json<SourceCodeSaved>, ApiError> {
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        let Executed { id, counter } = execute(
            ctx,
            &CODE,
            req.payload,
            Exec::update(&id, Some(req.expected), Source::Ui),
        )?;
        Ok(SourceCodeSaved {
            id,
            counter,
            tree: tree_of(ctx.tx.read(), role)?,
        })
    })
    .await
    .map(Json)
}

/// `POST sources/{id}/delete {expected}`: a never-used part and
/// everything under it; `422 rejected {reason: used}` once used.
async fn delete(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<DeleteSourceCode>,
) -> Result<Json<Deleted>, ApiError> {
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        let exists: bool = ctx.tx.read().query_row(
            "SELECT EXISTS (SELECT 1 FROM source_codes WHERE id = ?1)",
            [&id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(ApiError::NotFound);
        }
        execute(
            ctx,
            &DELETION,
            DeletionPayload {
                expected: req.expected,
            },
            Exec::create_with_id(&id, Source::Ui),
        )?;
        Ok(Deleted {
            deleted: sources::deleted_count(ctx.tx.read(), &id)?,
        })
    })
    .await
    .map(Json)
}

/// `POST contacts/{id}/acquisition`: the slice's counter and the
/// contact's view, read in the same transaction.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcquisitionSet {
    pub id: String,
    #[ts(type = "number")]
    pub counter: i64,
    pub view: ContactView,
}

/// `POST contacts/{id}/acquisition {expected, codeId}`: set or clear the
/// contact's code; re-sending the current one changes nothing.
async fn acquisition(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SetAcquisition>,
) -> Result<Json<AcquisitionSet>, ApiError> {
    t.write(move |ctx| {
        let done = set_acquisition(ctx, &id, req.expected, req.code_id)?;
        let view = queries::get(ctx.tx.read(), &done.id)?.ok_or(ContractError::NotFound)?;
        Ok(AcquisitionSet {
            id: done.id,
            counter: done.counter,
            view,
        })
    })
    .await
    .map(Json)
}
