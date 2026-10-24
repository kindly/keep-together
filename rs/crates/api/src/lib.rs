//! The HTTP API: JSON over HTTP, one `POST` per contract command, `GET`s
//! for reads. Conventions are in `rs/README.md`.

pub mod auth;
pub mod backup;
pub mod boot;
pub mod error;
pub mod events;
pub mod health;
pub mod jobs;
pub mod observe;
pub mod reset;
pub mod routes;
pub mod schema;
pub mod static_files;
pub mod tenant;
pub mod timing;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::{Router, middleware};
use serde::{Deserialize, Serialize};
use store::{Role, Store};
use ts_rs::TS;

pub use error::{ApiError, Body};
pub use tenant::Tenant;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    /// `KEEP_DEV_AUTH=1`: dev login allowed and sessions honoured.
    pub dev_auth: bool,
}

#[derive(Clone, Copy, Debug, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "Role")]
pub enum RoleName {
    Admin,
    Staff,
    Viewer,
}

impl From<Role> for RoleName {
    fn from(role: Role) -> Self {
        match role {
            Role::Admin => RoleName::Admin,
            Role::Staff => RoleName::Staff,
            Role::Viewer => RoleName::Viewer,
        }
    }
}

/// Dev auth (and every `/api/dev/*` route) only on a loopback bind (M1): a
/// server reachable from elsewhere never accepts the dev login, whatever
/// `KEEP_DEV_AUTH` says.
pub fn dev_auth_allowed(requested: bool, bind: std::net::IpAddr) -> bool {
    requested && bind.is_loopback()
}

/// Path parameters for tenant routes: always a named-field struct, since
/// the nested `{slug}` is a parameter too (`Path<String>` fails with two).
/// `Path(IdParam { id })` for `…/{id}/…`.
#[derive(Deserialize)]
pub struct IdParam {
    pub id: String,
}

/// Run blocking SQLite work off the async runtime.
pub async fn blocking<T, E>(
    f: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, ApiError>
where
    T: Send + 'static,
    E: Into<ApiError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(out) => out.map_err(Into::into),
        Err(join) => Err(ApiError::internal(join)),
    }
}

/// The whole app. `domain` holds the tenant routes (paths relative to
/// `/api/t/{slug}`); its handlers get a [`Tenant`] and nothing else.
pub fn app(state: AppState, domain: Router) -> Router {
    let tenant_routes = Router::new()
        .route("/", get(tenant::info))
        .route("/events", get(events::events))
        .route("/boot", get(boot::boot))
        .merge(domain)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            tenant::middleware,
        ))
        // Stateless: tenant handlers can't extract `AppState`.
        .with_state::<AppState>(());
    Router::new()
        .route("/api/dev/login", post(auth::login))
        .route("/api/dev/logout", post(auth::logout))
        .route("/api/dev/tenants", post(auth::create_tenant))
        .route("/api/dev/qc-seed", post(routes::qc_seed::fixture))
        .route("/api/dev/qc-crowd", post(routes::qc_seed::crowd))
        .route("/api/me", get(auth::me))
        .route("/api/groups", get(routes::groups::mine))
        .route("/api/groups/{slug}/opened", post(routes::groups::opened))
        .route("/healthz", get(health::healthz))
        .nest("/api/t/{slug}", tenant_routes)
        .with_state(state)
        .layer(middleware::from_fn(timing::middleware))
}
