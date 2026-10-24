//! The signed-in user's own account: what it has, password change, new
//! recovery codes. (Changing the second factor is `enrol/*` within the
//! step-up window.)

use auth::{accounts, sessions};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::flows::{Method, check_password, password_limits};
use super::{ClientIp, Revoked, fresh, session};
use crate::error::{ApiError, Body};
use crate::timing::Timing;
use crate::{AppState, blocking};

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccountInfo {
    pub email: String,
    pub method: Option<Method>,
    #[ts(type = "number")]
    pub recovery_codes_left: i64,
    #[ts(type = "number | null")]
    pub step_up_until: Option<i64>,
}

/// `GET /api/auth/account`
pub async fn info(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<AccountInfo>, ApiError> {
    let s = session(&state, &headers, &timing).await?;
    let st = state.clone();
    let out = blocking(move || {
        st.store.platform().with_read(|c| {
            let creds = accounts::credentials(c, s.user)?;
            Ok::<_, ApiError>(AccountInfo {
                email: s.email.clone(),
                method: creds.and_then(|c| c.second_factor).map(Method::from),
                recovery_codes_left: accounts::recovery_codes_left(c, s.user)?,
                step_up_until: s.authenticated_at.map(|at| at + auth::STEP_UP_MS),
            })
        })
    })
    .await?;
    Ok(Json(out))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct ChangePassword {
    pub current: String,
    pub new: String,
}

/// `POST /api/auth/account/password {current, new}`: every other session
/// of the user ends; this one stays.
pub async fn change_password(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<ChangePassword>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let s = session(&state, &headers, &timing).await?;
    password_limits(&state, &ip, &s.email)?;
    if let Some(message) = auth::password::problem(&req.new) {
        return Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new("new", message)],
        });
    }
    let st = state.clone();
    let user = s.user;
    blocking(move || {
        if check_password(&st, &s.email, &req.current)? != Some(s.user) {
            return Err(ApiError::Rejected {
                reason: "invalid_credentials".into(),
                message: "That isn't your current password.".into(),
            });
        }
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            accounts::set_password(tx, s.user, &req.new, now).map_err(ApiError::internal)?;
            sessions::revoke_others(tx, s.user, &s.id)?;
            accounts::log(tx, now, "password_changed", Some(s.user), "self", None, "")?;
            Ok(())
        })
    })
    .await?;
    // Streams of the ended sessions re-check and close.
    state.auth.revoked(Revoked::User(user));
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecoveryCodes {
    pub recovery_codes: Vec<String>,
}

/// `POST /api/auth/account/recovery-codes` (within the step-up window) →
/// 10 new codes; the old ones stop working.
pub async fn recovery_codes(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<RecoveryCodes>, ApiError> {
    let s = session(&state, &headers, &timing).await?;
    let now = contracts::now_ms();
    if !fresh(&s, now) {
        return Err(ApiError::StepUpRequired);
    }
    let st = state.clone();
    let codes = blocking(move || {
        st.store.platform().with_write(|tx| {
            if accounts::credentials(tx, s.user)?.and_then(|c| c.second_factor).is_none() {
                return Err(ApiError::Rejected {
                    reason: "no_second_factor".into(),
                    message: "Set up a second factor first.".into(),
                });
            }
            let codes = accounts::new_recovery_codes(tx, s.user)?;
            accounts::log(tx, now, "recovery_codes_renewed", Some(s.user), "self", None, "")?;
            Ok(codes)
        })
    })
    .await?;
    Ok(Json(RecoveryCodes { recovery_codes: codes }))
}
