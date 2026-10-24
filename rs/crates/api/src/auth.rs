//! Staff auth over HTTP (ADR 0020 §3; the rules and state are in the
//! `auth` crate, the session invariants in `auth::sessions`).
//!
//! - `/api/auth/*`: sign-in, second factor, enrolment, step-up, sign-out,
//!   reset and invite links, the signed-in account ([`flows`], [`links`],
//!   [`account`]).
//! - `/api/t/{slug}/members…`: the members page ([`members`]).
//! - `/api/dev/*`: the dev login, honoured only with `KEEP_DEV_AUTH=1` on a
//!   loopback bind and a loopback `Host` ([`guard`]).
//!
//! The cookie `kt_session` is `HttpOnly; SameSite=Lax; Path=/`, and
//! `Secure` unless the request's `Host` is loopback. Every state-changing
//! `/api` request passes the origin check in [`guard::csrf`].

mod account;
mod flows;
pub mod guard;
mod links;
mod members;

pub(crate) use ::auth::users;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use auth::limits::Limits;
use auth::{Session, Stage};
use axum::extract::connect_info::ConnectInfo;
use axum::extract::{FromRequestParts, State};
use axum::http::header::{COOKIE, HOST, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use comms::mail::{Mail, Mailer};
use serde::{Deserialize, Serialize};
use store::{Store, UserId};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::error::{ApiError, Body};
use crate::timing::Timing;
use crate::{AppState, RoleName, blocking};

pub const COOKIE_NAME: &str = "kt_session";

/// How often a live stream re-checks that its session and membership
/// still exist (a revocation from another process, e.g. `keep auth`,
/// isn't broadcast here).
pub const STREAM_RECHECK: Duration = Duration::from_secs(30);

/// Where links in emails point, and how to find the client's address.
#[derive(Clone, Debug)]
pub struct Config {
    /// The SPA's origin, no trailing slash (`KEEP_APP_ORIGIN`). Links in
    /// emails start here, and it is a trusted `Origin` for [`guard::csrf`].
    pub app_origin: String,
    /// The authenticator app's label.
    pub issuer: String,
    /// A header the proxy in front sets to the client's address
    /// (`KEEP_CLIENT_IP_HEADER`, `Fly-Client-IP` on Fly). Unset: the peer
    /// address. Never set it where clients can reach the api directly.
    pub client_ip_header: Option<HeaderName>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            app_origin: "http://localhost:3000".into(),
            issuer: "keep-together".into(),
            client_ip_header: None,
        }
    }
}

/// A session or a whole user was revoked: live streams re-check.
#[derive(Clone, Debug)]
pub(crate) enum Revoked {
    Session(String),
    User(i64),
}

/// Auth's process state: config, mail, rate limits, revocations.
pub struct Runtime {
    pub config: Config,
    pub mailer: Mailer,
    pub limits: Limits,
    revoked: broadcast::Sender<Revoked>,
}

impl Runtime {
    pub fn new(config: Config, mailer: Mailer) -> Self {
        Self {
            config,
            mailer,
            limits: Limits::default(),
            revoked: broadcast::channel(256).0,
        }
    }

    pub(crate) fn revoked(&self, r: Revoked) {
        let _ = self.revoked.send(r);
    }

    /// Send in the background: a response never waits on (or times) the
    /// mail server, so a reset for an unknown address answers as fast as
    /// one for a known address.
    pub(crate) fn send(&self, mail: Mail) {
        let mailer = self.mailer.clone();
        tokio::spawn(async move {
            let to = mail.to.clone();
            if let Err(e) = mailer.send(mail).await {
                eprintln!("mail to {to}: {e}");
            }
        });
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new(Config::default(), Mailer::log())
    }
}

/// Forget rate-limit keys that have fully replenished (hourly), so the
/// in-memory maps don't grow with every address ever tried.
pub struct LimitSweep(pub Arc<Runtime>);

impl crate::jobs::Job for LimitSweep {
    fn name(&self) -> &'static str {
        "auth-limit-sweep"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60 * 60)
    }
    fn run(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            self.0.limits.sweep();
            Ok(())
        })
    }
}

// ── cookies ────────────────────────────────────────────────────────────────

pub(crate) fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix(COOKIE_NAME)?.strip_prefix('='))
}

/// The host part of `Host` (no port), lower-cased.
pub(crate) fn host(headers: &HeaderMap) -> Option<String> {
    let h = headers.get(HOST)?.to_str().ok()?.to_ascii_lowercase();
    let host = if let Some(rest) = h.strip_prefix('[') {
        format!("[{}]", rest.split(']').next()?)
    } else {
        h.split(':').next()?.to_owned()
    };
    Some(host)
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// `Secure` except when the request came to a loopback host (local dev
/// over plain http). No `Host` at all: `Secure`.
fn secure(headers: &HeaderMap) -> bool {
    !host(headers).is_some_and(|h| is_loopback_host(&h))
}

fn cookie(headers: &HeaderMap, value: &str, max_age_ms: i64) -> Result<HeaderValue, ApiError> {
    let secure = if secure(headers) { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{secure}",
        max_age_ms / 1000
    ))
    .map_err(ApiError::internal)
}

/// `res` with the session cookie set to `token` (a session at `stage`).
pub(crate) fn with_session(
    mut res: Response,
    headers: &HeaderMap,
    token: &str,
    stage: Stage,
) -> Result<Response, ApiError> {
    let ttl = match stage {
        Stage::Full => auth::SESSION_TTL_MS,
        _ => auth::PARTIAL_TTL_MS,
    };
    res.headers_mut()
        .append(SET_COOKIE, cookie(headers, token, ttl)?);
    Ok(res)
}

/// `res` with the session cookie cleared.
pub(crate) fn without_session(
    mut res: Response,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    res.headers_mut()
        .append(SET_COOKIE, cookie(headers, "", 0)?);
    Ok(res)
}

// ── the request's session ──────────────────────────────────────────────────

/// The request's session at any stage, if any.
pub(crate) async fn current(
    state: &AppState,
    headers: &HeaderMap,
    timing: &Timing,
) -> Result<Option<Session>, ApiError> {
    let Some(token) = session_token(headers).map(str::to_owned) else {
        return Ok(None);
    };
    let store = state.store.clone();
    let start = Instant::now();
    let session = blocking(move || {
        store
            .platform()
            .with_read(|c| auth::sessions::get(c, &token, contracts::now_ms()))
    })
    .await?;
    timing.add_platform(start.elapsed());
    // A dev-login session is worthless once dev auth is off.
    Ok(session.filter(|s| state.dev_auth || !s.dev))
}

/// The request's signed-in session (second factor done). Anything less is
/// `401`.
pub(crate) async fn session(
    state: &AppState,
    headers: &HeaderMap,
    timing: &Timing,
) -> Result<Session, ApiError> {
    match current(state, headers, timing).await? {
        Some(s) if s.stage == Stage::Full => Ok(s),
        _ => Err(ApiError::Unauthenticated),
    }
}

/// Whether `s` signed in (or stepped up) within [`auth::STEP_UP_MS`].
pub(crate) fn fresh(s: &Session, now: i64) -> bool {
    s.authenticated_at
        .is_some_and(|at| now - at < auth::STEP_UP_MS)
}

/// The client's address, for rate limits: the configured proxy header,
/// else the peer.
pub(crate) struct ClientIp(pub String);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        if let Some(name) = &state.auth.config.client_ip_header
            && let Some(v) = parts.headers.get(name).and_then(|v| v.to_str().ok())
        {
            return Ok(ClientIp(v.trim().to_owned()));
        }
        Ok(ClientIp(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map_or_else(|| "unknown".into(), |c| c.0.ip().to_string()),
        ))
    }
}

// ── who is signed in ───────────────────────────────────────────────────────

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Membership {
    pub slug: String,
    pub name: String,
    pub role: RoleName,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Me {
    pub email: String,
    pub memberships: Vec<Membership>,
}

/// The signed-in user, for tenant routes that answer about them (`/boot`,
/// the members page, the event stream's end).
#[derive(Clone)]
pub struct Account {
    store: Arc<Store>,
    runtime: Arc<Runtime>,
    session: Session,
}

impl Account {
    pub(crate) fn new(state: &AppState, session: &Session) -> Self {
        Self {
            store: state.store.clone(),
            runtime: state.auth.clone(),
            session: session.clone(),
        }
    }

    pub(crate) fn session(&self) -> &Session {
        &self.session
    }

    /// Who is signed in, and their organisations.
    pub async fn me(&self, timing: &Timing) -> Result<Me, ApiError> {
        let store = self.store.clone();
        let user = UserId(self.session.user);
        let start = Instant::now();
        let members = blocking(move || store.platform().memberships(user)).await?;
        timing.add_platform(start.elapsed());
        Ok(Me {
            email: self.session.email.clone(),
            memberships: members
                .into_iter()
                .map(|m| Membership {
                    slug: m.tenant.slug,
                    name: m.tenant.name,
                    role: m.role.into(),
                })
                .collect(),
        })
    }

    /// Resolves when this session may no longer read `slug`: the session
    /// was revoked (sign-out, revoke-all) or expired, or the membership
    /// ended. Live streams end with it. Subscribes now, not when first
    /// polled, so a revocation in between isn't missed.
    pub fn ended(
        &self,
        slug: String,
    ) -> impl std::future::Future<Output = ()> + Send + 'static + use<> {
        let mut rx = self.runtime.revoked.subscribe();
        let account = self.clone();
        async move {
            let mut tick = tokio::time::interval(STREAM_RECHECK);
            tick.tick().await;
            loop {
                let recheck = tokio::select! {
                    r = rx.recv() => match r {
                        Ok(Revoked::Session(id)) => id == account.session.id,
                        Ok(Revoked::User(user)) => user == account.session.user,
                        Err(broadcast::error::RecvError::Lagged(_)) => true,
                        Err(broadcast::error::RecvError::Closed) => false,
                    },
                    _ = tick.tick() => true,
                };
                if recheck && !account.still_member(&slug).await {
                    return;
                }
            }
        }
    }

    async fn still_member(&self, slug: &str) -> bool {
        let store = self.store.clone();
        let id = self.session.id.clone();
        let user = self.session.user;
        let slug = slug.to_owned();
        let now = contracts::now_ms();
        blocking(move || {
            let live = store
                .platform()
                .with_read(|c| auth::sessions::by_id(c, &id, now))?
                .is_some();
            Ok::<_, ApiError>(live && store.platform().member(UserId(user), &slug)?.is_some())
        })
        .await
        // A failed check ends the stream; the client reconnects.
        .unwrap_or(false)
    }
}

/// `GET /api/me`: who is signed in, and their organisations.
pub async fn me(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<Me>, ApiError> {
    let session = session(&state, &headers, &timing).await?;
    Ok(Json(Account::new(&state, &session).me(&timing).await?))
}

/// `/api/auth/*`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/state", get(flows::state))
        .route("/api/auth/sign-in", post(flows::sign_in))
        .route("/api/auth/second-factor", post(flows::second_factor))
        .route("/api/auth/send-code", post(flows::send_code))
        .route("/api/auth/enrol/totp", post(flows::enrol_totp))
        .route("/api/auth/enrol/email", post(flows::enrol_email))
        .route("/api/auth/enrol/confirm", post(flows::enrol_confirm))
        .route("/api/auth/step-up", post(flows::step_up))
        .route("/api/auth/sign-out", post(flows::sign_out))
        .route("/api/auth/reset/request", post(links::reset_request))
        .route("/api/auth/reset/check", post(links::reset_check))
        .route("/api/auth/reset/complete", post(links::reset_complete))
        .route("/api/auth/invite/check", post(links::invite_check))
        .route("/api/auth/invite/accept", post(links::invite_accept))
        .route("/api/auth/account", get(account::info))
        .route("/api/auth/account/password", post(account::change_password))
        .route(
            "/api/auth/account/recovery-codes",
            post(account::recovery_codes),
        )
}

/// `/api/t/{slug}/members…` (in the tenant router: a member session).
pub fn member_routes() -> Router {
    members::routes()
}

// ── dev login (KEEP_DEV_AUTH) ──────────────────────────────────────────────

/// Whether `KEEP_ENV` names a deployed environment, where `KEEP_DEV_AUTH`
/// stops the boot (it is for local QC only).
pub fn dev_auth_refused(keep_env: Option<&str>) -> bool {
    matches!(keep_env, Some("prod" | "staging"))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub email: String,
}

/// `POST /api/dev/login {email}`: creates the user if new and signs in
/// fully, no password. Refused (403) unless `KEEP_DEV_AUTH=1`.
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(req): Body<LoginRequest>,
) -> Result<Response, ApiError> {
    if !state.dev_auth {
        return Err(ApiError::Forbidden);
    }
    let email = users::normalise_email(&req.email).ok_or_else(|| ApiError::Invalid {
        problems: vec![contracts::Problem::new("email", "an email address")],
    })?;
    let store = state.store.clone();
    let token = blocking(move || {
        store.platform().with_write(|tx| {
            let user = users::upsert(tx, &email)?;
            Ok::<_, ApiError>(auth::sessions::create_dev(tx, user, contracts::now_ms())?)
        })
    })
    .await?;
    with_session(
        Json(serde_json::json!({ "ok": true })).into_response(),
        &headers,
        &token,
        Stage::Full,
    )
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct CreateTenantRequest {
    pub slug: String,
    pub name: String,
}

/// `POST /api/dev/tenants {slug, name}`: a new organisation with the
/// caller as admin. Dev only, like login.
pub async fn create_tenant(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
    Body(req): Body<CreateTenantRequest>,
) -> Result<Json<Membership>, ApiError> {
    if !state.dev_auth {
        return Err(ApiError::Forbidden);
    }
    let session = session(&state, &headers, &timing).await?;
    let store = state.store.clone();
    let tenant = blocking(move || {
        let tenant = store.create_tenant(&req.slug, &req.name)?;
        store
            .platform()
            .set_membership(UserId(session.user), &tenant.id, store::Role::Admin)?;
        Ok::<_, store::StoreError>(tenant)
    })
    .await?;
    Ok(Json(Membership {
        slug: tenant.slug,
        name: tenant.name,
        role: RoleName::Admin,
    }))
}
