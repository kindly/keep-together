//! Sign-in, the second factor, enrolment, step-up and sign-out.
//!
//! A sign-in is two requests: the password makes a partial session
//! (`second_factor`, or `enrol` when the user has no second factor yet),
//! and the code completes it with a new token. Nothing but these routes
//! accepts a partial session.
//!
//! Once an address's sign-in password limit is spent, a sign-in needs an
//! emailed code as well (`check_email`; `auth::gate`, S1 M5). Wrong codes
//! are counted (`auth::failures`, S1 M1): five end a partial sign-in, ten
//! in an hour lock the user's second factor for the rest of it.

use auth::accounts::{self, SecondFactor};
use auth::failures::{self, Failure};
use auth::limits::allow;
use auth::notices::Notice;
use auth::{Keys, Session, Stage, codes, gate, password, secret, sessions, totp};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::header::USER_AGENT;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use comms::mail::Mail;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{ClientIp, Revoked, current, session_token, users, with_session, without_session};
use crate::error::{ApiError, Body};
use crate::timing::Timing;
use crate::{AppState, blocking};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuthStage {
    SignedOut,
    /// Too many sign-ins for this address lately: enter the code we
    /// emailed (sent only if the password was right) with the password.
    CheckEmail,
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
    /// `enrol` after a 2FA reset: a code has been emailed, and confirming
    /// an authenticator app needs it too (S1 M7).
    pub needs_email_code: bool,
}

impl AuthState {
    pub(crate) const SIGNED_OUT: AuthState = AuthState {
        stage: AuthStage::SignedOut,
        email: None,
        method: None,
        step_up_until: None,
        needs_email_code: false,
    };
}

pub(crate) fn state_of(conn: &Connection, s: &Session) -> Result<AuthState, ApiError> {
    let creds = accounts::credentials(conn, s.user)?;
    let method = creds
        .as_ref()
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
        needs_email_code: s.stage == Stage::Enrol && creds.is_some_and(|c| c.must_prove_email),
    })
}

fn wrong_credentials() -> ApiError {
    ApiError::Rejected {
        reason: "invalid_credentials".into(),
        message: "Wrong email or password.".into(),
    }
}

/// `s` as it is now, inside the write transaction: the request's own read
/// may be stale (a double submit, a revoke-all in between). Gone, or no
/// longer at a stage `ok` accepts: `401`.
pub(crate) fn reread(
    tx: &Connection,
    s: &Session,
    now: i64,
    ok: impl Fn(&Session) -> bool,
) -> Result<Session, ApiError> {
    sessions::by_id(tx, &s.id, now)?
        .filter(|fresh| ok(fresh))
        .ok_or(ApiError::Unauthenticated)
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
            "Your sign-in code is {code}\n\nIt works once, for 10 minutes. If you didn't try to sign in, someone may know your password: change it.\n"
        ),
    }
}

/// The browser's `User-Agent`, for the sessions list.
pub(crate) fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
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

/// Take one from the client-IP and the user's password limiters (a
/// signed-in user, or an invited existing account): `429` if either is
/// spent. Nobody else can spend the user's.
pub(crate) fn user_password_limits(state: &AppState, ip: &str, user: i64) -> Result<(), ApiError> {
    let l = &state.auth.limits;
    if allow(&l.password_ip, ip) && allow(&l.password_user, &user.to_string()) {
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

/// A password just verified: whose, and the stored hash it matched.
pub(crate) struct Verified {
    pub user: i64,
    hash: String,
}

impl Verified {
    /// Whether the password is still the one verified, inside the write
    /// transaction: argon2 runs before it, and a reset or change that
    /// committed in between must win (S1 codex C3).
    pub(crate) fn still(&self, tx: &Connection) -> Result<bool, ApiError> {
        Ok(accounts::credentials(tx, self.user)?.is_some_and(|c| c.password_hash == self.hash))
    }
}

/// Whether `password` is `email`'s, and the hash it matched. An unknown
/// email (or a user without a password, e.g. one made by the dev login)
/// is verified against the dummy hash: the same work as a wrong password.
pub(crate) fn verify_password(
    state: &AppState,
    email: &str,
    password: &str,
) -> Result<Option<Verified>, ApiError> {
    let found = state.store.platform().with_read(|c| {
        let Some(user) = users::by_email(c, email)? else {
            return Ok::<_, ApiError>(None);
        };
        Ok(accounts::credentials(c, user)?.map(|cr| (user, cr.password_hash)))
    })?;
    Ok(match found {
        Some((user, hash)) => password::verify(password, &hash).then_some(Verified { user, hash }),
        None => {
            password::verify(password, password::dummy_hash());
            None
        }
    })
}

/// The user whose password `password` is, if any ([`verify_password`]).
pub(crate) fn check_password(
    state: &AppState,
    email: &str,
    password: &str,
) -> Result<Option<i64>, ApiError> {
    Ok(verify_password(state, email, password)?.map(|v| v.user))
}

/// A partial sign-in just made.
pub(crate) struct Partial {
    pub token: String,
    pub stage: Stage,
    pub state: AuthState,
    /// An emailed code to send now.
    pub code: Option<String>,
}

/// Start a partial sign-in for `user`, whose password (or invite) was just
/// proven: `second_factor`, or `enrol` without one. An emailed code goes
/// out now when the user's method is email, or when enrolling after a 2FA
/// reset (S1 M7). `mailbox_proven`: an emailed code was just entered too
/// ([`gate`]), which is the whole second factor for the emailed method,
/// so that user is signed in at once.
pub(crate) fn start_partial(
    tx: &Connection,
    keys: &Keys,
    user: i64,
    user_agent: Option<&str>,
    mailbox_proven: bool,
    now: i64,
) -> Result<Partial, ApiError> {
    let creds = accounts::credentials(tx, user)?;
    let factor = creds.as_ref().and_then(|c| c.second_factor);
    let stage = match factor {
        Some(SecondFactor::Email) if mailbox_proven => Stage::Full,
        Some(_) => Stage::SecondFactor,
        None => Stage::Enrol,
    };
    let token = sessions::create(tx, user, stage, now)?;
    let id = secret::hash(&token);
    if let Some(ua) = user_agent {
        sessions::set_user_agent(tx, &id, ua)?;
    }
    let proof = factor.is_none() && creds.is_some_and(|c| c.must_prove_email);
    let code = if (factor == Some(SecondFactor::Email) && stage != Stage::Full) || proof {
        let code = codes::email_code();
        sessions::set_email_code(tx, keys, &id, &code, now)?;
        Some(code)
    } else {
        None
    };
    let s = sessions::by_id(tx, &id, now)?.ok_or(ApiError::Internal)?;
    Ok(Partial {
        token,
        stage,
        state: state_of(tx, &s)?,
        code,
    })
}

/// Check a code for `s` with `check`, counting a wrong one (S1 M1). A
/// locked user's codes aren't checked at all. `Err(failure)`: refused.
pub(crate) fn verify_code(
    tx: &Connection,
    s: &Session,
    now: i64,
    check: impl FnOnce() -> Result<bool, ApiError>,
) -> Result<Result<(), Failure>, ApiError> {
    if failures::locked(tx, s.user, now)? {
        if s.stage != Stage::Full {
            sessions::revoke(tx, &s.id)?;
        }
        return Ok(Err(Failure::Locked { notify: false }));
    }
    if check()? {
        Ok(Ok(()))
    } else {
        Ok(Err(failures::record(tx, s.user, Some(s), now)?))
    }
}

fn locked() -> ApiError {
    ApiError::Rejected {
        reason: "locked".into(),
        message: "Too many wrong codes, so signing in is paused for an hour. We've emailed you. If it wasn't you, reset your password.".into(),
    }
}

fn sign_in_again() -> ApiError {
    ApiError::Rejected {
        reason: "sign_in_again".into(),
        message: "Too many wrong codes. Sign in again.".into(),
    }
}

/// The answer to a refused code. A partial sign-in that `failure` ended
/// gets its cookie cleared; a lock that just happened emails the user.
pub(crate) fn refused(
    state: &AppState,
    headers: &HeaderMap,
    email: &str,
    failure: Failure,
) -> Result<Response, ApiError> {
    let ended = match failure {
        Failure::TryAgain => return Err(wrong_code()),
        Failure::SignInAgain => sign_in_again(),
        Failure::Locked { notify } => {
            if notify {
                state.auth.notify(email, Notice::Locked);
            }
            locked()
        }
    };
    without_session(ended.into_response(), headers)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SignIn {
    pub email: String,
    pub password: String,
    /// The emailed code, after a `check_email` answer.
    #[serde(default)]
    #[ts(optional)]
    pub email_code: Option<String>,
}

enum SignedIn {
    Started(Partial),
    /// Over the address's limit: "check your email" (and the code to send,
    /// if the password was right).
    CheckEmail(Option<String>),
    /// Over the limit, with a code: the password or the code was wrong
    /// (one answer for both). A lock this caused is to be notified.
    Wrong {
        notify: bool,
    },
    /// Under the limit: a wrong email or password (committed, so the
    /// failure stays logged).
    WrongPassword,
}

/// `POST /api/auth/sign-in {email, password, emailCode?}` → `AuthState`
/// and a partial session (`second_factor`: an emailed code is sent now if
/// that is the user's method; `enrol`: no second factor yet). Any session
/// the browser had is ended. A wrong email and a wrong password answer the
/// same.
///
/// Once the address's password limit is spent the answer is `check_email`
/// whatever the password, with no session; only a right password mails a
/// code. Sending the password again with that code carries on as above.
pub async fn sign_in(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<SignIn>,
) -> Result<Response, ApiError> {
    // C6: an address that can't be one is refused before it becomes a
    // limiter key (at most 254 characters).
    let email = users::normalise_email(&req.email).ok_or_else(|| ApiError::Invalid {
        problems: vec![contracts::Problem::new("email", "an email address")],
    })?;
    let l = &state.auth.limits;
    if !allow(&l.password_ip, &ip) {
        return Err(ApiError::RateLimited);
    }
    let gated = !allow(&l.password_email, &email);
    // Without mail the gate can't send its code: refuse, as before M5.
    if gated && state.auth.mailer.is_off() {
        return Err(ApiError::RateLimited);
    }
    let old = session_token(&headers).map(secret::hash);
    let ua = user_agent(&headers);
    let st = state.clone();
    let to = email.clone();
    let (done, ended) = blocking(move || {
        let now = contracts::now_ms();
        let keys = &st.auth.keys;
        let verified = verify_password(&st, &email, &req.password)?;
        st.store.platform().with_write(|tx| {
            // C3: a password reset or change since argon2 ran: wrong now.
            let user = match &verified {
                Some(v) if v.still(tx)? => Some(v.user),
                _ => None,
            };
            // Logged for unknown addresses too (no user, no address), so
            // both do the same write (C7).
            let failed = |tx: &Connection| -> Result<(), ApiError> {
                let known = users::by_email(tx, &email)?;
                accounts::log(tx, now, "sign_in_failed", known, "self", None, "password")?;
                Ok(())
            };
            if gated {
                let Some(user) = user else {
                    failed(tx)?;
                    return Ok(match req.email_code {
                        None => (SignedIn::CheckEmail(None), None),
                        Some(_) => (SignedIn::Wrong { notify: false }, None),
                    });
                };
                let Some(code) = req.email_code.as_deref() else {
                    accounts::log(tx, now, "sign_in_gated", Some(user), "self", None, "")?;
                    let code = (!failures::locked(tx, user, now)?)
                        .then(|| gate::issue(tx, keys, user, now))
                        .transpose()?;
                    return Ok((SignedIn::CheckEmail(code), None));
                };
                if failures::locked(tx, user, now)? {
                    return Ok((SignedIn::Wrong { notify: false }, None));
                }
                if !gate::check(tx, keys, user, code, now)? {
                    accounts::log(
                        tx,
                        now,
                        "sign_in_failed",
                        Some(user),
                        "self",
                        None,
                        "emailed code",
                    )?;
                    let notify = matches!(
                        failures::record(tx, user, None, now)?,
                        Failure::Locked { notify: true }
                    );
                    return Ok((SignedIn::Wrong { notify }, None));
                }
            }
            let Some(user) = user else {
                failed(tx)?;
                return Ok((SignedIn::WrongPassword, None));
            };
            if let Some(old) = &old {
                sessions::revoke(tx, old)?;
            }
            accounts::log(tx, now, "sign_in_password", Some(user), "self", None, "")?;
            let partial = start_partial(tx, keys, user, ua.as_deref(), gated, now)?;
            if partial.stage == Stage::Full {
                accounts::log(tx, now, "sign_in", Some(user), "self", None, "emailed code")?;
            }
            Ok::<_, ApiError>((SignedIn::Started(partial), old.clone()))
        })
    })
    .await?;
    if let Some(old) = ended {
        state.auth.revoked(Revoked::Session(old));
    }
    match done {
        SignedIn::Started(p) => {
            if let (Some(code), Some(to)) = (p.code, p.state.email.as_deref()) {
                state.auth.send(code_mail(to, &code));
            }
            with_session(Json(p.state).into_response(), &headers, &p.token, p.stage)
        }
        SignedIn::CheckEmail(code) => {
            if let Some(code) = code
                && allow(&state.auth.limits.email, &to)
            {
                state.auth.send(code_mail(&to, &code));
            }
            Ok(Json(AuthState {
                stage: AuthStage::CheckEmail,
                email: Some(to),
                method: None,
                step_up_until: None,
                needs_email_code: false,
            })
            .into_response())
        }
        SignedIn::WrongPassword => Err(wrong_credentials()),
        SignedIn::Wrong { notify } => {
            if notify {
                state.auth.notify(&to, Notice::Locked);
            }
            Err(ApiError::Rejected {
                reason: "invalid_credentials".into(),
                message: "Wrong password or code.".into(),
            })
        }
    }
}

/// Check a code against `s`'s user's second factor: their TOTP app, the
/// code emailed to this session, or an unused recovery code. Commits the
/// attempt either way (TOTP step, emailed-code attempts, recovery code
/// spent), so call it inside the transaction and commit.
pub(crate) fn check_second_factor(
    tx: &Connection,
    keys: &Keys,
    s: &Session,
    code: &str,
    now: i64,
) -> Result<bool, ApiError> {
    let Some(creds) = accounts::credentials(tx, s.user)? else {
        return Ok(false);
    };
    if !codes::is_six_digits(code) {
        let used = accounts::use_recovery_code(tx, keys, s.user, code, now)?;
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
    Ok(match creds.second_factor {
        Some(SecondFactor::Totp) => match creds.totp_secret(keys, s.user) {
            Some(secret_b32) => {
                match totp::verify(&secret_b32, code, (now / 1000) as u64, creds.totp_last_step) {
                    Some(step) => {
                        accounts::set_totp_step(tx, s.user, step)?;
                        true
                    }
                    None => false,
                }
            }
            None => false,
        },
        Some(SecondFactor::Email) => sessions::check_email_code(tx, keys, s, code, now)?,
        None => false,
    })
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct CodeRequest {
    pub code: String,
}

/// `POST /api/auth/second-factor {code}` (a `second_factor` session) →
/// `AuthState`, signed in, with a new token. A wrong code counts (module
/// docs): `wrong_code`, then `sign_in_again` or `locked` with the cookie
/// cleared.
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
    let email = s.email.clone();
    let done = blocking(move || {
        let now = contracts::now_ms();
        let keys = &st.auth.keys;
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, |s| s.stage == Stage::SecondFactor)?;
            let verdict = verify_code(tx, &s, now, || {
                check_second_factor(tx, keys, &s, &req.code, now)
            })?;
            if let Err(failure) = verdict {
                accounts::log(
                    tx,
                    now,
                    "sign_in_failed",
                    Some(s.user),
                    "self",
                    None,
                    "second factor",
                )?;
                return Ok::<_, ApiError>(Err(failure));
            }
            let token = sessions::complete(tx, &s, now)?;
            accounts::log(tx, now, "sign_in", Some(s.user), "self", None, "")?;
            let full = sessions::get(tx, &token, now)?.ok_or(ApiError::Internal)?;
            Ok(Ok((token, state_of(tx, &full)?)))
        })
    })
    .await?;
    match done {
        Ok((token, out)) => with_session(Json(out).into_response(), &headers, &token, Stage::Full),
        Err(failure) => refused(&state, &headers, &email, failure),
    }
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
    state.auth.require_mail()?;
    if !allow(&state.auth.limits.email, &s.email) {
        return Err(ApiError::RateLimited);
    }
    let st = state.clone();
    let to = s.email.clone();
    let code = blocking(move || {
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, |s| {
                matches!(s.stage, Stage::SecondFactor | Stage::Full)
            })?;
            let factor = accounts::credentials(tx, s.user)?.and_then(|c| c.second_factor);
            if factor != Some(SecondFactor::Email) {
                return Err(ApiError::Rejected {
                    reason: "not_email".into(),
                    message: "Your second factor is an authenticator app.".into(),
                });
            }
            let code = codes::email_code();
            sessions::set_email_code(tx, &st.auth.keys, &s.id, &code, now)?;
            Ok(code)
        })
    })
    .await?;
    state.auth.send(code_mail(&to, &code));
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Whether `s` may (re-)enrol a second factor: an `enrol` session, or a
/// signed-in one (changing method; confirming that needs the password
/// and the current factor, S1 codex C2).
fn may_enrol(s: &Session) -> bool {
    matches!(s.stage, Stage::Enrol | Stage::Full)
}

/// A session that may (re-)enrol a second factor ([`may_enrol`]).
async fn enrolling(
    state: &AppState,
    headers: &HeaderMap,
    timing: &Timing,
) -> Result<Session, ApiError> {
    match current(state, headers, timing).await? {
        Some(s) if may_enrol(&s) => Ok(s),
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
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, may_enrol)?;
            sessions::set_pending_secret(tx, &st.auth.keys, &s, &pending, now)?;
            Ok::<_, ApiError>(())
        })
    })
    .await?;
    Ok(Json(TotpEnrolment {
        qr_svg: totp::qr_svg(&url),
        secret: secret_b32,
        url,
    }))
}

/// `POST /api/auth/enrol/email`: email a code to confirm the emailed
/// method with (or, after a 2FA reset, a new code to go with an
/// authenticator app).
pub async fn enrol_email(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let s = enrolling(&state, &headers, &timing).await?;
    state.auth.require_mail()?;
    if !allow(&state.auth.limits.email, &s.email) {
        return Err(ApiError::RateLimited);
    }
    let code = codes::email_code();
    let (st, c) = (state.clone(), code.clone());
    let to = s.email.clone();
    blocking(move || {
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, may_enrol)?;
            sessions::set_email_code(tx, &st.auth.keys, &s.id, &c, now)?;
            Ok::<_, ApiError>(())
        })
    })
    .await?;
    state.auth.send(code_mail(&to, &code));
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConfirmEnrolment {
    pub method: Method,
    pub code: String,
    /// After a 2FA reset (`needsEmailCode`), the emailed code too when
    /// `method` is `totp`.
    #[serde(default)]
    #[ts(optional)]
    pub email_code: Option<String>,
    /// Changing method while signed in: your password...
    #[serde(default)]
    #[ts(optional)]
    pub password: Option<String>,
    /// ...and a code from your current second factor (or a recovery code).
    #[serde(default)]
    #[ts(optional)]
    pub current_code: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Enrolled {
    /// Shown once; each works once instead of a code.
    pub recovery_codes: Vec<String>,
    pub state: AuthState,
}

/// The new factor's code checks out (inside the transaction): an
/// authenticator app's against the secret this session is enrolling, and
/// after a 2FA reset the emailed code too (S1 M7: the emailed method's own
/// code is that proof). Stores the factor if so.
fn confirm_new_factor(
    tx: &Connection,
    keys: &Keys,
    s: &Session,
    req: &ConfirmEnrolment,
    must_prove: bool,
    now: i64,
) -> Result<bool, ApiError> {
    Ok(match req.method {
        Method::Totp => {
            let step = sessions::pending_secret(keys, s).and_then(|pending| {
                totp::verify(&pending, &req.code, (now / 1000) as u64, 0)
                    .map(|step| (pending, step))
            });
            // The app's code first (no side effect), then the emailed one,
            // which a check spends.
            let proven = step.is_some()
                && (!must_prove
                    || sessions::check_email_code(
                        tx,
                        keys,
                        s,
                        req.email_code.as_deref().unwrap_or(""),
                        now,
                    )?);
            match step.filter(|_| proven) {
                Some((pending, step)) => {
                    accounts::set_second_factor(
                        tx,
                        keys,
                        s.user,
                        SecondFactor::Totp,
                        Some((&pending, step)),
                        now,
                    )?;
                    true
                }
                None => false,
            }
        }
        Method::Email => {
            sessions::check_email_code(tx, keys, s, &req.code, now)? && {
                accounts::set_second_factor(tx, keys, s.user, SecondFactor::Email, None, now)?;
                true
            }
        }
    })
}

/// `POST /api/auth/enrol/confirm {method, code, emailCode?, password?,
/// currentCode?}` → the method is the user's second factor, with 10 new
/// recovery codes, and every other session of the user ends.
///
/// - An `enrol` session (no factor yet) is signed in with a new token. If
///   the user has a factor by now (another session enrolled first), it is
///   refused and ended: it can't replace that factor (S1 codex C1). After
///   a 2FA reset an authenticator app also needs the emailed code (M7).
/// - A signed-in session changes method only with the password and a code
///   from the current factor (or a recovery code), and gets a new token
///   whose sign-in time is unchanged: changing a factor isn't a step-up
///   (codex C2).
///
/// Wrong codes count as in [`second_factor`]. The user is emailed a notice.
pub async fn enrol_confirm(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<ConfirmEnrolment>,
) -> Result<Response, ApiError> {
    let s = enrolling(&state, &headers, &timing).await?;
    second_factor_limit(&state, s.user)?;
    if s.stage == Stage::Full {
        user_password_limits(&state, &ip, s.user)?;
    }
    let st = state.clone();
    let email = s.email.clone();
    let user = s.user;
    let done = blocking(move || {
        let now = contracts::now_ms();
        let keys = &st.auth.keys;
        let verified = match s.stage {
            Stage::Full => {
                let password = req.password.as_deref().unwrap_or("");
                match verify_password(&st, &s.email, password)? {
                    Some(v) if v.user == s.user => Some(v),
                    _ => return Err(wrong_credentials()),
                }
            }
            _ => None,
        };
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, may_enrol)?;
            let creds = accounts::credentials(tx, s.user)?.ok_or(ApiError::Unauthenticated)?;
            if s.stage == Stage::Enrol && creds.second_factor.is_some() {
                // C1: a factor was set up since this sign-in began.
                sessions::revoke(tx, &s.id)?;
                return Ok(Err(None));
            }
            if s.stage == Stage::Full {
                match &verified {
                    Some(v) if v.still(tx)? => {}
                    _ => return Err(wrong_credentials()),
                }
                if req.method == Method::Email && creds.second_factor == Some(SecondFactor::Email) {
                    return Err(ApiError::Rejected {
                        reason: "same_method".into(),
                        message: "Your second factor is already a code emailed to you.".into(),
                    });
                }
            }
            let must_prove = s.stage == Stage::Enrol && creds.must_prove_email;
            let verdict = verify_code(tx, &s, now, || {
                if s.stage == Stage::Full
                    && !check_second_factor(
                        tx,
                        keys,
                        &s,
                        req.current_code.as_deref().unwrap_or(""),
                        now,
                    )?
                {
                    return Ok(false);
                }
                confirm_new_factor(tx, keys, &s, &req, must_prove, now)
            })?;
            if let Err(failure) = verdict {
                return Ok::<_, ApiError>(Err(Some(failure)));
            }
            let recovery = accounts::new_recovery_codes(tx, keys, s.user)?;
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
                sessions::rotate(tx, &s)?
            };
            // C1: whoever else was signed in, or half signed in, is out.
            sessions::revoke_others(tx, s.user, &secret::hash(&token))?;
            let full = sessions::get(tx, &token, now)?.ok_or(ApiError::Internal)?;
            Ok(Ok((
                token,
                Enrolled {
                    recovery_codes: recovery,
                    state: state_of(tx, &full)?,
                },
            )))
        })
    })
    .await?;
    match done {
        Ok((token, out)) => {
            state.auth.revoked(Revoked::User(user));
            let factor = match req_method(&out) {
                Method::Totp => SecondFactor::Totp,
                Method::Email => SecondFactor::Email,
            };
            state.auth.notify(&email, Notice::FactorSet(factor));
            with_session(Json(out).into_response(), &headers, &token, Stage::Full)
        }
        Err(None) => without_session(ApiError::Unauthenticated.into_response(), &headers),
        Err(Some(failure)) => refused(&state, &headers, &email, failure),
    }
}

/// The method an enrolment set (its state's method).
fn req_method(out: &Enrolled) -> Method {
    out.state.method.unwrap_or(Method::Totp)
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct StepUp {
    pub password: String,
    pub code: String,
}

/// `POST /api/auth/step-up {password, code}` (signed in) → `AuthState`
/// with a new token and `stepUpUntil` an hour from now. A wrong code
/// counts towards the user's lock.
pub async fn step_up(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<StepUp>,
) -> Result<Response, ApiError> {
    let s = super::session(&state, &headers, &timing).await?;
    user_password_limits(&state, &ip, s.user)?;
    second_factor_limit(&state, s.user)?;
    let st = state.clone();
    let email = s.email.clone();
    let done = blocking(move || {
        let now = contracts::now_ms();
        if check_password(&st, &s.email, &req.password)? != Some(s.user) {
            return Err(wrong_credentials());
        }
        let keys = &st.auth.keys;
        st.store.platform().with_write(|tx| {
            let s = reread(tx, &s, now, |s| s.stage == Stage::Full)?;
            let verdict = verify_code(tx, &s, now, || {
                check_second_factor(tx, keys, &s, &req.code, now)
            })?;
            if let Err(failure) = verdict {
                return Ok::<_, ApiError>(Err(failure));
            }
            let token = sessions::step_up(tx, &s, now)?;
            accounts::log(tx, now, "step_up", Some(s.user), "self", None, "")?;
            let full = sessions::get(tx, &token, now)?.ok_or(ApiError::Internal)?;
            Ok(Ok((token, state_of(tx, &full)?)))
        })
    })
    .await?;
    match done {
        Ok((token, out)) => with_session(Json(out).into_response(), &headers, &token, Stage::Full),
        // A full session isn't ended by wrong codes: only told.
        Err(Failure::Locked { notify }) => {
            if notify {
                state.auth.notify(&email, Notice::Locked);
            }
            Err(locked())
        }
        Err(_) => Err(wrong_code()),
    }
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
