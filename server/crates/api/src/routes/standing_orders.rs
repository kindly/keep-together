//! `/api/t/{slug}/…`: standing orders (plan `bank-transfers.sv` step 5,
//! ADR 0027). A regular gift of kind `standing_order`: no provider, so
//! nothing here calls GoCardless. Staff and admins record one ("Record a
//! standing order", g2q3) and end one; any member reads them, as regular
//! gifts are read. Matching a statement line to one is
//! `bank/lines/{id}/instalment` (and "make this a standing order",
//! `bank/lines/{id}/standing-order`).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::Source;
use giving::standing::{MissedStandingOrder, StandingOrderSetUp, StandingOrderView};
use serde::Deserialize;
use ts_rs::TS;

use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route(
            "/contacts/{id}/standing-orders",
            get(of_contact).post(create),
        )
        .route("/standing-orders/missed", get(missed))
        .route("/standing-orders/{id}", get(one))
        .route("/standing-orders/{id}/end", post(end))
}

fn today() -> String {
    giving::terms_rules::date_of_ms(contracts::now_ms())
}

/// `GET contacts/{id}/standing-orders`: newest first.
async fn of_contact(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<Vec<StandingOrderView>>, ApiError> {
    t.read(move |r| {
        if contacts::donors::kind_of(r, &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        Ok(giving::standing::of_contact(r, &id, &today())?)
    })
    .await
    .map(Json)
}

/// `POST contacts/{id}/standing-orders {clientKey?, amount, frequency,
/// dayOfMonth, month?, sourceCodeId, bankReference?, startsOn}` → the
/// standing order. `422 invalid` (a quarterly or yearly one needs its
/// month), `409 duplicate` (the form's key, again).
async fn create(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(setup): Body<StandingOrderSetUp>,
) -> Result<Json<StandingOrderView>, ApiError> {
    t.write(move |ctx| {
        if contacts::donors::kind_of(ctx.tx.read(), &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        let so = giving::standing::create_standing_order(ctx, &id, setup, Source::Ui, None)?;
        giving::standing::get(ctx.tx.read(), &so, &today())?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

/// `GET standing-orders/{id}`: with its chain and the last 12 months'
/// expected payments to the next 3 (a Direct Debit's id is 404 here).
async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<StandingOrderView>, ApiError> {
    t.read(move |r| giving::standing::get(r, &id, &today())?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}

/// `POST standing-orders/{id}/end {expected, reason?}`: `expected` is its
/// `mandateVersion`.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "EndStandingOrder")]
pub struct End {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(default)]
    #[ts(optional)]
    pub reason: Option<String>,
}

async fn end(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<End>,
) -> Result<Json<StandingOrderView>, ApiError> {
    t.write(move |ctx| {
        giving::standing::end_standing_order(ctx, &id, req.expected, req.reason, Source::Ui)?;
        giving::standing::get(ctx.tx.read(), &id, &today())?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

/// `GET standing-orders/missed`: every standing order with a missed
/// payment, oldest miss first (g2q2: staff decide).
async fn missed(
    Extension(t): Extension<Tenant>,
) -> Result<Json<Vec<MissedStandingOrder>>, ApiError> {
    t.read(move |r| Ok(giving::standing::missed(r, &today())?))
        .await
        .map(Json)
}

/// The daily job (`api::jobs`): each organisation's standing orders'
/// missed flags, refreshed as of today, one file at a time.
pub struct StandingOrdersMissed(pub std::sync::Arc<store::Store>);

impl crate::jobs::Job for StandingOrdersMissed {
    fn name(&self) -> &'static str {
        "standing-orders-missed"
    }
    fn every(&self) -> std::time::Duration {
        std::time::Duration::from_secs(6 * 60 * 60)
    }
    fn run(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move { run_missed(&self.0, today()).await })
    }
}

/// The job's work as of `today` (tests pass a day).
pub async fn run_missed(store: &std::sync::Arc<store::Store>, today: String) -> Result<(), String> {
    crate::jobs::each_org(store, move |_, db| {
        contracts::transact(db, None, |ctx| {
            giving::standing::refresh_all_missed(ctx, &today)
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .await
}
