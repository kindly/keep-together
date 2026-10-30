//! `/api/t/{slug}/bank/batches…`: paying-in batches (bank transfers 6b,
//! ADR 0027 decision 6). Cash and cheques paid in together on one slip:
//! staff open a batch on a bank account, record its gifts into it (the
//! record-gift page's `payingInBatchId`), and close it with the slip's
//! total and the date it was paid in. Matching a closed batch to its
//! statement line (which clears its cheques) is the reconcile step's
//! (`giving::bank::match_batch`), never these routes'.
//!
//! Every member reads; staff and admins write (`Tenant::write`). Saves
//! carry the batch's `version`: `409 stale`. Never optimistic: a write
//! answers the batch as it now is, read in the same transaction.

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{ContractError, Ctx, Exec, Executed, Source, execute};
use giving::types::{BatchStatus, PayingInBatchPayload, PayingInBatchRow, RecentGift};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/bank/batches", get(list).post(create))
        .route("/bank/batches/{id}", get(one))
        .route("/bank/batches/{id}/save", post(save))
        .route("/bank/batches/{id}/close", post(close))
        .route("/bank/batches/{id}/reopen", post(reopen))
}

/// A batch as its pages show it: the batch, its account's name and, once
/// matched, its statement line's date and amount.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PayingInBatchView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub batch: PayingInBatchRow,
    pub account_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<banking::LineSummary>,
}

fn view_of(conn: &Connection, batch: PayingInBatchRow) -> Result<PayingInBatchView, ApiError> {
    let account_name = banking::account::account(conn, &batch.batch.account_id)?
        .map(|a| a.payload.name)
        .unwrap_or_default();
    let line = match &batch.line_id {
        Some(id) => banking::line_summary(conn, id)?,
        None => None,
    };
    Ok(PayingInBatchView {
        batch,
        account_name,
        line,
    })
}

fn view(conn: &Connection, id: &str) -> Result<PayingInBatchView, ApiError> {
    let batch = giving::bank::get_batch(conn, id)?.ok_or(ApiError::NotFound)?;
    view_of(conn, batch)
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<BatchStatus>,
}

/// `GET bank/batches?status=open|closed`: open ones first, then the
/// newest closed (at most 200).
async fn list(
    Extension(t): Extension<Tenant>,
    Params(q): Params<ListQuery>,
) -> Result<Json<Vec<PayingInBatchView>>, ApiError> {
    t.read(move |r| {
        giving::batches::batches(r, q.status)?
            .into_iter()
            .map(|b| view_of(r, b))
            .collect()
    })
    .await
    .map(Json)
}

/// `GET bank/batches/{id}`: the batch and its gifts.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PayingInBatchDetail {
    pub batch: PayingInBatchView,
    pub gifts: Vec<RecentGift>,
}

async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<PayingInBatchDetail>, ApiError> {
    t.read(move |r| {
        Ok(PayingInBatchDetail {
            batch: view(r, &id)?,
            gifts: giving::batches::gifts_in_batch(r, &id)?,
        })
    })
    .await
    .map(Json)
}

/// `POST bank/batches {accountId, slipNumber}`: a new open batch.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenBatch {
    pub account_id: String,
    #[serde(default)]
    pub slip_number: String,
}

async fn create(
    Extension(t): Extension<Tenant>,
    Body(req): Body<OpenBatch>,
) -> Result<Json<PayingInBatchView>, ApiError> {
    t.write(move |ctx| {
        // An archived account takes no new batches, as it takes no imports.
        let account = banking::account::account(ctx.tx.read(), &req.account_id)?;
        if account.as_ref().is_some_and(|a| !a.payload.active) {
            return Err(ContractError::rejected(
                "account_inactive",
                "This account is archived; make it active to pay into it",
            )
            .into());
        }
        let id = execute(
            ctx,
            &giving::PAYING_IN_BATCH,
            PayingInBatchPayload {
                account_id: req.account_id,
                slip_number: req.slip_number,
                banked_on: None,
                total: None,
                status: BatchStatus::Open,
            },
            Exec::create(Source::Ui),
        )?
        .id;
        view(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// The batch's payload now, for a save that changes some of it.
fn current(ctx: &Ctx, id: &str) -> Result<PayingInBatchPayload, ApiError> {
    Ok(giving::bank::get_batch(ctx.tx.read(), id)?
        .ok_or(ApiError::NotFound)?
        .batch)
}

fn run(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    payload: PayingInBatchPayload,
) -> Result<Executed, ApiError> {
    Ok(execute(
        ctx,
        &giving::PAYING_IN_BATCH,
        payload,
        Exec::update(id, Some(expected), Source::Ui),
    )?)
}

/// `POST bank/batches/{id}/save {expected, slipNumber, bankedOn?, total?}`:
/// the slip's details; open or closed stays as it is. `409 stale`; `422
/// rejected batch_matched` once its line is matched.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveBatch {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(default)]
    pub slip_number: String,
    #[serde(default)]
    #[ts(optional)]
    pub banked_on: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub total: Option<i64>,
}

async fn save(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(s): Body<SaveBatch>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| {
        let now = current(ctx, &id)?;
        let payload = PayingInBatchPayload {
            slip_number: s.slip_number,
            banked_on: s.banked_on,
            total: s.total,
            ..now
        };
        run(ctx, &id, s.expected, payload)
    })
    .await
    .map(Json)
}

/// `POST bank/batches/{id}/close {expected, bankedOn, total}`: the slip's
/// total (pence) and the date it was paid in; no more gifts go in. A
/// difference from its gifts' sum is shown, never refused.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloseBatch {
    #[ts(type = "number")]
    pub expected: i64,
    pub banked_on: String,
    #[ts(type = "number")]
    pub total: i64,
}

async fn close(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(c): Body<CloseBatch>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| {
        let now = current(ctx, &id)?;
        let payload = PayingInBatchPayload {
            banked_on: Some(c.banked_on),
            total: Some(c.total),
            status: BatchStatus::Closed,
            ..now
        };
        run(ctx, &id, c.expected, payload)
    })
    .await
    .map(Json)
}

/// `POST bank/batches/{id}/reopen {expected}`: open again for a gift
/// left out; `422 rejected batch_matched` once matched.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReopenBatch {
    #[ts(type = "number")]
    pub expected: i64,
}

async fn reopen(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(r): Body<ReopenBatch>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| {
        let now = current(ctx, &id)?;
        let payload = PayingInBatchPayload {
            status: BatchStatus::Open,
            ..now
        };
        run(ctx, &id, r.expected, payload)
    })
    .await
    .map(Json)
}
