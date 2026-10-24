//! `seed`: load the perf generator's JSONL into one organisation
//! (`seed::perf`).
//!
//!   cargo run --release -p api --bin seed -- --data data --slug perf-a --name "Perf A" \
//!     --admin perf-a@example.com --jsonl $TMPDIR/rs10k/a.jsonl --prefix perfa

use std::path::PathBuf;

use api::schema;
use store::{Store, StoreConfig};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == &format!("--{name}"))
        .and_then(|i| args.get(i + 1).cloned())
}

fn required(name: &str) -> String {
    arg(name).unwrap_or_else(|| panic!("--{name} is required"))
}

fn main() {
    let dir = PathBuf::from(arg("data").unwrap_or_else(|| "data".into()));
    let slug = required("slug");
    let store = Store::open_with(
        StoreConfig {
            dir,
            org_migrations: schema::org_migrations(),
            readers: 1,
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
        },
        schema::PLATFORM_SCHEMAS,
    )
    .expect("open data dir");
    seed::perf::load(
        &store,
        seed::perf::Load {
            prefix: arg("prefix").unwrap_or_else(|| slug.clone()),
            name: arg("name"),
            admin: required("admin"),
            jsonl: required("jsonl").into(),
            slug,
        },
    );
}
