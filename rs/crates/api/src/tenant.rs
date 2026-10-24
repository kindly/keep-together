//! `/api/t/{slug}/…`: session → membership in `platform.db` → the one
//! org file this request may touch.
//!
//! Tenant routes are a stateless `Router`: a handler can't extract the
//! `AppState` (so can't reach the `Store`), only the [`Tenant`] this
//! middleware put in the request, which holds a single `OrgDb`.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{OriginalUri, Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use contracts::Ctx;
use serde::Serialize;
use store::{OrgDb, OrgRead, Role, Store, UserId};
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
    /// When this session last proved password + second factor.
    authenticated_at: i64,
    timing: Timing,
    /// For [`Tenant::write`]'s re-check only (handlers never see it).
    store: Arc<Store>,
    /// The session's stored hash.
    session_id: String,
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
    ///
    /// The session and the role are checked again first, on `platform.db`:
    /// the middleware's check ran before the body arrived, which a client
    /// can delay at will, and a sign-out, removal or demotion in between
    /// must stop the write (S1 codex C5). What remains is the moment
    /// between this check and the org file's transaction (two files).
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
        let store = self.store.clone();
        let session = self.session_id.clone();
        let slug = self.slug.clone();
        blocking(move || {
            let start = Instant::now();
            let now = contracts::now_ms();
            let live = store
                .platform()
                .with_read(|c| ::auth::sessions::by_id(c, &session, now))?
                .is_some_and(|s| s.user == user && s.stage == ::auth::Stage::Full);
            if !live {
                return Err(ApiError::Unauthenticated);
            }
            match store.platform().member(UserId(user), &slug)? {
                Some(m) if m.role >= Role::Staff => {}
                _ => return Err(ApiError::Forbidden),
            }
            timing.add_platform(start.elapsed());
            let start = Instant::now();
            let out = contracts::transact(&db, Some(user), f);
            timing.add_db(start.elapsed());
            out
        })
        .await
    }
}

impl Tenant {
    /// Admin-only routes: role `admin`, and a sign-in (or step-up) within
    /// the last hour (ADR 0020), else `403 step_up_required`.
    pub fn require_admin(&self) -> Result<(), ApiError> {
        if self.role < Role::Admin {
            return Err(ApiError::Forbidden);
        }
        if contracts::now_ms() - self.authenticated_at >= ::auth::STEP_UP_MS {
            return Err(ApiError::StepUpRequired);
        }
        Ok(())
    }

    /// This organisation's committed changes as SSE, resuming after
    /// `Last-Event-ID` if given (see [`crate::events`]).
    pub async fn events(
        &self,
        last_event_id: Option<&str>,
    ) -> Result<
        impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>
        + Send
        + 'static
        + use<>,
        ApiError,
    > {
        crate::events::stream(self.db.clone(), last_event_id).await
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
    // Writes need staff or above, whatever the route: a viewer's command
    // is refused here, before its body is read or its ids looked up, so no
    // write route can forget (the roles meta-test in `tests/roles.rs`).
    let reads = matches!(*req.method(), Method::GET | Method::HEAD);
    let resolved = async {
        let req = &mut req;
        let session = auth::session(&state, &headers, &timing).await?;
        let slug = slug(&uri).ok_or(ApiError::NotFound)?.to_owned();
        let store = state.store.clone();
        let start = Instant::now();
        let found = blocking(move || {
            // Unknown slug and someone else's organisation read the same.
            let Some(member) = store
                .platform()
                .member(store::UserId(session.user), &slug)?
            else {
                return Err(ApiError::Forbidden);
            };
            let db = store.org(&member.tenant.id)?;
            Ok((member, db))
        })
        .await;
        timing.add_platform(start.elapsed());
        let (member, db) = found?;
        if !reads && member.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        req.extensions_mut()
            .insert(auth::Account::new(&state, &session));
        Ok::<_, ApiError>(Tenant {
            db,
            slug: member.tenant.slug,
            name: member.tenant.name,
            role: member.role,
            user: session.user,
            authenticated_at: session.authenticated_at.unwrap_or(0),
            timing: timing.clone(),
            store: state.store.clone(),
            session_id: session.id.clone(),
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

#[cfg(test)]
mod tests {
    use store::StoreConfig;

    use super::*;

    /// S1 codex C5: `write` checks the session and the role on
    /// `platform.db` itself, so a sign-out or a demotion after the
    /// middleware's check (e.g. while the handler ran) stops the write.
    #[tokio::test]
    async fn a_write_rechecks_the_session_and_role() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(
            Store::open_with(
                StoreConfig {
                    dir: tmp.path().to_path_buf(),
                    org_migrations: crate::schema::org_migrations(),
                    readers: 1,
                    max_open: 4,
                },
                crate::schema::PLATFORM_SCHEMAS,
            )
            .unwrap(),
        );
        let t = store.create_tenant("alpha", "Alpha").unwrap();
        let p = store.platform();
        let cat = p.upsert_user("cat@alpha.org").unwrap();
        p.set_membership(cat, &t.id, Role::Staff).unwrap();
        let now = contracts::now_ms();
        let token = p
            .with_write(|tx| ::auth::sessions::create(tx, cat.0, ::auth::Stage::Full, now))
            .unwrap();
        let tenant = Tenant {
            db: store.org(&t.id).unwrap(),
            slug: "alpha".into(),
            name: "Alpha".into(),
            role: Role::Staff,
            user: cat.0,
            authenticated_at: now,
            timing: Timing::default(),
            store: store.clone(),
            session_id: ::auth::secret::hash(&token),
        };
        let write = || tenant.write(|_ctx| Ok(()));
        assert!(write().await.is_ok());
        p.set_membership(cat, &t.id, Role::Viewer).unwrap();
        assert!(matches!(write().await, Err(ApiError::Forbidden)));
        p.set_membership(cat, &t.id, Role::Staff).unwrap();
        p.with_write(|tx| ::auth::sessions::revoke_user(tx, cat.0))
            .unwrap();
        assert!(matches!(write().await, Err(ApiError::Unauthenticated)));
    }
}
