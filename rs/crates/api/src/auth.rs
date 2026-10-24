//! The stubbed auth: a dev session cookie. Every session is a dev session,
//! so with `KEEP_DEV_AUTH` unset nobody can log in and no existing cookie
//! is honoured either.

use std::time::Instant;

use axum::extract::State;
use axum::http::header::{COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use store::Session;
use ts_rs::TS;

use crate::error::{ApiError, Body};
use crate::timing::Timing;
use crate::{AppState, RoleName, blocking};

pub const COOKIE_NAME: &str = "kt_session";

pub(crate) fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix(COOKIE_NAME)?.strip_prefix('='))
}

/// The request's session, timed as platform work.
pub(crate) async fn session(
    state: &AppState,
    headers: &HeaderMap,
    timing: &Timing,
) -> Result<Session, ApiError> {
    if !state.dev_auth {
        return Err(ApiError::Unauthenticated);
    }
    let token = session_token(headers).ok_or(ApiError::Unauthenticated)?.to_owned();
    let store = state.store.clone();
    let start = Instant::now();
    let session = blocking(move || store.platform().session(&token)).await?;
    timing.add_platform(start.elapsed());
    session.ok_or(ApiError::Unauthenticated)
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub email: String,
}

/// `POST /api/dev/login {email}`: creates the user if new and sets the
/// session cookie. Refused (403) unless `KEEP_DEV_AUTH=1`.
pub async fn login(
    State(state): State<AppState>,
    Body(req): Body<LoginRequest>,
) -> Result<Response, ApiError> {
    if !state.dev_auth {
        return Err(ApiError::Forbidden);
    }
    let email = req.email.trim().to_owned();
    if !email.contains('@') {
        return Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new("email", "an email address")],
        });
    }
    let store = state.store.clone();
    let token = blocking(move || {
        let user = store.platform().upsert_user(&email)?;
        store.platform().create_session(user, contracts::now_ms())
    })
    .await?;
    let cookie = format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax");
    let mut res = Json(serde_json::json!({ "ok": true })).into_response();
    res.headers_mut()
        .insert(SET_COOKIE, HeaderValue::from_str(&cookie).map_err(ApiError::internal)?);
    Ok(res)
}

/// `POST /api/dev/logout`
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    if let Some(token) = session_token(&headers).map(str::to_owned) {
        let store = state.store.clone();
        blocking(move || store.platform().delete_session(&token)).await?;
    }
    let mut res = Json(serde_json::json!({ "ok": true })).into_response();
    res.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_static("kt_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"),
    );
    Ok(res)
}

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

/// `GET /api/me`: who is logged in, and their organisations.
pub async fn me(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<Me>, ApiError> {
    let session = session(&state, &headers, &timing).await?;
    let store = state.store.clone();
    let start = Instant::now();
    let members = blocking(move || store.platform().memberships(session.user)).await?;
    timing.add_platform(start.elapsed());
    Ok(Json(Me {
        email: session.email,
        memberships: members
            .into_iter()
            .map(|m| Membership {
                slug: m.tenant.slug,
                name: m.tenant.name,
                role: m.role.into(),
            })
            .collect(),
    }))
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
    let session = session(&state, &headers, &timing).await?;
    let store = state.store.clone();
    let tenant = blocking(move || {
        let tenant = store.create_tenant(&req.slug, &req.name)?;
        store
            .platform()
            .set_membership(session.user, &tenant.id, store::Role::Admin)?;
        Ok::<_, store::StoreError>(tenant)
    })
    .await?;
    Ok(Json(Membership {
        slug: tenant.slug,
        name: tenant.name,
        role: RoleName::Admin,
    }))
}
