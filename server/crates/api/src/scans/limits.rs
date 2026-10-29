//! The scan upload's settings and guards: the per-org files cap
//! (`KEEP_FILES_CAP_BYTES`), the data volume's reserve
//! (`KEEP_FILES_DISK_RESERVE_BYTES`) and the bound on uploads in flight.
//!
//! **Disk.** `/data` is one volume for every org: `platform.db`, the org
//! files, the files dbs, Litestream's state and the snapshot job's copies.
//! A files db filling it would stop every organisation's writes. So an
//! upload is refused (`507 storage_full`) when the volume's free space
//! after it would drop below the reserve: by default, deployed
//! (`KEEP_ENV=prod|staging`), the larger of a quarter of the volume and
//! twice the largest file on it (the snapshot job's `VACUUM INTO` copy
//! and its `.zst` beside it); elsewhere (a dev machine's disk) only the
//! latter. `KEEP_FILES_DISK_RESERVE_BYTES` sets it outright.
//!
//! **In flight.** At most [`MAX_IN_FLIGHT`] scan uploads at once, across
//! every org, phone and signed-in: the rest are refused (`503 busy`; the
//! phone retries the same `id`/`pageId`) before their bodies are read, so
//! waiting uploads can't pile up bodies and blocking threads behind the
//! one decode.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::error::ApiError;

/// Scan uploads in flight at once, across the process.
pub const MAX_IN_FLIGHT: usize = 8;

/// The scan settings, in [`crate::AppState`].
#[derive(Debug)]
pub struct ScanLimits {
    /// Bytes of blobs an org's files db may hold.
    pub cap_bytes: i64,
    /// Free bytes the data volume keeps after an upload; `None`: the
    /// default (module docs).
    pub disk_reserve: Option<u64>,
    /// The default reserve includes a quarter of the volume.
    pub deployed: bool,
    in_flight: Arc<AtomicUsize>,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            cap_bytes: store::files::CAP_BYTES,
            disk_reserve: None,
            deployed: false,
            in_flight: Arc::default(),
        }
    }
}

impl ScanLimits {
    /// From `KEEP_FILES_CAP_BYTES`, `KEEP_FILES_DISK_RESERVE_BYTES` and
    /// `KEEP_ENV`. A value that isn't a whole number of bytes stops the
    /// boot.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let bytes = |name: &str| -> Result<Option<u64>, String> {
            match var(name).filter(|v| !v.is_empty()) {
                None => Ok(None),
                Some(v) => v
                    .parse::<u64>()
                    .map(Some)
                    .map_err(|_| format!("{name}={v:?} is not a number of bytes")),
            }
        };
        let cap_bytes = match bytes("KEEP_FILES_CAP_BYTES")? {
            Some(cap) => i64::try_from(cap).map_err(|_| "KEEP_FILES_CAP_BYTES is too large")?,
            None => store::files::CAP_BYTES,
        };
        Ok(Self {
            cap_bytes,
            disk_reserve: bytes("KEEP_FILES_DISK_RESERVE_BYTES")?,
            deployed: matches!(var("KEEP_ENV").as_deref(), Some("prod" | "staging")),
            in_flight: Arc::default(),
        })
    }

    /// Uploads holding a slot now.
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }

    /// This cap instead (bytes of blobs per org).
    pub fn with_cap(mut self, cap_bytes: i64) -> Self {
        self.cap_bytes = cap_bytes;
        self
    }

    /// This reserve instead of the default.
    pub fn with_disk_reserve(mut self, reserve: u64) -> Self {
        self.disk_reserve = Some(reserve);
        self
    }

    /// A slot for one upload, held until the guard drops; `503 busy` when
    /// [`MAX_IN_FLIGHT`] are taken.
    pub fn take_slot(&self) -> Result<Slot, ApiError> {
        let taken = self
            .in_flight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_IN_FLIGHT).then_some(n + 1)
            });
        match taken {
            Ok(_) => Ok(Slot(self.in_flight.clone())),
            Err(_) => Err(ApiError::Busy),
        }
    }

    /// Refuse an upload of `incoming` bytes that would leave the data
    /// volume (holding `data_dir`) below the reserve: `507 storage_full`.
    pub fn check_disk(&self, data_dir: &Path, incoming: u64) -> Result<(), ApiError> {
        let (free, total) = volume(data_dir).map_err(ApiError::internal)?;
        let reserve = match self.disk_reserve {
            Some(r) => r,
            None => {
                let snapshot = 2 * largest_file(data_dir);
                if self.deployed {
                    snapshot.max(total / 4)
                } else {
                    snapshot
                }
            }
        };
        if free < incoming.saturating_add(reserve) {
            eprintln!(
                "scan upload refused: {free} bytes free on the data volume, reserve {reserve}"
            );
            return Err(ApiError::StorageFull);
        }
        Ok(())
    }
}

/// An upload's place among [`MAX_IN_FLIGHT`].
#[derive(Debug)]
pub struct Slot(Arc<AtomicUsize>);

/// The request's [`Slot`], in its extensions: `api::body` takes it before
/// the body is read; the upload's handler moves it into its blocking work
/// ([`HeldSlot::take`]), so it is freed when the decode and the write end,
/// not when the client hangs up (a dropped request drops its future, but
/// not a `spawn_blocking` already running). A request that never reaches
/// the handler frees it with its extensions.
#[derive(Clone, Debug)]
pub struct HeldSlot(Arc<std::sync::Mutex<Option<Slot>>>);

impl HeldSlot {
    pub fn new(slot: Slot) -> Self {
        Self(Arc::new(std::sync::Mutex::new(Some(slot))))
    }

    /// The slot, to move into the work.
    pub fn take(&self) -> Option<Slot> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// `(free bytes for an unprivileged writer, total bytes)` of the volume
/// holding `path`.
/// The volume holding `path`: (bytes free to this process, bytes in
/// all), from `statvfs`.
pub fn volume(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // Safety: `c` is a valid C string and `stat` a writable statvfs.
    let rc = unsafe { libc::statvfs(c.as_ptr(), stat.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // Safety: statvfs succeeded, so it filled `stat`.
    let stat = unsafe { stat.assume_init() };
    // The fields' widths differ by platform (u32 on some): cast.
    #[allow(clippy::unnecessary_cast)]
    let (block, avail, blocks) = (
        stat.f_frsize as u64,
        stat.f_bavail as u64,
        stat.f_blocks as u64,
    );
    Ok((avail * block, blocks * block))
}

/// The largest database on the data volume: `platform.db`, any org file
/// or files db (what one snapshot copies at once).
/// What the data dir's organisations hold: their org files and files dbs
/// (each counted by its `.db`; bytes include the `-wal` and `-shm`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DataUsage {
    pub org_files: u64,
    pub org_bytes: u64,
    pub files_dbs: u64,
    pub files_bytes: u64,
}

/// [`DataUsage`] of `data_dir`, by listing `orgs/` and `files/`. A
/// directory not there yet counts nothing.
pub fn data_usage(data_dir: &Path) -> DataUsage {
    let tally = |dir: &str| {
        let (mut dbs, mut bytes) = (0, 0);
        if let Ok(entries) = std::fs::read_dir(data_dir.join(dir)) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "db") {
                    dbs += 1;
                }
                bytes += std::fs::metadata(&path).map_or(0, |m| m.len());
            }
        }
        (dbs, bytes)
    };
    let (org_files, org_bytes) = tally("orgs");
    let (files_dbs, files_bytes) = tally("files");
    DataUsage {
        org_files,
        org_bytes,
        files_dbs,
        files_bytes,
    }
}

fn largest_file(data_dir: &Path) -> u64 {
    let size = |p: &Path| std::fs::metadata(p).map_or(0, |m| m.len());
    let mut largest = size(&data_dir.join("platform.db"));
    for dir in ["orgs", "files"] {
        let Ok(entries) = std::fs::read_dir(data_dir.join(dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            largest = largest.max(size(&entry.path()));
        }
    }
    largest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_come_from_the_environment_and_bad_ones_stop_the_boot() {
        let vars = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        let none = ScanLimits::from_vars(vars(&[])).unwrap();
        assert_eq!(
            (none.cap_bytes, none.disk_reserve, none.deployed),
            (store::files::CAP_BYTES, None, false)
        );
        let set = ScanLimits::from_vars(vars(&[
            ("KEEP_FILES_CAP_BYTES", "500000000"),
            ("KEEP_FILES_DISK_RESERVE_BYTES", "0"),
            ("KEEP_ENV", "prod"),
        ]))
        .unwrap();
        assert_eq!(
            (set.cap_bytes, set.disk_reserve, set.deployed),
            (500_000_000, Some(0), true)
        );
        assert!(ScanLimits::from_vars(vars(&[("KEEP_FILES_CAP_BYTES", "2GB")])).is_err());
        assert!(ScanLimits::from_vars(vars(&[("KEEP_FILES_DISK_RESERVE_BYTES", "-1")])).is_err());
    }

    #[test]
    fn slots_run_out_and_come_back() {
        let limits = ScanLimits::default();
        let held: Vec<Slot> = (0..MAX_IN_FLIGHT)
            .map(|_| limits.take_slot().unwrap())
            .collect();
        assert!(matches!(limits.take_slot(), Err(ApiError::Busy)));
        drop(held);
        assert!(limits.take_slot().is_ok());
    }

    /// The handler takes the slot out of the request and moves it into
    /// its blocking work: dropping the request (the client hung up) then
    /// frees nothing; the work ending does.
    #[test]
    fn a_held_slot_lives_with_the_work_not_the_request() {
        let limits = ScanLimits::default();
        let held = HeldSlot::new(limits.take_slot().unwrap());
        let in_request = held.clone();
        let work = held.take().expect("the handler takes it");
        drop(held);
        drop(in_request); // the request and its extensions are gone
        assert_eq!(limits.in_flight(), 1);
        let worker = std::thread::spawn(move || drop(work));
        worker.join().unwrap();
        assert_eq!(limits.in_flight(), 0);
        // A request that never reached its handler frees it with itself.
        let unused = HeldSlot::new(limits.take_slot().unwrap());
        drop(unused);
        assert_eq!(limits.in_flight(), 0);
    }

    #[test]
    fn the_disk_reserve_refuses_what_would_eat_into_it() {
        let tmp = tempfile::tempdir().unwrap();
        let (free, _) = volume(tmp.path()).unwrap();
        let tight = ScanLimits {
            disk_reserve: Some(free),
            ..ScanLimits::default()
        };
        assert!(matches!(
            tight.check_disk(tmp.path(), 1 << 20),
            Err(ApiError::StorageFull)
        ));
        let roomy = ScanLimits {
            disk_reserve: Some(0),
            ..ScanLimits::default()
        };
        assert!(roomy.check_disk(tmp.path(), 1).is_ok());
        // The default reserve counts the largest file twice.
        std::fs::create_dir_all(tmp.path().join("files")).unwrap();
        std::fs::write(tmp.path().join("files/a.db"), vec![0u8; 4096]).unwrap();
        assert_eq!(largest_file(tmp.path()), 4096);
    }
}
