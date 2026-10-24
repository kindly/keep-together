//! Seeded worlds, written through the same contract functions the API
//! calls: [`riverside`] (staging's reset seed, `keep dev seed-riverside`)
//! and [`perf`] (the 10k generator's JSONL, the `seed` bin).
//!
//! No dependency on `api` (whose reset uses this crate): callers open the
//! store with the api's schemas and pass its `seed_new_org`.

pub mod perf;
pub mod riverside;
