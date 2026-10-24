<sv-page label="plan: rust spike" category="plans">

<sv-prose id="b1">
# Plan: Rust + SQLite spike

*Planner `planner-rustspike`, 2026-10-24. A one-factory-day experiment with a go/no-go answer. Design tree first, then the brief, then the grill.*
</sv-prose>

<sv-prose id="tree">
## Design tree

**Settled by the human (2026-10-24)**

- Built from scratch (`../ngo-go-rs` is scrapped), as a new `rs/` Cargo workspace on branch `spike/rust` in this repo. `main` and Convex stay untouched.
- SQLite with **one database file per organisation**, plus a small `platform.db` for tenants, memberships and sessions. A handler gets one org's connection and has no other, so a wrong-tenant query has nothing to run against.
- Local only, no Fly. Network delay = one measured RTT from here to a London host, applied with `tc netem` or added to the server time.
- Litestream replicates to S3 in eu-west-2 (`keep-` prefix, keep-dev account), with a narrow IAM user and one timed restore drill.
- Auth is stubbed: a dev session cookie.
- Scope in: contacts (details, emails, phones, addresses), dropdown fields with the list filter, search, revisions, a 10k seed. Scope out: gifts, Gift Aid, source-code admin, real auth, email.
- The SPA gets a data-layer switch (env) so the contacts pages run on either backend.

**Settled in round 1 (all as recommended)**

- DB access: rusqlite (sync) on axum + tokio; one writer connection per org behind a mutex, a small reader pool, WAL, calls in `spawn_blocking`.
- API: JSON over HTTP, RPC per contract (`POST …/contacts/{id}/save`), GETs for reads, `409 {kind:"stale", current}` with the slice's current state.
- Types: ts-rs, exported to `src/lib/data/rust-types/` and committed.
- Migrations: rusqlite_migration (`PRAGMA user_version`), run on every org file when it opens.
- SPA seam: hook-level interface in `src/lib/data/`, Convex impl wraps today's calls, Rust impl on TanStack Query, `VITE_BACKEND=convex|rust`.
- QC flows: `contact.spec` (details, emails, phones + addresses), `search.spec`, `contacts.spec`, `fields.spec` (list filter, set/clear), `isolation.spec`; Rust qc-seed endpoint, `QC_LEGS=0`.
- Delay: `tc netem` on loopback for the API port only (human runs the sudo lines); scripted measurements add the RTT arithmetically.
- Output: `docs/spikes/10-rust-sqlite.md`.
</sv-prose>

<sv-prose id="goal">
## Goal

Get a **go/no-go answer to "should keep-together's backend become Rust + SQLite?"** in one factory day. The spike rebuilds the contacts slice (the part that has been hardest on Convex) to the same contracts and the same SPA, measures the seven questions below against Convex's numbers, and writes a comparison with a recommendation and a revised parity estimate (how much work to bring the Rust backend to where `main` is now).

The questions, each with a measurement:

| # | question | measured by | Convex baseline |
|---|---|---|---|
| 1 | Search at 10k contacts with FTS5 (trigram vs unicode61+prefix) | the `scripts/perf-search10k` cases, same seed shape, server time median/p95 | `factory/out/tester-search10k-report.md`: smith 487 ms, jones 280, full email 430, no match 21 |
| 2 | Dropdown fields, list filter, keyset paging in SQL | LOC of the query code + list/filter/page 2–5 timings | list 57 ms, field filter 98 ms, LOC of `contacts/queries.ts` list path + `listFilter` |
| 3 | The contract model in a SQLite transaction | unit tests: expected counter, pure apply, revision rows, stale refusal, ADR 0013 upcast-on-restore, ADR 0014 child ids | `convex/lib/contracts.ts` (474 LOC) and its tests |
| 4 | Tenancy isolation by construction | two-tenant test, plus a review that tries to break it | `convex/lib/tenancy.ts` (460 LOC) |
| 5 | User-perceived latency with network delay applied | the QC flows below, real browser, RTT applied | latest QC trend for the same flows |
| 6 | SPA without live queries | save-time stale refusal → merge → retry in the contact form, two-tab test | spike 04 (live form) |
| 7 | Ops | Litestream continuous backup + a timed restore drill of a 10k org | Convex snapshot export/import (spike 01) |

**Out of scope:** gifts, Gift Aid, source codes beyond what the seed's acquisition needs (none — drop acquisition from the Rust seed), real auth, email, notes, identifiers, relationships, deploying anywhere, any change to `convex/` or to `main`.

**Domain rules that apply:** 2 doesn't (no consent here); 1, 4 don't (no Gift Aid); **3** (archive, never delete — the spike has no delete endpoint), **6** (tenancy is structural: the org file *is* the scope), **7** (pence: no money in scope, but the schema helper that the review checks must have no REAL columns). The contract conventions (counters, revisions, child ids, two-tier validation) apply in full: question 3 is about them.
</sv-prose>

<sv-prose id="shape">
## Shape of the backend

```
rs/
  Cargo.toml                 workspace
  crates/
    store/      org + platform db open, pragmas, migrations, writer/reader pools
    contracts/  Contract trait, execute_contract (counter, apply, revision), upcasters
    contacts/   contacts domain: slices, apply fns, warnings, search projection, queries
    api/        axum app: session cookie, tenant resolution, routes, Server-Timing header
    seed/       bin: 10k seed from the perf generator's JSONL, through the contracts
  data/         (gitignored) platform.db, orgs/<tenant-id>.db
```

- **Tenancy by construction.** `api` resolves `/api/t/{slug}/…` + session → membership in `platform.db` → an `OrgDb` handle for that one file. Domain functions take `&OrgTx` (a transaction on one org file) and nothing else; `contacts` has no dependency on `store`'s platform side and no tenant id in its tables. There's no `tenantId` column at all: the org file is the scope.
- **Contracts.** `execute_contract(tx, contract, entity_id, expected, payload)`: `BEGIN IMMEDIATE`, read the root's counter, compare, run the pure `apply(current, payload) -> next`, write, append a `revisions` row (entity, contract name, version, payload JSON, group, at), run the `project` hook (rebuilds the FTS row), commit. Mismatch → `Stale { current }`. Slices: `contacts.details`, `contacts.methods` (emails + phones, child rows with ids, identity immutable per id), `contacts.addresses` (editable in place), `contacts.archive`, `contacts.fields`, each with its own counter column, as on Convex. `saveForm` runs several slices in one transaction under one command group.
- **Search.** `contact_search` FTS5 table, rebuilt for one contact by the `project` hook in the same transaction (the `contactSearch` rule). Two variants, side by side, measured on the same seed: `tokenize='trigram'` (substring, ≥3 chars) and `unicode61` with prefix queries. Exact lookups (number, phone, email) by ordinary indexes first, as now.
- **Lists.** Keyset paging on `(sort_key, id)`; dropdown filter is a join on `contact_field_values(field_id, option_id, contact_id)`; first email and display name are columns on the list's query, not a second read.
- **Timing.** Every response carries `Server-Timing: db;dur=…, total;dur=…` so measure scripts and QC read server time without logs.
</sv-prose>

<sv-prose id="steps">
## Steps (builder briefs)

Branch `spike/rust` off `main`; one worktree per builder (`factory/spawn.sh builder <name> keep-together-f1 --worktree spike/rust-<step>`), merged into `spike/rust` in order. Steps 2a and 2b run **in parallel** once step 1 is merged.

### Step 1 — foundation (builder-rs-foundation)

- `rs/` workspace, crates `store`, `contracts`, `api` (skeleton), CI-free `cargo test`.
- `store`: open/create `platform.db` and `orgs/<id>.db`; pragmas (WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout`); one writer connection per org behind a mutex + a reader pool; migrations run when a file opens.
- `contracts`: `Contract` trait (name, version, counter column, `apply`, `project`, upcasters), `execute_contract`, `Stale`, revision rows, command groups, restore through the upcaster chain. Tested on a toy entity: counter check, stale, revision payload, upcast on restore, child-row reconcile by id.
- `api`: axum, dev session cookie (`POST /api/dev/login {email}` sets it; refused unless `KEEP_DEV_AUTH=1`), `/api/t/{slug}` → `OrgDb`, `Server-Timing` middleware, JSON errors (`409 {kind:"stale", current}`, `422 {problems}`, `403 forbidden`).
- Two-tenant test at the HTTP level: A's cookie on B's slug → 403; a handler can only reach the file it was handed.
- **Files:** `rs/**`, `.gitignore` (`rs/target`, `rs/data`).

### Step 2a — contacts domain + seed + measure (builder-rs-contacts)

- `contacts` crate: tables, the five slices, `saveForm`, `warnings`, search projection (both FTS variants behind a flag), `list` (filters: kind, archived, field option / not set; keyset), `search`, `get`, `history`, `restore`, field definitions + options (enough to create the "Volunteer status" dropdown).
- Routes in `api`: `GET contacts`, `GET contacts/search`, `GET contacts/{id}`, `GET contacts/{id}/history`, `POST contacts` (create), `POST contacts/{id}/save` (saveForm), `POST contacts/{id}/archive`, `POST contacts/{id}/restore`, `GET/POST fields`.
- Seed: `git checkout ed548df -- scripts/perf-search10k` (the generator), a small `export-jsonl.mjs` that writes the generator's 10,000 + 63 contacts as JSONL, and `rs/crates/seed` that pushes them through `execute_contract` in-process (same contracts as the API, no HTTP).
- `scripts/perf-search10k-rs/measure.mjs`: the same cases as `measure.mjs`, over HTTP, 20 reps, server time from `Server-Timing`, client time too. Both FTS variants.
- Tests: every slice, stale per slice (different slices never conflict), child ids, two-tenant isolation on every route.
- **Files:** `rs/crates/contacts/**`, `rs/crates/api/src/routes/**`, `rs/crates/seed/**`, `scripts/perf-search10k*`.

### Step 2b — SPA data layer (builder-rs-spa), parallel with 2a

- `src/lib/data/`: a hook-level interface for the contacts pages only (`useContactList`, `useContactSearch`, `useContact`, `useContactHistory`, `useSaveContactForm`, `useCreateContact`, `useFields`), with a Convex implementation wrapping today's calls and a Rust implementation on TanStack Query + `fetch`. Chosen by `VITE_BACKEND=convex|rust` at build time.
- `src/routes/t.$slug.contacts.*` and `src/components/contact-form.tsx` call the interface, not `convex/react`. Convex behaviour unchanged (`pnpm check` green, QC unchanged on Convex).
- Rust path without live queries: refetch on focus and after each save; a `409 stale` response is dispatched into the existing reducer as a `server` update (the slice's current state comes back in the 409, so no extra round trip), which merges and re-requests the save — the spike-04 reducer is reused unchanged.
- Codes against the step-1 API contract and the ts-rs types; mocks the Rust API in dom tests until 2a lands.
- **Files:** `src/lib/data/**`, contacts routes, `contact-form.tsx`, `vite.config.ts` (proxy `/api` → `:8787` in dev).

### Step 3 — measurement (tester-rs)

- Measure the RTT here → London once (TCP connect to an eu-west-2 endpoint, 50 samples, median).
- Q1/Q2: run `measure.mjs` on the Rust server, both FTS variants, with and without the RTT; LOC counts (tokei) of both stacks' equivalent code.
- Q5: the chosen QC flows against `VITE_BACKEND=rust`, delay applied, against the latest Convex QC numbers for the same flows. QC seeds through a Rust `POST /api/dev/qc-seed` (step 2a adds it, refused unless `KEEP_QC_SEED=1`).
- Q6: two-tab conflict flow in a browser, recorded.
- Q7: Litestream to S3 (human has run the AWS commands below), then the restore drill: delete the local org file, `litestream restore`, time it, run the search cases again on the restored file.
- Writes `docs/spikes/10-rust-sqlite.md`: per question, Convex vs spike, numbers, LOC, then the revised parity estimate and a recommendation.

### Step 4 — review (reviewer-rs)

- Code review of `rs/` and the SPA seam, with a **security eye on tenancy**: can any route reach an org file other than the session's membership? Path traversal through slug or tenant id into `orgs/`? Can a connection or a cached handle leak between requests? Does the dev cookie or qc-seed endpoint run with the env flag off? FTS query injection (MATCH syntax from user input)?
- A codex review alongside (`codex exec`, per CLAUDE.md), findings relayed.
- Adds its verdict to the spike doc.
</sv-prose>

<sv-prose id="tests">
## Tests that prove it

- `cargo test`: contract semantics (Q3) on a toy entity and on every contacts slice; stale refusal per slice; slices never falsely conflict; revisions written per contract with name + version; restore through an upcaster; child rows reconciled by id, identity fields immutable per id.
- **Two-tenant isolation:** every route called with tenant A's session against B's slug → 403; A's search for "smith" returns none of B's; no function in `contacts` can name an org (enforced by crate dependencies, checked in review).
- `pnpm check` still green on the branch (the Convex implementation of the seam is behaviour-preserving).
- QC flows (below) pass on both backends.
</sv-prose>

<sv-prose id="aws">
## AWS commands for the human (Litestream)

Run in the `keep-dev` account. Bucket `keep-dev-litestream-spike`, IAM user `keep-litestream-spike` with access to that bucket only, keys into `rs/.env.litestream` (gitignored).

```bash
export AWS_PROFILE=keep-dev AWS_REGION=eu-west-2
B=keep-dev-litestream-spike U=keep-litestream-spike

aws s3api create-bucket --bucket $B --create-bucket-configuration LocationConstraint=eu-west-2
aws s3api put-public-access-block --bucket $B --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket $B --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws iam create-user --user-name $U
aws iam put-user-policy --user-name $U --policy-name litestream-$B --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":\"arn:aws:s3:::$B\"},
    {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$B/*\"}
  ]}"

aws iam create-access-key --user-name $U --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text \
  | awk '{print "LITESTREAM_ACCESS_KEY_ID=" $1 "\nLITESTREAM_SECRET_ACCESS_KEY=" $2}' > rs/.env.litestream
chmod 600 rs/.env.litestream
```

Teardown after the spike: `aws iam delete-access-key`, `delete-user-policy`, `delete-user`, `aws s3 rb s3://$B --force`.

Litestream itself isn't installed here: the tester installs the release binary into `~/.local/bin` (pinned version), and the config replicates `rs/data/platform.db` and every `rs/data/orgs/*.db` (directory replication) to `s3://$B/<file>`.
</sv-prose>

<sv-prose id="latency">
## Network delay

- RTT: the tester measures TCP connect time to `s3.eu-west-2.amazonaws.com:443`, 50 samples, median (London; Convex's ~30–35 ms is to Ireland, `platform/qcProbe:rtt` = 34.5 ms in the search report).
- Recommended: `tc netem` on loopback, **only for the API port** (8787), so `vite preview` and Playwright aren't delayed. Needs root; the human runs:

```bash
sudo tc qdisc add dev lo root handle 1: prio
sudo tc qdisc add dev lo parent 1:3 handle 30: netem delay ${HALF_RTT}ms   # each direction crosses lo once
sudo tc filter add dev lo parent 1:0 protocol ip u32 match ip dport 8787 0xffff flowid 1:3
sudo tc filter add dev lo parent 1:0 protocol ip u32 match ip sport 8787 0xffff flowid 1:3
# remove: sudo tc qdisc del dev lo root
```

- The scripted measurements (Q1/Q2) report server time and add the RTT arithmetically, so they need no netem.
</sv-prose>

<sv-prose id="grill-intro">
## Grill

Round 1 covers every open decision; each has my recommendation pre-selected. Send it untouched to accept them all.
</sv-prose>

<sv-ask id="r1q1" round="1">
**DB access and async model.** SQLite is in-process, so the async story is "where do blocking calls run".

- * rusqlite (sync) on axum/tokio: one writer connection per org behind a mutex, a small reader pool, calls in `spawn_blocking`. Full SQLite surface (FTS5 options, backup API, `BEGIN IMMEDIATE`), no build-time DB
- sqlx (async SQLite): compile-time-checked queries, but they need a live DB at build time (or offline metadata), and it's a thin layer over the same blocking SQLite
- rusqlite, but a plain thread per org with a channel (actor), no pool
</sv-ask>

<sv-ask id="r1q2" round="1">
**API style.** The SPA talks JSON over HTTP either way. What shape?

- * RPC per contract: `POST /api/t/{slug}/contacts/{id}/save {slices: {details: {expected, …}}}`, GETs for reads, `409 {kind:"stale", current}` carrying the slice's current state so the form merges without another fetch
- REST resources: `PATCH /contacts/{id}/details` etc., ETag/If-Match for the counter, 412 on stale
- One JSON-RPC endpoint (`POST /api/rpc {fn, args}`), closest to Convex's call shape
</sv-ask>

<sv-ask id="r1q3" round="1">
**Type generation** from Rust structs to the SPA.

- * ts-rs: `#[derive(TS)]`, exports `.ts` files from a test into `src/lib/data/rust-types/` (committed, like `_generated`)
- specta: richer (can also describe the endpoints), more moving parts for a one-day spike
- Hand-written TS types, checked by a contract test
</sv-ask>

<sv-ask id="r1q4" round="1">
**Migrations.** With a file per organisation, every org file is migrated when it opens. Note SQLite doesn't validate existing rows against a new schema the way a Convex deploy does, so the two-phase loosen/backfill/tighten rule becomes per-migration judgement.

- * rusqlite_migration: embedded SQL steps, `PRAGMA user_version`, runs on open
- refinery: migration history table, more ceremony
- sqlx migrate (only if sqlx is chosen above)
</sv-ask>

<sv-ask id="r1q5" round="1">
**SPA seam.** How do the contacts pages switch backend?

- * Hook-level interface in `src/lib/data/` (`useContactList`, `useContact`, `useSaveContactForm`, …): the Convex impl wraps today's calls, the Rust impl uses TanStack Query; `VITE_BACKEND=convex|rust` at build time
- A generic adapter under `useQuery(api.x)` so the pages don't change (fakes Convex function refs for Rust; clever, brittle)
- Fork the contacts pages for Rust (no seam; fastest, but the comparison then isn't the same UI)
</sv-ask>

<sv-ask id="r1q6" round="1" pick="many">
**QC flows to point at the Rust backend** (Q5). QC needs a Rust seed endpoint either way, and runs with `QC_LEGS=0` (there's no Convex WebSocket to tap).

- * `contact.spec`: details Save + autosave; emails; phones and addresses
- * `search.spec`: all (search by what you have, by contact number)
- * `contacts.spec`: the list, paging, new contact
- * `fields.spec`: "fields on the contacts list" (dropdown filter) and "set and clear a value"
- * `isolation.spec`
- `contact-cache.spec` (Convex query-cache behaviour; probably meaningless on Rust)
</sv-ask>

<sv-ask id="r1q7" round="1">
**Network delay for the QC flows.**

- * `tc netem` on loopback, API port only (you run three `sudo tc` lines; scripted measurements add the RTT arithmetically)
- No netem: add the RTT to server times everywhere, including QC (no sudo, less realistic: misses round-trip count per interaction)
- A delay middleware in the Rust server (`KEEP_DELAY_MS`), no sudo, delays responses only
</sv-ask>

<sv-ask id="r1q8" round="1">
**The comparison output.**

- * `docs/spikes/10-rust-sqlite.md` (spikes category, like 01–09): a table per question (Convex vs spike, numbers, LOC), the revised parity estimate, the recommendation, the reviewer's verdict
- A sideview page with an interactive Vue chart of the latencies, plus the doc
- A plan page in `factory/plans/` (keeps it with the factory, not the docs)
</sv-ask>

<sv-ask id="r1fin" round="1" role="close">
Round 1: the open technical decisions (DB access, API, types, migrations, SPA seam, QC flows, delay, output). Approve to accept them, or revise any.
</sv-ask>

<sv-ask id="r2fin" round="2" role="close">
Round 2: confirmation. Round 1 is folded into the design tree and the steps; no branch is left open. Approve to hand the four steps to the controller, or revise with a note.
</sv-ask>

</sv-page>
