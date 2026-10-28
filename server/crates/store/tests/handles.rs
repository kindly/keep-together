//! M2: per-org open locks and the handle LRU. Its own test binary: the fd
//! count is per process.

use std::sync::Arc;
use std::time::{Duration, Instant};

use store::{M, Migrations, Store, StoreConfig};

const THINGS: &str = "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL);";

fn store(dir: &std::path::Path, migrations: Vec<M<'static>>, max_open: usize) -> Store {
    Store::open(StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: Migrations::new(migrations),
        readers: 1,
        max_open,
    })
    .unwrap()
}

fn open_fds() -> usize {
    std::fs::read_dir("/proc/self/fd").map_or(0, |d| d.count())
}

#[test]
fn a_slow_open_of_one_org_does_not_block_another() {
    let tmp = tempfile::tempdir().unwrap();
    let first = store(tmp.path(), vec![M::up(THINGS)], 64);
    let a = first.create_tenant("alpha", "Alpha").unwrap();
    let b = first.create_tenant("beta", "Beta").unwrap();
    drop(first);

    // A new release with a slow migration: every file takes 600 ms to open.
    let slow = M::up_with_hook("SELECT 1;", |_: &rusqlite::Transaction| {
        std::thread::sleep(Duration::from_millis(600));
        Ok(())
    });
    let store = Arc::new(store(tmp.path(), vec![M::up(THINGS), slow], 64));
    store.org(&b.id).unwrap();

    let opening = {
        let store = store.clone();
        std::thread::spawn(move || store.org(&a.id).map(|_| ()))
    };
    std::thread::sleep(Duration::from_millis(100));
    let start = Instant::now();
    store.org(&b.id).unwrap();
    assert!(
        start.elapsed() < Duration::from_millis(200),
        "B waited {:?} for A's open",
        start.elapsed()
    );
    opening.join().unwrap().unwrap();
}

#[test]
fn open_handles_stay_under_the_cap_and_in_use_ones_survive() {
    let tmp = tempfile::tempdir().unwrap();
    let cap = 4;
    let store = store(tmp.path(), vec![M::up(THINGS)], cap);
    let baseline = open_fds();
    let tenants: Vec<_> = (0..cap + 10)
        .map(|i| store.create_tenant(&format!("org-{i}"), "Org").unwrap())
        .collect();
    let held = store.org(&tenants[0].id).unwrap();
    for t in &tenants {
        store
            .org(&t.id)
            .unwrap()
            .read(|r| {
                r.query_row("SELECT count(*) FROM things", [], |row| {
                    row.get::<_, i64>(0)
                })
            })
            .unwrap();
    }
    assert!(store.open_count() <= cap, "{} open", store.open_count());
    // One org is a writer and a reader: a handful of fds (db, wal, shm
    // each). Unbounded, 14 orgs would be several times this.
    let grown = open_fds().saturating_sub(baseline);
    assert!(grown <= (cap + 1) * 6, "{grown} fds for {cap} cached orgs");

    // The held handle was never closed: the cache still hands it out.
    assert!(Arc::ptr_eq(&held, &store.org(&tenants[0].id).unwrap()));

    // Idle close: everything unused goes, the held one stays.
    assert!(store.close_idle(Duration::ZERO) >= 1);
    assert_eq!(store.open_count(), 1);
    drop(held);
    store.close_idle(Duration::ZERO);
    assert_eq!(store.open_count(), 0);
    // And reopens on demand.
    store.org(&tenants[3].id).unwrap();
    assert_eq!(store.open_count(), 1);
}
