# QC suite

Playwright drives the production build of the SPA (headless Chromium,
1280×800) against local release builds of the Rust api, times every user
interaction from the input event to the result on screen, and fails the
run when a flow is over budget, a server call is over 100 ms, a ported
route has no flow, or two tenants can see each other's data.

The design and the reasons behind it: `factory/plans/qc-suite.sv`, ADR
0018 and `docs/spikes/07-qc-harness.md`; the move to Rust:
`factory/plans/migration-rust.sv` (F3) and `docs/spikes/10-rust-sqlite.md`.
`cargo test` and `pnpm check` stay the correctness layer; QC is never part
of `pnpm check`.

## Running it

```bash
sudo scripts/qc-netem.sh on 3            # the human, once per boot: the hosted RTT on the api ports
pnpm qc                                  # full run: build, start the pool, test, judge
pnpm qc qc/flows/contacts.spec.ts        # one spec file (a filtered run)
QC_REPEATS=1 QC_NO_NETEM=1 pnpm qc       # fast functional pass at loopback speed
QC_MODE=record pnpm qc                   # measure and write history, assert nothing
QC_NO_WAIT=1 pnpm qc                     # fail at once if another run holds the lock
pnpm qc --target staging                 # the nightly: against keep-staging, no pool, no netem
pnpm qc:pool                             # build and start the pool, and hold it (Ctrl-C stops it)
pnpm qc:rtt --write                      # re-measure the hosted RTT into qc/rtt.json
```

- **Run it outside the Claude sandbox.** It binds the pool's ports and
  writes the lock in the main checkout.
- **The lock.** `pnpm qc` takes `.qc.lock` in the main checkout for the
  whole run. The pool's ports are the machine's, so a run from another
  worktree waits its turn; `QC_NO_WAIT=1` (or `--no-wait`) fails fast
  instead. A lock whose pid is dead, or that is more than two hours old,
  is taken over.
- **No `--reporter`.** `qc/reporter.ts` carries the run's gates, and a
  command-line `--reporter` would replace it, so `playwright.config.ts`
  refuses one.
- **No retries.** A flaky test is a failure to look at.

## The pool

`pnpm qc` runs `scripts/qc.mjs`, which:

1. builds the release `api` (`cargo build --release -p api` in `server/`) and
   the SPA into `dist-qc/`, in parallel (`--no-build` skips it);
2. starts `QC_INSTANCES` (default 3) apis, instance `i` on `KEEP_PORT`
   8801+i with an empty data dir `qc-data/<i>`, `KEEP_DEV_AUTH=1` and
   `KEEP_QC_SEED=1`, on 127.0.0.1. Every run starts from empty files;
3. checks each api's round trip against `qc/rtt.json` (see Netem);
4. writes `qc/.instances.json`, and Playwright's webServer starts one
   `qc/serve.mjs` per instance on 4301+i: the build, with `/api` proxied
   to that instance's api over kept-alive connections, as one hosted
   origin serves both. The change stream gets a connection of its own;
5. runs `playwright test` and stops the apis when it exits.

Workers map onto instances by index, about two per instance. Each worker
seeds fresh tenants (`qc-r<run>w<n>-a|b`) through `POST /api/dev/qc-seed`,
which the api refuses unless it runs with dev auth and `KEEP_QC_SEED=1`.
Every tenant is its own SQLite file, so one worker's bulk write (the
paged list's crowd, `POST /api/dev/qc-crowd`) holds up no other worker's
samples: the Convex era's quiet holds are gone.

### Netem

QC times the app at the round trip a user has to the hosted app: the
median TCP connect from this machine to `keep-staging`, in
`qc/rtt.json` (13 ms, measured 2026-10-24; re-measure with
`pnpm qc:rtt --write`). `scripts/qc-netem.sh on N` adds half of
it each way on loopback, on the api ports only, so serve.mjs, Chromium
and Playwright aren't delayed. It needs root, so the human runs it; it
lasts until `off` or a reboot. An assert run fails if the apis answer
faster than 80% of the target (netem off); `QC_NO_NETEM=1` runs anyway,
and `rttMs` in history says what the samples saw. Record mode doesn't
check.

### Staging

`pnpm qc --target staging` is the nightly: one instance, the hosted app
at `QC_STAGING_URL` (default `https://staging.keep-together.org.uk`), no
build, no netem, no lock. Its history lines carry `env: staging`.
Staging has no dev auth, so set-up goes through its token surface,
`/api/qc/*` (`server/crates/api/src/routes/qc_seed.rs`): `KEEP_QC_TOKEN` must
be in the env (the Fly secret; `scripts/fly/staging.sh` makes it and
sets it as the GitHub secret too, without ever showing it). With it the workers seed `qc-` groups
whose users have `@qc.keep-together.invalid` addresses, sign in for real
(password, then TOTP) for the timed `auth.signIn`, and take further
sessions from `/api/qc/session` (a TOTP code is good once per 30 s, and
each test opens its own session). The token reaches nothing outside
`qc-` groups; a wrong one is a 404. Locally the pool uses `/api/dev/*`
(dev auth and `KEEP_QC_SEED=1`), the same world under the same names.
Set-up calls give up after 10 s (body included) with their route named.
A session call that hangs is retried once (never the seed: each seed sets
new credentials, and an abandoned first try could overwrite the
retry's). Every retry is recorded (`qc/retries.ts`): a `SETUP RETRIES`
banner lists them, marking a route the run before retried too, and the
run's history lines count them (`setupRetries`; the nightly's
`retries=`).

Staging mails only the addresses in `KEEP_MAIL_ONLY_TO`, never QC's
(`@qc.keep-together.invalid`), so for QC's users mail is off and the api
refuses what needs email (`mail_off`), as with `KEEP_MAIL=off`. The seed says so (`mailOff` in the
world), and the flows that send email (the reset request, an invite)
then check that refusal instead: the same answer for any address, no
invite made. They are annotated `mailOff`; a `MAIL OFF` banner lists them
on every such run and the run's history lines carry them (`mailOff`), so
a green night never means the email paths worked.

```bash
KEEP_QC_TOKEN=… pnpm qc --target staging
```

The house server runs it every night at 03:00 against the commit staging
runs (`scripts/qc-nightly/`; docs/ops.md "Nightly QC"), with its own
clone, history and trend report; `~/.local/share/keep-qc-nightly/bin/status.sh`
shows the runs and the streak of passing nights the cutover gate counts.

### Pending ports

Until a wave step ports its module, its specs and tests are skipped
(`qc/pending.ts`, each with a `pendingPort` annotation naming the step)
and its flows are marked `pendingPort` in `qc/budgets.ts`. Every run
lists them by step in a banner, with the routes still being ported, and
none of them fails the run. A step that ports a module deletes its lines
from `qc/pending.ts`, re-points the specs at the Rust api, and drops the
flows' marks. Every module is on the Rust backend now (B3): the list is
empty and no flow is marked, and the mechanism stays for the next port.

## Reading the output

After the run the reporter prints one row per flow:

| Column | Meaning |
|---|---|
| `kind` | `repeat` (repeatable), `infreq` (infrequent), `rare`, `once` (once per session) or `bulk` |
| `n` | timed samples across all workers |
| `median`, `p95`, `max` | raw ms, input event to result on screen, network included |
| `target` | tracked, never failed: a median at or over it is flagged `TARGET` (blank for kinds without one) |
| `budget` | the failing line: every sample must be under this |
| `headroom` | budget − max; negative means over |
| `over` | samples at or over the budget |
| `RTT` | median HTTP round trip from the workers to their api, for context only |
| last column | `ok`, `OVER`, `KNOWN OVER` / `ok (known over)`, `not judged` (record mode or RTT ceiling), `self-test`; `· TARGET` when the flow is flagged against its target; `(re-measured: 1st max N)` after a spike |

Then the server table: per route, the calls' `Server-Timing` total
(p50, p95, max) against its limit.

Banners to look for:

- **`TARGET`**: every flow whose median is at or over its target, or rose
  16 ms or more (about one frame) against the median of its medians over
  its last 5 runs in `history.jsonl` (same flow, same kind, RTT under the
  ceiling), listed on every run with the reason, target, line and max.
  Tracked, **never failing**; with none flagged a one-line all-clear is
  printed instead. A flow with no history gets no drift flag. Runs over
  the RTT ceiling aren't checked. See Budgets.
- **`KNOWN OVER`**: every approved exception in `qc/budgets.ts`, listed on
  every run with its samples, so none is forgotten.
- **`pendingPort`**: what isn't on the Rust backend yet, by step (see
  Pending ports).
- **`SETUP RETRIES`**: set-up calls that got no answer in 10 s and were
  sent again, by route; `ALSO RETRIED ON THE RUN BEFORE` when it recurs.
  Passing, but a recurring hang is a bug to chase.
- **`MAIL OFF`**: the target had mail off, and these tests checked the
  `mail_off` refusal instead of the email path (see Staging).
- **`RTT over 150 ms`**: the link is too slow to judge latency. Behaviour
  is still checked, but latency asserts were skipped. Rerun on a better
  link.
- **`SPIKES`**: flows that were over budget once and judged on their
  re-measure, with both sample sets, and routes that passed with one slow
  call.
- **`LINK`**: samples at or over budget while this machine's first hop
  (a `ping` to the default gateway every 100 ms, `qc/link.setup.ts`) was
  at 50 ms or more instead of its usual 2–5 ms. Judged as usual: the
  banner says where the time went, it doesn't excuse it. It matters for
  the staging run; the local pool's traffic never leaves the machine.
- **`QC RUN FAILED, whatever the test counts above say`**: a gate the
  tests can't see failed: the coverage gate, a flow in `qc/budgets.ts`
  that nothing timed, the server rule, or the worker-setup sign-in over
  budget.

Each flow also gets one line in `qc-results/history.jsonl` (gitignored,
local): samples, p50/p95, budget (the failing line), `targetMs` and the
`target` check, pass, RTT, `env`, git sha and the run's server times by
route. Its `detail` (and `firstDetail` for a re-measure) has one entry per
sample: wall-clock time, worker and instance, and what the sample asked
the api: each `/api` request the watched page (and, for propagation
between tabs, the input page) made in the window, with its start and end
from the input event, status and `Server-Timing` (`serverMs`, `dbMs`);
the first change event the watched page got (`eventMs`); long tasks, host
CPU, load and the first hop's worst round trip (`linkMs`). A slow sample's
calls say whose time it was: server time, or the round trips around it.
Lines from the Convex era keep their legs, blame and judgements; the trend
report reads both.

How the calls are taken: a tap installed from each page's first script
wraps `fetch` (the SPA looks it up on every call) and `EventSource`, and
inside the timed window only notes times and strings; they're read after
the result is on screen. A call's end is when its response headers
arrived. A sample's calls are every request started after it was armed
(after the settle, just before the action): on a checkbox, React's
onChange runs on `click`, before the trusted `input` event t0 is taken
from, so its request can start a moment before t0 (a negative
`startMs`).

`pnpm qc:report` renders that history to `qc-report/trend.html`: per-flow
p50/p95 over the last 30 runs against the budget line, and per-route
server times. The Playwright HTML report is in `qc-report/playwright/`,
with a screenshot for each failed test and a trace for each flow that
failed its budget.

**Tracing is off for timed samples** (human, 2026-10-23). Playwright's
tracing snapshots the whole DOM around every action, the timed click
included, so its cost grows with the page (~230 ms of snapshotting on one
`contacts.loadMore` click). A flow that fails its budget gets one more
sample, untimed and unjudged, with tracing on, attached to the test as
`trace` (worker-setup sign-ins write theirs to
`test-results/.traces/<run>/`); if that sample throws, the flow keeps its
verdict and the record says `traceError`. A functional failure has a
screenshot and, when the page logged anything, its console and uncaught
errors (`console`), not a trace; to trace one, rerun it with
`pnpm qc --trace on <spec>` and ignore its times.

**Phone pairing tokens.** The history, the server table and the
over-budget message name `/api/scan/<token>` as `/scan/:token`. A trace
doesn't: one from `scan.open` or `scan.sendPage` (or a `--trace on` run of
`qc/flows/scan-phone.spec.ts`) holds the page URL with its token and every
call made with it. The pairings are the test's own, held by its phone
context and soon ended, but the trace still holds a credential in a
working format: keep it out of issues and chats, and delete it after use.

**Held results.** Every timed sample must do the work it claims to
measure. TanStack Query keeps what it fetched until something invalidates
it (the change stream, or this tab's own write), so a flow whose result
comes from the server says `server: true`. After every `before` the
harness waits until the page has no `/api` request in flight for three
frames (`settle`); then, for a `server: true` sample, it drops every
cached query no component observes (as Convex dropped an unsubscribed
query; after the settle, since a query a `before` left loses its observer
only in an effect), and a sample in which the watched page got no `/api`
answer before `until` held fails with `HeldResultError`. `contact.revisit` times the cache on purpose and isn't
`server: true`.

## Budgets

Budgets live in `qc/budgets.ts`. Every time is **raw**: from the input
event to the result on screen, network included. There's no round-trip
allowance and no median: **every sample must be under the budget.**

Budgets have two tiers (human, 2026-10-23; ADR 0018 amendment):

- **The failing line** (`maxMs`, the `budget` column): every sample must
  be under it. It alone decides pass and fail.
- **The target** (`targetMs`): tracked, never failed. A flow whose median
  is at or over its target, or whose median rose by 16 ms or more against
  the median of its medians over its last 5 runs (same flow, same kind),
  is flagged in the `TARGET` banner every run and in the trend report
  (`qc/target.ts`). The trend report draws the target dotted under the
  dashed line.

Each
flow call takes one untimed warm-up, then `QC_REPEATS` (default 5) timed
samples.

**Spikes.** A machine occasionally stalls, so a judged flow with any
sample at or over budget is **re-measured once**, straight away in the
same test, with K fresh samples. Only the re-measure is judged: the flow
fails if any sample in it is at or over budget too (ADR 0018's base rule;
the Convex era's blame-and-retry went with Convex). The one-sample sign-in
in the worker fixture re-measures by signing in again. Record
mode and runs over the RTT ceiling judge nothing, so they never
re-measure. Functional assertions never retry.

Spikes stay visible. The table says `ok (re-measured: 1st max 137)`, a
`SPIKES` banner lists both sample sets of every re-measured flow, and the
history line carries `remeasured: true` and `firstSamplesMs` (its
`samplesMs` are the judged re-measure). The trend report rings those
points. A flow that spikes run after run is slow, not unlucky: look at it.

The server rule has the same shape (qc/server.ts): every call a timed
sample made must take under **100 ms on the server**, by its response's
`Server-Timing: total`, grouped by route (`POST /t/:slug/contacts/:id/save`).
Each route may have **one** call at or over 100 ms in a run, as long as it
has other calls and all of them are under. A second slow call fails, and
so does a route whose only call was slow. `/api/dev/*` and `/api/qc/*` (the sign-in stub,
the QC seed) is reported, not asserted. An answered call without the
header fails: the api sets it on every response. Bulk routes
(`BULK_ROUTES` in qc/budgets.ts) have their own limit.

| Kind | Applies to | Failing line | Target (tracked) |
|---|---|---|---|
| `repeatable` | anything a user can do more than once in a signed-in session: navigation, search, save, add, archive … | **under 150 ms, every sample** (human, 2026-10-23) | median under 100 ms |
| `infrequent` | creating a record (a new contact); every later edit of it is `repeatable` | **under 200 ms, every sample** (human, 2026-10-23) | median under 150 ms |
| `rare` | done seldom: restoring a contact from its history | **under 250 ms, every sample** (human, 2026-10-23) | median under 200 ms |
| `oncePerSession` | sign-in, the first page load | its own budget, recorded: 1.5× the worst sample of three `QC_MODE=record` runs | none |
| bulk | an action over many records, such as setting a field on up to 100 contacts | exempt from the repeatable line; its own recorded budget, and the UI must show a progress state | none |

Two marks change how a flow is judged:

- **`knownOver: '<reason> (<who> <date>)'`**: an exception the human
  approved. The flow is still timed and recorded, and listed in the
  banner on every run, but being over budget doesn't fail the run. It
  must name the reason, who approved it and the date. Remove it with the
  fix. None is set today: the marks on `contact.addEmail` and `gift.save`
  were lifted with the two-tier budgets (human, 2026-10-23).
- **`pending: true`**: no spec times the flow yet; a run that doesn't
  time it warns instead of failing. Drop it when the spec lands.
- **`pendingPort: '<step>'`**: the flow's module isn't on the Rust backend
  yet (see "Pending ports"); listed in the banner, never failing. The step
  that ports it drops the mark.

**Raising a budget, exempting a flow (a `knownOver` mark, the bulk kind,
or anything else that stops a sample failing) needs the human's explicit
OK**, given in the task or on the plan page. A flow over budget means
fixing the code, not the number. The only budgets set without a further
OK are the initial recorded ones (plan step 9b).

## Adding a flow

1. **Name it** in `qc/budgets.ts`: `'<area>.<action>'`, with its kind. A
   new repeatable flow is `repeatable`; anything else needs the human's
   OK (see Budgets).
2. **Write the spec** in `qc/flows/<area>.spec.ts`, importing `test` and
   `expect` from `../fixtures` (they give `page` signed in as user A,
   `users`, `world`, `instance`, `flow`, `session`, `rttMs`; `apiGet` and
   `qcCrowd` reach the api directly). Selectors: `getByRole`, `getByLabel`,
   `getByPlaceholder`; add a `data-testid` only where the UI is ambiguous.
3. **Annotate the route** the test exercises, with its full path as in
   `src/routeTree.gen.ts`:

   ```ts
   const CONTACT = { type: 'route', description: '/t/$slug/contacts/$contactId' }
   test('archive', { annotation: CONTACT }, async ({ page, flow, users }) => { … })
   ```

   An annotation pushed at runtime (`test.info().annotations.push(…)`)
   counts too. A test that touches several routes annotates each.
4. **Time the interaction** with `flow()`:

   ```ts
   await flow(page, 'contact.archive', {
     before: async () => { /* untimed: reach the start state */ },
     action: () => page.getByRole('button', { name: 'Archive' }).click(),
     until: () => document.body.innerText.includes('Archived'),
   })
   ```

   `until` runs in the page every animation frame, so it can't close over
   test variables; pass data through `arg`. `start: 'navigation'` times a
   page load from navigation start; `inputPage` times propagation from one
   tab to another. `server: true` when the result comes from the server
   (see Held results). Each test makes the entities it changes: the seeded
   world is shared by every test in a worker.
5. **Run** `pnpm qc qc/flows/<area>.spec.ts`, then a full `pnpm qc`.

### The coverage gate

Every route in `src/routeTree.gen.ts` that the Rust backend serves
(`src/lib/data/ported.ts`) must be covered by at least one test that
**ran** (not skipped) with a matching `route` annotation, and every route
annotation must name a real route. Routes being ported are listed in the
pendingPort banner instead. `qc/reporter.ts` checks this at
the end of the run, from the annotations Playwright reports, including
those pushed at runtime:

- in a full run (assert or record mode) a gap **fails the run**;
- in a filtered run (spec files, `--grep`, `--last-failed`,
  `--only-changed`, `--shard`, `--list`) it only warns, since that run
  skips tests on purpose.

`qc/coverage.test.ts`, under `pnpm check`, gives an earlier and rougher
warning: every route must appear as a quoted string somewhere in
`qc/flows/`. So a new route without a flow fails `pnpm check` before
anyone runs `pnpm qc`.

### Isolation

`qc/flows/isolation.spec.ts` is mandatory and runs on every worker: user
A must not see tenant B's group, contacts or search results. A new route
that shows tenant data adds its case there.

## The builder obligation

A builder whose change touches `src/` or `server/` runs `pnpm qc` before
reporting DONE and puts the summary table in the report. If it fails,
fix the code, or report BLOCKED with the first failing lines and the log
path; never raise a budget to get green.
