//! Checkpoints off the write path.
//!
//! SQLite's auto-checkpoint runs inside the COMMIT that pushes the WAL past
//! 1000 pages: on an org file that is the writer, still holding the writer
//! mutex, so one write in ~50 paid for copying the WAL back and two fsyncs
//! (p50 109 ms under load), and every write queued behind it waited too.
//! So writers run with `wal_autocheckpoint=0`, and each open org file has a
//! checkpointer thread with its own connection that never takes the writer
//! mutex:
//!
//! - every [`INTERVAL`], if anything committed since its last run (or that
//!   run left frames behind), a `PASSIVE` checkpoint, which never waits on
//!   readers or writers;
//! - at once (at most every [`HIGH_WATER_GAP`]) when a commit leaves
//!   [`HIGH_WATER_PAGES`] or more un-checkpointed;
//! - when idle (nothing committed for a whole interval) and the `-wal` file
//!   has grown past [`TRUNCATE_ABOVE_BYTES`], a `TRUNCATE` with no busy
//!   timeout: it shrinks the file, or gives up at once if anyone (a
//!   writer, a reader, Litestream's read lock) is in the way, and isn't
//!   tried again until something commits.
//!
//! The last connection to close still checkpoints the file (SQLite does
//! that whatever `wal_autocheckpoint` says), so closing a handle (LRU,
//! idle-close) leaves no WAL behind. Litestream: `docs/ops.md`.

use std::cell::Cell;
use std::os::raw::c_int;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::conn;

/// How often a file with new commits is checkpointed.
pub const INTERVAL: Duration = Duration::from_secs(1);
/// Un-checkpointed WAL pages that wake the checkpointer at once (~4 MB at
/// 4 KiB pages: SQLite's own auto-checkpoint threshold).
pub const HIGH_WATER_PAGES: i64 = 1000;
/// The least time between two high-water checkpoints, so a WAL a long
/// reader pins (it can't be checkpointed past that reader) isn't
/// checkpointed after every commit.
pub const HIGH_WATER_GAP: Duration = Duration::from_millis(100);
/// An idle file's `-wal` above this is truncated.
pub const TRUNCATE_ABOVE_BYTES: u64 = 4 << 20;

thread_local! {
    /// The WAL's length in pages after this thread's last commit on a
    /// writer, set by [`wal_hook`] and taken by `OrgDb::write_raw` on the
    /// same thread right after the commit.
    static COMMITTED_PAGES: Cell<Option<c_int>> = const { Cell::new(None) };
}

/// Installed on writers in place of SQLite's auto-checkpoint (which is
/// itself a WAL hook; setting one replaces the other). Only records.
fn wal_hook(_: &rusqlite::hooks::Wal, pages: c_int) -> rusqlite::Result<()> {
    COMMITTED_PAGES.with(|c| c.set(Some(pages)));
    Ok(())
}

/// Turn off checkpoints on commit for this writer connection.
pub(crate) fn writer_setup(writer: &Connection) -> rusqlite::Result<()> {
    writer.pragma_update(None, "wal_autocheckpoint", 0)?;
    writer.wal_hook(Some(wal_hook));
    Ok(())
}

/// The WAL length the last commit on this thread left, if it committed.
pub(crate) fn take_committed_pages() -> Option<i64> {
    COMMITTED_PAGES.with(|c| c.take()).map(i64::from)
}

#[derive(Default)]
struct State {
    /// The WAL's length in pages (its last frame), as of the last commit.
    frames: i64,
    /// How many of those the last checkpoint copied back.
    backfilled: i64,
    /// Commits so far.
    commits: u64,
    paused: bool,
    stop: bool,
}

impl State {
    fn backlog(&self) -> i64 {
        (self.frames - self.backfilled).max(0)
    }
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

/// One org file's checkpointer thread; stopped (and joined) when dropped.
pub(crate) struct Checkpointer {
    shared: Arc<Shared>,
    page_size: i64,
    thread: Option<JoinHandle<()>>,
}

impl Checkpointer {
    pub(crate) fn start(path: &Path, page_size: i64) -> std::io::Result<Self> {
        let shared = Arc::new(Shared::default());
        let thread = {
            let (shared, path) = (shared.clone(), path.to_path_buf());
            std::thread::Builder::new()
                .name("wal-checkpoint".into())
                .spawn(move || run(&path, &shared))?
        };
        Ok(Self {
            shared,
            page_size,
            thread: Some(thread),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A commit left the WAL `pages` long. Called on the writer, still
    /// holding the writer mutex: only bookkeeping.
    pub(crate) fn committed(&self, pages: i64) {
        let mut st = self.lock();
        if pages < st.frames {
            // The WAL restarted from the top: nothing in it is backfilled.
            st.backfilled = 0;
        }
        st.frames = pages;
        st.commits += 1;
        if st.backlog() >= HIGH_WATER_PAGES {
            self.shared.wake.notify_one();
        }
    }

    /// Bytes of WAL not yet copied back into the file.
    pub(crate) fn backlog_bytes(&self) -> i64 {
        self.lock().backlog() * self.page_size
    }

    /// Hold checkpoints (tests: to let the WAL grow).
    #[cfg(test)]
    pub(crate) fn set_paused(&self, paused: bool) {
        self.lock().paused = paused;
        self.shared.wake.notify_one();
    }
}

impl Drop for Checkpointer {
    fn drop(&mut self) {
        self.lock().stop = true;
        self.shared.wake.notify_one();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn wal_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push("-wal");
    PathBuf::from(p)
}

/// The thread: wait until a checkpoint is due, run it, record it. It never
/// returns early except on stop: an error is logged and tried again next
/// interval.
fn run(path: &Path, shared: &Shared) {
    let mut conn: Option<Connection> = None;
    let mut last = Instant::now();
    let mut seen_commits = 0;
    // The last checkpoint couldn't copy everything (a reader in the way).
    let mut left = false;
    // A `TRUNCATE` met a lock (Litestream's read lock, say): not again
    // until something commits.
    let mut truncate_refused = false;
    loop {
        let (committed, high_water) = {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if st.stop {
                    return;
                }
                let elapsed = last.elapsed();
                let new = st.commits != seen_commits;
                if !st.paused {
                    if new && st.backlog() >= HIGH_WATER_PAGES && elapsed >= HIGH_WATER_GAP {
                        break;
                    }
                    if elapsed >= INTERVAL {
                        break;
                    }
                }
                let wait = if st.paused {
                    INTERVAL
                } else {
                    INTERVAL - elapsed
                };
                st = shared
                    .wake
                    .wait_timeout(st, wait)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            let committed = st.commits != seen_commits;
            seen_commits = st.commits;
            (committed, st.backlog() >= HIGH_WATER_PAGES)
        };
        last = Instant::now();
        let busy = committed || left || high_water;
        if committed {
            truncate_refused = false;
        }
        if !busy
            && (truncate_refused
                || std::fs::metadata(wal_path(path)).map_or(0, |m| m.len()) <= TRUNCATE_ABOVE_BYTES)
        {
            continue;
        }
        if conn.is_none() {
            conn = match open(path) {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("wal-checkpoint {}: open: {e}", path.display());
                    continue;
                }
            };
        }
        let Some(c) = conn.as_ref() else { continue };
        // Idle: nothing committed for a whole interval, everything copied.
        let mode = if busy { "PASSIVE" } else { "TRUNCATE" };
        match checkpoint(c, mode) {
            // Didn't run (another checkpoint in progress): next interval.
            Ok((_, log, _)) if log < 0 => left = true,
            Ok((refused, _, _)) if mode == "TRUNCATE" => {
                truncate_refused = refused != 0;
                if refused == 0 {
                    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    // Empty now, unless a commit came in since (which then
                    // set `frames` itself).
                    if st.commits == seen_commits {
                        st.frames = 0;
                    }
                    st.backfilled = 0;
                }
            }
            Ok((_, log, done)) => {
                left = log > done;
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                // `log` is the WAL's length when the checkpoint ran; a
                // commit since may have made it longer (keep `frames`) or
                // restarted it (then `done` is about the old WAL, and the
                // next commit resets `backfilled`).
                if log >= st.frames {
                    st.frames = log;
                }
                st.backfilled = done;
            }
            Err(e) => {
                eprintln!("wal-checkpoint {}: {mode}: {e}", path.display());
                conn = None;
            }
        }
    }
}

/// The checkpointer's own connection: no busy timeout, so a `TRUNCATE`
/// that meets anyone gives up at once (a `PASSIVE` never waits anyway).
fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = conn::open(path, false, false)?;
    conn.busy_timeout(Duration::ZERO)?;
    Ok(conn)
}

/// `(busy, WAL pages, pages checkpointed)`; `-1, -1` when not in WAL mode.
fn checkpoint(conn: &Connection, mode: &str) -> rusqlite::Result<(i64, i64, i64)> {
    conn.query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })
}
