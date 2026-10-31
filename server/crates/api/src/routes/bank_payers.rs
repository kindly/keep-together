//! What the reconcile pages read beside step 4's matching routes (bank
//! transfers 6b): a contact's remembered payers and forgetting them
//! (g1q8: shown and removable on the contact), the transfers entered
//! by hand that a line could be matched to, and an account's unmatched
//! lines to pick one from (no suggestions computed). Staff and admins only:
//! payers are read from statement lines, which viewers never see (g1q9).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::Source;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use store::Role;
use ts_rs::TS;

use super::Params;
use crate::{ApiError, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/contacts/{id}/bank-payers", get(payers))
        .route("/contacts/{id}/bank-payers/forget", post(forget))
        .route("/bank/lines/{id}/hand-transfers", get(hand_transfers))
        .route("/bank/accounts/{id}/line-choices", get(line_choices))
}

fn require_staff(t: &Tenant) -> Result<(), ApiError> {
    if t.role < Role::Staff {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

/// A remembered payer, with its account's name.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankPayerView")]
pub struct PayerView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub payer: banking::matching::Payer,
    pub account_name: String,
}

fn payers_of(conn: &Connection, contact_id: &str) -> Result<Vec<PayerView>, ApiError> {
    if contacts::donors::kind_of(conn, contact_id)?.is_none() {
        return Err(ApiError::NotFound);
    }
    banking::matching::payers_of(conn, contact_id)?
        .into_iter()
        .map(|payer| {
            let account_name = banking::account::account(conn, &payer.account_id)?
                .map(|a| a.payload.name)
                .unwrap_or_default();
            Ok(PayerView {
                payer,
                account_name,
            })
        })
        .collect()
}

/// `GET contacts/{id}/bank-payers`: the payer names and references their
/// matched lines carried, per account, newest first.
async fn payers(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<Vec<PayerView>>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| payers_of(r, &id)).await.map(Json)
}

/// `POST contacts/{id}/bank-payers/forget`: every payer remembered for
/// the contact forgotten (`banking::forget_payers`); answers what is
/// left, which is none until a line is matched to them again.
async fn forget(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<Vec<PayerView>>, ApiError> {
    require_staff(&t)?;
    t.write(move |ctx| {
        if contacts::donors::kind_of(ctx.tx.read(), &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        banking::matching::forget_payers(ctx, &id, Source::Ui, None)?;
        payers_of(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

/// Days either side of a line's date that its hand-entered transfers are
/// looked for, by default and at most.
pub const HAND_TRANSFER_DAYS: i64 = 14;
pub const HAND_TRANSFER_DAYS_MAX: i64 = 60;

#[derive(Deserialize)]
struct DaysQuery {
    days: Option<i64>,
}

/// A transfer entered by hand, not on a statement yet.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankHandTransfer")]
pub struct HandTransfer {
    pub id: String,
    pub contact_id: String,
    pub contact_name: String,
    pub received_on: String,
    #[ts(type = "number")]
    pub amount: i64,
}

/// `GET bank/lines/{id}/hand-transfers?days`: the transfers entered by
/// hand and received within `days` (14; at most 60) of the line's date
/// that no statement line is matched to yet, oldest first: what "match to
/// gifts already entered" picks from.
async fn hand_transfers(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<DaysQuery>,
) -> Result<Json<Vec<HandTransfer>>, ApiError> {
    require_staff(&t)?;
    let days = q
        .days
        .unwrap_or(HAND_TRANSFER_DAYS)
        .clamp(0, HAND_TRANSFER_DAYS_MAX);
    t.read(move |r| {
        let line = banking::matching::line(r, &id)?.ok_or(ApiError::NotFound)?;
        let shift = |d: i64| {
            giving::terms_rules::add_days(&line.posted_on, d)
                .ok_or_else(|| ApiError::internal("a line's date that isn't one"))
        };
        let (from, to) = (shift(-days)?, shift(days)?);
        giving::bank::transfers_not_on_a_statement(r, &from, &to)?
            .into_iter()
            .map(|g| {
                let contact_name = contacts::donors::name_of(r, &g.contact_id)?
                    .map(|(name, _)| name)
                    .unwrap_or_default();
                Ok(HandTransfer {
                    id: g.id,
                    contact_id: g.contact_id,
                    contact_name,
                    received_on: g.received_on,
                    amount: g.amount,
                })
            })
            .collect()
    })
    .await
    .map(Json)
}

/// `GET bank/accounts/{id}/line-choices`: the account's unmatched lines,
/// oldest first (at most 200), without suggestions: what a picker (a
/// batch matched from its side) chooses from. The lines read with
/// suggestions is step 4's `GET bank/accounts/{id}/lines`.
async fn line_choices(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<Vec<banking::matching::LineView>>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| {
        banking::account::account(r, &id)?.ok_or(ApiError::NotFound)?;
        Ok(banking::matching::lines(
            r,
            &id,
            banking::matching::MatchState::Unmatched,
        )?)
    })
    .await
    .map(Json)
}
