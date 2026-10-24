//! `keep-api`. Env:
//! - `KEEP_DATA_DIR` (default `data`): platform.db + orgs/
//! - `KEEP_BIND` (default 127.0.0.1; Fly sets 0.0.0.0), `KEEP_PORT` (default 8787)
//! - `KEEP_MAX_OPEN_ORGS` (default 64): org files kept open beyond those in use
//! - `KEEP_DEV_AUTH=1`: allow the dev session cookie — honoured only when
//!   bound to a loopback address (M1)
//! - `KEEP_STATIC_DIR`: serve the built SPA from there (`static_files`)
//! - `KEEP_RESET_SEED=riverside`: seed an empty store (`reset`)
//! - `KEEP_SNAPSHOT_*`, `KEEP_ENV`: hourly snapshots (`backup`)
//! - `KEEP_LITESTREAM_SOCKET`: Litestream's control socket, for `/healthz`
//! - `SENTRY_DSN`: error reporting (`observe`)
//! - auth (`auth_runtime`): `KEEP_APP_ORIGIN`, `KEEP_CLIENT_IP_HEADER`,
//!   `KEEP_MAIL`/`KEEP_SMTP_URL`/`KEEP_MAIL_FROM`; with `KEEP_ENV=prod` or
//!   `staging`, `KEEP_DEV_AUTH` stops the boot
//!
//! Every org file is migrated before the server listens; a file that
//! won't migrate stops the boot, naming the org.

use std::net::IpAddr;
use std::sync::Arc;

use api::backup::{self, SnapshotConfig, SnapshotJob};
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
    let _sentry = api::observe::init_sentry();
    let dir: String = env("KEEP_DATA_DIR", "data".into());
    let bind: IpAddr = env("KEEP_BIND", IpAddr::from([127, 0, 0, 1]));
    let port: u16 = env("KEEP_PORT", 8787);
    let max_open: usize = env("KEEP_MAX_OPEN_ORGS", StoreConfig::DEFAULT_MAX_OPEN);
    let requested = std::env::var("KEEP_DEV_AUTH").is_ok_and(|v| v == "1");
    let dev_auth = dev_auth_allowed(requested, bind);
    if requested && !dev_auth {
        eprintln!("KEEP_DEV_AUTH ignored: the server binds {bind}, not a loopback address");
    }

    let store = Store::open_with(
        StoreConfig {
            dir: dir.clone().into(),
            org_migrations: schema::org_migrations(),
            readers: 4,
            max_open,
        },
        schema::PLATFORM_SCHEMAS,
    )
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
    // After the migrations: the seed writes through the head schema.
    match api::reset::seed_from_env(&store) {
        Ok(true) => eprintln!("seeded {}", api::reset::SLUG),
        Ok(false) => {}
        Err(e) => {
            eprintln!("KEEP_RESET_SEED: {e}");
            std::process::exit(1)
        }
    }
    let store = Arc::new(store);

    let snapshots = SnapshotConfig::from_env(dir.as_ref()).unwrap_or_else(|e| {
        eprintln!("snapshot settings: {e}");
        std::process::exit(1)
    });
    // After Sentry: a restore marker that needs review is reported here.
    backup::init_health(
        dir.as_ref(),
        snapshots.is_some(),
        std::env::var_os("KEEP_LITESTREAM_SOCKET").map(Into::into),
    );
    let mut jobs = jobs::standard(&store);
    if let Some(config) = snapshots {
        // A minute after boot (`first_after`), then hourly.
        jobs.register(SnapshotJob::new(config));
    }
    jobs.spawn();

    let state = AppState::new(store, dev_auth).with_auth(auth_runtime(dev_auth));
    let mut router = app(state, api::routes::router());
    if let Some(static_dir) = api::static_files::dir_from_env() {
        router = api::static_files::with_static(router, static_dir);
    }
    let listener = tokio::net::TcpListener::bind((bind, port))
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind {bind}:{port}: {e}");
            std::process::exit(1)
        });
    eprintln!("keep-api on http://{bind}:{port} (data {dir}, dev auth {dev_auth})");
    // The peer address feeds the auth rate limits (unless
    // KEEP_CLIENT_IP_HEADER names the proxy's header).
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
        .await
        .expect("serve");
}

/// Auth's settings from the env; refuses (exits) what a deployed
/// environment must never run with.
fn auth_runtime(dev_auth: bool) -> api::auth::Runtime {
    let deployed = matches!(
        std::env::var("KEEP_ENV").as_deref(),
        Ok("prod" | "staging")
    );
    if deployed && std::env::var("KEEP_DEV_AUTH").is_ok_and(|v| v == "1") {
        eprintln!("KEEP_DEV_AUTH=1 is refused with KEEP_ENV=prod|staging");
        std::process::exit(2)
    }
    debug_assert!(!(deployed && dev_auth));
    let mailer = comms::mail::Mailer::from_env().unwrap_or_else(|e| {
        eprintln!("mail settings: {e}");
        std::process::exit(2)
    });
    if mailer.is_log() && std::env::var("KEEP_ENV").as_deref() == Ok("prod") {
        eprintln!("KEEP_MAIL=log is refused with KEEP_ENV=prod: set KEEP_MAIL=smtp");
        std::process::exit(2)
    }
    let mut config = api::auth::Config::default();
    if let Ok(origin) = std::env::var("KEEP_APP_ORIGIN") {
        config.app_origin = origin.trim_end_matches('/').to_owned();
    } else if deployed {
        eprintln!("KEEP_APP_ORIGIN is required with KEEP_ENV=prod|staging (links in emails)");
        std::process::exit(2)
    }
    if let Ok(name) = std::env::var("KEEP_CLIENT_IP_HEADER") {
        config.client_ip_header = Some(name.parse().unwrap_or_else(|_| {
            eprintln!("KEEP_CLIENT_IP_HEADER={name:?} is not a header name");
            std::process::exit(2)
        }));
    }
    api::auth::Runtime::new(config, mailer)
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
