//! Jobs, `/healthz`, and dev auth only on loopback (M1).

mod common;

use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use api::jobs::{Job, Jobs, each_org};
use axum::http::StatusCode;
use common::{request, world};
use http_body_util::BodyExt;
use tower::ServiceExt;

struct Count(Arc<AtomicUsize>);

impl Job for Count {
    fn name(&self) -> &'static str {
        "count"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60)
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            // A failing run keeps its schedule.
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err("first run fails".into());
            }
            Ok(())
        })
    }
}

#[tokio::test(start_paused = true)]
async fn a_job_runs_every_period_after_start() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut jobs = Jobs::new();
    jobs.register(Count(runs.clone()));
    assert_eq!(jobs.names(), vec!["count"]);
    jobs.spawn();
    tokio::time::sleep(Duration::from_secs(59)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn each_org_visits_every_file_once_and_reports_failures_by_org() {
    let w = world();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let alpha = w.alpha.id.clone();
    let out = each_org(&w.store, move |id, db| {
        let n: i64 = db
            .read(|r| r.query_row("SELECT count(*) FROM revisions", [], |row| row.get(0)))
            .map_err(|e: rusqlite::Error| e.to_string())?;
        s.lock().unwrap().push((id.clone(), n));
        if *id == alpha {
            return Err("alpha failed".into());
        }
        Ok(())
    })
    .await;
    let mut ids: Vec<_> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    let mut expected = vec![w.alpha.id.clone(), w.beta.id.clone()];
    expected.sort();
    assert_eq!(ids, expected);
    let err = out.unwrap_err();
    assert!(
        err.contains(w.alpha.id.as_str()) && err.contains("alpha failed"),
        "{err}"
    );
}

#[tokio::test]
async fn healthz_answers_without_a_session() {
    let w = world();
    let res = w
        .app
        .clone()
        .oneshot(request("GET", "/healthz", None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["db"], "ok");
    assert!(body["walBacklogBytes"].is_i64(), "{body}");
    // The data volume, as counts: free within total, and no path.
    let (free, total) = (
        body["diskFreeBytes"].as_u64().unwrap(),
        body["diskTotalBytes"].as_u64().unwrap(),
    );
    assert!(total > 0 && free <= total, "{body}");
    let dir = w.store.dir().to_str().unwrap().to_owned();
    assert!(!body.to_string().contains(&dir), "{body}");
}

/// The data volume's numbers are statvfs's for the data dir.
#[tokio::test]
async fn healthz_reports_the_data_volume() {
    let w = world();
    let res = w
        .app
        .clone()
        .oneshot(request("GET", "/healthz", None, None))
        .await
        .unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let (free, total) = api::scans::limits::volume(w.store.dir()).unwrap();
    // Within a few MB of what statvfs says now (other writers share it).
    let near = |a: u64, b: u64| a.abs_diff(b) < 64 << 20;
    assert!(
        near(body["diskFreeBytes"].as_u64().unwrap(), free),
        "{body}"
    );
    assert_eq!(body["diskTotalBytes"].as_u64().unwrap(), total);
}

#[test]
fn the_daily_usage_line_counts_org_files_and_files_dbs() {
    let tmp = tempfile::tempdir().unwrap();
    for (dir, name, len) in [
        ("orgs", "a.db", 4096),
        ("orgs", "a.db-wal", 100),
        ("orgs", "b.db", 8192),
        ("files", "a.db", 1000),
    ] {
        std::fs::create_dir_all(tmp.path().join(dir)).unwrap();
        std::fs::write(tmp.path().join(dir).join(name), vec![0u8; len]).unwrap();
    }
    assert_eq!(
        api::scans::limits::data_usage(tmp.path()),
        api::scans::limits::DataUsage {
            org_files: 2,
            org_bytes: 4096 + 100 + 8192,
            files_dbs: 1,
            files_bytes: 1000,
        }
    );
    let line = api::backup::usage_line(tmp.path());
    assert!(
        line.starts_with("data usage: 2 org files 12388 bytes, 1 files dbs 1000 bytes; volume ")
            && line.contains(" bytes free"),
        "{line}"
    );
    // An empty data dir counts nothing rather than failing.
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(
        api::scans::limits::data_usage(empty.path()),
        api::scans::limits::DataUsage::default()
    );
}

#[test]
fn wal_watch_warns_once_per_crossing() {
    let w = world();
    let watch = api::jobs::WalWatch::new(w.store.clone());
    let over = api::jobs::WAL_WARN_BYTES + 1;
    assert!(!watch.crossed(0));
    assert!(watch.crossed(over));
    assert!(!watch.crossed(over), "not again while it stays over");
    assert!(!watch.crossed(0));
    assert!(watch.crossed(over), "again after it went back under");
}

#[test]
fn dev_auth_only_on_loopback() {
    let ip = |s: &str| s.parse::<IpAddr>().unwrap();
    assert!(api::dev_auth_allowed(true, ip("127.0.0.1")));
    assert!(api::dev_auth_allowed(true, ip("::1")));
    assert!(!api::dev_auth_allowed(true, ip("0.0.0.0")));
    assert!(!api::dev_auth_allowed(true, ip("192.168.1.10")));
    assert!(!api::dev_auth_allowed(false, ip("127.0.0.1")));
}

struct Early(Arc<AtomicUsize>);

impl Job for Early {
    fn name(&self) -> &'static str {
        "early"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(3600)
    }
    fn first_after(&self) -> Duration {
        Duration::from_secs(60)
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

#[tokio::test(start_paused = true)]
async fn a_job_may_run_first_sooner_than_its_period() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut jobs = Jobs::new();
    jobs.register(Early(runs.clone()));
    jobs.spawn();
    tokio::time::sleep(Duration::from_secs(61)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_secs(3000)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}
