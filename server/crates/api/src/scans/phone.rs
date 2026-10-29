//! The paired phone's routes, outside the tenant prefix: `/api/scan/{token}`
//! (module docs in [`super`]). No session: the token and the device
//! cookie are the only credentials, and they reach one org's file, for
//! uploads and the sitting's own scans only.
//!
//! | route | |
//! |---|---|
//! | `GET /api/scan/{token}` | claim (first device) or reopen: `ScanSitting` |
//! | `POST /api/scan/{token}/scans?id=` | body: one page's image → `ScanUploaded`, a new draft |
//! | `POST /api/scan/{token}/scans/{scanId}/pages?pageId=` | body: the next page → `ScanUploaded` |
//!
//! An upload's token and cookie are checked before its body is read
//! ([`precheck`], from `api::body`), and the body is then held to
//! [`super::UPLOAD_BODY_LIMIT`].

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::header::{CACHE_CONTROL, COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, Method};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use giftaid::scans::{self as domain, MAX_PAGE_BYTES, MAX_PAGES, Status};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    DEV_DEVICE_COOKIE, DEVICE_COOKIE, HARD_CAP_MS, Live, MAX_UPLOADS, Purpose, Target, Uploaded,
    Use,
};
use crate::error::ApiError;
use crate::routes::Params;
use crate::{AppState, blocking};

pub const PREFIX: &str = "/api/scan/";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/scan/{token}", get(open))
        .route("/api/scan/{token}/scans", post(new_scan))
        .route("/api/scan/{token}/scans/{scan_id}/pages", post(add_page))
}

/// What the phone may know of its sitting.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanSitting {
    pub org_name: String,
    pub purpose: Purpose,
    #[ts(type = "number")]
    pub expires_at: i64,
    /// When the link ends if the phone sends nothing before then.
    #[ts(type = "number")]
    pub idle_expires_at: i64,
    #[ts(type = "number")]
    pub uploads_left: i64,
    pub max_pages: usize,
    #[ts(type = "number")]
    pub max_page_bytes: i64,
    /// This sitting's scans, oldest first: ids and page counts, nothing
    /// else.
    pub scans: Vec<SittingScan>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SittingScan {
    pub id: String,
    pub pages: usize,
    /// Still a draft: pages can be added.
    pub open: bool,
}

/// The device cookie's value on this request, if any.
fn device_token(headers: &HeaderMap) -> Option<&str> {
    let name = device_cookie_name(headers);
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix(name)?.strip_prefix('='))
        .filter(|t| ::auth::secret::well_formed(t))
}

fn device_cookie_name(headers: &HeaderMap) -> &'static str {
    if crate::auth::cookie_name(headers) == crate::auth::COOKIE_NAME {
        DEVICE_COOKIE
    } else {
        DEV_DEVICE_COOKIE
    }
}

fn device_cookie(headers: &HeaderMap, token: &str) -> Result<HeaderValue, ApiError> {
    let secure = if device_cookie_name(headers) == DEVICE_COOKIE {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{secure}",
        device_cookie_name(headers),
        HARD_CAP_MS / 1000
    ))
    .map_err(ApiError::internal)
}

/// From `api::body`, before an upload's body is read: the pairing must
/// be live and this device's, or the request ends here. The pairing goes
/// into the request for the handler.
pub async fn precheck(state: &AppState, req: &mut Request) -> Result<(), ApiError> {
    if req.method() != Method::POST {
        return Ok(());
    }
    let Some(token) = token_of(req.uri().path()) else {
        return Err(ApiError::Gone);
    };
    let live = resolve(state, token, req.headers(), Use::Upload).await?;
    req.extensions_mut().insert(live);
    Ok(())
}

/// The `{token}` of a `/api/scan/{token}/…` path.
fn token_of(path: &str) -> Option<String> {
    let rest = path.strip_prefix(PREFIX)?;
    Some(rest.split('/').next()?.to_owned())
}

async fn resolve(
    state: &AppState,
    token: String,
    headers: &HeaderMap,
    how: Use,
) -> Result<Live, ApiError> {
    let store = state.store.clone();
    let device = device_token(headers).map(::auth::secret::hash);
    blocking(move || {
        super::resolve(&store, &token, device.as_deref(), how, contracts::now_ms())
            .map_err(ApiError::from)
    })
    .await
}

#[derive(Deserialize)]
struct TokenParam {
    token: String,
}

/// `GET /api/scan/{token}`: the first device to open the link claims it
/// (a new device cookie if it has none), and it answers what the phone
/// may know. Another device: `403`. Dead: `410`.
async fn open(
    State(state): State<AppState>,
    Path(TokenParam { token }): Path<TokenParam>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (minted, headers_for_claim) = match device_token(&headers) {
        Some(_) => (None, headers.clone()),
        None => {
            let fresh = ::auth::secret::token();
            let mut h = headers.clone();
            h.insert(
                COOKIE,
                HeaderValue::from_str(&format!("{}={fresh}", device_cookie_name(&headers)))
                    .map_err(ApiError::internal)?,
            );
            (Some(fresh), h)
        }
    };
    let live = resolve(&state, token, &headers_for_claim, Use::Claim).await?;
    let sitting = sitting(&state, live).await?;
    let mut res = Json(sitting).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(fresh) = minted {
        res.headers_mut()
            .append(SET_COOKIE, device_cookie(&headers, &fresh)?);
    }
    Ok(res)
}

async fn sitting(state: &AppState, live: Live) -> Result<ScanSitting, ApiError> {
    let store = state.store.clone();
    blocking(move || {
        let db = store.org(&live.tenant)?;
        let pairing_id = live.pairing.id.clone();
        let scans = db.read(move |r| domain::by_pairing(r, &pairing_id))?;
        Ok::<_, ApiError>(ScanSitting {
            org_name: live.org_name,
            purpose: live.pairing.purpose,
            expires_at: live.pairing.expires_at,
            idle_expires_at: live.pairing.idle_expires_at(),
            uploads_left: MAX_UPLOADS - live.pairing.uploads,
            max_pages: MAX_PAGES,
            max_page_bytes: MAX_PAGE_BYTES,
            scans: scans
                .into_iter()
                .map(|s| SittingScan {
                    id: s.id,
                    pages: s.pages.len(),
                    open: s.status == Status::Draft && s.image_deleted_at.is_none(),
                })
                .collect(),
        })
    })
    .await
}

/// `?id=` / `?pageId=`: the phone's own key for what it uploads, so a
/// retry is the same scan or page.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Keys {
    pub id: Option<String>,
    pub page_id: Option<String>,
}

impl Keys {
    pub fn checked(self) -> Result<Self, ApiError> {
        for (field, value) in [("id", &self.id), ("pageId", &self.page_id)] {
            if value
                .as_deref()
                .is_some_and(|v| !contracts::is_client_id(v))
            {
                return Err(ApiError::Invalid {
                    problems: vec![contracts::Problem::new(
                        field,
                        "32 lower-case hex characters",
                    )],
                });
            }
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
struct PageParams {
    token: String,
    scan_id: String,
}

/// `POST /api/scan/{token}/scans`: the first page of a new draft.
async fn new_scan(
    State(state): State<AppState>,
    Extension(live): Extension<Live>,
    Path(TokenParam { token }): Path<TokenParam>,
    Params(keys): Params<Keys>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Uploaded>, ApiError> {
    let keys = keys.checked()?;
    receive(
        &state,
        live,
        token,
        &headers,
        Target::New { id: keys.id },
        body,
    )
    .await
}

/// `POST /api/scan/{token}/scans/{scanId}/pages`: the next page of one of
/// this sitting's drafts.
async fn add_page(
    State(state): State<AppState>,
    Extension(live): Extension<Live>,
    Path(PageParams { token, scan_id }): Path<PageParams>,
    Params(keys): Params<Keys>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Uploaded>, ApiError> {
    let keys = keys.checked()?;
    let target = Target::Page {
        scan_id,
        page_id: keys.page_id,
    };
    receive(&state, live, token, &headers, target, body).await
}

async fn receive(
    state: &AppState,
    checked: Live,
    token: String,
    headers: &HeaderMap,
    target: Target,
    body: Bytes,
) -> Result<Json<Uploaded>, ApiError> {
    // The body took up to 30 s: the pairing may have ended meanwhile.
    let live = resolve(state, token, headers, Use::Upload).await?;
    if live.pairing.id != checked.pairing.id {
        return Err(ApiError::Gone);
    }
    let (store, limits) = (state.store.clone(), state.scans.clone());
    let out = blocking(move || {
        let left = super::take_upload(&store, &live.pairing.id)?;
        let db = store.org(&live.tenant)?;
        let page = super::store_page(&db, &body, &limits)?;
        let scan_id = super::upload(
            &db,
            live.pairing.user_id,
            Some(&live.pairing.id),
            target,
            page,
        )?;
        let pages = super::page_count(&db, &scan_id)?;
        Ok::<_, ApiError>(Uploaded {
            scan_id,
            pages,
            uploads_left: Some(left),
        })
    })
    .await?;
    Ok(Json(out))
}
