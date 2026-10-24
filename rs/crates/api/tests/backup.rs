//! The hourly snapshot job against an in-memory bucket: what it uploads,
//! when it skips, and that every snapshot restores to its own org's rows.

use std::path::Path;
use std::sync::Arc;

use api::backup::{SnapshotConfig, SnapshotJob, Tier, key};
use contacts::form::create;
use contacts::types::{CreateContact, Details, Kind};
use contracts::{Ctx, Source};
use futures_util::TryStreamExt;
use object_store::memory::InMemory;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt};
use store::{Store, StoreConfig, Tenant};
use time::OffsetDateTime;
use time::macros::datetime;

fn open(dir: &Path) -> Store {
    Store::open(StoreConfig {
        dir: dir.into(),
        org_migrations: api::schema::org_migrations(),
        readers: 1,
    })
    .unwrap()
}

fn add_contacts(store: &Store, tenant: &Tenant, last: &str, n: usize) {
    store
        .org(&tenant.id)
        .unwrap()
        .write(|tx| {
            let ctx = Ctx::new(tx, None);
            for i in 0..n {
                let details = Details {
                    client_key: None,
                    kind: Kind::Individual,
                    title: String::new(),
                    first_name: format!("P{i}"),
                    last_name: last.into(),
                    nickname: String::new(),
                    name: String::new(),
                    birth_date: None,
                    is_deceased: false,
                    deceased_date: None,
                };
                create(&ctx, CreateContact { id: None, details }, Source::Seed)?;
            }
            Ok::<_, contracts::ContractError>(())
        })
        .unwrap();
}

struct World {
    _tmp: tempfile::TempDir,
    store: Store,
    a: Tenant,
    b: Tenant,
    bucket: Arc<InMemory>,
    job: SnapshotJob,
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = open(tmp.path());
    let a = store.create_tenant("alpha", "Alpha").unwrap();
    let b = store.create_tenant("bravo", "Bravo").unwrap();
    add_contacts(&store, &a, "Alphason", 3);
    add_contacts(&store, &b, "Bravoson", 2);
    // Not orgs: the job leaves them alone.
    std::fs::write(tmp.path().join("orgs/notes.txt"), "x").unwrap();
    std::fs::write(tmp.path().join("orgs/premigrate.v1.db"), "x").unwrap();
    let bucket = Arc::new(InMemory::new());
    let job = SnapshotJob::new(SnapshotConfig {
        data_dir: tmp.path().into(),
        env: "test".into(),
        bucket: bucket.clone(),
    });
    World {
        _tmp: tmp,
        store,
        a,
        b,
        bucket,
        job,
    }
}

async fn keys(bucket: &InMemory) -> Vec<String> {
    let mut keys: Vec<String> = bucket
        .list(None)
        .map_ok(|m| m.location.to_string())
        .try_collect()
        .await
        .unwrap();
    keys.sort();
    keys
}

/// Download, decompress, open: (integrity_check, contact last names).
async fn restore(bucket: &InMemory, key: &ObjectPath) -> (String, Vec<String>) {
    let bytes = bucket.get(key).await.unwrap().bytes().await.unwrap();
    let raw = zstd::decode_all(&bytes[..]).unwrap();
    let tmp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(tmp.path(), raw).unwrap();
    let conn = rusqlite::Connection::open(tmp.path()).unwrap();
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    let mut stmt = conn
        .prepare("SELECT DISTINCT last_name FROM contacts ORDER BY 1")
        .unwrap();
    let names = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    (check, names)
}

const NOON: OffsetDateTime = datetime!(2026-10-24 12:00 UTC);
/// "Now" for the restores: after every run in these tests.
const LATER: OffsetDateTime = datetime!(2026-12-01 00:00 UTC);

#[tokio::test]
async fn first_run_uploads_every_file_at_every_tier() {
    let w = world();
    let report = w.job.run_once(NOON).await.unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(report.uploaded.len(), 3);
    let (a, b) = (w.a.id.as_str(), w.b.id.as_str());
    let mut expected: Vec<String> = ["platform", a, b]
        .iter()
        .flat_map(|name| {
            [Tier::Hourly, Tier::Daily, Tier::Monthly]
                .map(|t| key(t, "test", name, NOON).to_string())
        })
        .collect();
    expected.sort();
    assert_eq!(keys(&w.bucket).await, expected);
}

#[tokio::test]
async fn each_snapshot_restores_its_own_org_only() {
    let w = world();
    w.job.run_once(NOON).await.unwrap();
    let (check, names) =
        restore(&w.bucket, &key(Tier::Hourly, "test", w.a.id.as_str(), NOON)).await;
    assert_eq!((check.as_str(), names), ("ok", vec!["Alphason".to_owned()]));
    let (check, names) =
        restore(&w.bucket, &key(Tier::Hourly, "test", w.b.id.as_str(), NOON)).await;
    assert_eq!((check.as_str(), names), ("ok", vec!["Bravoson".to_owned()]));
    // The copy keeps the org's stamp, so it can only be put back as itself.
    let bytes = w
        .bucket
        .get(&key(Tier::Hourly, "test", w.a.id.as_str(), NOON))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let tmp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(tmp.path(), zstd::decode_all(&bytes[..]).unwrap()).unwrap();
    let stamp: String = rusqlite::Connection::open(tmp.path())
        .unwrap()
        .query_row("SELECT tenant_id FROM _org", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stamp, w.a.id.as_str());
}

#[tokio::test]
async fn unchanged_orgs_are_skipped_and_changed_ones_go_hourly() {
    let w = world();
    w.job.run_once(NOON).await.unwrap();
    let one = datetime!(2026-10-24 13:00 UTC);
    let report = w.job.run_once(one).await.unwrap();
    // Only platform.db, which has no revisions to compare.
    let names: Vec<_> = report
        .uploaded
        .iter()
        .map(|(n, t)| (n.as_str(), t.clone()))
        .collect();
    assert_eq!(names, [("platform", vec![Tier::Hourly])]);
    assert_eq!(report.skipped, 2);

    add_contacts(&w.store, &w.b, "Bravoson", 1);
    let two = datetime!(2026-10-24 14:00 UTC);
    let report = w.job.run_once(two).await.unwrap();
    let names: Vec<_> = report
        .uploaded
        .iter()
        .map(|(n, t)| (n.as_str(), t.clone()))
        .collect();
    assert_eq!(
        names,
        [
            ("platform", vec![Tier::Hourly]),
            (w.b.id.as_str(), vec![Tier::Hourly])
        ]
    );
    let (_, names) = restore(&w.bucket, &key(Tier::Hourly, "test", w.b.id.as_str(), two)).await;
    assert_eq!(names, ["Bravoson"]);
}

#[tokio::test]
async fn a_new_day_keeps_yesterdays_last_state_and_a_new_month_keeps_everything() {
    let w = world();
    w.job.run_once(NOON).await.unwrap();
    add_contacts(&w.store, &w.a, "Later", 1);
    w.job
        .run_once(datetime!(2026-10-24 23:00 UTC))
        .await
        .unwrap();

    let midnight = datetime!(2026-10-25 00:00 UTC);
    let report = w.job.run_once(midnight).await.unwrap();
    let a = report.uploaded.iter().find(|(n, _)| n == w.a.id.as_str());
    // A moved since its last daily (noon yesterday): its daily copy is
    // the 23:00 state. B didn't: no daily, nothing at all.
    assert_eq!(a.map(|(_, t)| t.clone()), Some(vec![Tier::Daily]));
    assert!(!report.uploaded.iter().any(|(n, _)| n == w.b.id.as_str()));
    let (_, names) = restore(
        &w.bucket,
        &key(Tier::Daily, "test", w.a.id.as_str(), midnight),
    )
    .await;
    assert_eq!(names, ["Alphason", "Later"]);

    let november = datetime!(2026-11-01 00:00 UTC);
    let report = w.job.run_once(november).await.unwrap();
    for org in [&w.a, &w.b] {
        let tiers = report
            .uploaded
            .iter()
            .find(|(n, _)| n == org.id.as_str())
            .map(|(_, t)| t.clone());
        assert_eq!(tiers, Some(vec![Tier::Monthly]), "{:?}", org.id);
    }
}

#[tokio::test]
async fn a_failing_file_does_not_stop_the_others() {
    let w = world();
    // A file named like an org that isn't a database.
    let bogus = "0123456789abcdef0123456789abcdef";
    std::fs::write(w._tmp.path().join(format!("orgs/{bogus}.db")), "not sqlite").unwrap();
    let report = w.job.run_once(NOON).await.unwrap();
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].0, bogus);
    assert_eq!(report.uploaded.len(), 3);
    // Nothing of it reached the bucket, and the temp copies are gone.
    assert!(!keys(&w.bucket).await.iter().any(|k| k.contains(bogus)));
    let tmp_files = std::fs::read_dir(w._tmp.path().join("snapshots-tmp"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(tmp_files, 0);
}

#[tokio::test]
async fn health_reports_the_age_of_the_last_platform_snapshot() {
    let w = world();
    // The only test in this binary that sets the global.
    api::backup::init_health(w._tmp.path(), true, None);
    assert_eq!(api::backup::health().await.snapshot_age_seconds, None);
    w.job.run_once(OffsetDateTime::now_utc()).await.unwrap();
    let h = api::backup::health().await;
    assert_eq!(h.snapshots, "on");
    assert_eq!(h.litestream, "off");
    let age = h.snapshot_age_seconds.unwrap();
    assert!((0..5).contains(&age), "{age}");
}

#[tokio::test]
async fn restore_puts_back_the_newest_copy_of_every_listed_org() {
    let w = world();
    w.job.run_once(NOON).await.unwrap();
    add_contacts(&w.store, &w.a, "Later", 1);
    let later = datetime!(2026-10-24 15:00 UTC);
    w.job.run_once(later).await.unwrap();
    // An org the bucket holds but platform.db doesn't list (a staging
    // reset's leftover) stays out.
    let ghost = "fedcba9876543210fedcba9876543210";
    let copy = w
        .bucket
        .get(&key(Tier::Hourly, "test", w.b.id.as_str(), NOON))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    w.bucket
        .put(&key(Tier::Monthly, "test", ghost, NOON), copy.into())
        .await
        .unwrap();

    let target = tempfile::tempdir().unwrap();
    let restored = api::backup::restore_latest(w.bucket.as_ref(), "test", target.path(), LATER)
        .await
        .unwrap();
    assert!(restored.missing.is_empty() && restored.passed_over.is_empty());
    let names: Vec<_> = restored
        .files
        .iter()
        .map(|(n, k, _)| (n.as_str(), k.as_str()))
        .collect();
    let (a, b) = (w.a.id.as_str(), w.b.id.as_str());
    let (first, second) = if a < b { (a, b) } else { (b, a) };
    let key_of = |name: &str| {
        let at = if name == "platform" || name == a {
            later
        } else {
            NOON
        };
        key(Tier::Hourly, "test", name, at).to_string()
    };
    assert_eq!(
        names,
        [
            ("platform", key_of("platform").as_str()),
            (first, key_of(first).as_str()),
            (second, key_of(second).as_str()),
        ]
    );

    // The restored dir opens as a store, with each org's rows its own.
    let store = open(target.path());
    let last_names = |slug: &str| {
        let t = store.platform().tenant_by_slug(slug).unwrap().unwrap();
        store
            .org(&t.id)
            .unwrap()
            .read(|r| {
                let mut stmt = r.prepare("SELECT DISTINCT last_name FROM contacts ORDER BY 1")?;
                stmt.query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    assert_eq!(last_names("alpha"), ["Alphason", "Later"]);
    assert_eq!(last_names("bravo"), ["Bravoson"]);
    assert!(!target.path().join(format!("orgs/{ghost}.db")).exists());

    // Never over existing data.
    let again = api::backup::restore_latest(w.bucket.as_ref(), "test", target.path(), LATER).await;
    assert!(again.unwrap_err().contains("empty data dir"));
}

#[tokio::test]
async fn a_stored_snapshot_is_never_replaced() {
    let w = world();
    w.job.run_once(NOON).await.unwrap();
    let a_key = key(Tier::Hourly, "test", w.a.id.as_str(), NOON);
    let before = w.bucket.get(&a_key).await.unwrap().bytes().await.unwrap();

    // A second pass in the same minute after a change: the key exists, so
    // nothing is replaced and A stays due.
    add_contacts(&w.store, &w.a, "Later", 1);
    let report = w.job.run_once(NOON).await.unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert!(!report.uploaded.iter().any(|(n, _)| n == w.a.id.as_str()));
    let after = w.bucket.get(&a_key).await.unwrap().bytes().await.unwrap();
    assert_eq!(before, after);

    // The next minute it goes up under its own key.
    let minute = datetime!(2026-10-24 12:01 UTC);
    let report = w.job.run_once(minute).await.unwrap();
    let a = report.uploaded.iter().find(|(n, _)| n == w.a.id.as_str());
    assert_eq!(a.map(|(_, t)| t.clone()), Some(vec![Tier::Hourly]));
    let (_, names) = restore(
        &w.bucket,
        &key(Tier::Hourly, "test", w.a.id.as_str(), minute),
    )
    .await;
    assert_eq!(names, ["Alphason", "Later"]);
}

#[tokio::test]
async fn restore_ignores_future_stamps_and_falls_back_past_bad_copies() {
    let w = world();
    w.job.run_once(NOON).await.unwrap();
    add_contacts(&w.store, &w.a, "Later", 1);
    let one = datetime!(2026-10-24 13:00 UTC);
    w.job.run_once(one).await.unwrap();
    let a = w.a.id.as_str();
    // Planted: a far-future copy (it would sort first), and junk as the
    // newest real-looking copy of A.
    w.bucket
        .put(
            &key(Tier::Hourly, "test", a, datetime!(2099-01-01 00:00 UTC)),
            b"junk".to_vec().into(),
        )
        .await
        .unwrap();
    let two = datetime!(2026-10-24 14:00 UTC);
    w.bucket
        .put(&key(Tier::Hourly, "test", a, two), b"junk".to_vec().into())
        .await
        .unwrap();

    let target = tempfile::tempdir().unwrap();
    let now = datetime!(2026-10-24 15:00 UTC);
    let restored = api::backup::restore_latest(w.bucket.as_ref(), "test", target.path(), now)
        .await
        .unwrap();
    assert!(restored.missing.is_empty());
    let passed: Vec<_> = restored
        .passed_over
        .iter()
        .map(|(k, _)| k.as_str())
        .collect();
    assert_eq!(passed.len(), 2, "{passed:?}");
    assert!(passed.iter().any(|k| k.contains("2099-01-01")));
    assert!(
        passed
            .iter()
            .any(|k| k.contains(&key(Tier::Hourly, "test", a, two).to_string()))
    );
    let (_, key_used, _) = restored.files.iter().find(|(n, _, _)| n == a).unwrap();
    assert_eq!(key_used, &key(Tier::Hourly, "test", a, one).to_string());
}

#[tokio::test]
async fn an_org_without_a_snapshot_is_reported_and_the_rest_restored() {
    let w = world();
    w.job.run_once(NOON).await.unwrap();
    // A's copies all gone (an upload that failed, an org made mid-run).
    for tier in [Tier::Hourly, Tier::Daily, Tier::Monthly] {
        w.bucket
            .delete(&key(tier, "test", w.a.id.as_str(), NOON))
            .await
            .unwrap();
    }
    let target = tempfile::tempdir().unwrap();
    let restored = api::backup::restore_latest(w.bucket.as_ref(), "test", target.path(), LATER)
        .await
        .unwrap();
    assert_eq!(restored.missing, [w.a.id.as_str().to_owned()]);
    let names: Vec<_> = restored.files.iter().map(|(n, _, _)| n.as_str()).collect();
    assert_eq!(names, ["platform", w.b.id.as_str()]);
    assert!(
        target
            .path()
            .join(format!("orgs/{}.db", w.b.id.as_str()))
            .exists()
    );
}
