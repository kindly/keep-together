# 0018 — QC runs the built SPA against a pool of live dev instances, with RTT-adjusted budgets and a coverage gate

Status: accepted (2026-10-18; proposed 2026-10-17) · drafted by the step 0 spike

**Amended in review (2026-10-18), superseding decision 4's numbers:**
anything a user can do more than once per session must have **every
sample under 100 ms, raw** (input to screen, network included; no RTT
allowance, no median). Server: every uncached call of our functions on
user paths under 100 ms. A flow over budget is re-measured once and fails
only if over twice; both sets are recorded. Bulk actions and
once-per-session flows have their own recorded budgets. Approved
exceptions are marked `knownOver` with a reason and date. Raising a
budget or adding an exception needs the human's OK. Details:
`factory/plans/qc-suite.sv`, `qc/README.md`.
(`docs/spikes/07-qc-harness.md`) for review. Plan:
`factory/plans/qc-suite.sv`.

## Context

`pnpm check` proves correctness with `convex-test`, which runs functions
in-process against a mock database. It can't see what a user sees: the
production bundle, Convex Auth over a real socket, live-query
propagation, render time, and the network in between. The product's
pitch is a fast, live form for volunteers, so slowness and broken flows
are regressions just like wrong data. Factory builders also change the
UI unattended, so they need a check they can run before reporting done.

What the spike established (details and numbers in spike 7):

- Convex dev deployments are free, take ~2 s to create and can't be
  deleted from the CLI.
- A deploy key per deployment plus `convex deploy` pushes to several
  deployments in parallel without touching `.env.local`. `convex dev`
  can't do that.
- `convex logs --success --jsonl` reports per-function `executionTime`,
  so server time can be separated from network and render time.
- Convex Auth's `createAccount` works from an internal action, so a seed
  can create users who sign in through the UI.
- Our flows today run 50–410 ms against a ~17 ms WebSocket round trip
  from home broadband to Convex EU.
- The Claude sandbox blocks WebSockets and distorts latency, so QC runs
  outside it.

## Decision

1. **What is tested.** The production build (`vite build`, served by
   `vite preview`), driven by Playwright in headless Chromium at
   1280×800, against live Convex cloud dev deployments. Never `prod`. It
   doesn't replace `convex-test`. QC is the behaviour-and-latency layer
   above it.
2. **Where.** A pool of reused dev deployments `dev/qc-1..N` (N=3 to
   start), each with its own build (the Convex URL is compiled in) and
   about two Playwright workers. Each run pushes the current code to the
   whole pool in parallel with deploy keys. A lock file in the main
   checkout makes concurrent runs from different worktrees queue. Data
   is never wiped between runs. Every run and worker seeds fresh tenants
   (`r<run>w<n>-a|b`), and a reset is an explicit snapshot import.
3. **Tenancy.** Every worker seeds two tenants with two users through an
   internal `platform/qcSeed` (Convex Auth `createAccount` plus the
   existing contracts via `executeContract`). A mandatory isolation spec
   checks that user A sees nothing of tenant B through the UI.
4. **Latency is a pass/fail criterion.** Each timed step is measured in
   the page, from just before dispatch to the frame where the result is
   on screen. It is judged as `measured − roundTrips × RTT`, where
   RTT is the median WebSocket round trip measured at worker start and
   each flow declares its inherent round trips. A flow passes when the
   median of K=5 repeats is within budget and the max is within 2×. When
   RTT is over 150 ms the run checks behaviour only, and says so loudly.
   Convex server time is asserted separately (query p95 ≤ 50 ms,
   mutation p95 ≤ 100 ms over our own modules' uncached executions).
5. **Budgets are recorded, then held.** The first budgets are 1.5× the
   worst p95 across three recorded runs. After that, a flow over budget
   means the code gets fixed. **Raising a budget needs the human's
   explicit OK.**
6. **Coverage gate.** Every route in `src/routeTree.gen.ts` must be named
   by at least one spec's `route` annotation, or the run fails. New
   flows cost one spec file and one budget entry.
7. **When.** `pnpm qc`, local only, never part of `pnpm check`. Builders
   whose change touches `src/` or `convex/` run it before reporting done
   and include the summary table. No retries. A flaky test is a failure
   to investigate. Results append to a gitignored
   `qc-results/history.jsonl`. Nightly CI with its own pool comes later.

## Consequences

- Slow or broken flows block a builder's DONE instead of reaching the
  human. The suite needs network access, Convex credentials and a
  machine outside the Claude sandbox, so it stays out of `pnpm check`
  and out of PR CI.
- Running outside the sandbox means `pnpm qc` needs a sandbox exclusion
  or per-run approval in builder sessions.
- Budgets measure one machine on one network. RTT adjustment and the
  150 ms ceiling make them portable enough for a laptop and a nightly
  runner, but not for arbitrary networks.
- The pool accumulates data and needs occasional resets. Deployments
  are removed only from the dashboard.
- `platform/qcSeed` ships to every deployment, prod included, as an
  internal function like `devSeed`. Only the CLI or dashboard can call
  it.
- Domain rule 3 holds: the suite archives through the UI and never
  deletes. A reset replaces the whole deployment's data and never
  touches `prod`.
- Each new UI area (giving, consent, Gift Aid) brings its own flows,
  which check derived state (eligibility from the declaration chain,
  current consent from the log, exact pence round trips) through the
  UI.
