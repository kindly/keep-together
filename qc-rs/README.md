# qc-rs: the QC flows on the Rust backend

Rust spike step 3 (`factory/plans/rust-spike.sv`, results in
`docs/spikes/10-rust-sqlite.md`). This is not part of `pnpm qc` or
`pnpm check`. It reuses the Convex QC harness's timing code
(`qc/timing.ts`, re-exported here), so samples are taken the same way:
from the input event to the result on screen.

```bash
# The Rust API, with netem on :8787 if you want real latency (run unsandboxed)
(cd rs && KEEP_DATA_DIR=data KEEP_DEV_AUTH=1 KEEP_QC_SEED=1 ./target/release/api) &
VITE_BACKEND=rust npx vite build --outDir dist-qc-rs
QC_LEGS=0 QC_MODE=record npx playwright test -c qc-rs/playwright.config.ts \
  --grep-invert "identifier|gift|source codes|fields tab|bulk|Switch group|record-gift|a value B holds|B's fields|history pages|Restore to here|re-anchors|two tabs on one contact|unseen change|filter the list by a field|paper form"
node qc-rs/compare.mjs ../keep-together/qc-results/history.jsonl <run id>…
```

- **`.flows/`** (gitignored): the config copies the in-scope
  `qc/flows/*.spec.ts` files here verbatim, so their `../fixtures` import
  resolves to `qc-rs/fixtures.ts`. The `--grep-invert` above leaves out
  tests for features the Rust build doesn't have.
- **`rust/`**: flows the Convex specs can't run unchanged:
  - field filter on the seeded field (Rust has no Settings › Fields tab);
  - "Restore this";
  - two tabs without live queries;
  - tenancy against id and slug tampering;
  - contact numbers.
- **`serve.mjs`** serves the build and proxies `/api` over kept-alive
  connections. `vite preview`'s proxy opens a new connection per request,
  which under netem adds a second RTT to every call.
- **Cold cache by default.** Before each sample the fixture drops the
  TanStack queries that nothing is observing, as Convex drops an
  unsubscribed query, so a sample asks the server. `QC_RS_WARM=1` keeps
  the cache: repeat searches are then drawn from it in ~3 ms.
- **Requests per sample.** Each sample's `/api` calls are written to
  `qc-results/runs/<id>/rust-calls.jsonl`, with start and end times
  relative to the input event.
