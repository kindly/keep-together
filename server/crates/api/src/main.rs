//! `keep-api`. Env:
//! - `KEEP_DATA_DIR` (default `data`): platform.db + orgs/
//! - `KEEP_BIND` (default 127.0.0.1; Fly sets 0.0.0.0), `KEEP_PORT` (default 8787)
//! - `KEEP_MAX_OPEN_ORGS` (default 64): org files kept open beyond those in use
//! - `KEEP_DEV_AUTH=1`: allow the dev session cookie — honoured only when
//!   bound to a loopback address (M1)
//! - `KEEP_STATIC_DIR`: serve the built SPA from there (`static_files`)
//! - `KEEP_RESET_SEED=riverside`: seed `seed::riverside` (`reset`)
//! - `KEEP_QC_TOKEN`: the `/api/qc/*` surface for the nightly QC run, only
//!   with `KEEP_ENV=staging`; with `prod` it stops the boot
//!   (`routes::qc_seed`)
//! - `KEEP_SNAPSHOT_*`, `KEEP_ENV`: hourly snapshots (`backup`)
//! - `KEEP_LITESTREAM_SOCKET`: Litestream's control socket, for `/healthz`;
//!   when set, Litestream also owns org files' WAL checkpoints (no
//!   checkpointer threads: `store::Store::without_checkpointer`)
//! - `SENTRY_DSN`: error reporting (`observe`)
//! - `KEEP_GOCARDLESS` (`off`/`fake`/`sandbox`/`live`),
//!   `KEEP_GOCARDLESS_CLIENT_ID`, `KEEP_GOCARDLESS_CLIENT_SECRET`,
//!   `KEEP_GOCARDLESS_WEBHOOK_SECRET`: Direct Debit (`gocardless`); `fake`
//!   and `sandbox` are refused with `KEEP_ENV=prod`, `live` without it, and
//!   `sandbox`/`live` without the three secrets
//! - `KEEP_ADDRESS_LOOKUP` (`off`/`fake`/`ideal`), `KEEP_IDEAL_POSTCODES_KEY`,
//!   `KEEP_ADDRESS_LOOKUP_CAP`, `KEEP_ADDRESS_LOOKUP_DAILY_CEILING`: the
//!   contact form's postcode lookup (`address`); `ideal` without a key or
//!   an unknown value stops the boot
//! - auth (`api::auth::boot`): `KEEP_APP_ORIGIN`, `KEEP_CLIENT_IP_HEADER`,
//!   `KEEP_SETTINGS_KEY`, `KEEP_AUTH_PEPPER`,
//!   `KEEP_MAIL`/`KEEP_SMTP_URL`/`KEEP_MAIL_FROM`/`KEEP_MAIL_ONLY_TO`; with `KEEP_ENV=prod` or
//!   `staging` the first four are required and `KEEP_DEV_AUTH` stops the
//!   boot; `KEEP_MAIL=log` only for dev
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
    // Before the store opens: a refused setting stops the boot before it
    // migrates or copies anything.
    let auth =
        api::auth::boot::runtime(|name| std::env::var(name).ok(), bind).unwrap_or_else(|e| {
            eprintln!("{e}");
            std::process::exit(2)
        });
    debug_assert!(
        !(dev_auth && api::auth::dev_auth_refused(std::env::var("KEEP_ENV").ok().as_deref()))
    );
    let qc = qc_access();
    let scan_limits = api::scans::limits::ScanLimits::from_vars(|name| std::env::var(name).ok())
        .unwrap_or_else(|e| {
            eprintln!("{e}");
            std::process::exit(2)
        });
    let address = api::address::from_vars(|name| std::env::var(name).ok()).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(2)
    });
    let self_host = if bind.is_unspecified() || bind.is_loopback() {
        if bind.is_ipv6() {
            "[::1]".to_owned()
        } else {
            "127.0.0.1".to_owned()
        }
    } else if bind.is_ipv6() {
        format!("[{bind}]")
    } else {
        bind.to_string()
    };
    let gocardless = api::gocardless::from_vars(
        |name| std::env::var(name).ok(),
        api::gocardless::Origins {
            app_origin: &auth.config.app_origin,
            self_base: &format!("http://{self_host}:{port}"),
        },
        auth.keys.settings_key().clone(),
    )
    .unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(2)
    })
    .map(Arc::new);
    if let Some(gc) = &gocardless {
        eprintln!(
            "gocardless {:?}: OAuth redirect {}",
            gc.mode, gc.redirect_uri
        );
    }
    if let Some(lookup) = &address {
        eprintln!(
            "address lookup {:?}: {} a month per organisation, {} a day in all",
            lookup.mode, lookup.cap, lookup.ceiling
        );
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
    let store = if std::env::var_os("KEEP_LITESTREAM_SOCKET").is_some() {
        store.without_checkpointer()
    } else {
        store
    };
    // TOTP secrets from before auth step 3 are sealed now that the key is
    // known (after the step's pre-migration copy).
    match store
        .platform()
        .with_write(|tx| ::auth::keys::seal_plaintext_secrets(tx, &auth.keys))
    {
        Ok(0) => {}
        Ok(n) => eprintln!("sealed {n} TOTP secret(s)"),
        Err(e) => {
            eprintln!("boot stopped: sealing TOTP secrets: {e}");
            std::process::exit(1)
        }
    }
    match store.migrate_all() {
        Ok(0) => {}
        Ok(n) => eprintln!("migrated {n} organisation file(s)"),
        Err(e) => {
            eprintln!("boot stopped: {e}");
            std::process::exit(1)
        }
    }
    // After the migrations: the org files are read at the head schema.
    match jobs::reconcile_pending(&store) {
        Ok((added, failed)) => {
            if added > 0 {
                eprintln!("marked {added} unfinished job(s) pending");
            }
            for f in failed {
                eprintln!("pending-job reconcile: {f}");
            }
        }
        Err(e) => eprintln!("pending-job reconcile: {e}"),
    }
    // After the migrations: the seed writes through the head schema.
    match api::reset::seed_from_env(&store, &auth.keys, auth.policy) {
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
    if let Some(gc) = &gocardless {
        jobs.register(api::gocardless::process::EventsJob {
            store: store.clone(),
            gc: gc.clone(),
        });
        jobs.register(api::gocardless::catchup::CatchUpJob {
            store: store.clone(),
            gc: gc.clone(),
        });
    }
    let state = AppState::new(store, dev_auth)
        .with_scan_limits(Arc::new(scan_limits))
        .with_auth(auth)
        .with_qc(qc)
        .with_address(address)
        .with_gocardless(gocardless);
    jobs.register(api::auth::LimitSweep(state.auth.clone()));
    jobs.spawn();

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

/// `KEEP_QC_TOKEN`: on only with `KEEP_ENV=staging`. The token is never
/// printed, here or in any error.
fn qc_access() -> Option<api::routes::qc_seed::QcAccess> {
    let keep_env = std::env::var("KEEP_ENV").ok();
    let token = std::env::var("KEEP_QC_TOKEN").ok();
    match api::routes::qc_seed::QcAccess::from_env(keep_env.as_deref(), token.as_deref()) {
        Ok(Some(qc)) => {
            eprintln!("/api/qc/* on (KEEP_QC_TOKEN, KEEP_ENV=staging)");
            Some(qc)
        }
        Ok(None) => {
            if token.is_some_and(|t| !t.is_empty()) {
                eprintln!("KEEP_QC_TOKEN ignored: /api/qc/* needs KEEP_ENV=staging");
            }
            None
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2)
        }
    }
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
