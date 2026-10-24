//! `/api/t/{slug}/…`: session → membership in `platform.db` → the one
//! org file this request may touch.
//!
//! Tenant routes are a stateless `Router`: a handler can't extract the
//! `AppState` (so can't reach the `Store`), only the [`Tenant`] this
//! middleware put in the request, which holds a single `OrgDb`.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{OriginalUri, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use contracts::Ctx;
use serde::Serialize;
use store::{OrgDb, OrgRead, Role};
use ts_rs::TS;

use crate::error::ApiError;
use crate::timing::Timing;
use crate::{AppState, RoleName, auth, blocking};

/// The organisation a request is scoped to, and who is asking.
#[derive(Clone)]
pub struct Tenant {
    db: Arc<OrgDb>,
    pub slug: String,
    pub name: String,
    pub role: Role,
    /// The platform user id: revisions' `actor`.
    pub user: i64,
    timing: Timing,
}

impl Tenant {
    /// Read one consistent snapshot of this organisation's file.
    pub async fn read<T, F>(&self, f: F) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(&OrgRead) -> Result<T, ApiError> + Send + 'static,
    {
        let db = self.db.clone();
        let timing = self.timing.clone();
        blocking(move || {
            let start = Instant::now();
            let out = db.read(f);
            timing.add_db(start.elapsed());
            out
        })
        .await
    }

    /// Run commands in one `BEGIN IMMEDIATE` transaction on this
    /// organisation's file, as this user. Needs `staff` or above.
    pub async fn write<T, F>(&self, f: F) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(&Ctx) -> Result<T, ApiError> + Send + 'static,
    {
        if self.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        let db = self.db.clone();
        let timing = self.timing.clone();
        let user = self.user;
        blocking(move || {
            let start = Instant::now();
            let out = db.write(|tx| f(&Ctx::new(tx, Some(user))));
            timing.add_db(start.elapsed());
            out
        })
        .await
    }
}

/// The `{slug}` in `/api/t/{slug}/…`.
fn slug(uri: &OriginalUri) -> Option<&str> {
    let rest = uri.path().strip_prefix("/api/t/")?;
    let slug = rest.split('/').next()?;
    (!slug.is_empty()).then_some(slug)
}

pub(crate) async fn middleware(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    uri: OriginalUri,
    mut req: Request,
    next: Next,
) -> Response {
    let headers = req.headers().clone();
    let resolved = async {
        let session = auth::session(&state, &headers, &timing).await?;
        let slug = slug(&uri).ok_or(ApiError::NotFound)?.to_owned();
        let store = state.store.clone();
        let start = Instant::now();
        let found = blocking(move || {
            // Unknown slug and someone else's organisation read the same.
            let Some(member) = store.platform().member(session.user, &slug)? else {
                return Err(ApiError::Forbidden);
            };
            let db = store.org(&member.tenant.id)?;
            Ok((member, db))
        })
        .await;
        timing.add_platform(start.elapsed());
        let (member, db) = found?;
        Ok::<_, ApiError>(Tenant {
            db,
            slug: member.tenant.slug,
            name: member.tenant.name,
            role: member.role,
            user: session.user.0,
            timing: timing.clone(),
        })
    }
    .await;
    match resolved {
        Ok(tenant) => {
            req.extensions_mut().insert(tenant);
            next.run(req).await
        }
        Err(err) => err.into_response(),
    }
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TenantInfo {
    pub slug: String,
    pub name: String,
    pub role: RoleName,
}

/// `GET /api/t/{slug}`
pub async fn info(Extension(tenant): Extension<Tenant>) -> Json<TenantInfo> {
    Json(TenantInfo {
        slug: tenant.slug,
        name: tenant.name,
        role: tenant.role.into(),
    })
}
