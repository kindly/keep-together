//! The HTTP API: JSON over HTTP, one `POST` per contract command, `GET`s
//! for reads. Conventions are in `server/README.md`.

pub mod address;
pub mod auth;
pub mod backup;
pub mod body;
pub mod boot;
pub mod error;
pub mod events;
pub mod gocardless;
pub mod health;
pub mod jobs;
pub mod observe;
pub mod reset;
pub mod routes;
pub mod scans;
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
    /// `KEEP_DEV_AUTH=1` (loopback only): the dev login is allowed.
    pub dev_auth: bool,
    /// Auth's config, mailer, rate limits and revocations.
    pub auth: Arc<auth::Runtime>,
    /// `/api/qc/*` (`KEEP_QC_TOKEN` on staging); off when `None`.
    pub qc: Option<Arc<routes::qc_seed::QcAccess>>,
    /// `KEEP_ADDRESS_LOOKUP` ([`address`]); off when `None`.
    pub address: Option<Arc<address::Lookup>>,
    /// `KEEP_GOCARDLESS` ([`gocardless`]); off when `None`.
    pub gocardless: Option<Arc<gocardless::GoCardless>>,
    /// Scan uploads' cap, disk reserve and slots ([`scans::limits`]).
    pub scans: Arc<scans::limits::ScanLimits>,
}

impl AppState {
    /// With auth's defaults: links to `http://localhost:3000`, mail to
    /// the log. [`AppState::with_auth`] for anything else.
    pub fn new(store: Arc<Store>, dev_auth: bool) -> Self {
        Self {
            store,
            dev_auth,
            auth: Arc::new(auth::Runtime::default()),
            qc: None,
            address: None,
            gocardless: None,
            scans: Arc::default(),
        }
    }

    pub fn with_scan_limits(mut self, limits: Arc<scans::limits::ScanLimits>) -> Self {
        self.scans = limits;
        self
    }

    pub fn with_gocardless(mut self, gc: Option<Arc<gocardless::GoCardless>>) -> Self {
        self.gocardless = gc;
        self
    }

    pub fn with_address(mut self, lookup: Option<address::Lookup>) -> Self {
        self.address = lookup.map(Arc::new);
        self
    }

    pub fn with_qc(mut self, qc: Option<routes::qc_seed::QcAccess>) -> Self {
        self.qc = qc.map(Arc::new);
        self
    }

    pub fn with_auth(mut self, runtime: auth::Runtime) -> Self {
        self.auth = Arc::new(runtime);
        self
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
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

impl From<RoleName> for Role {
    fn from(role: RoleName) -> Self {
        match role {
            RoleName::Admin => Role::Admin,
            RoleName::Staff => Role::Staff,
            RoleName::Viewer => Role::Viewer,
        }
    }
}

impl std::fmt::Display for RoleName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(Role::from(*self).as_str())
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
        .merge(auth::member_routes())
        .merge(domain)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            tenant::middleware,
        ))
        // Stateless: tenant handlers can't extract `AppState`.
        .with_state::<AppState>(());
    let fake = state.gocardless.as_ref().and_then(|gc| gc.fake.clone());
    let mut router = Router::new()
        .route("/api/dev/login", post(auth::login))
        .route("/api/dev/tenants", post(auth::create_tenant))
        .route("/api/dev/qc-seed", post(routes::qc_seed::fixture))
        .route("/api/dev/qc-crowd", post(routes::qc_seed::crowd))
        .route("/api/dev/qc-hold", post(routes::qc_seed::hold))
        .route("/api/qc/seed", post(routes::qc_seed::qc_fixture))
        .route("/api/qc/crowd", post(routes::qc_seed::qc_crowd))
        .route("/api/qc/hold", post(routes::qc_seed::qc_hold))
        .route("/api/qc/session", post(routes::qc_seed::qc_session))
        .route("/api/me", get(auth::me))
        .route("/api/groups", get(routes::groups::mine))
        .route("/api/groups/{slug}/opened", post(routes::groups::opened))
        .route("/healthz", get(health::healthz))
        .route("/api/gocardless/callback", get(gocardless::oauth::callback))
        .route(
            "/api/gocardless/webhook",
            post(gocardless::webhook::receive),
        )
        .merge(auth::routes())
        .merge(scans::phone::router())
        .nest("/api/t/{slug}", tenant_routes);
    if let Some(fake) = fake {
        router = router.nest(gocardless::FAKE_PREFIX, gocardless::fake::router(fake));
    }
    router
        .layer(middleware::from_fn_with_state(state.clone(), body::buffer))
        .layer(middleware::from_fn(auth::guard::dev_host))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::guard::csrf,
        ))
        .with_state(state)
        .layer(middleware::from_fn(timing::middleware))
}
