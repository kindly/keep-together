//! Sign-in, the second factor, enrolment, step-up and sign-out.
//!
//! A sign-in is two requests: the password makes a partial session
//! (`second_factor`, or `enrol` when the user has no second factor yet),
//! and the code completes it with a new token. Nothing but these routes
//! accepts a partial session.

use auth::accounts::{self, SecondFactor};
use auth::limits::allow;
use auth::{Session, Stage, codes, password, secret, sessions, totp};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use comms::mail::Mail;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    ClientIp, Revoked, current, fresh, session_token, users, with_session, without_session,
};
use crate::error::{ApiError, Body};
use crate::timing::Timing;
use crate::{AppState, blocking};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuthStage {
    SignedOut,
    /// Password checked: enter the code.
    SecondFactor,
    /// Password checked, no second factor yet: set one up.
    Enrol,
    SignedIn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Method {
    Totp,
    Email,
}

impl From<SecondFactor> for Method {
    fn from(f: SecondFactor) -> Self {
        match f {
            SecondFactor::Totp => Method::Totp,
            SecondFactor::Email => Method::Email,
        }
    }
}

/// Where the browser's sign-in stands.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AuthState {
    pub stage: AuthStage,
    pub email: Option<String>,
    /// The second factor to ask for (`second_factor`, `signed_in`).
    pub method: Option<Method>,
    /// Admin-only actions work until then (ms since the epoch).
    #[ts(type = "number | null")]
    pub step_up_until: Option<i64>,
}

impl AuthState {
    pub(crate) const SIGNED_OUT: AuthState = AuthState {
        stage: AuthStage::SignedOut,
        email: None,
        method: None,
        step_up_until: None,
    };
}

pub(crate) fn state_of(conn: &Connection, s: &Session) -> Result<AuthState, ApiError> {
    let method = accounts::credentials(conn, s.user)?
        .and_then(|c| c.second_factor)
        .map(Method::from);
    Ok(AuthState {
        stage: match s.stage {
            Stage::SecondFactor => AuthStage::SecondFactor,
            Stage::Enrol => AuthStage::Enrol,
            Stage::Full => AuthStage::SignedIn,
        },
        email: Some(s.email.clone()),
        method,
        step_up_until: s.authenticated_at.map(|at| at + auth::STEP_UP_MS),
    })
}

fn wrong_credentials() -> ApiError {
    ApiError::Rejected {
        reason: "invalid_credentials".into(),
        message: "Wrong email or password.".into(),
    }
}

pub(crate) fn wrong_code() -> ApiError {
    ApiError::Rejected {
        reason: "wrong_code".into(),
        message: "That code didn't work. Check it and try again.".into(),
    }
}

pub(crate) fn code_mail(to: &str, code: &str) -> Mail {
    Mail {
        to: to.into(),
        subject: format!("Your keep-together code: {code}"),
        text: format!(
            "Your sign-in code is {code}\n\nIt works once, for 15 minutes. If you didn't try to sign in, someone may know your password: change it.\n"
        ),
    }
}

/// `GET /api/auth/state`
pub async fn state(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<AuthState>, ApiError> {
    let Some(s) = current(&state, &headers, &timing).await? else {
        return Ok(Json(AuthState::SIGNED_OUT));
    };
    let store = state.store.clone();
    let out = blocking(move || store.platform().with_read(|c| state_of(c, &s))).await?;
    Ok(Json(out))
}

/// Take one from each password limiter (client IP, email): `429` if
/// either is spent. Unknown emails are limited the same.
pub(crate) fn password_limits(state: &AppState, ip: &str, email: &str) -> Result<(), ApiError> {
    let l = &state.auth.limits;
    if allow(&l.password_ip, ip) && allow(&l.password_email, email) {
        Ok(())
    } else {
        Err(ApiError::RateLimited)
    }
}

pub(crate) fn second_factor_limit(state: &AppState, user: i64) -> Result<(), ApiError> {
    if allow(&state.auth.limits.second_factor, &user.to_string()) {
        Ok(())
    } else {
        Err(ApiError::RateLimited)
    }
}

/// The user and whether `password` is theirs. An unknown email (or a user
/// without a password, e.g. one made by the dev login) is verified
/// against the dummy hash: the same work as a wrong password.
pub(crate) fn check_password(
    state: &AppState,
    email: &str,
    password: &str,
) -> Result<Option<i64>, ApiError> {
    let found = state.store.platform().with_read(|c| {
        let Some(user) = users::by_email(c, email)? else {
            return Ok::<_, ApiError>(None);
        };
        Ok(accounts::credentials(c, user)?.map(|cr| (user, cr.password_hash)))
    })?;
    Ok(match found {
        Some((user, hash)) => password::verify(password, &hash).then_some(user),
        None => {
            password::verify(password, password::dummy_hash());
            None
        }
    })
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct SignIn {
    pub email: String,
    pub password: String,
}

/// `POST /api/auth/sign-in {email, password}` → `AuthState` and a partial
/// session (`second_factor`: an emailed code is sent now if that is the
/// user's method; `enrol`: no second factor yet). Any session the browser
/// had is ended. A wrong email and a wrong password answer the same.
pub async fn sign_in(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<SignIn>,
) -> Result<Response, ApiError> {
    let email =
        users::normalise_email(&req.email).unwrap_or_else(|| req.email.trim().to_lowercase());
    password_limits(&state, &ip, &email)?;
    let old = session_token(&headers).map(secret::hash);
    let st = state.clone();
    let (token, stage, out, code) = blocking(move || {
        let now = contracts::now_ms();
        let user = check_password(&st, &email, &req.password)?;
        st.store
            .platform()
            .with_write(|tx| {
                if let Some(old) = &old {
                    sessions::revoke(tx, old)?;
                }
                let Some(user) = user else {
                    if let Some(known) = users::by_email(tx, &email)? {
                        accounts::log(
                            tx,
                            now,
                            "sign_in_failed",
                            Some(known),
                            "self",
                            None,
                            "password",
                        )?;
                    }
                    return Ok(None);
                };
                let factor = accounts::credentials(tx, user)?.and_then(|c| c.second_factor);
                let stage = if factor.is_some() {
                    Stage::SecondFactor
                } else {
                    Stage::Enrol
                };
                let token = sessions::create(tx, user, stage, now)?;
                let id = secret::hash(&token);
                let code = if factor == Some(SecondFactor::Email) {
                    let code = codes::email_code();
                    sessions::set_email_code(tx, &id, &code, now)?;
                    Some(code)
                } else {
                    None
                };
                accounts::log(tx, now, "sign_in_password", Some(user), "self", None, "")?;
                let s = sessions::by_id(tx, &id, now)?.ok_or(ApiError::Internal)?;
                Ok::<_, ApiError>(Some((token, stage, state_of(tx, &s)?, code)))
            })?
            .ok_or_else(wrong_credentials)
    })
    .await?;
    if let (Some(code), Some(to)) = (code, out.email.as_deref()) {
        state.auth.send(code_mail(to, &code));
    }
    with_session(Json(out).into_response(), &headers, &token, stage)
}

/// Check a code against `s`'s user's second factor: their TOTP app, the
/// code emailed to this session, or an unused recovery code. Commits the
/// attempt either way (TOTP step, emailed-code attempts, recovery code
/// spent), so call it inside the transaction and commit.
pub(crate) fn check_second_factor(
    tx: &Connection,
    s: &Session,
    code: &str,
    now: i64,
) -> Result<bool, ApiError> {
    let Some(creds) = accounts::credentials(tx, s.user)? else {
        return Ok(false);
    };
    if !codes::is_six_digits(code) {
        let used = accounts::use_recovery_code(tx, s.user, code, now)?;
        if used {
            let left = accounts::recovery_codes_left(tx, s.user)?;
            accounts::log(
                tx,
                now,
                "recovery_code_used",
                Some(s.user),
                "self",
                None,
                &format!("{left} left"),
            )?;
        }
        return Ok(used);
    }
    Ok(match (creds.second_factor, creds.totp_secret.as_deref()) {
        (Some(SecondFactor::Totp), Some(secret_b32)) => {
            match totp::verify(secret_b32, code, (now / 1000) as u64, creds.totp_last_step) {
                Some(step) => {
                    accounts::set_totp_step(tx, s.user, step)?;
                    true
                }
                None => false,
            }
        }
        (Some(SecondFactor::Email), _) => sessions::check_email_code(tx, s, code, now)?,
        _ => false,
    })
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct CodeRequest {
    pub code: String,
}

/// `POST /api/auth/second-factor {code}` (a `second_factor` session) →
/// `AuthState`, signed in, with a new token.
pub async fn second_factor(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
    Body(req): Body<CodeRequest>,
) -> Result<Response, ApiError> {
    let s = match current(&state, &headers, &timing).await? {
        Some(s) if s.stage == Stage::SecondFactor => s,
        _ => return Err(ApiError::Unauthenticated),
    };
    second_factor_limit(&state, s.user)?;
    let st = state.clone();
    let done = blocking(move || {
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            if !check_second_factor(tx, &s, &req.code, now)? {
                accounts::log(
                    tx,
                    now,
                    "sign_in_failed",
                    Some(s.user),
                    "self",
                    None,
                    "second factor",
                )?;
                return Ok::<_, ApiError>(None);
            }
            let token = sessions::complete(tx, &s, now)?;
            accounts::log(tx, now, "sign_in", Some(s.user), "self", None, "")?;
            let full = sessions::get(tx, &token, now)?.ok_or(ApiError::Internal)?;
            Ok(Some((token, state_of(tx, &full)?)))
        })
    })
    .await?;
    let (token, out) = done.ok_or_else(wrong_code)?;
    with_session(Json(out).into_response(), &headers, &token, Stage::Full)
}

/// `POST /api/auth/send-code`: email a code to a user whose method is
/// email, for a `second_factor` session (a new code) or a signed-in one
/// (to step up). Rate-limited per address.
pub async fn send_code(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let s = match current(&state, &headers, &timing).await? {
        Some(s) if matches!(s.stage, Stage::SecondFactor | Stage::Full) => s,
        _ => return Err(ApiError::Unauthenticated),
    };
    if !allow(&state.auth.limits.email, &s.email) {
        return Err(ApiError::RateLimited);
    }
    let st = state.clone();
    let to = s.email.clone();
    let code = blocking(move || {
        st.store.platform().with_write(|tx| {
            let factor = accounts::credentials(tx, s.user)?.and_then(|c| c.second_factor);
            if factor != Some(SecondFactor::Email) {
                return Err(ApiError::Rejected {
                    reason: "not_email".into(),
                    message: "Your second factor is an authenticator app.".into(),
                });
            }
            let code = codes::email_code();
            sessions::set_email_code(tx, &s.id, &code, contracts::now_ms())?;
            Ok(code)
        })
    })
    .await?;
    state.auth.send(code_mail(&to, &code));
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// A session that may (re-)enrol a second factor: an `enrol` one, or a
/// signed-in one within the step-up window (changing method).
async fn enrolling(
    state: &AppState,
    headers: &HeaderMap,
    timing: &Timing,
) -> Result<Session, ApiError> {
    match current(state, headers, timing).await? {
        Some(s) if s.stage == Stage::Enrol => Ok(s),
        Some(s) if s.stage == Stage::Full => {
            if fresh(&s, contracts::now_ms()) {
                Ok(s)
            } else {
                Err(ApiError::StepUpRequired)
            }
        }
        _ => Err(ApiError::Unauthenticated),
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TotpEnrolment {
    /// Base32, for typing in by hand.
    pub secret: String,
    /// `otpauth://` for the QR code.
    pub url: String,
    /// The QR code as an SVG document.
    pub qr_svg: String,
}

/// `POST /api/auth/enrol/totp` → a new secret for this session to confirm
/// (`enrol/confirm` with `method: "totp"`). It isn't the user's until
/// confirmed.
pub async fn enrol_totp(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<TotpEnrolment>, ApiError> {
    let s = enrolling(&state, &headers, &timing).await?;
    let secret_b32 = totp::new_secret();
    let url = totp::url(&secret_b32, &state.auth.config.issuer, &s.email);
    let st = state.clone();
    let pending = secret_b32.clone();
    blocking(move || {
        st.store
            .platform()
            .with_write(|tx| sessions::set_pending_secret(tx, &s.id, &pending, contracts::now_ms()))
    })
    .await?;
    Ok(Json(TotpEnrolment {
        qr_svg: totp::qr_svg(&url),
        secret: secret_b32,
        url,
    }))
}

/// `POST /api/auth/enrol/email`: email a code to confirm the emailed
/// method with.
pub async fn enrol_email(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let s = enrolling(&state, &headers, &timing).await?;
    if !allow(&state.auth.limits.email, &s.email) {
        return Err(ApiError::RateLimited);
    }
    let code = codes::email_code();
    let (st, c, id) = (state.clone(), code.clone(), s.id.clone());
    blocking(move || {
        st.store
            .platform()
            .with_write(|tx| sessions::set_email_code(tx, &id, &c, contracts::now_ms()))
    })
    .await?;
    state.auth.send(code_mail(&s.email, &code));
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct ConfirmEnrolment {
    pub method: Method,
    pub code: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Enrolled {
    /// Shown once; each works once instead of a code.
    pub recovery_codes: Vec<String>,
    pub state: AuthState,
}

/// `POST /api/auth/enrol/confirm {method, code}` → the method is the
/// user's second factor, with 10 new recovery codes; an `enrol` session
/// is now signed in (new token), a signed-in one gets a new token.
pub async fn enrol_confirm(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
    Body(req): Body<ConfirmEnrolment>,
) -> Result<Response, ApiError> {
    let s = enrolling(&state, &headers, &timing).await?;
    second_factor_limit(&state, s.user)?;
    let st = state.clone();
    let done = blocking(move || {
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let ok = match req.method {
                Method::Totp => match s.pending_secret.as_deref() {
                    Some(pending) => totp::verify(pending, &req.code, (now / 1000) as u64, 0)
                        .map(|step| {
                            accounts::set_second_factor(
                                tx,
                                s.user,
                                SecondFactor::Totp,
                                Some((pending, step)),
                                now,
                            )
                        })
                        .transpose()?
                        .is_some(),
                    None => false,
                },
                Method::Email => {
                    sessions::check_email_code(tx, &s, &req.code, now)? && {
                        accounts::set_second_factor(tx, s.user, SecondFactor::Email, None, now)?;
                        true
                    }
                }
            };
            if !ok {
                return Ok::<_, ApiError>(None);
            }
            let recovery = accounts::new_recovery_codes(tx, s.user)?;
            let method = match req.method {
                Method::Totp => "totp",
                Method::Email => "email",
            };
            accounts::log(
                tx,
                now,
                "second_factor_enrolled",
                Some(s.user),
                "self",
                None,
                method,
            )?;
            let token = if s.stage == Stage::Enrol {
                sessions::complete(tx, &s, now)?
            } else {
                sessions::set_stage(tx, &s.id, Stage::Full)?;
                sessions::step_up(tx, &s, now)?
            };
            let full = sessions::get(tx, &token, now)?.ok_or(ApiError::Internal)?;
            Ok(Some((
                token,
                Enrolled {
                    recovery_codes: recovery,
                    state: state_of(tx, &full)?,
                },
            )))
        })
    })
    .await?;
    let (token, out) = done.ok_or_else(wrong_code)?;
    with_session(Json(out).into_response(), &headers, &token, Stage::Full)
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct StepUp {
    pub password: String,
    pub code: String,
}

/// `POST /api/auth/step-up {password, code}` (signed in) → `AuthState`
/// with a new token and `stepUpUntil` an hour from now.
pub async fn step_up(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<StepUp>,
) -> Result<Response, ApiError> {
    let s = super::session(&state, &headers, &timing).await?;
    password_limits(&state, &ip, &s.email)?;
    second_factor_limit(&state, s.user)?;
    let st = state.clone();
    let done = blocking(move || {
        let now = contracts::now_ms();
        if check_password(&st, &s.email, &req.password)? != Some(s.user) {
            return Err(wrong_credentials());
        }
        st.store.platform().with_write(|tx| {
            if !check_second_factor(tx, &s, &req.code, now)? {
                return Ok::<_, ApiError>(None);
            }
            let token = sessions::step_up(tx, &s, now)?;
            accounts::log(tx, now, "step_up", Some(s.user), "self", None, "")?;
            let full = sessions::get(tx, &token, now)?.ok_or(ApiError::Internal)?;
            Ok(Some((token, state_of(tx, &full)?)))
        })
    })
    .await?;
    let (token, out) = done.ok_or_else(wrong_code)?;
    with_session(Json(out).into_response(), &headers, &token, Stage::Full)
}

/// `POST /api/auth/sign-out`: the session ends (its live streams too) and
/// the cookie is cleared. Fine without a session.
pub async fn sign_out(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(id) = session_token(&headers).map(secret::hash) {
        let st = state.clone();
        let revoked = id.clone();
        blocking(move || {
            st.store
                .platform()
                .with_write(|tx| sessions::revoke(tx, &revoked))
        })
        .await?;
        state.auth.revoked(Revoked::Session(id));
    }
    without_session(Json(AuthState::SIGNED_OUT).into_response(), &headers)
}
