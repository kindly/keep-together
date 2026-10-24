//! `snapshot-restore --data <dir>`: put `platform.db` and every org it
//! lists back from the newest hourly snapshots (`api::backup`), into an
//! empty data dir. Reads the same `KEEP_SNAPSHOT_*` and `KEEP_ENV`
//! settings as the api. Used by the image's entrypoint on an empty volume
//! (`KEEP_RESTORE_SOURCE=snapshot`), the restore drill and `drill.yml`.
//! Prints one line per file and the total time.

use std::path::PathBuf;
use std::time::Instant;

use api::backup::{SnapshotConfig, restore_latest};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let data: PathBuf = match (args.next().as_deref(), args.next()) {
        (Some("--data"), Some(dir)) => dir.into(),
        _ => {
            eprintln!("usage: snapshot-restore --data <dir>");
            std::process::exit(2);
        }
    };
    let config = match SnapshotConfig::from_env(&data) {
        Ok(Some(c)) => c,
        Ok(None) => fail("KEEP_SNAPSHOT_BUCKET is not set"),
        Err(e) => fail(&e),
    };
    let started = Instant::now();
    match restore_latest(config.bucket.as_ref(), &config.env, &data).await {
        Ok(files) => {
            for (name, key, bytes) in &files {
                println!("restored {name} from {key} ({bytes} bytes)");
            }
            println!(
                "snapshot restore: {} files in {:.1}s",
                files.len(),
                started.elapsed().as_secs_f64()
            );
        }
        Err(e) => fail(&e),
    }
}

fn fail(message: &str) -> ! {
    eprintln!("snapshot-restore: {message}");
    std::process::exit(1);
}
