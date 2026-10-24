//! `keep-api`: the spike's server. Env:
//! - `KEEP_DATA_DIR` (default `data`): platform.db + orgs/
//! - `KEEP_PORT` (default 8787), `KEEP_BIND` (default 127.0.0.1; the
//!   image sets 0.0.0.0)
//! - `KEEP_DEV_AUTH=1`: allow the dev session cookie
//! - `KEEP_STATIC_DIR`: serve the built SPA from there (`static_files`)
//! - `KEEP_RESET_SEED=riverside`: seed an empty store (`reset`)
//! - `KEEP_SNAPSHOT_*`, `KEEP_ENV`: hourly snapshots (`backup`)
//! - `KEEP_LITESTREAM_SOCKET`: Litestream's control socket, for `/healthz`
//! - `SENTRY_DSN`: error reporting (`observe`)

use std::net::IpAddr;
use std::sync::Arc;

use api::backup::{self, SnapshotConfig, SnapshotJob};
use api::{AppState, app, schema};
use store::{Store, StoreConfig};

#[tokio::main]
async fn main() {
    let _sentry = api::observe::init_sentry();
    let dir = std::env::var("KEEP_DATA_DIR").unwrap_or_else(|_| "data".into());
    let port: u16 = std::env::var("KEEP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let bind: IpAddr = std::env::var("KEEP_BIND")
        .ok()
        .map(|b| b.parse().expect("KEEP_BIND is an IP address"))
        .unwrap_or([127, 0, 0, 1].into());
    let dev_auth = std::env::var("KEEP_DEV_AUTH").is_ok_and(|v| v == "1");
    let store = Arc::new(
        Store::open(StoreConfig {
            dir: dir.clone().into(),
            org_migrations: schema::org_migrations(),
            readers: 4,
        })
        .expect("open data dir"),
    );
    if api::reset::seed_from_env(&store).expect("KEEP_RESET_SEED") {
        eprintln!("seeded {}", api::reset::SLUG);
    }

    let snapshots = SnapshotConfig::from_env(dir.as_ref()).expect("snapshot settings");
    backup::init_health(
        dir.as_ref(),
        snapshots.is_some(),
        std::env::var_os("KEEP_LITESTREAM_SOCKET").map(Into::into),
    );
    if let Some(config) = snapshots {
        // The first run a minute after boot (`first_after`), then hourly.
        backup::spawn(Arc::new(SnapshotJob::new(config)));
    }

    let state = AppState {
        store: store.clone(),
        dev_auth,
    };
    let mut router = backup::healthz_route(app(state, api::routes::router()), store);
    if let Some(static_dir) = api::static_files::dir_from_env() {
        router = api::static_files::with_static(router, static_dir);
    }
    let listener = tokio::net::TcpListener::bind((bind, port))
        .await
        .expect("bind");
    eprintln!("keep-api on http://{bind}:{port} (data {dir}, dev auth {dev_auth})");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve");
}

/// Ctrl-C, or SIGTERM (Litestream forwards it to the app it runs).
async fn shutdown() {
    let term = async {
        #[cfg(unix)]
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
        #[cfg(not(unix))]
        std::future::pending::<()>().await;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term => {}
    }
}
