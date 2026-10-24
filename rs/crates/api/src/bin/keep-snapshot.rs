//! `keep-snapshot`: the hourly snapshots (`api::backup`) by hand. Reads the
//! same `KEEP_SNAPSHOT_*` and `KEEP_ENV` settings as the api.
//!
//! - `keep-snapshot run --data <dir>`: one pass of the job now, beside the
//!   running api (it only reads org files and writes its own ledger
//!   rows). The restore drill uses it rather than waiting for the hour.
//! - `keep-snapshot restore --data <dir>`: put `platform.db` and every org
//!   it lists back from the newest good snapshots, into an empty data dir
//!   (`scripts/ops/restore.sh snapshot`: the entrypoint on an empty volume,
//!   the drill, `drill.yml`). Exit 4: restored, but some orgs had no
//!   usable snapshot (listed as `MISSING`).
//!
//! One line per file, then the total time.

use std::path::PathBuf;
use std::time::Instant;

use api::backup::{SnapshotConfig, SnapshotJob, restore_latest};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, data): (&str, PathBuf) = match args.as_slice() {
        [cmd, flag, dir] if flag == "--data" && (cmd == "run" || cmd == "restore") => {
            (cmd, dir.into())
        }
        _ => {
            eprintln!("usage: keep-snapshot run|restore --data <dir>");
            std::process::exit(2);
        }
    };
    let config = match SnapshotConfig::from_env(&data) {
        Ok(Some(c)) => c,
        Ok(None) => fail("KEEP_SNAPSHOT_BUCKET is not set"),
        Err(e) => fail(&e),
    };
    let started = Instant::now();
    if cmd == "run" {
        let report = SnapshotJob::new(config)
            .run_once(time::OffsetDateTime::now_utc())
            .await
            .unwrap_or_else(|e| fail(&e));
        for (name, tiers) in &report.uploaded {
            let tiers: Vec<_> = tiers.iter().map(|t| t.as_str()).collect();
            println!("uploaded {name} ({})", tiers.join(", "));
        }
        for (name, err) in &report.failed {
            println!("FAILED {name}: {err}");
        }
        println!(
            "snapshot run: {} uploaded, {} unchanged, {} failed in {:.1}s",
            report.uploaded.len(),
            report.skipped,
            report.failed.len(),
            started.elapsed().as_secs_f64()
        );
        if !report.failed.is_empty() {
            std::process::exit(1);
        }
        return;
    }
    let env = config.env.clone();
    let restored = restore_latest(
        config.bucket.as_ref(),
        &env,
        &data,
        time::OffsetDateTime::now_utc(),
    )
    .await
    .unwrap_or_else(|e| fail(&e));
    for (key, why) in &restored.passed_over {
        println!("passed over {key}: {why}");
    }
    for (name, key, bytes) in &restored.files {
        println!("restored {name} from {key} ({bytes} bytes)");
    }
    for id in &restored.missing {
        println!("MISSING org {id}: no snapshot passed its checks");
    }
    println!(
        "snapshot restore: {} files, {} missing in {:.1}s",
        restored.files.len(),
        restored.missing.len(),
        started.elapsed().as_secs_f64()
    );
    if !restored.missing.is_empty() {
        // Everything else is restored; restore.sh and the entrypoint
        // decide whether to boot without the missing orgs.
        std::process::exit(4);
    }
}

fn fail(message: &str) -> ! {
    eprintln!("keep-snapshot: {message}");
    std::process::exit(1);
}
