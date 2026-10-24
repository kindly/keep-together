<sv-page label="plan: migration to rust" category="plans">

<sv-prose id="b1">
# Plan: migration to Rust + SQLite per organisation

*planner-migration, 2026-10-24.* This page is the plan. The design tree comes first, then the brief, then the grill rounds. The brief's steps get sharper after each round.
</sv-prose>

<sv-prose id="tree">
## Design tree

**Settled before the grill (human, 2026-10-24)**

- **Move keep-together off Convex** to Rust (axum + rusqlite) with **one SQLite file per organisation** plus `platform.db`. The spike on `spike/rust` is the starting point.
- Reasons:
  1. **No lock-in.** It can be hosted anywhere, and each organisation owns its SQLite file.
  2. **Reporting.** SQL, including reports and data selections written by agents. A read-only per-org connection makes agent SQL safe by construction.
  3. **Agent-driven import.** Staging tables, SQL mapping and dedupe, commit through contracts, and undo by file snapshot. 10k contacts took 496 s on Convex and 15 s on Rust.
- Convex is **frozen**: fixes only, no new features.
- **Liveness via SSE.** Each org has a channel that sends an event after each commit. Clients use it for cache invalidation, list refetch and open-form merge notices. Search isn't live.
- Cross-contact checks (e.g. "also used by" on an email) may be **approximate**.
- **Auth from crates:** axum-login + tower-sessions + argon2 + totp-rs, with webauthn-rs later. Magic links, invites and roles are hand-written. A security review is required.
- **Litestream to S3.** The human runs the AWS commands. It is unmeasured, so a restore drill comes early. Litestream ≥ 0.5.4 can replicate a whole directory and pick up new org files with `watch: true` ([directory watcher](https://litestream.io/guides/directory-watcher/)).
- **Gifts are never optimistic.**
- **QC keeps its two-tier budgets:** a 150 ms failing line and a 100 ms tracked target.

**Round 1 (human, 2026-10-24): all as recommended, plus live list growth dropped**

- **Sequencing.**
  - Merge `rs/` into `main` now and tag `convex-final`. The preview stays on that build until Rust is hosted.
  - Each route is ported **straight to Rust**, with no dual-backend seam.
  - `convex/` stays in the tree as read-only reference and is deleted at cutover.
- **Vertical slices.** One builder owns a module end to end: crate, routes, SPA, tests and QC flows.
- **Dropped:**
  - fieldSlots: field values are rows;
  - the `contactSearch` table: FTS5 is maintained by the `project` hook;
  - two-phase schema changes: one migration per change, transactional per file;
  - id lineage and export/import: moving an org means copying its file;
  - `dev:instance` and cloud dev deployments: each worktree has a local data dir;
  - the paged-list split/merge/hold machinery: keyset paging + `useInfiniteQuery` + SSE refetch;
  - `tenantId` columns and the scoped constructors;
  - Workpool: an in-process scheduler loops over org files;
  - **live list growth in place**: lists refetch on SSE.
- **Kept and ported:** history moments, "Load older" and "Restore to here".
- **Hosting.**
  - Fly.io London: one machine, one volume, one process serving the API and the SPA from the same origin.
  - The API base URL stays configurable.
  - Litestream runs as a sidecar in the same machine.
- **Backups.**
  - Phase 0, before any real data.
  - Litestream `dir` + `watch` to S3 in `keep-prod` (eu-west-2, versioned).
  - Drill: kill the machine, then restore `platform.db` and every org file.
  - Checks: integrity check, row counts, search cases.
  - Targets: a 10k org back in under 60 s, at most 1 s of writes lost.
  - Then a monthly scheduled restore test.
- **Migrations.**
  - Every org file migrates at boot, before traffic, with bounded concurrency and a `VACUUM INTO` copy first.
  - Opens take a per-org lock.
  - Handles sit in an LRU with a cap and idle close.
  - Migrations are forward-only and transactional, and there is a fixture test for every past schema version.
- **Dev data.** Start fresh with the ported seeds. No Convex data move.
- **QC.**
  - Keep `qc/`. Drop `convex logs` blame, legs, the quiet gate and the RTT probe.
  - Server time comes from `Server-Timing`.
  - The gate is a local release build under netem at the hosted RTT, with a nightly run against hosted staging.
  - Each builder re-points the flows for the module it ports.
- **Auth v1** is ADR 0020 for staff, without Google:
  - argon2 passwords;
  - TOTP and an emailed code as second factors;
  - invites, reset by emailed link, and roles;
  - operator CLI for tenants and 2FA reset;
  - no enumeration.

  Google, WebAuthn and supporter logins come later.
- **Agent features.**
  - Don't preclude them.
  - Phase 0 adds `keep sql <org> "<select…>"` on a read-only connection.
  - Import and reports are separate plans after cutover.
- **DuckDB.**
  - SQLite stays the system of record.
  - DuckDB is later the engine for reports, agent queries and imports, attaching the org file read-only.
  - It is not built in this migration, and nothing here precludes it.
- **Factory.**
  - One foundation builder, then 3–4 in parallel.
  - A fresh reviewer per step.
  - Codex reviews foundation, auth and cutover.
  - The security review of auth is its own step.
  - The human checks in once per phase.

**Round 2 (human, 2026-10-24): all as recommended, except environments**

- **Environments.** There are only two Fly apps:
  - `keep-staging`, from phase 0. It replaces demo and preview and is reset to `riverside` on each deploy.
  - `keep-prod`, created at cutover.

  Both are in `lhr`, each with one machine and one volume. Everything else (QC, builders, dev) runs locally.
- **Deploys.** GitHub Actions on push to `main` (cargo test, `pnpm check`, image, deploy to staging). Prod is deployed by a manual `workflow_dispatch`.
- **Live form.**
  - An SSE event for the open contact fetches the changed slice and dispatches it into the reducer as a `server` update.
  - Typing is preserved, and the conflict badge shows on a clash.
- **SSE events** carry ids only: `{entity, id, contract, counter}`. Clients reconnect with `Last-Event-ID`, and a client that fell too far behind refetches everything.
- **Email** goes over SMTP via `lettre` to SES London (`auth.` domain, `keep-mail-tx`). Dev uses Mailpit or the log.
- **Tests.** Every test case whose rule still holds is ported as a named test. Each module's report carries a parity table (Convex test → Rust test, or "dropped, because …"), which the reviewer checks.
- **Crates.**
  - One crate per module: `contacts`, `sources`, `giving`, `giftaid`, `comms`, plus `platform`, `auth`, `store`, `contracts`, `api`.
  - Commands that span modules live in `api` and run in one `OrgTx`.
- **Phase 0 runs as three parallel builders:** F1 core, F2 ops, F3 SPA.
- **Auth runs in wave A**, in parallel with the domain slices.
- **Pages.** `pages.yml` is pinned to `convex-final` now, and Pages is retired once staging is up.
- **Teardown.** Convex code goes at cutover. The Convex cloud project stays for 30 days, then the human deletes it.
- **Layout.** At cutover `rs/` becomes `server/`, the SPA stays at the root, and the pnpm scripts wrap cargo.
- **Backups.** Hourly snapshots run as well as Litestream:
  - only orgs that changed, plus `platform.db`;
  - stored in a separate bucket in another account, with Object Lock;
  - kept hourly for 48 h, daily for 30 d and monthly for 12 months;
  - the drill restores from both.

**Round 3 (human, 2026-10-24): all as recommended, brief confirmed**

- Domains: `staging.keep-together.org.uk` now and `app.keep-together.org.uk` at cutover, as CNAMEs to Fly.
- The snapshot bucket goes in a **new `keep-backup` account**, added to `bootstrap.sh`, which the human runs.
- Monitoring:
  - Sentry EU (free tier, scrubbed) for errors;
  - `/healthz` with Litestream lag and snapshot age;
  - a 15-minute GitHub cron that opens an issue on failure, or when a backup is more than 2 h stale.
- The cutover gate is as written in C1.
- **The plan is confirmed.**

**Facts the plan adopts without a question** (from the spike's findings):
- A stale retry is sent at once, not after the 700 ms autosave pause.
- Archive, restore and create return the new view, so each is one round trip.
- Cold load is one bootstrap request (`/api/t/{slug}/boot`: me, fields, first page).
- `OrgTx` no longer derefs to a connection, so contracts hold by construction (M3).
- The Vite proxy runs only for `VITE_BACKEND=rust`, and dev auth counts as no auth (M1).
- Client ids are validated.
- History of an unknown id answers 404.
- The trigram variant goes.
- `qc-crowd` is capped.
- Sessions expire, and cookies are `Secure`.
- Any table or column without `INTEGER` pence fails a schema test (rule 7).

**Grill complete (2026-10-24).**
</sv-prose>

<sv-prose id="goal">
## Goal

Bring keep-together to parity with `main` on the Rust backend, then switch `main` to it and delete `convex/`. Parity means:

- every feature built on `main` today;
- its domain tests;
- its QC flows under the budgets;
- real auth;
- email;
- backups with a proven restore.

The plan has to let builders run in parallel without asking questions, and go faster than the spike's 10–14 factory days.

**Out of scope:** new features (payments, Direct Debit, supporter logins, bulk email beyond what exists), agent features beyond what round 1 decides, and dedicated-instance tooling.

**Domain rules:** every one of the seven applies, because the whole product moves. Rule 6 changes mechanism, not meaning: the org file *is* the tenant scope, and domain crates never see a tenant id. Rule 7 becomes INTEGER pence with no REAL columns, and a schema test enforces it.
</sv-prose>

<sv-prose id="adr">
## ADR needed (proposed, not written here)

**ADR 0024 — Rust + SQLite per organisation.** It supersedes ADR 0017's stack, tenancy mechanism, tiers and export/import parts, and amends 0018 (QC pool and blame) and 0020 decision 4 (auth library). It re-expresses 0013's contracts on SQLite transactions. Phase 0 writes it, and it reuses the spike doc's numbers.
</sv-prose>

<sv-prose id="scope">
## What parity means (inventory of `main`)

Full survey: `factory/out/planner-migration-inventory.md`.

| area | on `main` | spike covers | to port |
|---|---|---|---|
| contacts core + child rows + numbers + fields + search | built | yes, except below | warnings `alsoUsedBy`, `bulkSetField`, field delete/reorder/retire, `sharedAddresses`, `byClientKey`, history moments / "Load older" / "Restore to here", retired tags revisions rendering |
| identifiers + types | built | no | contracts `contacts.identifiers`, `contacts.identifierType`, settings tab |
| notes | built | no | `contacts.note`, `contacts.noteFlags`, UI |
| relationships | backend only | no | contracts + seed of UK types (no UI to port) |
| source codes + acquisition | built | no | `sources.code` (`used` preserved), `contacts.acquisition`, tree editor, picker, list filter |
| cash gifts (void/unvoid) + `recordGift` | built | no | `giving.gift`, `giving.status`, allocations projection, gift pages, home "my recent" |
| Gift Aid declarations + IRmark | built (no claim) | no | three `giftaid.*` contracts (declaration v2), `rules.ts`, IRmark in Rust with the HMRC fixture |
| comms suppressions | partial (E2a) | no | `comms.suppression`, email hold UI |
| platform: tenants, memberships, preferences, groups | built | partly (tenants, memberships) | three preference contracts, operator tenant creation + seeds, `mine`/`opened`, settings layout |
| auth | password + roles only | dev stub | real auth (round 1 q9) |
| seeds | devSeed, testSeed, qcSeed | qc-seed, 10k seed | devSeed, testSeed riverside |

**Not built on `main`, so not part of parity:** merge/tombstone, the consent log, `comms.send`/SES, Direct Debit, crons, erasure, export, Gift Aid claims.

**Size:** about 10.4k lines of Convex code and 15.7k of tests. The spike ported about 4k of it. About 12k lines of SPA, of which only the data layer and the contacts hooks change much.

</sv-prose>

<sv-prose id="phases">
## Steps (builder briefs)

**Shape:** step 0 → phase 0 (F1, F2, F3 in parallel) → wave A (A1–A4 in parallel) → wave B (B1–B3 in parallel, plus the auth security review) → cutover (C1, then C2). Estimate: about **5–6 factory days** of builder time, paced by the human's check-ins and AWS/Fly commands.

**Every step:**
- One builder in its own worktree: `factory/spawn.sh builder <name> keep-together-f1 --worktree port/<step>`. Then a fresh reviewer, a fix round, and a merge to `main` by the controller.
- The builder reads `CLAUDE.md`, including its migration section (F1 adds it), `rs/README.md`, and the Convex source it ports (`convex/…`, read-only reference).
- **Definition of done:**
  - `cargo test` and `cargo clippy -- -D warnings` (from `rs/`) pass;
  - `pnpm check` passes;
  - the module's QC flows pass locally under budget;
  - every route is isolation-tested (two orgs: B never sees A, and A's ids under B's slug answer 404);
  - the report has a **parity table**: each Convex test in the module → its Rust/dom test, or "dropped: reason".
- **Local data:** `rs/data/` in the worktree (gitignored). Each worktree uses its own `KEEP_PORT` (8787 + n), and Vite proxies to it. No cloud deployments.
- Never write to a domain table except through `contracts::execute` (sealed in F1). Money is `INTEGER` pence. Domain crates never see a tenant id.

### Step 0: merge and pin (controller, ~15 min)

1. Tag `main` (a5e2b0a or later) as `convex-final`.
2. Change `.github/workflows/pages.yml` to check out `convex-final` (`ref: convex-final`), so the Pages demo keeps the Convex build.
3. Merge `spike/rust` into `main` (11 commits, no conflicts expected). Push.

### Phase 0: three builders in parallel

**F1, core (`builder-f1-core`, branch `port/f1`)**

*Files:* `rs/crates/{store,contracts,api}/**`, new empty crates `rs/crates/{platform,auth,sources,giving,giftaid,comms,cli}` (only their Cargo manifests and `lib.rs`, so later builders don't collide on the workspace), `vite.config.ts`, `CLAUDE.md` (a new "Migration to Rust (in progress)" section only), `rs/README.md`.

The first commit fixes the SSE event type, `{seq, entity, id, contract, counter}`, as a ts-rs type, so F3 can code against it.

1. **M1.**
   - Proxy `/api` only when `VITE_BACKEND=rust`.
   - The README says dev auth means no auth.
   - Dev routes are refused unless the server binds 127.0.0.1.
2. **M2.**
   - Replace the global `orgs` mutex with per-org open locks (open-once cell per tenant).
   - Add an LRU of open handles with a cap (`KEEP_MAX_OPEN_ORGS`, default 64) and idle close after 10 min. A handle in use is never closed (it is an `Arc`).
   - Test: a slow open of org A doesn't block a request to an already open org B, and opening the cap + 10 orgs keeps the number of fds bounded.
3. **Boot migration.**
   - On start, `Store::migrate_all()` opens every `orgs/*.db`, 4 at a time.
   - Before running pending migrations on a file, it writes a `VACUUM INTO data/premigrate/<id>.v<from>.db` copy and deletes older copies.
   - **Fail closed:** any failure stops the boot with the org named, so the deploy fails visibly.
   - Rollback is the previous image plus `scripts/ops/rollback-migration.sh`, which puts the copies back.
   - **Migration fixture test:** for each version N, build a file at N with representative rows, migrate it to head, and assert row counts and `PRAGMA integrity_check`. A new migration must add its fixture.
4. **M3.**
   - `OrgTx` no longer derefs to `Connection`.
   - `contracts` gets crate-private write access. `projection` hooks and the sequence allocator use a narrow `ProjectionTx` / `SeqTx` API.
   - A compile-fail test (trybuild) shows that domain code can't call `execute` on raw SQL.
5. **Lows.**
   - L1: cap `qc-crowd` at 10k.
   - L2: sessions expire (7 days), cookies `Secure` (except on localhost) and `HttpOnly`. Auth replaces the store later.
   - L3: `create_tenant` adds the handle to the cache only after the platform commit.
   - L4: history of an unknown id answers 404.
   - L5: client ids and child keys must be 32 hex characters.
   - L6: cap fields per org (200) and child rows per contact (50 of each kind).
   - L7: delete the trigram variant.
6. **SSE.**
   - `GET /api/t/{slug}/events` is `text/event-stream` and needs a member session, viewer or above.
   - Each org has a `tokio::sync::broadcast` channel. `OrgDb::write` publishes **after commit** one event per executed contract. `seq` is the revision row id, so it is monotonic per file.
   - `Last-Event-ID` replays from `revisions` where `id > n`, at most 1000 rows. Beyond that the server sends one `reset` event.
   - Keep-alive comment every 20 s.
   - Tests: an event arrives after commit, never on a rolled-back write; replay works; B's stream never carries A's events.
7. **Round trips.**
   - Archive, restore and create return the contact view.
   - A new `GET /api/t/{slug}/boot` returns `{me, org, fields, firstPage}`.
8. **Jobs.**
   - `Store::each_org()` yields org ids.
   - `api::jobs` runs named in-process interval jobs, each looping over org files one at a time and never across files in one transaction. F2's snapshot job is the first user.
9. **`keep` CLI** (`rs/crates/cli`, bin `keep`). Subcommands:
   - `keep sql <slug> "<sql>"` opens the org file `SQLITE_OPEN_READ_ONLY` with `query_only`, an authorizer that allows only `SELECT`/`READ`/`FUNCTION`, `ATTACH` limited to 0, and a 10 s progress-handler timeout. Output is CSV, or `--json`.
   - `keep tenant create --slug --name --admin-email` is a stub until A3.
   - Tests: a `DELETE`, `ATTACH`, `PRAGMA writable_schema` or CTE write is refused, and the file is unchanged.
10. **Schema guard test.** No `REAL` column in any org table, and every column named `*amount*` / `*pence*` is `INTEGER` (rule 7).
11. **CLAUDE.md migration section.** Convex is frozen, so builders port into `rs/`. The section names the conventions above. The Convex sections stay until C2.

**F2, ops (`builder-f2-ops`, branch `port/f2`)**

*Files:* `rs/Dockerfile`, `fly.staging.toml`, `rs/litestream.yml`, `rs/crates/api/src/{static_files,backup}.rs` (new files only), `scripts/aws/backup.sh`, `scripts/fly/*.sh`, `scripts/ops/*.sh`, `.github/workflows/{ci,deploy,drill}.yml`, `docs/ops.md`, `docs/decisions/0024-rust-sqlite-per-org.md`.

1. **Static SPA.** The api serves `dist/` with an SPA fallback when `KEEP_STATIC_DIR` is set. `/api/*` never falls back. The SPA reads `VITE_API_BASE` (default same origin).
2. **Image.** Multi-stage:
   - pnpm build with `VITE_BACKEND=rust`;
   - cargo release build of `api` and `keep`;
   - runtime `debian:stable-slim` with the Litestream release binary (≥ 0.5.4, version pinned).
   - The entrypoint is `litestream replicate -config /etc/litestream.yml -exec "api"`, so Litestream supervises the app.
3. **Litestream config.**
   - One `dir: /data/orgs` entry with `pattern: "*.db"` and `watch: true`, plus `/data/platform.db`.
   - The S3 replica is in `keep-prod` eu-west-2, prefix per environment.
   - Retention 7 days, snapshot interval 24 h.
4. **Hourly snapshots** (`backup.rs`, registered with F1's jobs).
   - Every hour, for each org whose max revision id moved since the last snapshot, plus `platform.db`:
     1. run the SQLite online backup API to a temp file;
     2. run `integrity_check`;
     3. compress with zstd;
     4. upload with the `object_store` crate (S3-compatible, provider-neutral) to the snapshot bucket under `<env>/<tenant-id>/<utc-hour>.db.zst`.
   - Object Lock retention and the lifecycle rules (hourly 48 h, daily 30 d, monthly 12 months) are set by the AWS script, not the app.
   - Snapshot state lives in `platform.db` (`snapshots(tenant_id, last_revision, at)`).
5. **AWS script** `scripts/aws/backup.sh`, idempotent and echoing every command. The human runs it. It makes:
   - the Litestream bucket in `keep-prod` (versioned, SSE-S3, public access blocked);
   - the snapshot bucket in the new `keep-backup` account (`scripts/aws/bootstrap.sh` gains the account; the human runs both) (Object Lock in governance mode, lifecycle);
   - one IAM user per environment, limited to its prefix (put/get/list, no delete on the snapshot bucket), with access keys printed for `fly secrets set`.
6. **Fly.**
   - `scripts/fly/staging.sh` (the human runs it) creates the app `keep-staging` in `lhr`, a 1 GB volume `keep_data` and the secrets.
   - The script prints the Route 53 CNAME for `staging.keep-together.org.uk` and runs `fly certs add`.
   - `fly.staging.toml` sets a health check on `/healthz`, which reports DB open, Litestream lag (seconds since the last WAL upload, from Litestream's metrics endpoint) and last snapshot age.
   - Staging boots with `KEEP_RESET_SEED=riverside`, which wipes and re-seeds on each deploy. That seed is the QC seed until B3 ports riverside.
7. **CI.**
   - `ci.yml` adds the Rust toolchain, `cargo test` and `clippy`, with a cache.
   - `health.yml`: a cron every 15 min that calls `/healthz` on each live environment and opens a GitHub issue on failure, or when the last snapshot is more than 2 h old or Litestream lags.
   - Sentry (EU region, DSN as a Fly secret and a build var) for api (`sentry` crate) and SPA errors. Request bodies, emails and cookies are scrubbed.
   - `deploy.yml`: on push to `main`, after checks, `flyctl deploy -c fly.staging.toml` (secret `FLY_API_TOKEN`, which the human adds). A `workflow_dispatch` input `env=prod` is stubbed until C2.
8. **Restore drill** (`scripts/ops/restore-drill.sh` + `docs/ops.md`). Seed a 10k org on staging with the `seed` bin, then:
   1. destroy the machine and volume;
   2. create a fresh volume;
   3. `litestream restore` `platform.db` and every org file;
   4. boot.

   Then check `integrity_check`, row counts against the pre-drill counts (taken with `keep sql`) and the 10k search cases. Repeat from the snapshot bucket. Record the timings. **Pass:** a 10k org back in under 60 s from either source, and at most 1 s of acknowledged writes lost (on Litestream). `drill.yml` repeats the restore part monthly in a GitHub runner and fails loudly.
9. **ADR 0024.** Draft it from this page's design tree and the spike doc (Status: proposed). It supersedes the 0017 parts listed above and amends 0018 and 0020 §4.

**F3, SPA (`builder-f3-spa`, branch `port/f3`)**

*Files:* `src/lib/data/**`, `src/main.tsx`, `src/routes/t.$slug*.tsx` (layout and nav only), the contacts routes, `src/components/contact-form*.tsx`, `src/lib/contact-form-state.ts`, `qc/**`, `qc-rs/**` (folded into `qc/` and deleted), `package.json` scripts.

1. **Rust-only SPA.**
   - The `VITE_BACKEND` switch and `convex-*` data files go. `ConvexProvider` leaves `main.tsx`.
   - Routes not yet ported render a "being ported" placeholder and are hidden from the nav, driven by one `PORTED` list in `src/lib/data/ported.ts`. Each wave step adds its routes there.
   - Unported components (e.g. `gift-form.tsx`) stay on disk until their slice ports them, with dom tests left as they are.
2. **Boot.** One `/boot` request on cold load seeds the TanStack cache.
3. **SSE client** (`src/lib/data/events.ts`).
   - One `EventSource` per open tenant.
   - A table maps `entity` to the query keys to invalidate: list, search and the entity's own view.
   - On `reset`, invalidate everything. Reconnect uses the browser's `Last-Event-ID`.
4. **Live form merge (r2q3).**
   - An event for the open contact with a counter above the form's fetches the slice and dispatches it as a `server` update.
   - Port the Convex tests "remote edit lands under in-progress typing" and "conflict badge" as dom and QC tests.
5. **Stale retry.** A queued retry after a 409 is sent at once, as `saveNow` does. Target: the stale path under 150 ms (QC flow `contact.staleMerge`).
6. **QC re-pointed** (folding in `qc-rs/`):
   - **Pool:** N local release `api` servers (`KEEP_PORT` 8801+i, data dir `qc-data/<i>`, `KEEP_QC_SEED=1`) behind `serve.mjs` keep-alive.
   - **Server time** comes from `Server-Timing`.
   - **Delete** `blame.ts`, `live.ts`, the WebSocket legs in `timing.ts`, `quiet.ts`, `server-timings*.ts`, the RTT probe and `scripts/qc-instances.mjs`.
   - **Judging** goes back to ADR 0018's base rule: re-measure once, fail if over twice.
   - **Netem RTT** = the median RTT from this machine to `keep-staging` (measured with curl once staging is up; 30 ms until then), in `qc/rtt.json`.
   - **Coverage gate.** Flows of unported modules are marked `pendingPort` and listed in the run banner, so they don't fail the run.
   - **Nightly:** `pnpm qc --target staging` against `keep-staging` (no netem), recorded in `history.jsonl` with `env: staging`.
7. **Two-tab live propagation** flow `contact.livePropagation` returns, under 150 ms from save to the other tab.

### Wave A: four builders in parallel, after F1–F3 merge

Each one ports backend, routes, SPA and QC flows, and adds its routes to `PORTED`.

**A1, contacts-rest (`builder-a1-contacts`)**

*Files:* `rs/crates/contacts/**`, `rs/crates/comms/**`, `rs/crates/api/src/routes/{contacts,identifiers,notes,relationships,comms}.rs`, the contact page sections, `src/routes/t.$slug.settings.identifiers.tsx`.

- Identifiers: `contacts.identifiers`, `contacts.identifierType` (cap 200), the `tenantPreferences.identifierTypes` switch read through `platform`, and the Settings › Identifiers tab.
- Notes: `contacts.note` (≤ 20 KB), `contacts.noteFlags`, pinned and archived.
- Relationships: backend contracts, plus the UK types seed as `contacts::seed_new_org` (no UI).
- Comms: `comms.suppression` and the email-hold UI with Release. `releaseAtProvider` stays a no-op.
- Contact lookups:
  - warnings `alsoUsedBy`, approximate and indexed on normalised email;
  - `sharedAddresses`;
  - `byClientKey` idempotent create;
  - `findByEmail` and `findByIdentifier` as crate functions.
- Convex tests: `identifiers`, `identifierTypes`, `notes*`, `relationships`, `suppressions`, `contacts.test.ts` (remaining cases), `warnings`. QC flows: `contact-identifiers`, `contact-notes`, the email hold, and "also used by".

**A2, sources and acquisition (`builder-a2-sources`)**

*Files:* `rs/crates/sources/**`, `rs/crates/contacts/src/acquisition.rs`, `routes/sources.rs`, `settings.sources`, `source-code-picker`, `contact-acquisition`, the list's source filter.

- `sources.code` (with `used` preserved across save, reconcile and restore), delete while unused, `tree`, `picker` (search, 50), `filterOptions`, `describe`, and the seven starter categories as `sources::seed_new_org`.
- `contacts.acquisition` (FTS projection of the code, detail and category).
- The list filter by category, detail and version (SQL join).
- The tree editor's live merge of concurrent edits, through SSE plus the reducer.
- Convex tests: `sources`, `writers`, `acquisition`, `sourceFilter`, `picker.timing`, `src/lib/source-codes.test.ts`. QC: `sources.spec`, `contact-acquisition.spec`.

**A3, platform (`builder-a3-platform`)**

*Files:* `rs/crates/platform/**` (tenants, memberships and preferences move here from `store`), `rs/crates/cli` (`tenant create`), `routes/{me,groups,preferences}.rs`, `src/routes/index.tsx`, `t.$slug.settings.tsx`, `settings.groups`, the staff-list switch.

- Operator `keep tenant create` makes the file, runs every crate's `seed_new_org`, creates the admin membership and the invite (an email stub until A4).
- `mine`, `opened` (lastUsedAt) and Switch group.
- The three preference contracts (`tenantPreferences.identifierTypes`, `.sourceCodes`, `.fields`), each its own counter.
- `tenantSettings` with AES-GCM under `KEEP_SETTINGS_KEY` (unused by features yet, but tested).
- devSeed `demoTenant` as `keep dev seed-demo`.
- Convex tests: `tenants`, `preferences`, `lib/tenancy` (rewritten as file-scope tests), `roles` (every write route refuses a viewer, as a route-table meta-test). QC: `groups.spec`, `settings.spec`, `isolation.spec` (whole).

**A4, auth (`builder-a4-auth`)**

*Files:* `rs/crates/auth/**`, `rs/crates/api/src/auth.rs` (replaces the stub), `rs/crates/comms/src/mail.rs` (lettre transport only; coordinate with A1, who owns the rest of `comms`), `src/routes/{index,sign-in*,invite*,reset*,account*}.tsx`, `src/routes/t.$slug.settings.members.tsx`.

- axum-login + tower-sessions (store in `platform.db`), argon2id passwords (min 8), a dummy-hash on unknown email (no enumeration), rate limit per IP and per email (`tower_governor`).
- Invite-only staff: an admin invites, the email link leads to setting a password and enrolling 2FA.
- 2FA required. The user picks TOTP (totp-rs, QR) or an emailed 6-digit code, and gets 10 recovery codes.
- Reset by emailed link (15 min, single use).
- 7-day sessions. Admin routes need a sign-in within the last hour (step-up).
- Members settings: invite, remove, re-role, reset 2FA. At least one admin always remains.
- `keep auth reset-2fa <email>` (operator, logged).
- Email over `lettre` SMTP to SES (`auth.` domain). Dev uses Mailpit at `localhost:1025`, or `KEEP_MAIL=log`.
- `KEEP_DEV_AUTH` stays for local QC only and is refused when `KEEP_ENV=prod|staging`.
- Convex tests: `auth.test.ts`, `authErrors`. New tests cover every ADR 0020 §3 rule. QC: `auth.spec` (sign-in with TOTP via a test secret).

### Wave B: three builders, plus the security review

**B1, fields admin and history (`builder-b1-fields`)**

*Files:* `rs/crates/contacts/src/{fields,history}.rs`, `settings.fields`, `bulk-set-field`, the history panel.

- Field delete, option reorder, and retire (a batched job through `api::jobs`, no 100-row cap needed).
- `bulkSetField`: one command group, up to 1000 contacts per call.
- The Settings › Fields UI (1,134 lines to port).
- History with moments, "Load older" (pages of 10), and "Restore to here" (`restoreTo`, only the slices that differ). Retired `contacts.tags` / `contacts.tag` revisions render read-only.
- Convex tests: `fields`, `fieldValues`, `history`, `revision-group-name`, `listFilter`, `-settings-fields.dom`, `bulk-set-field.dom`, `contact-history*`. QC: `fields.spec`, the history flows.

**B2, giving and Gift Aid (`builder-b2-giving`)**

*Files:* `rs/crates/{giving,giftaid}/**`, `routes/{gifts,giftaid}.rs`, `src/routes/t.$slug.gifts.*`, `t.$slug.index.tsx`, `contact-giftaid.tsx`, the Gifts panel.

- `giving.gift` (amount `INTEGER` pence, allocations), `giving.status` (void and unvoid), the allocations projection, `byContact` (keyset, 50), `myRecent`, `get`, `donor`, `history`.
- `recordGift` in `api`: one `OrgTx` composing an optional new contact, acquisition, the gift and a declaration, under one command group.
- `giftaid.declaration` (v2, identity upcaster from v1), `giftaid.cancellation`, `giftaid.void`.
- `rules.rs`: the dated-chain eligibility (rule 1).
- IRmark in plain Rust (sha1 + base64 over the canonical body), proven against `test/fixtures/hmrc`.
- **Never optimistic.** The gift form and void/unvoid show only server-confirmed state.
- Convex tests: `giving`, `recordGift`, `declarations`, `rules`, `irmark`, `gift-form*`, `-gift.dom`, `contact-giftaid.dom`. QC: `gift-record.spec`, `gifts.spec`.

**B3, seeds and QC completion (`builder-b3-seeds`)**, starts when B1 and B2 are halfway through.

*Files:* `rs/crates/seed/**`, `rs/crates/api/src/routes/qc_seed.rs`, `qc/**`.

- `testSeed` riverside as `keep dev seed-riverside`: the fixed-seed 100 donors with notes, relationships, gifts and one password user per role. It becomes staging's reset seed.
- The QC seed covers every module's fixtures.
- Clear every `pendingPort` mark in QC. The full suite is green locally, and nightly on staging.

**S1, auth security review (`reviewer-auth-sec`)**, after A4 merges, in parallel with wave B.

- A fresh reviewer reads `auth`, `api/auth.rs`, the session store and the email flows against the OWASP ASVS L2 auth/session chapters and ADR 0020 §3.
- Codex runs alongside (`codex exec`, per CLAUDE.md). Findings go to A4's fix round.

### Cutover

**C1, readiness gate (controller, plus a codex review of all of `rs/`).** Cutover may start when every one of these holds:
- every row of the parity table on this page is ported, and every parity table reviewed;
- QC full suite green locally, and 3 nightly runs on staging in a row;
- the restore drill has passed from both sources;
- S1 is closed;
- codex findings are fixed or waived by the human;
- the human has clicked through staging.

**C2, switch (`builder-c2-cutover`).**
1. The human runs `scripts/fly/prod.sh` and `backup.sh prod`, and sets up DNS.
2. The `deploy.yml` prod path goes live.
3. Delete `convex/`, `convex.json`, the Convex packages, `.claude/skills/convex-*`, `.agents/` Convex mirrors, `skills-lock.json` Convex entries, the Convex scripts (`dev-instance.sh`, `convex-*.mjs`, `test-instances.mjs`, `rehearsal.mjs`, `tenant-export.py`), `pages.yml`, and every Convex env var.
4. Rename `rs/` to `server/`. The pnpm scripts wrap cargo: `pnpm dev` runs api and Vite, `pnpm check` runs cargo and TS.
5. Rewrite `CLAUDE.md`, `docs/architecture.md` and `AGENTS.md` for the new stack. Retire `docs/migrations.md`. ADR 0024 becomes Accepted.
6. Tag `rust-cutover`. 30 days later the human deletes the Convex cloud project.
</sv-prose>

<sv-prose id="tests">
## Tests that prove it

- **Per module:** the named ports of every Convex test case whose rule still holds, plus the parity table.
- **Tenancy:**
  - every route under two orgs: 403 on the other slug, and 404 for the other org's ids under one's own slug;
  - SSE streams carry only the org's events;
  - `keep sql` is read-only;
  - files are stamped.
- **Contracts:** sealed (`trybuild`). For every contract: stale refusal, revisions, restore through upcasters, child ids.
- **Migrations:** a fixture per schema version, boot-migrates to head, integrity check.
- **Backups:** the drill (Litestream and snapshot) with timings in `docs/ops.md`, monthly in CI.
- **QC:** every flow under the two-tier budgets, locally under netem at the staging RTT, and nightly against staging.
</sv-prose>

<sv-prose id="rules">
## Domain rules check

| rule | where it applies |
|---|---|
| 1 Gift Aid dated chain | B2 `giftaid::rules`, ported tests |
| 2 consent log | not built on `main`, so not in this port; the consent plan comes later on Rust |
| 3 anonymise, never delete | no delete route for contacts or gifts; deletion only of unused source codes and options, as on `main` |
| 4 reclaim is a record | no claim on `main`; the schema leaves room |
| 5 suppression centralised | A1 `comms` owns suppression; A4's auth mail is transactional and never checks marketing opt-outs |
| 6 no tenants in domain code | the org file is the scope; domain crates have no `platform` dependency (review checks `Cargo.toml`) |
| 7 integer pence | F1 schema guard test; B2 money columns `INTEGER` |
</sv-prose>

<sv-prose id="grill-intro">
## Grill

Rounds 1–2 settled the roots and the mechanisms. Round 3 covers the last open branches and asks you to confirm the brief.
</sv-prose>

<sv-ask id="r1q1" round="1">
**Sequencing: where does the port happen, and when does Convex go?** Today `main` is the spike's base plus one plan commit, so merging is trivial.
- * Merge `rs/` into `main` now. Tag `convex-final`, and the preview keeps running that build until Rust is hosted. Port each route **directly to Rust**, with no dual-backend seam to maintain. Keep `convex/` in the tree as read-only reference for builders and delete it at cutover.
- Run both backends behind `VITE_BACKEND` until full parity, then flip. Convex stays usable throughout, but every route needs two implementations.
- Use a long-lived `rust` branch and merge to `main` at parity.
</sv-ask>

<sv-ask id="r1q2" round="1">
**Slicing for parallel builders.**
- * **Vertical slices.** One builder owns a module end to end: crate, routes, SPA hooks and routes, domain tests and QC flows. Modules: contacts-rest, sources, fields settings, giving, Gift Aid, comms, platform/settings.
- Horizontal: backend builders first, then SPA builders against the finished API.
</sv-ask>

<sv-ask id="r1q3" round="1" pick="many">
**Drop or simplify.** Ticked items go; unticked ones are ported as they are.
- * `fieldSlots`: field values become rows, with no five-field limit (the spike already does this)
- * The `contactSearch` projection table: the FTS5 table is rebuilt by the contract's `project` hook
- * Two-phase schema changes: one migration per change, run in a transaction per file
- * Id lineage and snapshot export/import: moving an org between hosts = copying its file
- * `pnpm dev:instance` and cloud dev deployments: each worktree gets its own local data dir
- * Paged-list split/merge/hold machinery: keyset paging + `useInfiniteQuery` + SSE refetch
- * `tenantId` columns and scoped constructors: the org file is the scope
- * Workpool fan-out for per-tenant jobs: an in-process scheduler loops over org files
- Live list growth in place (refetch on SSE instead)
- History "moments", "Load older" and "Restore to here" (the spike has a flat list)
</sv-ask>

<sv-ask id="r1q4" round="1">
**Hosting.**
- * **Fly.io London** (`lhr`): one machine and one volume, with **one process** serving the API and the built SPA from the same origin, so cookies need no CORS. The API base URL stays configurable, so the SPA can still be served elsewhere. Litestream runs as a sidecar process in the same machine.
- A plain VPS (Hetzner or a UK provider) with systemd, Caddy and Litestream: cheaper per month, but we patch the OS.
- Fly for the API and GitHub Pages for the SPA (cross-origin cookies and CORS).
</sv-ask>

<sv-ask id="r1q5" round="1">
**Backup and restore drill.**
- * In **phase 0, before any real data**: Litestream `dir` + `watch` to an S3 bucket in `keep-prod` (eu-west-2, versioned, SSE). The human runs a script the builder writes. Drill: kill the machine, restore `platform.db` plus every org file onto a fresh volume, then run `PRAGMA integrity_check`, row counts and the search cases. Target: a 10k org back in under 60 s, with ≤ 1 s of writes lost. After that it runs as a monthly scheduled restore test.
- The same drill, but after cutover.
- Litestream plus a nightly `VACUUM INTO` snapshot per org kept for 30 days, so there is a second copy that doesn't depend on Litestream.
</sv-ask>

<sv-ask id="r1q6" round="1">
**Migrations across many org files** (reviewer M2: one global lock held through open and migrate; handles never closed).
- * **Migrate every org file at boot**, before serving traffic, with bounded concurrency and a pre-migration copy of each file (`VACUUM INTO`) kept until the next deploy. Opens take a **per-org** lock. Handles live in an **LRU cache with a cap and idle close**. Each migration is forward-only and transactional. A test runs every migration over fixture files from each past schema version.
- Migrate lazily on first open (as the spike does), with a per-org lock and the LRU.
</sv-ask>

<sv-ask id="r1q7" round="1">
**Dev data.**
Every deployment is seeded and disposable: demo and preview reset to a fixed-seed `riverside`, and QC and rehearsal slots are wiped. The docs say there are no real tenants. The one unknown is **your own `zany-bird-247`**.
- * **Start fresh.** Port the seeds (`devSeed:demoTenant`, `testSeed` riverside with 100 donors, the QC seed, the 10k perf generator) through the contracts. No Convex → SQLite data move.
- Also import `zany-bird-247`: `scripts/tenant-export.py` writes a per-tenant JSONL, and a one-off Rust importer reads it through the contracts. Say what's there in the rider.
</sv-ask>

<sv-ask id="r1q8" round="1">
**QC harness.**
- * Keep `qc/` (Playwright flows, `timing.ts`, budgets, judge, trend, coverage). Drop the Convex-specific parts: blame from `convex logs`, legs, the WebSocket quiet gate and the RTT probe function. Server time comes from `Server-Timing`. The **gate** is a local release build with `tc netem` at the hosted RTT. A **nightly run** goes against the hosted staging app. Flows are re-pointed per module by the builder who ports it.
- Run QC only against the hosted app.
</sv-ask>

<sv-ask id="r1q9" round="1">
**Auth scope for v1.** On `main` today only roles (R1–R3) exist. Invites, 2FA, reset and Better Auth were never built, so this is new work on either stack. ADR 0020 decisions 2 and 3: roles admin/staff/viewer, invite-only staff, 2FA required, 7-day sessions, re-auth within an hour for admin.
- * **v1 = ADR 0020 for staff, without Google.** Email + password (argon2), TOTP **and** an emailed code as second factors, invites, reset by emailed link, roles, operator CLI for tenants and 2FA reset, and the no-enumeration rules. Google, WebAuthn and supporter logins come later.
- The same, with Google sign-in in v1.
- A smaller v1: password + TOTP only. Invites by operator CLI, no emailed codes.
</sv-ask>

<sv-ask id="r1q10" round="1">
**Agent-facing features: now, or only "don't preclude"?**
- * **Don't preclude, plus one cheap enabler in phase 0:** an operator CLI `keep sql <org> "<select…>"` on a read-only connection, which also proves the safety claim. Import with staging tables and a report builder are separate plans after cutover.
- In scope now: the read-only SQL runner and agent import (staging tables + commit through contracts + snapshot undo).
- Don't preclude only. Build nothing.
</sv-ask>

<sv-ask id="r1q11" round="1">
**Factory process.**
- * Phase 0: **one builder** (foundation), then **3–4 parallel builders** on vertical slices (cap 6 workers, leaving room for reviewers). **A fresh reviewer per step**, plus codex on foundation, auth and cutover. **Security review** of auth as its own step. The human checks in once per phase.
- Two builders at a time, reviewer every step.
- As many builders as modules (6), review at phase ends only.
</sv-ask>

<sv-ask id="r1q12" round="1">
**DuckDB: what role does it play?**

**"Quack", checked.** Quack is DuckDB's HTTP client-server protocol. One DuckDB instance serves (`quack_serve`) and others `ATTACH 'quack:host'`, with several concurrent writers. It shipped in beta in v1.5.3 (2026-05-12). The docs say the protocol, names and defaults may still change, and production-ready is planned for DuckDB 2.0 ([docs](https://www.duckdb.org/docs/current/quack/overview), [InfoQ](https://infoq.com/news/2026/05/duckdb-quack-protocol)). One third-party article says 2.0 shipped with it in August 2026. I haven't verified that.

**Why it isn't the primary store now:**
- Our writes are small transactions with same-row counter checks, which is OLTP work. DuckDB is columnar and built for analytics.
- There is no Litestream equivalent: no continuous WAL shipping to S3.
- Its FTS index is static and must be rebuilt after changes. Ours is updated by the `project` hook on every save.
- Its record as a transactional server is short, and Quack is still beta.

**What would make us revisit it:**
- Quack is production-ready (2.0 GA plus a few months in the field).
- There is a continuous backup story equal to Litestream.
- Incremental FTS exists.
- SQLite becomes the bottleneck for reports at real tenant sizes.
- * **SQLite stays the system of record.** Contracts, revisions, Litestream and SSE all stay on SQLite. **DuckDB is the engine for reports, agent queries and imports.** It attaches the org's SQLite file **read-only** through its `sqlite` extension, with no copy and no sync, so isolation holds by construction. Imports are staged and mapped in DuckDB (CSV, Excel, Parquet), then committed through the contracts into SQLite. Only the SQLite path is built in this migration. DuckDB arrives with the agent-features plans, and nothing here may preclude it.
- The same split, but put the DuckDB read-only runner in phase 0 instead of a plain SQLite `keep sql`.
- DuckDB as the primary store (via Quack), replacing SQLite.
- No DuckDB.
</sv-ask>

<sv-ask id="r1fin" round="1" role="close">
Round 1: sequencing, slicing, drops, hosting, backups, migrations, dev data, QC, auth scope, agent features, DuckDB, factory. Send when done.
</sv-ask>

<sv-ask id="r2q1" round="2">
**Environments on Fly.**
- * **`keep-staging`** from phase 0. It replaces demo and preview, and every deploy resets it to the `riverside` seed. **`keep-prod`** is created at cutover. Both are in `lhr`, each with one machine and one volume.
- One app only, `keep-prod`, used as staging until the first real group.
- Staging, plus one app per builder for QC (more cost, closer to real).
</sv-ask>

<sv-ask id="r2q2" round="2">
**Deploys.**
- * GitHub Actions on push to `main`: `cargo test` + `pnpm check`, build the image, `fly deploy` to staging. Prod is a manual `workflow_dispatch`. The Fly token is a repo secret you add.
- You run `fly deploy` from your machine. No CI deploys.
</sv-ask>

<sv-ask id="r2q3" round="2">
**An open contact form, when an SSE event says that contact changed elsewhere.**
- * **Fetch and merge live.** Fetch the changed slice and dispatch it into the existing reducer as a `server` update, the same path a Convex query update took. Typing is preserved, and the conflict badge shows on a same-field clash. This brings back what Convex's live propagation gave us, at about one RTT plus the event.
- Show a notice ("changed elsewhere, reload"). The merge happens only at save, through the 409.
- Nothing until save.
</sv-ask>

<sv-ask id="r2q4" round="2">
**What an SSE event carries.**
- * **Ids only:** `{entity, id, contract, counter}` per committed contract, never data. The client refetches what it shows, so the stream can't leak more than the user can read. A dropped connection reconnects with `Last-Event-ID`, and refetches everything if it fell behind.
- The slice's new state, so no refetch (one round trip saved, but every event has to be checked against the viewer's role).
</sv-ask>

<sv-ask id="r2q5" round="2">
**Email transport** (auth needs it: invites, reset, emailed codes).
- * **SMTP via `lettre` to SES London's SMTP endpoint** (the `auth.` domain in `keep-mail-tx`, per ADR 0021). Any provider can be swapped in, there's no AWS SDK, and dev uses a local catcher (Mailpit) or the log.
- `aws-sdk-sesv2` (the API, with richer errors, but tied to AWS).
</sv-ask>

<sv-ask id="r2q6" round="2">
**Porting the tests** (about 15.7k lines on Convex).
- * **Port every test case whose rule still holds** as a named Rust test (or a dom test for the SPA). Each module gets a **parity table** in its report: every Convex test name maps to a Rust test name or to "dropped: Convex mechanics, because …". The reviewer checks the table.
- Port only the domain-rule tests and let QC cover the rest.
</sv-ask>

<sv-ask id="r2q7" round="2">
**Crates.**
- * **One crate per domain module** (`contacts`, `sources`, `giving`, `giftaid`, `comms`), plus `platform`, `auth`, `store`, `contracts` and `api`. Commands that span modules (e.g. `recordGift`: contact + gift + declaration) live in `api` and compose each crate's contracts in one `OrgTx` under one command group. Domain crates never depend on each other except through public functions, and `giving` → `contacts` is the only such edge. Parallel builders rarely touch the same files.
- A single `domain` crate with modules.
</sv-ask>

<sv-ask id="r2q8" round="2">
**Phase 0: one builder or three?** The parts are independent:
- **F1 core:** M1–M3, the lows, the org-handle LRU, boot migration, SSE server, the `/boot` endpoint, the bootstrap of the `platform` and `auth` crate skeletons, `keep sql`.
- **F2 ops:** Dockerfile, Fly staging, Litestream, the AWS script, the restore drill, the CI deploy.
- **F3 SPA:** strip Convex from the data layer, the SSE client and invalidation, the live form merge, the stale retry fix, and re-pointing QC at Rust (pool, `Server-Timing`, netem).
- * **Three in parallel** (F1, F2, F3), with F3 coding against F1's SSE event type, which is fixed in F1's first commit.
- One builder, in sequence (simpler, about 1 day slower).
</sv-ask>

<sv-ask id="r2q9" round="2">
**When auth starts.** It is the largest unestimated item and needs only F1 (platform crate, sessions) plus email.
- * **In wave A, in parallel with the domain slices.** The domain slices keep using the dev stub until auth merges, and the security review runs while wave B is going.
- After the domain port, as its own phase.
</sv-ask>

<sv-ask id="r2q10" round="2">
**The GitHub Pages demo** (careful-dolphin-689) builds from `main` on every push, so it would break as routes move to Rust.
- * Pin `pages.yml` to the `convex-final` tag now. Retire Pages once `keep-staging` is up, and staging becomes the demo.
- Keep Pages and point it at the Fly API cross-origin.
</sv-ask>

<sv-ask id="r2q11" round="2">
**Convex teardown at cutover.**
- * Delete `convex/`, the Convex skills, `_generated` and the Convex scripts **at cutover**. Keep the Convex cloud project (demo, preview, `zany-bird-247`) for **30 days**, then delete it (you run that).
- Delete the cloud deployments immediately at cutover.
- Keep the Convex project indefinitely as a reference.
</sv-ask>

<sv-ask id="r2q12" round="2">
**Repo layout after cutover.**
- * Rename `rs/` to `server/` at cutover. The SPA stays at the repo root, and the pnpm scripts wrap cargo (`pnpm dev` starts both).
- Keep `rs/`.
- Restructure into `server/` and `web/`.
</sv-ask>

<sv-ask id="r2q13" round="2">
**A second, independent backup alongside Litestream?** (human, 2026-10-24: "would we not do fairly regular hourly backups too?")

Litestream ships the WAL continuously, so at most about 1 s of writes is lost, and it can restore to any point in its retention window. But it is one mechanism. A bug in it, a bad config, or a deleted or overwritten replica takes out the only copy. Snapshots also give us known-good points to roll back to after a bad import or an app bug.
- * **Hourly snapshots as well.** In-process, the SQLite online backup API (or `VACUUM INTO`) takes a copy of each org file **that changed in the past hour** (skipped if its last revision id hasn't moved), plus `platform.db`, compresses it and uploads it to a **separate bucket in another account** with Object Lock, so a compromised app can't delete them. Retention: hourly for 48 h, daily for 30 days, monthly for 12 months. Fly's daily volume snapshots are a third layer (check what Fly charges for them now). The drill restores from Litestream **and** from a snapshot. Cost: pennies (a 10k org is about 31 MB, ~8 MB compressed).
- Hourly snapshots in the same bucket as Litestream, without Object Lock (simpler).
- Daily snapshots only.
- Litestream only.
</sv-ask>

<sv-ask id="r2fin" round="2" role="close">
Round 2: environments, deploys, live form, SSE payload, email, tests, crates, phase 0 split, auth timing, Pages demo, teardown, layout, second backup. Send when done.
</sv-ask>

<sv-ask id="r3q1" round="3">
**Domains.** `keep-together.org.uk` is in Route 53 in `keep-prod`.
- * `staging.keep-together.org.uk` now and `app.keep-together.org.uk` at cutover. Each is a CNAME to Fly, with Fly-issued certificates. `scripts/fly/*.sh` prints the Route 53 records for you to apply.
- `*.fly.dev` names until the first real group.
</sv-ask>

<sv-ask id="r3q2" round="3">
**Which account holds the hourly snapshot bucket** (Object Lock, separate from Litestream's)?
- * **A new `keep-backup` account** in the `keep` OU, added to `scripts/aws/bootstrap.sh`, which you run. Nothing else runs there, so a leaked app key or a compromised `keep-prod` can't reach the snapshots.
- A bucket in `keep-mail-tx`, which already exists (no new account, but it mixes purposes).
- A second bucket in `keep-prod`, with Object Lock in compliance mode.
</sv-ask>

<sv-ask id="r3q3" round="3">
**Monitoring and alerts.**
- * **Sentry (EU region, free tier)** for server and SPA errors, scrubbed of request bodies and emails. `/healthz` reports Litestream lag and the last snapshot's age. A GitHub Actions cron every 15 min calls `/healthz` on staging and prod and opens an issue (which emails you) if it fails or a backup is more than 2 h stale.
- Fly logs and the health check only. No external services.
- An uptime service (e.g. Better Stack) instead of the GitHub cron.
</sv-ask>

<sv-ask id="r3q4" round="3">
**Cutover gate** (C1). The recommended list is on the page: parity complete, QC green with 3 nightly staging runs, drill passed, security review closed, codex fixed or waived, and you've clicked through staging.
- * That gate as written.
- That gate, plus a week of using staging for real (e.g. entering a real group's data) before switching.
</sv-ask>

<sv-ask id="r3fin" round="3" role="close">
Round 3: domains, snapshot account, monitoring, cutover gate. **"Approved" also confirms the brief above (phase 0 → wave A → wave B → cutover) as the plan.** Choose "revise" and add a note if any step needs changing.
</sv-ask>

</sv-page>
