//! `keep-api`. Env:
//! - `KEEP_DATA_DIR` (default `data`): platform.db + orgs/
//! - `KEEP_BIND` (default 127.0.0.1; Fly sets 0.0.0.0), `KEEP_PORT` (default 8787)
//! - `KEEP_MAX_OPEN_ORGS` (default 64): org files kept open beyond those in use
//! - `KEEP_DEV_AUTH=1`: allow the dev session cookie — honoured only when
//!   bound to a loopback address (M1)
//!
//! Every org file is migrated before the server listens; a file that
//! won't migrate stops the boot, naming the org.

use std::net::IpAddr;
use std::sync::Arc;

use api::{AppState, app, dev_auth_allowed, jobs, schema};
use store::{Store, StoreConfig};

fn env<T: std::str::FromStr>(name: &str, default: T) -> T {
    match std::env::var(name) {
        Ok(v) => v.parse().unwrap_or_else(|_| {
            eprintln!("{name}={v:?} is not valid");
            std::process::exit(2)
        }),
        Err(_) => default,
    }
}

#[tokio::main]
async fn main() {
    let dir: String = env("KEEP_DATA_DIR", "data".into());
    let bind: IpAddr = env("KEEP_BIND", IpAddr::from([127, 0, 0, 1]));
    let port: u16 = env("KEEP_PORT", 8787);
    let max_open: usize = env("KEEP_MAX_OPEN_ORGS", StoreConfig::DEFAULT_MAX_OPEN);
    let requested = std::env::var("KEEP_DEV_AUTH").is_ok_and(|v| v == "1");
    let dev_auth = dev_auth_allowed(requested, bind);
    if requested && !dev_auth {
        eprintln!("KEEP_DEV_AUTH ignored: the server binds {bind}, not a loopback address");
    }

    let store = Store::open(StoreConfig {
        dir: dir.clone().into(),
        org_migrations: schema::org_migrations(),
        readers: 4,
        max_open,
    })
    .unwrap_or_else(|e| {
        eprintln!("open data dir {dir}: {e}");
        std::process::exit(1)
    });
    match store.migrate_all() {
        Ok(0) => {}
        Ok(n) => eprintln!("migrated {n} organisation file(s)"),
        Err(e) => {
            eprintln!("boot stopped: {e}");
            std::process::exit(1)
        }
    }
    let store = Arc::new(store);
    jobs::standard(&store).spawn();

    let state = AppState { store, dev_auth };
    let listener = tokio::net::TcpListener::bind((bind, port))
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind {bind}:{port}: {e}");
            std::process::exit(1)
        });
    eprintln!("keep-api on http://{bind}:{port} (data {dir}, dev auth {dev_auth})");
    axum::serve(listener, app(state, api::routes::router()))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}
