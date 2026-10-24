//! `keep-api`: the spike's server. Env:
//! - `KEEP_DATA_DIR` (default `data`): platform.db + orgs/
//! - `KEEP_PORT` (default 8787), bound on 127.0.0.1
//! - `KEEP_DEV_AUTH=1`: allow the dev session cookie

use std::sync::Arc;

use api::{AppState, app, schema};
use axum::Router;
use store::{Store, StoreConfig};

#[tokio::main]
async fn main() {
    let dir = std::env::var("KEEP_DATA_DIR").unwrap_or_else(|_| "data".into());
    let port: u16 = std::env::var("KEEP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let dev_auth = std::env::var("KEEP_DEV_AUTH").is_ok_and(|v| v == "1");
    let store = Store::open(StoreConfig {
        dir: dir.clone().into(),
        org_migrations: schema::org_migrations(),
        readers: 4,
    })
    .expect("open data dir");
    let state = AppState {
        store: Arc::new(store),
        dev_auth,
    };
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind");
    eprintln!("keep-api on http://127.0.0.1:{port} (data {dir}, dev auth {dev_auth})");
    axum::serve(listener, app(state, Router::new()))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}
