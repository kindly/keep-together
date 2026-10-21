# QC suite

Playwright drives the production build of the SPA (`vite build` +
`vite preview`, headless Chromium, 1280×800) against live Convex dev
deployments, times every user interaction from the input event to the
result on screen, and fails the run when a flow is over budget, a route
has no flow, or two tenants can see each other's data.

The design and the reasons behind it: `factory/plans/qc-suite.sv`, ADR
0018 and `docs/spikes/07-qc-harness.md`. `convex-test` under `pnpm check`
stays the correctness layer; QC is never part of `pnpm check`.

## Running it

```bash
pnpm qc                                  # full run: push, build, test, judge
pnpm qc qc/flows/contacts.spec.ts        # one spec file (a filtered run)
QC_REPEATS=1 pnpm qc                     # fast functional pass, 1 timed sample per flow
QC_MODE=record pnpm qc                   # measure and write history, assert nothing
QC_NO_WAIT=1 pnpm qc                     # fail at once if another run holds the lock
QC_LEGS=0 pnpm qc                        # no WebSocket tap: samples carry no legs (A/B its cost)
pnpm qc:instances --reset                # prepare the pool and empty every instance
```

- **Run it outside the Claude sandbox.** The sandbox's proxy blocks the
  WebSockets the SPA needs, slows the network enough to skew timings, and
  `pnpm qc` writes to the main checkout (lock, env files).
- **The lock.** `pnpm qc` takes `.qc.lock` in the main checkout for the
  whole run, from push to the last test. A run from another worktree
  waits its turn; `QC_NO_WAIT=1` (or `--no-wait` to
  `scripts/qc-instances.mjs`) fails fast instead. A lock whose pid is dead,
  or that is more than two hours old, is taken over.
- **No `--reporter`.** `qc/reporter.ts` carries the run's gates, and a
  command-line `--reporter` would replace it, so `playwright.config.ts`
  refuses one.
- **No retries.** A flaky test is a failure to look at.

## The pool

`pnpm qc` runs `scripts/qc-instances.mjs`, which:

1. ensures `dev/qc-1..3` exist (`QC_INSTANCES` changes the count), each
   with Convex Auth keys and a deploy key in `.env.qc-<i>.local` in the
   main checkout;
2. pushes this checkout's code to every instance in parallel with
   `convex deploy`, never `convex dev`, so `.env.local` is left alone;
3. builds `dist-qc/qc-<i>` against each instance's URL and writes
   `qc/.instances.json`;
4. runs `playwright test` and holds the lock until it exits.

Workers map onto instances by index, about two per instance. Each worker
seeds fresh tenants (`r<run>w<n>-a|b`) through `platform/qcSeed:fixture`,
which refuses to run unless the deployment has `QC_SEED_ENABLED=1` (set
only on the pool). Nothing is wiped between runs, so data accumulates;
`--reset` replaces every instance's data with an empty snapshot when it
gets in the way. The human's own dev deployment is never a pool member.

## Reading the output

After the run the reporter prints one row per flow:

| Column | Meaning |
|---|---|
| `kind` | `repeat` (repeatable), `infreq` (infrequent), `rare`, `once` (once per session) or `bulk` |
| `n` | timed samples across all workers |
| `median`, `p95`, `max` | raw ms, input event to result on screen, network included |
| `budget` | every sample must be under this |
| `headroom` | budget − max; negative means over |
| `over` | samples at or over the budget |
| `RTT` | median WebSocket round trip of the workers, for context only |
| last column | `ok`, `OVER`, `KNOWN OVER` / `ok (known over)`, `not judged` (record mode or RTT ceiling), `self-test`; `(re-measured: 1st max N)` after a spike |

Banners to look for:

- **`KNOWN OVER`**: every approved exception in `qc/budgets.ts`, listed on
  every run with its samples, so none is forgotten.
- **`RTT over 150 ms`**: the link is too slow to judge latency. Behaviour
  is still checked, but latency asserts were skipped. Rerun on a better
  link.
- **`SPIKES`**: flows that were over budget once and judged on their
  re-measure, with both sample sets, and server functions that passed
  with one slow call.
- **`LINK`**: samples at or over budget while this machine's first hop
  (a `ping` to the default gateway every 100 ms, `qc/link.setup.ts`) was
  at 50 ms or more instead of its usual 2–5 ms. On Wi-Fi the link to
  the router freezes for 200–600 ms now and then, or crawls at 50–130 ms
  for a few seconds, and every flow on every instance waits it out
  (factory/out/builder-qcstall.md). They're judged as usual: the banner
  says where the time went, it doesn't excuse it. A wired link avoids it.
- **`QC RUN FAILED, whatever the test counts above say`**: a gate the
  tests can't see failed: the coverage gate, a flow in `qc/budgets.ts`
  that nothing timed, or the worker-setup sign-in over budget.

Each flow also gets one line in `qc-results/history.jsonl` (gitignored,
local): samples, p50/p95, budget, pass, RTT, git sha and the run's
Convex server execution times. Its `detail` (and `firstDetail` for a
re-measure) has one entry per sample: wall-clock time, worker and
instance, and the sample's legs from a tap on the page's WebSocket:
when the Mutation went out, when the server committed it (server
clock), when its MutationResponse and the Transition carrying it came
back, plus long tasks, host CPU, load and the first hop's worst round
trip (`linkMs`). A slow sample's legs say whose time it was: a late
commit with the first hop slow is the link; a late response or
Transition with a clean link is the deployment. The run directory
(`qc-results/runs/<id>/`) also keeps every server call
(`server-calls.jsonl`), each worker's RTT every 2 s from Node
(`rtt-*.jsonl`, probing `platform/qcProbe:rtt`, which server timings
leave out) and the first-hop pings (`link.json`).

How the legs are taken, and their limits:

- Inside the timed window the tap only keeps each frame's string and
  time; it's parsed after the result is on screen. An incoming frame's
  time is its `MessageEvent.timeStamp`, so the SPA's own handling of it
  isn't counted in the leg. Measured cost of the tap: see
  factory/out/builder-qcstall.md (the A/B, `QC_LEGS=0` against 1).
- `commitMs` is on the server's clock, so it's only as good as the two
  clocks agree (a few ms).
- `linkMs` counts an unanswered echo from its send until the link
  answered again. Without a gateway or a working `ping` the reporter
  prints `link: first hop not watched`, so a missing LINK banner never
  means a clean link.
- On a checkbox click, t0 is the trusted `input` event fired inside the
  click, a few ms after the press.

### Blame

Every sample at or over budget, in both sets of a re-measure, gets a
breakdown and a verdict (`qc/blame.ts`). They go on its history line as
`detail[i].blame`, in a `BLAME` list after the table, and as counts by
verdict next to the failures (all slow samples, then each failed flow).
The reporter's blame is context. What judges a sample is the same
blame, computed live in the worker for the judged set (see Ours).

```
128 = page 18 · to Convex ≈21 · our function 30 (contacts/mutations:setAcquisition) · back ≈46 · Transition 13 · overhead beyond the probe 49 · probe 30 ms @ that moment (run median 33) · link 1 ms → convex/network (…)
```

| Leg | From the sample |
|---|---|
| page | input → send, plus the Transition (or last message) → result on screen; long tasks shown when any |
| to Convex ≈ | send → commit, less our function (server clock) |
| our function | the matching call in `server-calls.jsonl`: same function (`fns`, from the frame the page sent), same instance. A mutation's call must complete from 10 ms before to 100 ms after its commit timestamp, both on the server clock, so clock skew can't move it; without a commit (a query change, an action), between the send and the response or screen message ± 10 ms on the page's clock. Zero or two candidates (two workers share an instance) is `unmatched`, never a guess; history from before `fns` is always unmatched. A query change takes the slowest query it adds |
| back ≈ | commit → response (server clock) |
| Transition | response → the Transition carrying the result |
| Convex + network | send → screen message, less our function, when there's no commit to split it (a query change) |
| overhead beyond the probe | send → screen message, less our function and the probe: what a no-op round trip at that moment wouldn't take. Derived, it overlaps the legs |
| probe | the worker's `qcProbe:rtt` samples within 1 s of the sample, and its run median |
| link | the first hop's worst round trip during the sample |
| Convex slow on … | a spell: other instances with a call at or over 100 ms within 500 ms of the sample (rule 4) |
| re-runs | the page's own subscribed queries (`subs`, tracked by the tap from the page's first script) that started after the commit (−10 ms) and completed by the Transition (+10 ms) on that instance: what the sample waited for besides our mutation. Their **critical path**: re-runs whose intervals overlap run side by side, so each overlapping group counts its slowest, and groups one after another add up (human, 2026-10-21). Max, union and sum are kept too |
| our share | page + our function + the re-runs' critical path. None for a save whose re-runs can't be told (no `subs`), so it never understates |

The legs before `overhead` add up to the sample. `≈` legs rest on
`commitMs`, so they're as good as the two clocks agree; a call's log time
lands about 15 ms before its response reaches the page.

The verdict is the first rule that holds:

1. `link`: the first hop was at 50 ms or more (the LINK rule).
2. `unclear`: no legs (`QC_LEGS=0`, or the page sent nothing).
3. `ours`: page time 40 ms or more. Before the probe, since the page's
   time doesn't depend on the server.
4. `convex/network`: a probe at that moment at 1.5× the worker's run
   median and 20 ms over it, or a spell: calls at or over 100 ms on two
   other instances within 500 ms, of at least two different functions.
   Seeds, bulk functions, `auth:*` and the sample's own functions don't
   count, so a regression of our code, slow on every instance at once,
   stays `ours`. The probe runs every 2 s and misses most stalls; the
   other instances catch them. Before the function: a stall slows our
   function too.
5. `unclear`: our function unmatched.
6. `ours`: our function 50 ms or more (half the server budget).
7. `unclear`: function and page normal, the excess in the legs between
   them. That is no evidence it wasn't ours (human, 2026-10-21), and
   unclear counts as ours (see Ours).

### Ours

Human, 2026-10-21 (ADR 0018 amendment). The set re-measure stays as it
is (see Budgets). Then, **inside the judged set**, every sample at or
over budget is blamed live in the worker (`qc/live.ts`, `qc/judge.ts`):

| Verdict | What happens |
|---|---|
| `ours` | fails, as today; no retry |
| `unclear` | counts as ours: fails, no retry |
| `link` or `convex/network` (positive evidence: a first-hop stall, the probe elevated, or a spell) | measured again, up to **2** more attempts. An attempt under budget passes it (`passed on retry`); an attempt that is over and ours fails it. Still over and not ours after the last: **our share** of that attempt must be under **budget − 50 ms** (repeatable 100 → 50, infrequent 150 → 100, rare 200 → 150) to pass (`passed on our share`), else `failed: our share over` |

- **Retry cap:** 10 extra attempts per run, across all workers (files in
  `qc-results/runs/<id>/retries/`). Past it a sample is judged as today
  (over budget fails) as `failed: retry cap`.
- **Self-test flows** (`harness.*`) are always judged as today.
- **Live data.** The log collector and the link monitor append
  `server-calls.live.jsonl` and `link.live.jsonl` in the run directory as
  they go. Before blaming, the worker pings every instance with the probe
  query and waits until each log stream has passed the sample's window
  plus 500 ms (the spell window), at most 8 s; `convex logs` lags 30 ms at
  the median, under 100 ms at p99. A stream that doesn't catch up leaves
  calls missing, so the function goes unmatched, the verdict unclear,
  and the sample fails: waiting costs time, never excuses a sample.
  `[logs behind]` marks it.
- **Reading it:** the table's last column adds `(1 passed on retry, …)`;
  a `JUDGED` list after `BLAME` shows each judged sample's attempts,
  verdicts and our share; and next to the failures,
  `ours: N slow samples judged, R retried (E extra attempts): …`. A failed
  flow's error names each failing sample's rule and attempts. History
  carries `detail[i].judge` (rule, attempts) and `judged` (counts by rule)
  per flow.
- **Hidden-ours signals**, tracked per flow, not judged: the medians of the
  characters (≈ bytes) the page received per sample, the requests it
  sent, and the commit latency (send → commit less the probe), as
  `signals` in history and three columns in the trend report. The trend
  flags a flow that passed on our share in most of the runs that timed it
  (at least two): `leans on our share`.

`pnpm qc:report` renders that history to
`qc-report/trend.html`: per-flow p50/p95 over the last 30 runs against the
budget line. The Playwright HTML report is in `qc-report/playwright/`,
with traces for failed tests.

Server execution times come from `convex logs`: every uncached call of
our own functions on a user path must take under 100 ms, bar one spike
per function (see Budgets). `auth:*`, admin and cached calls are
reported, not asserted.

## Budgets

Budgets live in `qc/budgets.ts`. Every time is **raw**: from the input
event to the result on screen, network included. There's no round-trip
allowance and no median: **every sample must be under the budget.** Each
flow call takes one untimed warm-up, then `QC_REPEATS` (default 5) timed
samples.

**Spikes.** Convex dev deployments occasionally stall (server time jumps
from ~15 ms to 120–160 ms), so a judged flow with any sample at or over
budget is **re-measured once**, straight away in the same test, with K
fresh samples. Only the re-measure is judged: the flow fails if it has a
sample at or over budget that is ours (see Ours: a sample that isn't
ours is retried, then judged on our share). This covers both kinds; the one-sample
sign-in in the worker fixture re-measures by signing in again. Record
mode and runs over the RTT ceiling judge nothing, so they never
re-measure. Functional assertions never retry.

Spikes stay visible. The table says `ok (re-measured: 1st max 137)`, a
`SPIKES` banner lists both sample sets of every re-measured flow, and the
history line carries `remeasured: true` and `firstSamplesMs` (its
`samplesMs` are the judged re-measure). The trend report rings those
points. A flow that spikes run after run is slow, not unlucky: look at it.

The server rule has the same shape: each asserted function may have
**one** call at or over 100 ms in a run, as long as it has other calls
and all of them are under. A second slow call fails, and so does a
function whose only call was slow, since nothing re-measured it. The
function's other calls in the run are its re-measure: the server can't
replay a call, and a stall is one moment, so one slow call per function
is what it looks like. Server spikes are in the same banner.

| Kind | Applies to | Budget |
|---|---|---|
| `repeatable` | anything a user can do more than once in a signed-in session: navigation, search, save, add, archive … | **under 100 ms, every sample** |
| `infrequent` | creating a record (a new contact); every later edit of it is `repeatable` | **under 150 ms, every sample** (human, 2026-10-19) |
| `rare` | done seldom: restoring a contact from its history | **under 200 ms, every sample** (human, 2026-10-21) |
| `oncePerSession` | sign-in, the first page load | its own budget, recorded: 1.5× the worst sample of three `QC_MODE=record` runs |
| bulk | an action over many records, such as tagging up to 100 contacts | exempt from 100 ms; its own recorded budget, and the UI must show a progress state. The first bulk flow adds the `'bulk'` kind to `qc/budgets.ts` |

Two marks change how a flow is judged:

- **`knownOver: '<reason> (<who> <date>)'`**: an exception the human
  approved. The flow is still timed and recorded, and listed in the
  banner on every run, but being over budget doesn't fail the run. It
  must name the reason, who approved it and the date. Remove it with the
  fix.
- **`pending: true`**: no spec times the flow yet; a run that doesn't
  time it warns instead of failing. Drop it when the spec lands.

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
   `users`, `flow`, `rttMs`). Selectors: `getByRole`, `getByLabel`,
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
   tab to another. Each test makes the entities it changes: the seeded
   world is shared by every test in a worker.
5. **Run** `pnpm qc qc/flows/<area>.spec.ts`, then a full `pnpm qc`.

### The coverage gate

Every route in `src/routeTree.gen.ts` must be covered by at least one test
that **ran** (not skipped) with a matching `route` annotation, and every
route annotation must name a real route. `qc/reporter.ts` checks this at
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

A builder whose change touches `src/` or `convex/` runs `pnpm qc` before
reporting DONE and puts the summary table in the report. If it fails,
fix the code, or report BLOCKED with the first failing lines and the log
path; never raise a budget to get green.

**Exception:** a branch that changes `convex/schema.ts` doesn't run
`pnpm qc` until it's merged. The pool is shared, and that schema, plus the
data the seed writes under it, would stop every main-based run from
deploying. Say "pnpm qc pending merge" in the report instead.
