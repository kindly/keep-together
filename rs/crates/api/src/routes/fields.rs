//! `/api/t/{slug}/fields…`: dropdown field definitions. Managing them is
//! for admins, and staff while "staff can manage fields" is on; setting a
//! contact's values is ordinary staff editing.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contacts::fields::{
    DeletionPayload, FIELD, FIELD_DELETE, FIELD_OPTION, FIELD_OPTION_DELETE, RETIRE_BATCH,
    add_option, definitions, deleted_count, reorder_options, retire_batch, retire_finish,
    retire_start, retiring_fields,
};
use contacts::types::{
    DeleteFieldPart, DeletedFieldPart, FieldDefinition, FieldRetirePayload, ReorderOptions,
    ReorderedOptions, RetirePhase, SaveField, SaveFieldOption,
};
use contracts::{ContractError, Ctx, Exec, Executed, Source, execute};
use platform::{ListKind, Role, may_manage_list};
use rusqlite::Connection;
use store::{OrgDb, Store, TenantId};

use crate::jobs::{Job, clear_pending, each_pending_org};
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/fields", get(list).post(save_field))
        .route("/fields/options", post(save_option))
        .route("/fields/options/{id}/delete", post(delete_option))
        .route("/fields/{id}/delete", post(delete_field))
        .route("/fields/{id}/reorder", post(reorder))
        .route("/fields/{id}/retire", post(retire))
}

/// Admins, and staff while the switch is on (Convex `requireListManager`).
fn require_manager(conn: &Connection, role: Role) -> Result<(), ApiError> {
    if may_manage_list(conn, role, ListKind::Fields)? {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

/// `GET fields`: every live field with its options, archived included.
async fn list(Extension(t): Extension<Tenant>) -> Result<Json<Vec<FieldDefinition>>, ApiError> {
    t.read(|r| Ok(definitions(r)?)).await.map(Json)
}

fn exec(id: &Option<String>, expected: Option<i64>) -> Exec<'_> {
    match id {
        Some(id) => Exec::update(id, Some(expected.unwrap_or(-1)), Source::Ui),
        None => Exec::create(Source::Ui),
    }
}

/// `POST fields {id?, expected?, label, appliesTo, isActive}`
async fn save_field(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveField>,
) -> Result<Json<Executed>, ApiError> {
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        Ok(execute(
            ctx,
            &FIELD,
            req.payload,
            exec(&req.id, req.expected),
        )?)
    })
    .await
    .map(Json)
}

/// `POST fields/options {id?, expected?, fieldId, label, position, isActive}`.
/// A new option (no `id`) goes at the end of its field's list, whatever
/// `position` says.
async fn save_option(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveFieldOption>,
) -> Result<Json<Executed>, ApiError> {
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        let p = req.payload;
        Ok(match &req.id {
            None => add_option(ctx, &p.field_id, p.label, p.is_active, Source::Ui)?,
            Some(_) => execute(ctx, &FIELD_OPTION, p, exec(&req.id, req.expected))?,
        })
    })
    .await
    .map(Json)
}

/// `POST fields/{id}/delete {expected}`: a field none of whose options was
/// ever used, with its options; `422 rejected {reason: used}` otherwise.
async fn delete_field(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<DeleteFieldPart>,
) -> Result<Json<DeletedFieldPart>, ApiError> {
    // Irreversible: a recent sign-in, whoever may manage the list.
    t.require_step_up()?;
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        execute(
            ctx,
            &FIELD_DELETE,
            DeletionPayload {
                expected: req.expected,
            },
            Exec::create_with_id(&id, Source::Ui),
        )
        .map_err(gone)?;
        Ok(DeletedFieldPart {
            deleted: deleted_count(ctx.tx.read(), &id)?,
        })
    })
    .await
    .map(Json)
}

/// `POST fields/options/{id}/delete {expected}`: an option never used.
async fn delete_option(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<DeleteFieldPart>,
) -> Result<Json<DeletedFieldPart>, ApiError> {
    // Irreversible: a recent sign-in, whoever may manage the list.
    t.require_step_up()?;
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        execute(
            ctx,
            &FIELD_OPTION_DELETE,
            DeletionPayload {
                expected: req.expected,
            },
            Exec::create_with_id(&id, Source::Ui),
        )
        .map_err(gone)?;
        Ok(DeletedFieldPart { deleted: 1 })
    })
    .await
    .map(Json)
}

/// Deleting what was already deleted is deleting something not there.
fn gone(e: ContractError) -> ContractError {
    match e {
        ContractError::Duplicate { .. } => ContractError::NotFound,
        e => e,
    }
}

/// `POST fields/{id}/reorder {order}`: every option, archived included;
/// `409 stale` when the set of options changed meanwhile.
async fn reorder(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<ReorderOptions>,
) -> Result<Json<ReorderedOptions>, ApiError> {
    let role = t.role;
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        Ok(ReorderedOptions {
            moved: reorder_options(ctx, &id, &req.order, Source::Ui)?,
        })
    })
    .await
    .map(Json)
}

/// `POST fields/{id}/retire`: archive the field and mark it retiring (one
/// transaction), then answer, phase `retiring`. The values are cleared in
/// the background, a batch (one transaction, one command group) at a
/// time, and the field marked retired; the Settings tab follows through
/// the events. Irreversible: needs a recent sign-in. A retire the server
/// stopped part way is carried on by the `field-retire` job, and running
/// this again carries it on too.
async fn retire(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<FieldRetirePayload>, ApiError> {
    t.require_step_up()?;
    let role = t.role;
    let start = id.clone();
    t.write(move |ctx| {
        require_manager(ctx.tx.read(), role)?;
        Ok(retire_start(ctx, &start, Source::Ui)?)
    })
    .await?;
    let field = id.clone();
    t.run_job(RETIRE_JOB, id, move |ctx| retire_step(ctx, &field))
        .await?;
    Ok(Json(FieldRetirePayload {
        phase: RetirePhase::Retiring,
    }))
}

/// The job (and `platform.db` marker) name for retires.
pub const RETIRE_JOB: &str = "field-retire";

/// One batch, or the finish once no value is left: true once ended.
fn retire_step(ctx: &Ctx, id: &str) -> Result<bool, ApiError> {
    if retire_batch(ctx, id, RETIRE_BATCH, Source::Ui)? > 0 {
        return Ok(false);
    }
    Ok(retire_finish(ctx, id, Source::Ui)?)
}

/// Carries on any retire left part way (the server stopped mid-retire),
/// as whoever started it. Visits only the orgs `platform.db` marks as
/// having one, so an idle org is never opened. One field failing is
/// logged (and sent to Sentry) and the others carry on; its marker stays,
/// so the next run tries again.
pub struct FieldRetire(pub Arc<Store>);

impl FieldRetire {
    fn resume(store: &Store, tenant: &TenantId, db: &OrgDb, keys: &[String]) -> Result<(), String> {
        let retiring: Vec<(String, Option<i64>)> =
            db.read(|r| retiring_fields(r)).map_err(|e| e.to_string())?;
        let mut failed = Vec::new();
        for key in keys {
            let Some((_, actor)) = retiring.iter().find(|(id, _)| id == key) else {
                // Ended (or never started): nothing left to carry on.
                clear_pending(store, tenant, RETIRE_JOB, key).map_err(|e| e.to_string())?;
                continue;
            };
            let done = loop {
                match contracts::transact(db, *actor, |ctx| retire_step(ctx, key)) {
                    Ok(true) => break Ok(()),
                    Ok(false) => continue,
                    Err(e) => break Err(e),
                }
            };
            match done {
                Ok(()) => {
                    clear_pending(store, tenant, RETIRE_JOB, key).map_err(|e| e.to_string())?
                }
                Err(e) => {
                    let message = format!("{RETIRE_JOB} {tenant} {key}: {e:?}");
                    crate::observe::error(&message);
                    failed.push(message);
                }
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(failed.join("; "))
        }
    }
}

impl Job for FieldRetire {
    fn name(&self) -> &'static str {
        RETIRE_JOB
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60)
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        let store = self.0.clone();
        Box::pin(each_pending_org(
            &self.0,
            RETIRE_JOB,
            move |id, db, keys| Self::resume(&store, id, db, keys),
        ))
    }
}
