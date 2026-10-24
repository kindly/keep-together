# Spike 10: Rust + SQLite backend (contacts slice)

Date: 2026-10-24 · Status: **done, except Q7 (deferred)** · Plan: `factory/plans/rust-spike.sv` · Branch: `spike/rust`

## Verdict: no-go on switching now. Keep the branch, and decide again once Q7 has numbers.

The contacts slice was rebuilt on axum + rusqlite with one SQLite file
per organisation. It keeps the domain rules and the same SPA, and on
three of the six measured questions it does better than Convex:

- Search and lists at 10k contacts are 20–200× faster on the server.
- Saves take one round trip where Convex takes about two.
- Tenancy isolation is structural and held up against every tampering
  attempt.

Several things weigh against switching now:

- **Latency.** At the size of the groups we actually serve, what a user
  feels on Convex is already about one round trip.
- **Lost behaviour.** The switch gives up live queries, which costs us
  live propagation and makes the stale-merge path the common one.
- **Ops.** Rust needs a server and a backup story. ADR 0017 chose Convex
  to avoid both, and the ops question (Q7, Litestream) isn't answered
  yet.
- **Work.** Reaching `main` is about 10–14 factory days, plus ops set-up
  by the human (estimate below).

**What would change this to go:**

- Q7 shows Litestream backup and restore are cheap and boring.
- The 10k-contact search on Convex can't be brought under its 100 ms
  target. It is 280–506 ms server time today. Rust does it in 1–7 ms on
  the same seed.

## What was run

- **Rust:** `rs/` at `spike/rust` (steps 1, 2a and 2b, plus this step).
  Release build, local, one file per organisation, WAL.
- **Seed:** the perf generator's 10,000 + 63 contacts, put through the
  same contract functions the API uses.
  - It took **12.9 s** here and 14.8 s in 2a. Convex took 496 s.
  - The org file is 31 MB, with both FTS tables.
- **Network delay:** `tc netem` on the host loopback, 15 ms each way on
  port 8787. That is a **30 ms RTT**, matching Convex's ~29.5 ms
  (`platform/qcProbe:rtt` median in the QC history).
  - Checked with curl: TCP connect 30 ms, then 30 ms per request on a
    reused connection.
  - The API, the browser and the flows ran outside the Claude sandbox so
    the delay applied.
- **QC flows:** `qc-rs/` (see its README) runs the in-scope Convex specs
  verbatim against `VITE_BACKEND=rust`, plus `qc-rs/rust/rust.spec.ts`.
  - Same timing code (`qc/timing.ts`), `QC_LEGS=0`, `QC_MODE=record`,
    5 samples per flow per run.
  - Two cold-cache runs (`rstne1r0h8`, `rstne1sjn0`; cold load re-run in
    `rstne1vs3z`, `rstne1vx59`) and one warm run (`rstne1u2lm`).
- **Convex numbers:** `qc-results/history.jsonl` in the main checkout,
  last 5 runs per flow (median of medians), RTT under the ceiling.
- **Machine:** CPU governor `powersave`, 16 cores.

## The questions

### Q1. Search at 10k with FTS5: Rust is 70–400× faster on the server

Server time in ms, 20 calls per case (`scripts/perf-search10k-rs/measure.mjs`).

- "Rust words" is unicode61 with prefix indexes, which is the variant
  chosen.
- The "re-run" column is mine (step 3); "2a" is the builder's run.
- Mine are roughly 2× slower than 2a's: my server answered unsandboxed
  over the netem loopback, with the `powersave` governor. Either column
  says the same thing.
- Client time under netem was server time + ~31.5 ms on every case.

| case | Convex | Rust words, re-run (2a) | p95 | Rust trigram, re-run |
|---|---|---|---|---|
| rare full name | 207 | 1.23 (0.26) | 1.46 | 1.88 |
| rare surname only | 30 | 0.96 (0.26) | 1.32 | 1.34 |
| smith | 487 | 2.79 (1.34) | 3.43 | 4.33 |
| smi (prefix) | 473 | 2.59 (1.08) | 3.03 | 3.30 |
| jones | 280 | 1.75 (0.71) | 2.35 | 2.30 |
| john smith | 408 | 1.36 (0.38) | 1.63 | 1.50 |
| full email | 430 | 1.67 (0.60) | 1.87 | 2.81 |
| gmail | 490 | 6.17 (3.42) | 6.69 | 16.6 |
| gmail.com | 506 | 6.62 (3.75) | 7.03 | 17.1 |
| LS6 | 477 | 3.28 (1.44) | 3.52 | 5.01 |
| full postcode | 419 | 1.27 (0.33) | 1.46 | 1.36 |
| contact number | 23 | 1.12 (0.20) | 1.37 | 1.04 |
| full phone | 28 | 1.18 (0.27) | 1.44 | 1.59 |
| phone tail | 29 | 1.07 (0.25) | 1.33 | 1.26 |
| no match | 21 | 0.93 (0.20) | 1.30 | 0.83 |
| smith + archived | 489 | 2.87 (1.17) | 3.11 | 3.28 |
| smith + individual | 481 | 2.63 (1.38) | 3.21 | 3.24 |
| keystroke "s" | 421 | 7.55 (4.17) | 7.91 | 28.7 |
| keystroke "l" | 329 | 8.18 (5.09) | 8.74 | 30.2 |

- Use **unicode61 "words"**, not trigram.
  - Convex's rule (every word whole, the last one a prefix) is a plain
    `MATCH`.
  - Words is equal or faster on every case, and 3–4× faster on one- and
    two-letter entries (trigram has to scan 8–9k rows for those).
  - Its index is half the size.
- **Search parity** is tested by `rs/crates/contacts/tests/search_parity.rs`.
  It ports 15 cases from `convex/contacts/searchList.test.ts` and
  `search.test.ts`: phones in every spelling, exact-phone rank, postcodes,
  email parts, organisations by street and town, accent folding, the
  whole-word rule, joined names (hyphen, apostrophe, "de la", "van der"),
  the sort name not joined, the 16-term cap, no prefix match on contact
  numbers, number match against the archived and kind filters, exact
  email against the kind filter, and two organisations.
  - All 15 pass on both FTS variants. The variants return the same rows
    and the same `numberMatch` / `invalidNumber`.
  - Not ported: identifier lookups (identifiers aren't in the spike) and
    the empty-query kind list (on Rust that is the list endpoint).
- **Contact numbers (Luhn)** are covered in the browser too
  (`rust.spec.ts`):
  - the written number finds the contact first, badged;
  - the sequence without its check digit ("100 27") finds it;
  - a wrong check digit shows "isn't a valid contact number";
  - B's search for A's number never returns A's contact.

### Q2. Dropdown fields, list filter and keyset paging in SQL: 30–40× faster, similar code size

| list call, server ms | Convex | Rust re-run (2a) | p95 |
|---|---|---|---|
| plain first page | 57 | 1.58 (0.48) | 1.89 |
| kind filter | 60–61 | 1.62–1.64 | 1.90 |
| field = Active | 98 | 2.28 (0.91) | 2.42 |
| field not set | 99 | 1.70 (0.51) | 1.99 |
| with archived | 61 | 1.62 | 1.92 |
| Load more, pages 2–5 | 58–71 | 1.54–1.64 | ≤ 2.01 |
| field = Active, pages 2–5 | – | 2.08–2.36 | ≤ 2.76 |

Lines of code (non-blank, non-comment; counted with
`scripts/perf-search10k-rs/loc.mjs`):

| | Convex | Rust |
|---|---|---|
| list query path | 190 (`queries.ts` list path, excluding source filters) + 72 (`lib/fieldSlots.ts`) | 230 (`queries.rs` up to `search`, including the query and filter types and the cursor) |
| SPA paging | 265 (`src/lib/paged-list.ts`: split, merge and hold machinery) | part of `src/lib/data/rust/hooks.tsx` (TanStack `useInfiniteQuery`) |

- Convex's list keeps state per page and splits a page when it grows
  (`toSplit`, `LIST_PAGE_MAX_ROWS`). Keyset paging in SQL needs neither.
- Field values are rows, not slots, so there is no five-field limit and
  no slot bookkeeping.
- The behaviour the SPA loses is live growth. Convex's list grows in
  place when contacts arrive. Rust's doesn't until refetch: the Convex
  test "a page that grows splits without loss" fails on Rust, showing
  200 rows where 450 were expected.

### Q3. Contracts in a SQLite transaction: holds

- `execute` runs `BEGIN IMMEDIATE` → counter check → pure apply → write →
  revision row → `project` hook → commit.
- The `contracts` crate tests cover it on a toy entity: expected counter;
  stale refused with current state and nothing written; slices never
  falsely conflict; revisions with name, version and actor; failures
  leave nothing behind; command groups; child rows reconciled by id with
  identity immutable; restore upcasts (ADR 0013), refuses what it can't
  upcast, and brings back a removed child with its id; restore to a time
  touches only the slices that differ.
- The contacts tests cover the same for every slice.
- Code size: `contracts` crate 677 lines (+ 703 test lines). Convex's
  `lib/contracts.ts` is 324 (+ 643 test lines). The Rust crate also does
  the child reconcile and canonical diff that Convex does elsewhere.

### Q4. Tenancy by construction: holds, nothing crossed

- **Design.** There is no tenant column anywhere. A handler gets one org
  file's connection and nothing else. Tenant ids come only from
  `platform.db` rows, and are 32 hex characters before they become a
  path. Files are stamped with their tenant and refused on a mismatch.
  `ATTACH` is disabled. Readers are read-only.
- **Tests** (2a's, plus mine in `rust.spec.ts` against the real server
  and real files):
  - A's cookie on B's slug, on all 12 tenant routes (GET and POST): 403
    `{kind:"forbidden"}`, the same body as for an unknown slug.
  - B's contact ids under A's own slug (get, save, archive, restore):
    404, and B's contact is unchanged.
  - Restoring a revision of another of A's contacts onto this one: 404.
  - Slug tampering never returns 2xx or any of B's ids. The slugs tried:
    upper case, `%00`, `%2F..%2F`, `a/../b`, encoded `../b`, `..`,
    `orgs`, `platform`, and a leading space.
  - Path tampering under A's slug: `..%2F..%2Fb%2Fcontacts%2F<id>`, a
    trailing `%00`, an upper-case id.
  - A forged cookie: 401. B's cookie on A's slug: 403.
  - In the UI: B's ids on A's slug show "No such contact"; B's slug shows
    nothing of B's.
  - The QC isolation specs that exist on Rust pass: B's group, B's
    settings, B's contact, and A's list and search.
- **Minor.** `GET …/contacts/{id}/history` for an id that isn't in the
  file answers `200 {revisions: []}`, where `GET …/contacts/{id}`
  answers 404. Nothing leaks, since it reads A's own file, but the
  answers are inconsistent.
- Code size: Convex's `lib/tenancy.ts` is 357 lines. Rust's `store` is
  518 and the `api` core (auth stub, tenant middleware, errors, timing)
  is 531, but together they also do what Convex the platform does: open
  files, migrate them, pool connections, and handle sessions.

### Q5. User-perceived latency at 30 ms RTT: reads the same, saves faster, cold load faster

Input event to result on screen, ms. Rust is the cold-cache median of 10
samples (20 where the flow runs twice), p95 beside it. `calls` is the
`/api` requests inside the sample window.

| flow | Convex median | Convex p95 | Rust median | Rust p95 | calls on Rust |
|---|---|---|---|---|---|
| contacts.search | 42.5 | 43.8 | 44.8 | 52.3 | 1 GET |
| contacts.search.phone | 41.8 | 43.1 | 41.8 | 44.6 | 1 |
| contacts.search.postcode | 43.4 | 44.9 | 41.7 | 44.4 | 1 |
| contacts.search.emailPart | 43.0 | 44.2 | 42.0 | 44.3 | 1 |
| contacts.search.org | 43.9 | 44.5 | 44.0 | 44.6 | 1 |
| contacts.search.number | 41.3 | 43.3 | 39.5 | 40.5 | 1 |
| contacts.showArchived | 45.2 | 46.7 | 46.5 | 47.5 | 1 |
| fields.filter | 40.7 | 43.1 | 41.4 | 53.6 | 1 |
| contacts.loadMore | 49.0 | 53.1 | 52.1 | 53.4 | 1 |
| contacts.nav | 42.0 | 75.2 | 48.0 | 52.0 | 2 in parallel |
| contact.save | 80.6 | 97.7 | **47.8** | 48.0 | 1 POST |
| contact.addEmail | 97.9 | 114.8 | **48.0** | 48.4 | 1 POST |
| contact.field.set | 89.0 | 93.2 | **48.8** | 53.0 | 1 POST |
| contact.field.clear | 88.8 | 92.4 | **40.8** | 51.9 | 1 POST |
| contact.archive | 80.5 | 81.4 | 81.6 | 82.6 | POST, then 2 GETs |
| contact.restore | 92.1 | 98.5 | 82.3 | 82.7 | POST, then 2 GETs |
| contacts.create | 84.0 | 97.3 | 81.4 | 83.7 | POST, then 2–3 GETs |
| contacts.coldLoad | 263.0 | 276.4 | **130.1** | 133.9 | 3 steps: `/fields` → `/me` → `/fields` + `/contacts` |
| auth.signIn | 465.7 | 637.3 | 117.8 | 119.6 | not comparable: a dev stub with no password check |

- **Reads** are one round trip on both stacks, so they cost the same.
  The QC tenants are small: Convex's 10k search times (Q1) never reach
  these flows.
- **Saves** are one round trip on Rust, against about two on Convex
  (the mutation, then the query transition).
- **Archive, restore and create** wait for the POST and then a refetch,
  which is two round trips: level with Convex. The POST could return the
  new view, as save already returns `current`, and take these to one.
- **Cold load** is a waterfall of three dependent requests. It could be
  one.
- **Warm cache** (`QC_RS_WARM=1`, the SPA as built): TanStack shows a
  repeated search from its cache in **2.7–4.2 ms** and refetches in the
  background. The cold numbers above are the fair comparison, because
  Convex drops an unsubscribed query. Users would still see the warm
  numbers whenever they repeat a search.
- **Measurement note.** `vite preview`'s proxy opens a new TCP connection
  per request. Under netem that makes every call ~64 ms (two RTTs). The
  numbers above go through `qc-rs/serve.mjs`, which keeps connections
  alive, as a deployed SPA would.

### Q6. SPA without live queries: works, with one slow path and lost liveness

Tested in two browser tabs (`rust.spec.ts`, all pass):

- **Stale merge.** A saves the nickname, and B (not refreshed) saves the
  title. B's save returns 200 with `stale: {details}` and `current`. The
  spike-04 reducer merges and retries with the new counter, and the
  server ends up with both edits. **This path takes 781 ms** (781 in
  each of three runs; 847 in a first run through `vite preview`'s
  proxy, which adds a round trip per call), against 48 ms for a plain save in the same tab:
  - the retry waits out the form's autosave pause (`AUTOSAVE_MS = 700`,
    `src/components/contact-form.tsx:43`);
  - a Save click sets `saveNow`, but the queued retry after a stale reply
    doesn't.

  On Convex this path is rare, because live queries keep counters fresh.
  On Rust every concurrent edit takes it. Sending the retry at once would
  make it ~80 ms.
- **Same field edited in both tabs.** B's own edit is kept and saved
  after the merge, and A sees it on reload.
- **No live propagation.** A change in tab A reaches tab B only on focus
  or visibility change (TanStack `refetchOnWindowFocus`), not while B is
  open. Convex's `contact.livePropagation` (~79 ms) and the
  "remote edit lands under in-progress typing" and "conflict badge"
  tests have no Rust counterpart. They fail when run.
- History on Rust is a plain list with "Restore this". It has no
  moments, no "Load older" and no "Restore to here". Convex's four
  history tests don't apply to it.

### Q7. Ops (Litestream continuous backup, timed restore of a 10k org): deferred

This wasn't run (human, 2026-10-24). It needs the AWS bucket and IAM
user in the plan's "AWS commands" section. It is the main open cost
question.

## Seam gaps found (Rust path rendering Convex code)

| where | what | state |
|---|---|---|
| `contact-form.tsx` `EmailHold` per email row | `useMutation` with no ConvexProvider: any contact with an email crashed ("Something went wrong!") | **fixed** in `1d9c190` (gated by `FEATURES.emailHolds`) |
| `src/lib/data/rust/hooks.tsx:279` `useEmailContext` | `alsoUsedBy: undefined`: the "Also used by …" warning never shows on Rust, though 2a's `ContactView.warnings` carries it. Convex's two shared-email tests fail | open; not a one-liner (wire `warnings` through) |
| `/t/$slug/settings/*`, `/t/$slug/gifts/*` reached directly | Convex hooks with no provider (2b noted it). Nothing links there | open, out of the spike's scope |
| Settings › Fields | absent on Rust, so fields can only be made through the API | out of scope |

Every other `convex/react` user on the contacts routes is gated
(`ContactAcquisition`, `SourceCodePicker`, `SourceFilter`,
`RememberOpened`, notes, Gift Aid, bulk set) or swapped out
(`ContactHistory` for `RustContactHistory`, the query caches).

## QC results on Rust (functional)

- 39 tests were selected from the in-scope Convex specs, plus
  `rust.spec.ts`. 36 pass.
- The 3 failures are behaviour Rust doesn't have:
  - live list growth (Load more's second half);
  - "Also used by" ×2 (the seam gap above).
- Left out as Convex-only: identifiers, gifts, source codes,
  Settings › Fields, bulk set, Switch group, live two-tab propagation,
  the WebSocket stale gate, and history paging and "Restore to here".

## Lines of code

Non-blank, non-comment lines. Rust `#[cfg(test)]` modules are counted as
tests. Generated code (ts-rs types, `_generated`) is excluded.

| | Convex code | Convex tests | Rust code | Rust tests |
|---|---|---|---|---|
| contacts domain: in-scope files of `convex/contacts/` (contracts, field defs/types/values, fields, history, mutations, number, queries, rules, search, searchProjection, validators, view, warnings) + `lib/fieldSlots.ts` | 3,815 | 4,939 | 2,919 (`contacts` crate) | 1,730 |
| contract machinery | 324 | 643 | 677 | 703 |
| tenancy and storage | 357 | 86 | 518 (`store`) | 126 |
| HTTP layer: routes + core | (Convex function wrappers are inside the domain files) | – | 181 + 531 | 876 |
| SPA data layer | 275 (`convex-*`) + 265 (`paged-list.ts`) | – | 563 | 504 |
| shared seam (`backend`, `index`, `types`) | 102 | | | |
| seed / QC seed | – | – | 191 + 278 | – |

- **Backend for the same slice:** Convex ~4,500 lines, Rust ~4,830.
  Convex's in-scope `mutations.ts` and `queries.ts` still carry some
  identifier and acquisition code, so like for like is closer to
  parity, perhaps +10–15% for Rust.
- **Tests:** Rust has ~3,400 test lines, Convex ~5,700 for the slice.
  The Rust slice tests fewer edge cases per rule (the parity sample
  above adds 15).

## Parity estimate (how much work to bring Rust to `main`)

No earlier written estimate was found in the plan or the docs, so this
one starts from the spike's own numbers.

**Delivered in about one factory day** (steps 1, 2a and 2b, three
builders): ~4,800 lines of Rust backend code and ~3,400 test lines, plus
~940 lines of SPA seam and 500 test lines.

**Not yet ported from `main`:**

| part | Convex code lines | notes |
|---|---|---|
| rest of contacts | ~800 | identifiers, notes, relationships, acquisition, donors, retire |
| giving | 675 | |
| giftaid | 678 | IRmark XML, which is a Node action today |
| sources | 701 | |
| comms | 204 | |
| platform | 1,733 | tenants, members, settings, roles, seeds |
| rest of lib | ~650 | auth helpers, roles, lists, migrations |
| **total** | **~5,400** | about 8,700 test lines on Convex |

**Also needed:**

- the SPA seam for the remaining ~12 routes (contacts needed ~940 lines
  for 3 routes);
- the history panel with moments;
- a QC pool on Rust.

**Things the spike stubbed:**

- **Real auth.** Spike 09 chose Better Auth, a TypeScript library, so on
  Rust it means hand-building TOTP, magic links and sessions, or running
  a sidecar.
- **Email** through SES.
- **Per-tenant scheduled jobs** (Convex crons + Workpool).
- **Webhooks** (Stripe, GoCardless).
- **File storage.**
- **Hosting**, with Litestream (Q7), migrations across org files, and
  deploys.

**Estimate:**

| work | factory days |
|---|---|
| backend domain parity | 4–6 |
| SPA seam and QC parity | 2–3 |
| auth, email, jobs, webhooks, hosting and backups | 3–5 |
| **total** | **~10–14** |

The total excludes the human's ops set-up time and an ADR to replace
0017. Throughout that time Convex `main` stands still or the two
diverge.

## Risks

- **A server to run.** Rust brings back the ops that ADR 0017 was
  written to avoid. Q7 is unmeasured.
- **No live queries.**
  - Concurrent edits always take the stale path, which is slow today
    (781 ms).
  - Lists don't grow in place.
  - Live propagation goes. ADR 0004 had planned SSE for it before
    Convex's live queries retired that plan.
- **Auth** has no TypeScript library to lean on.
- **Migrations over many files.** Each org file migrates when it opens,
  and SQLite doesn't validate old rows against a new schema the way a
  Convex deploy does.
- **The performance win is mostly at a scale we don't serve yet.** At QC
  tenant sizes, reads cost the same on both stacks.

## Findings for the builders (from this step)

1. **Fixed (`1d9c190`):** `EmailHold` wasn't gated, so the contact page
   crashed on Rust for any contact with an email.
2. Not fixed: `useEmailContext` on Rust drops "Also used by" (see the
   seam gaps above).
3. A stale retry waits out the 700 ms autosave pause.
4. Archive, restore and create refetch after the POST; returning the view
   would make them one round trip.
5. Cold load is a waterfall of three requests.
6. `history` of an unknown id answers 200 with an empty page, where
   `GET contacts/{id}` answers 404.

## Reviewer's verdict (step 4)

reviewer-rs, 2026-10-24. Full findings: `factory/out/reviewer-rs.md` in the
main checkout. Codex hasn't been run; its command is in that file.

**I agree with no-go for now.** The numbers support it:
- At QC tenant sizes, reads are level on both stacks.
- Saves are the only win a user would feel, at about one round trip.
- Losing live queries makes the 781 ms stale path the common one.
- Q7, the cost that ADR 0017 exists to avoid, is unmeasured.

**Tenancy holds; I found no cross-organisation path.** A request reaches an
org file only through a membership row:
- the slug is used only as a SQL parameter;
- the tenant id is checked as 32 hex characters before it becomes a path;
- handlers can't reach `Store`;
- files are stamped, `ATTACH` is off and readers are read-only;
- restore checks that the revision belongs to this contact;
- child keys that another contact holds are refused.

No SQL is built from input, and FTS terms are alphanumeric and quoted.

What I would add before any further step:

- **The Vite `/api` proxy is unconditional**, and the dev server is served on
  `.ts.net`. With `KEEP_DEV_AUTH=1`, anyone on the tailnet can sign in as any
  user without a password. `qc-crowd` needs no session at all. Proxy only
  when `VITE_BACKEND=rust`, and treat dev auth as no auth.
- **Org handles.** One global mutex is held while an org file opens and
  migrates, so a slow migration stalls every organisation. Handles are never
  closed, so file descriptors run out at roughly 150–200 orgs. Add this to
  the Risks.
- **Contract discipline is by review, not construction.** `OrgTx` derefs to
  a raw connection, so Q3 "holds" by convention, as on Convex.
- **Method caveats:**
  - Q1's heading says 70–400×, but its own table gives about 20–330×, and
    the verdict says 20–200×.
  - The cold-load gap is overstated by about 30–60 ms. The loopback has no
    TLS, and the stub auth does no work.
  - Rust's p95 is the maximum of 10 samples.

  None of these changes the verdict.
- The 3–5 days for auth, email, jobs and hosting looks optimistic. Real auth
  on Rust is the largest unestimated item.

## Reproducing it

- **Server-side tables:** `rs/README.md` "The 10k measurement". This
  run's output is in `rs/data/measure-tester/` (gitignored).
- **QC flows:** `qc-rs/README.md`.
- **Parity tests:** `cargo test -p contacts --test search_parity`.
- **LOC:** `node scripts/perf-search10k-rs/loc.mjs '<groups JSON>'`
  (file lists as in the table above).
