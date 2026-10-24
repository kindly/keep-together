# 0024: Rust + SQLite, one file per organisation

Status: proposed (2026-10-24), drafted by builder F2 from the plan
`factory/plans/migration-rust.sv` (grill complete, confirmed by the human
2026-10-24). It becomes accepted at cutover (step C2).

Supersedes the parts of [ADR 0017](0017-convex-react-shared-tenancy.md)
that name the stack, the tenancy mechanism, the dedicated-instance tiers
and the export/import between deployments. Amends
[0018](0018-qc-live-dev-instances.md) (the QC pool and blame) and
[0020](0020-accounts-roles-supporter-logins.md) decision 4 (the auth
library). Re-expresses [0013](0013-model-layer-versioning.md)'s contracts
on SQLite transactions.

Unchanged: 0006 (AGPL-3.0), 0007 (the domain invariants, rule 6 restated
below), 0008, 0010, 0013's model (aggregates, partitioned contracts,
counters, revisions, restore), 0014, 0015, 0019, 0020 decisions 1 to 3,
0021, 0022, 0023.

## Context

ADR 0017 picked Convex so nobody would run a server. The spike on
`spike/rust` (`docs/spikes/10-rust-sqlite.md`) rebuilt the contacts slice
on axum + rusqlite with one SQLite file per organisation, and measured it
against Convex on the same seed:

- Search at 10k contacts: 1 to 7 ms server time on Rust, 280 to 506 ms
  on Convex, against a 100 ms target Convex can't reach today.
- Lists and the field filter in SQL: 30 to 40 times faster.
- A save is one round trip where Convex takes about two. Cold load is one
  request.
- Tenancy by construction held against every tampering attempt the
  reviewer tried.
- At the sizes we serve today, what a user feels is about the same on
  both. The speed matters at scale, and for what comes next.

What comes next is why the human chose to move (2026-10-24):

1. **No lock-in.** It runs on any host, and each organisation's data is
   one file it can take away.
2. **Reporting in SQL**, including reports and data selections written by
   agents. A read-only connection to one org's file makes agent SQL safe
   by construction.
3. **Agent-driven import**: staging tables, SQL mapping and dedupe,
   commit through the contracts, undo by restoring the file. 10k contacts
   took 496 s to load on Convex and 15 s on Rust.

The spike's "no-go on switching now" rested on two open costs: a server
to run, and no tested backup. This ADR takes on the first and makes the
second part of the first phase of the migration.

## Decision

**Stack.** Rust: axum, rusqlite (bundled SQLite), tokio. One crate per
domain module (`contacts`, `sources`, `giving`, `giftaid`, `comms`) plus
`platform`, `auth`, `store`, `contracts` and `api`. Commands that span
modules live in `api` and compose each crate's contracts in one
transaction. The SPA stays (Vite, React 19, TanStack Router and Query,
shadcn) and talks JSON over HTTP.

**Tenancy: one SQLite file per organisation**, `orgs/<tenant-id>.db`,
plus `platform.db` for tenants, users, memberships and sessions. No table
has a `tenantId` column, and there are no scoped constructors. A request
reaches `/api/t/{slug}/…`; the session and membership resolve the slug to
a tenant id, and the id to that one file. Domain crates take a
transaction on a file and can't name another organisation. Every file
carries its tenant id and is refused under another name; connections
can't `ATTACH`. Rule 6 keeps its meaning with a new mechanism: the file
is the scope, and the review checks that domain crates don't depend on
`platform`.

**Contracts (0013 on SQLite).** Every domain write goes through
`contracts::execute` inside the caller's transaction: counter check,
pure apply, write, counter bump, revision row, projection. The
transaction type doesn't expose raw SQL execution to domain code, and a
compile-fail test proves it. Money is `INTEGER` pence (rule 7), and a
schema test fails on any `REAL` column.

**Schema changes** are one forward-only migration per change, run in a
transaction per file. Every org file migrates at boot, four at a time,
before traffic, with a `VACUUM INTO` copy first. A failure stops the
boot and names the org. Each schema version has a fixture file the tests
migrate to head. The two-phase loosen/tighten rule of 0017 goes: SQLite
doesn't re-validate old rows on deploy.

**Liveness: server-sent events.** Each org has a stream that sends one
event per committed contract, `{seq, entity, id, contract, counter}`,
ids only. Clients refetch what they show. An open contact form merges a
remote change live, as Convex's live queries did; lists refetch rather
than grow in place. Gifts are never optimistic.

**Hosting.** Fly.io London (`lhr`): one machine and one volume per
environment, one process serving the API and the built SPA from the same
origin. Two apps: `keep-staging` from the first phase (reset to the
riverside seed on every deploy, replacing the Pages demo) and
`keep-prod` at cutover. The API base URL stays configurable, so the SPA
can be served elsewhere. Everything else (dev, QC, builders) runs
locally, each worktree with its own data dir. Deploys go through GitHub
Actions: staging on every push to `main`, prod by hand.

**Backups: two independent copies, drilled.**

- Litestream 0.5 replicates `platform.db` and every org file (directory
  watch) to S3 in `keep-prod` (eu-west-2, versioned), syncing every
  second, with 7 days of point-in-time history. It runs the api as its
  child process.
- An in-process job snapshots every org file that changed in the past
  hour, plus `platform.db`, to a bucket in a separate `keep-backup`
  account with Object Lock. The app's key can add and read there, never
  delete or overwrite. Kept hourly for 48 h, daily for 30 days, monthly
  for 12 months.
- The drill (`docs/ops.md`): destroy the machine and its volume, restore
  from each source onto a new volume, and check integrity, row counts
  and search results. A 10k org must be back in under 60 s from either
  source, with at most 1 s of acknowledged writes lost on Litestream.
  It runs before any real data. After that it runs monthly in CI for
  staging, and by hand for prod, on the human's own machine: prod data
  is never restored on GitHub's runners.
- An empty volume restores itself at boot from Litestream. It falls back
  to the snapshots only when Litestream has nothing, and then loudly
  (Sentry, `/healthz`, an issue) until a human has checked. A failed
  restore stops the boot rather than start empty.

**Monitoring.** `/healthz` reports the database, the last snapshot's age
and Litestream's lag. A GitHub cron every 15 minutes opens an issue when
it fails or a backup is more than 2 hours stale. Sentry (EU) gets server
and browser errors, scrubbed of bodies, cookies and email addresses.

**Auth (amends 0020 decision 4).** No library does what 0020 needs on
this stack in one piece, so it's built from crates: axum-login,
tower-sessions (store in `platform.db`), argon2id, totp-rs, with
webauthn-rs later. Magic links, invites and roles are written here. The
rules of 0020 decisions 1 to 3 stand. A separate security review gates
cutover.

**QC (amends 0018).** The Playwright suite, budgets and judge stay. The
pool becomes local release builds of the api; server time comes from
`Server-Timing`; Convex log blame, legs, the WebSocket quiet gate and the
RTT probe go. The gate runs under netem at the measured RTT to staging,
with a nightly run against staging.

**Agents.** `keep sql <org> "<select…>"` runs on a read-only connection
with an authorizer that allows only reads. DuckDB may later attach org
files read-only for reports and imports. SQLite stays the system of
record.

## Consequences

- We run a server again. One machine per environment keeps it small,
  and the restore drill is the test of whether it stays boring. If the
  drill fails its targets, this decision is reopened before cutover.
- Moving an organisation means copying its file. Id lineage,
  `import --replace-all` and the export scripts of 0017 go.
- The dedicated-instance tier of 0017 isn't rebuilt. One process can
  serve one org or many; a group that needs its own machine gets its own
  Fly app running the same image.
- Convex is frozen from 2026-10-24 (fixes only). `convex/` stays as
  read-only reference until cutover, and the Convex cloud project is
  deleted 30 days after.
- Live list growth and live propagation of every query go. The SSE
  stream brings back what users noticed: the open form's merge and list
  refresh.
- Per-org SQLite limits writes to one writer per file. That's fine at the
  sizes we serve, and the spike measured it.
- Litestream is one more moving part, and it was unmeasured when this was
  written. The hourly snapshots exist so that a Litestream bug or a bad
  config isn't the only copy.
