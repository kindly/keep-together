//! The signed-in user's own account: what it has, password change, new
//! recovery codes, the sessions list and "sign out other sessions".
//! (Changing the second factor is `enrol/*` within the step-up window.)
//! Every change is mailed to the account's address (S1 M3).

use auth::notices::Notice;
use auth::{Stage, accounts, sessions};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::flows::{Method, check_password, reread, user_password_limits};
use super::{ClientIp, Revoked, session};
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
/// of the user ends, and every reset link they had (S1 L7); this session
/// stays. The user is emailed a notice.
pub async fn change_password(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<ChangePassword>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let s = session(&state, &headers, &timing).await?;
    user_password_limits(&state, &ip, s.user)?;
    if let Some(message) = state.auth.password_problem(&req.new) {
        return Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new("new", message)],
        });
    }
    let st = state.clone();
    let user = s.user;
    let email = s.email.clone();
    blocking(move || {
        if check_password(&st, &s.email, &req.current)? != Some(s.user) {
            return Err(ApiError::Rejected {
                reason: "invalid_credentials".into(),
                message: "That isn't your current password.".into(),
            });
        }
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, |s| s.stage == Stage::Full)?;
            accounts::set_password(tx, s.user, &req.new, now).map_err(ApiError::internal)?;
            sessions::revoke_others(tx, s.user, &s.id)?;
            // Phone pairings too, this session's included (the device
            // may be what prompted the change).
            crate::scans::end_all_of_user(tx, s.user, "password_changed", now)?;
            accounts::void_resets(tx, s.user, now)?;
            accounts::log(tx, now, "password_changed", Some(s.user), "self", None, "")?;
            Ok(())
        })
    })
    .await?;
    // Streams of the ended sessions re-check and close.
    state.auth.revoked(Revoked::User(user));
    state.auth.notify(&email, Notice::PasswordChanged);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecoveryCodes {
    pub recovery_codes: Vec<String>,
}

/// `POST /api/auth/account/recovery-codes` (within the step-up window) →
/// 10 new codes; the old ones stop working. The user is emailed a notice.
pub async fn recovery_codes(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<RecoveryCodes>, ApiError> {
    let s = session(&state, &headers, &timing).await?;
    let now = contracts::now_ms();
    if !state.auth.fresh(&s, now) {
        return Err(ApiError::StepUpRequired);
    }
    let st = state.clone();
    let email = s.email.clone();
    let codes = blocking(move || {
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, |s| {
                s.stage == Stage::Full && st.auth.fresh(s, now)
            })?;
            if accounts::credentials(tx, s.user)?
                .and_then(|c| c.second_factor)
                .is_none()
            {
                return Err(ApiError::Rejected {
                    reason: "no_second_factor".into(),
                    message: "Set up a second factor first.".into(),
                });
            }
            let codes = accounts::new_recovery_codes(tx, &st.auth.keys, s.user)?;
            accounts::log(
                tx,
                now,
                "recovery_codes_renewed",
                Some(s.user),
                "self",
                None,
                "",
            )?;
            Ok(codes)
        })
    })
    .await?;
    state.auth.notify(&email, Notice::RecoveryCodesRenewed);
    Ok(Json(RecoveryCodes {
        recovery_codes: codes,
    }))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionInfo {
    #[ts(type = "number")]
    pub signed_in_at: i64,
    /// Last used (to within a few minutes).
    #[ts(type = "number")]
    pub last_seen: i64,
    /// The browser it was signed in from, as it said.
    pub user_agent: Option<String>,
    /// This browser.
    pub current: bool,
}

/// `GET /api/auth/account/sessions` → your signed-in sessions, most
/// recently used first (S1 M6, ASVS 3.3.4).
pub async fn sessions(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionInfo>>, ApiError> {
    let s = session(&state, &headers, &timing).await?;
    let st = state.clone();
    let list = blocking(move || {
        st.store
            .platform()
            .with_read(|c| sessions::list(c, s.user, &s.id, st.dev_auth, contracts::now_ms()))
    })
    .await?;
    Ok(Json(
        list.into_iter()
            .map(|l| SessionInfo {
                signed_in_at: l.created_at,
                last_seen: l.last_seen,
                user_agent: l.user_agent,
                current: l.current,
            })
            .collect(),
    ))
}

/// `POST /api/auth/account/sessions/sign-out-others`: every session of
/// yours but this one ends, with its live streams.
pub async fn sign_out_others(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let s = session(&state, &headers, &timing).await?;
    let st = state.clone();
    let user = s.user;
    let ended = blocking(move || {
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, |s| s.stage == Stage::Full)?;
            let n = sessions::revoke_others(tx, s.user, &s.id)?;
            // And every phone pairing of the user, this session's
            // included: an unknown phone is what this button is for.
            crate::scans::end_all_of_user(tx, s.user, "signed_out_others", now)?;
            accounts::log(
                tx,
                now,
                "signed_out_others",
                Some(s.user),
                "self",
                None,
                &format!("{n} ended"),
            )?;
            Ok::<_, ApiError>(n)
        })
    })
    .await?;
    state.auth.revoked(Revoked::User(user));
    Ok(Json(serde_json::json!({ "ok": true, "ended": ended })))
}
