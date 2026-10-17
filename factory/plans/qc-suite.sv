<sv-page label="plan: QC suite" category="plans">

<sv-prose id="b1">
## Design tree

*Confirmed by the human 2026-10-17 (round 3 approved). This page is the plan.*

- **Fixed by the project rules**
  - Two tenants and two users per worker; mandatory isolation spec.
  - No schema change and no new contract. The seed writes contacts through `executeContract`.
  - Never touches `prod`, never deletes a contact.
- **Tool:** Playwright, **Chromium only**, against the production build (`vite build` + `vite preview`), one build per instance.
- **Instances:** reused pool **`dev/qc-1..3`**, about 2 workers each. **Fresh tenants per run and per worker** (`r<run>w<n>-a|b`), no wipe; reset on demand with `import --replace-all`.
  - **A lock** in the main checkout makes concurrent runs from different worktrees wait their turn (`--no-wait` fails fast).
- **Latency**
  - Client time measured in the page; budgets are **round-trip adjusted** (`measured − roundTrips × RTT`).
  - Pass rule: **K=5 repeats, median ≤ budget and max ≤ 2× budget.**
  - **Record first:** 3 full runs, possibly at different times of day, without asserting. Each budget is 1.5× the worst p95 across them.
  - **Raising a budget later needs your explicit OK.** Otherwise the builder fixes the code.
  - **Server timings are asserted:** query p95 ≤ 50 ms, mutation p95 ≤ 100 ms.
  - **RTT ceiling of 150 ms:** above it, the run still checks behaviour but skips the latency asserts, with a loud warning.
  - **Desktop viewport 1280×800 only.** A phone viewport comes with the designed UI pass.
- **Where it runs:** **local only**, as a separate `pnpm qc` that is never part of `pnpm check`. Nightly and manual CI come later (step 11).
  - **Builders whose change touches `src/` or `convex/` run `pnpm qc` before reporting DONE**, and put the summary table in their report.
- **History:** `qc-results/history.jsonl`, gitignored, on your machine.
- **Guardrails**
  - **No retries.**
  - The **coverage gate fails the run** when a route has no flow.
  - `qcSeed` is an **internal function, like devSeed**, with no env-var gate.
  - The **devtools get gated behind `import.meta.env.DEV`** if step 0e shows they ship in the build.
- **ADR 0018:** drafted by the step 0 spike for your review.
</sv-prose>

<sv-prose id="b2">
## Goal

Add a Playwright suite that drives the built SPA against live Convex cloud dev deployments. It exercises every route, form and action that exists today. It times each interaction and fails the run when a flow is over budget. Shards run in parallel against a pool of dev instances. Adding a new flow takes one spec file and one budget entry, and a coverage gate fails when a route has no spec.

**Out of scope:**
- Replacing the `convex-test` unit tests, which stay the correctness layer under `pnpm check`.
- Load or stress testing (many concurrent users on one tenant).
- Visual regression.
- Production deployments.
</sv-prose>

<sv-prose id="b3">
## What exists today

**Routes** (`src/routes/`):

| Route | What's on it |
|---|---|
| `/` | sign in / sign up, groups list, create group (ok / taken / invalid), sign out |
| `/t/$slug` | layout: "sign in to open", "no group called …", header nav |
| `/t/$slug/contacts/` | list, name search, "show archived", New contact |
| `/t/$slug/contacts/new` | kind select, details fields, create → navigate, inline problems, duplicate → navigate |
| `/t/$slug/contacts/$contactId` | autosaving form over details, emails, phones, addresses (add, remove, primary, label); save pane ("N to fix", "N to check", "All changes saved"); history + "Restore to here"; Archive/Unarchive; "No such contact" |

**Auth:** Convex Auth `Password`. The JWT and refresh token live in `localStorage`, so Playwright `storageState` captures a signed-in session. Sign-up needs no email verification. `platform/devSeed:demoTenant` inserts a `users` row with **no password**, so a seeded user can't sign in yet.

**Instances:** `scripts/dev-instance.sh` creates `dev/<name>` in the EU, sets the auth keys and pushes with `convex dev --once`. Three things matter here:
- It backs up and restores `.env.local` around the push. **Two copies running in parallel race on `.env.local.bak`.**
- There's no CLI delete for a deployment.
- `VITE_CONVEX_URL` is compiled into the build, so one build serves exactly one instance.

**Browser tooling:** nothing installed. `/usr/bin/chromium` exists. The sandbox makes `$HOME` caches read-only, so Playwright's browsers either go in the repo or it uses `executablePath`.

**CI:** `ci.yml` runs `pnpm check` on PRs. `pages.yml` builds and deploys. CI has no Convex credentials apart from `vars.VITE_CONVEX_URL`.

**Server timings:** `convex logs --deployment X --jsonl --success` streams every successful execution. Whether those events include execution time still needs confirming (step 0a).

**Risk:** `__root.tsx` renders `TanStackDevtools` unconditionally, bottom-right. The contact form's save pane is `fixed right-4 bottom-4`, so the two may overlap.
</sv-prose>

<sv-prose id="b4">
## How it works

### Getting the SPA

Build once per instance: `VITE_CONVEX_URL=<url> vite build --outDir dist-qc/<instance>`. Serve each build with `vite preview --outDir … --port 41NN`. Builds take seconds. A runtime `?convex=` override would put test plumbing into production code, so I've ruled it out.

### Instance lifecycle

- **Pool, reused:** `dev/qc-1 … dev/qc-N`, created once by `pnpm qc:instances`, with env files in `.env.qc-<i>.local`. There's no CLI delete and creation is slow, so instances aren't created per run.
- **Per run:** push the current code to every pool instance in parallel, using a mechanism that leaves `.env.local` alone (step 0b). Then build once per instance.
- **Shards → instances:** a worker fixture maps `workerIndex % N` to an instance and its port. Default workers = 2 × N, capped at about half the CPU cores so browser CPU contention doesn't inflate render times.
- **Teardown:** stop the preview servers and log collectors. Deleting pool instances is a dashboard job.
- **Cost:** dev deployments are free. A run makes a few thousand function calls (~30 flows × 5 repeats × a few calls, plus seed and live-query updates).

### Isolation

Each worker seeds tenant A with user A and tenant B with user B, with distinctive contact names (`Alpha-<run>`, `Bravo-<run>`). Specs run as A. The isolation spec asserts:

- A on `/t/<slugB>/contacts` sees "No group called …".
- A on `/t/<slugA>/contacts/<contactIdOfB>` sees "No such contact".
- A's list, and a search for `Bravo-<run>`, show none of B's contacts.
- A's groups list shows only tenant A.

### Seeding a user who can sign in

`convex/platform/qcSeed.ts` is an internal action. It calls Convex Auth's `createAccount` for each user, then an internal mutation like `demoTenant`: tenant, membership and relationship types, plus contacts written through `executeContract`. It runs via `npx convex run --deployment <d> platform/qcSeed:fixture`. Each worker signs in through the UI once per user, which doubles as the timed sign-in flow, and saves `storageState`.

### What "latency" means

1. **Client-perceived (primary):** from action to rendered result, timed inside the page. The harness calls `performance.now()` just before dispatching the action. It then waits with `page.waitForFunction(pred, { polling: 'raf' })`, which checks every animation frame, and reads `performance.now()` when the predicate holds. Playwright's `expect` polling (100/250/500 ms) is too coarse for timing. For propagation between two tabs, it compares `performance.timeOrigin + performance.now()` across both pages; they're on the same machine and clock.
2. **Server execution:** Convex's own per-function execution time from the log stream, aggregated to p50/p95 per function. It separates "Convex is slow" from "the network or render is slow".

**Network:** a probe at worker start times a trivial query (`platform/tenants:mine` signed out) 10× over the page's WebSocket and takes the median round-trip time. Each flow declares the round trips it inherently needs. A flow is judged on `measured − roundTrips × rtt`.

**Flake control:**
- Production build only.
- One untimed warm-up iteration per flow per worker, plus a global hit on every function after each push, so cold starts don't count.
- `QC_REPEATS=1` gives a fast functional smoke run.
- K=5 timed repeats; a flow passes when the median ≤ budget and the max ≤ 2× budget.
- Workers are bounded, and the browser runs headless at a fixed viewport.

### Starting budgets (replaced by record mode)

Compute + render, after the RTT allowance:

| Flow | Budget | Round trips |
|---|---|---|
| Cold load `/t/<slug>/contacts` → list rendered | 1200 ms | 4 |
| Client nav list ↔ contact → data rendered | 250 ms | 1 |
| Search keystroke → list updated | 250 ms | 1 |
| Toggle "show archived" → list updated | 250 ms | 1 |
| Create contact click → contact page rendered | 500 ms | 2 |
| Save click → "All changes saved" | 300 ms | 1 |
| Add email + Save → persisted, warnings updated | 300 ms | 1 |
| Live propagation: A's save commits → B shows it | 300 ms | 1 |
| Archive/Unarchive → label flips, list badge | 250 ms | 1 |
| Restore to here → form shows restored values | 400 ms | 1 |
| Create group → appears in list | 400 ms | 1 |
| Sign in → groups list rendered | 2000 ms | 3 |
| Server: query p95 / mutation p95 | 50 / 100 ms | — |

Sign-in is high because Convex Auth hashes passwords in JS. The autosave timing starts at the Save click, which takes the deliberate 700 ms debounce out of it. A separate untimed test checks that autosave fires on its own.

### Reports

- The Playwright HTML report, with traces kept on failure only.
- `qc/reporter.ts` appends one JSON line per flow per run to `qc-results/history.jsonl`: runId, git sha, flow, samples, p50/p95, RTT, budget, pass/fail, plus the server per-function p50/p95. It also prints a terminal table: flow, median, max, budget, headroom.
- `pnpm qc:report` renders the history to a trend page: per-flow p50/p95 over runs, with the budget line.

### Pattern for new flows

- One spec per area: `qc/flows/<area>.spec.ts`. Each test carries a `route` annotation.
- Timed steps go through `flow(page, 'contact.save', { action, until, roundTrips })`. The name must exist in `qc/budgets.ts`.
- Selectors: `getByRole` / `getByLabel` / `getByPlaceholder`. Add a `data-testid` only where the UI is ambiguous (history moments, repeated row controls).
- `qc/coverage.test.ts` checks routes in `src/routeTree.gen.ts` against the annotations, and the run fails when a route has no flow.
- `qc/README.md` covers how to add a flow, pick a budget and count round trips.
</sv-prose>

<sv-prose id="b5">
## Contracts and tables

- **No schema change.** No loosen / backfill / tighten.
- **No new contract.** `qcSeed` uses the existing `details`, `methods` (`expected: 0`) and `relationshipType` contracts through `executeContract` with `source: 'seed'`, as `devSeed` does. `users`, `tenants` and `memberships` are inserted directly, which is allowed under `convex/platform/`.
- Convex Auth's `createAccount` is the only writer of the auth tables.
</sv-prose>

<sv-prose id="b6">
## Steps

Order: **0 → 1 → (2 ∥ 3) → (4 ∥ 5) → (6 ∥ 7 ∥ 8 ∥ 9 ∥ 10) → 9b → 11 (later)**. Each step is one builder session, each in its own worktree.

**0. Spike: confirm the unknowns** (output `docs/spikes/07-qc-harness.md`):
- a. Do `convex logs --jsonl --success` events carry execution time and function name?
- b. Find a parallel-safe push to several dev deployments that leaves `.env.local` alone. Candidates: deploy keys + `convex deploy`, a scratch cwd, or `--deployment`.
- c. Does `createAccount` work from an internal action with `Password`, and can that user then sign in through the UI?
- d. Get Playwright Chromium running under the sandbox: in-repo `PLAYWRIGHT_BROWSERS_PATH`, or `executablePath: /usr/bin/chromium`.
- e. Does the devtools trigger ship in `vite build`, and does it overlap the save pane?
- f. Measure RTT and time 3 flows by hand, as a sanity check on the budgets.
- g. Draft **ADR 0018**: QC against live dev instances, RTT-adjusted budgets, the coverage gate. It's for the human to review, not to merge unreviewed.

**1. Tooling skeleton.**
- Add `@playwright/test`; mind pnpm 11's `allowBuilds` and minimum release age.
- Add `playwright.config.ts` and the scripts `qc`, `qc:instances`, `qc:report`.
- Gitignore `dist-qc/`, `qc-results/`, `qc-report/`, `test-results/`.
- Make sure vitest excludes `qc/`.
- Files: `package.json`, `pnpm-workspace.yaml`, `playwright.config.ts`, `.gitignore`, vitest/tsconfig/eslint config.

**2. Instance pool** (∥ 3).
- `scripts/qc-instances.mjs`: ensure `dev/qc-1..N` exist, push to all in parallel, build `dist-qc/qc-<i>` and write `qc/.instances.json`.
- `--reset` imports an empty snapshot.
- **Lock:** `.qc.lock` in the main checkout (gitignored; holds pid, worktree and start time) is taken for the whole run, from push to teardown. A second run waits; with `--no-wait` it fails fast. A stale lock whose pid is dead is taken over.
- Factor the shared create and auth-key logic out of `dev-instance.sh` rather than copying it.

**3. QC seed** (∥ 2).
- `convex/platform/qcSeed.ts`: `fixture({ runId, worker, password })` returns two users, two tenants and their contact ids.
- `convex/platform/qcSeed.test.ts` (convex-test) checks two tenants, memberships only to their own tenant, contacts scoped and revisions written.

**4. Fixtures + timing harness.**
- `qc/fixtures.ts`: instance, port, seeded world, `storageState` per user.
- `qc/global-setup.ts`: preview servers and warm-up.
- `qc/timing.ts`: `flow()`, rAF measurement, the RTT probe, repeats and the pass rule. When median RTT is over 150 ms, it skips the latency asserts and the reporter prints a banner. `QC_MODE=record` measures without asserting.
- Fixed viewport 1280×800, headless.
- `qc/budgets.ts` and `qc/reporter.ts`.
- `qc/harness.spec.ts` self-test: a 1 ms budget must fail and a generous one must pass.

**5. Server-time collector** (∥ 4).
- `qc/server-timings.ts`: spawn `convex logs` per instance in global setup, aggregate in teardown.
- Assert query p95 ≤ 50 ms and mutation p95 ≤ 100 ms.

**6–8. Flow specs** (in parallel). Every test carries `route` annotations and timed steps.
- **6. Auth and groups:**
  - sign up, sign in, wrong password, sign out
  - groups list; create group (ok / taken / invalid)
  - group link to contacts
  - unauthenticated `/t/x`, unknown slug
  - **the isolation spec**
- **7. Contacts list and new:**
  - list, search, show archived
  - create an individual and an organisation
  - invalid input shows inline problems
  - a double-click on Create lands on one contact (clientKey dedupe)
- **8. Contact page:**
  - details and Save; autosave fires on its own (untimed)
  - emails, phones, addresses: add, remove, primary, label
  - a malformed email saves and shows "to check" (ADR 0015)
  - "N to fix"
  - archive and its list badge
  - history and Restore to here
  - "No such contact"
  - **two tabs on one contact:** a remote edit lands under in-progress typing, an edit to the same field in both shows a conflict badge, and the stale notice appears

**9. Coverage gate + `qc/README.md`.** The README covers adding a flow, budgets, and **the rule that raising a budget needs the human's OK**. It also covers the builder obligation to run `pnpm qc` for `src/` and `convex/` changes. The controller should add that obligation to `factory/roles/builder.md`; the planner doesn't edit role files.

**9b. Record and set budgets** (after 6–8): 3 full `QC_MODE=record` runs, at different times where possible. Write `qc/budgets.ts` at 1.5× the worst p95 per flow, and put the table on the page or in the report. This initial set is approved by this plan; later raises are not.

**10. Trend report:** `scripts/qc-report.mjs` renders `history.jsonl` to `qc-report/trend.html`.

**11. CI (later, nightly + manual):** `.github/workflows/qc.yml` with its own `dev/qc-ci-<i>` pool, a Convex token secret, and the report uploaded as an artifact.
</sv-prose>

<sv-prose id="b7">
## Tests that prove it

- **`harness.spec.ts`:** an impossible budget fails and a generous one passes, so the timing path is live.
- **`qcSeed.test.ts` (convex-test):** two tenants, memberships stay in their own tenant, contacts written through contracts.
- **The isolation spec** (two tenants per worker), run on every worker.
- **The coverage gate:** every route has an annotated flow.
- **Acceptance:** a full `pnpm qc` on the pool passes twice in a row with no budget flake.

## Domain rules check

- **6 (structural tenancy):** applies. The seed uses the scoped writer and contracts, there are two tenants per worker, and the isolation spec is mandatory.
- **3 (anonymise, don't delete):** applies to teardown. The suite archives through the UI and never deletes rows. A reset replaces the whole deployment's data.
- **1, 2, 4, 5, 7:** no UI yet. When giving, consent and Gift Aid flows land, their specs check derived state, such as eligibility from the declaration chain or current consent from the log. Amounts entered in pounds must round-trip to exact pence.

**ADR to propose:** "QC runs the built SPA against a pool of live dev instances, with RTT-adjusted budgets". I'd record it after step 0, once the mechanics are confirmed.
</sv-prose>

<sv-prose id="b8">
## Grill
</sv-prose>

<sv-ask id="g1q1" round="1">
**Where does the suite run?** CI needs a Convex team token as a GitHub secret. US runners add roughly 100 ms of round-trip time to Convex EU.
- * Local only now; nightly + manual CI later (step 11)
- Local now, and nightly CI from the start
- Local, and on every PR in CI
</sv-ask>

<sv-ask id="g1q2" round="1">
**How many pool instances?** Shards map onto them, about 2 workers each. If your Convex plan caps dev deployments or monthly function calls, put it in the rider.
- * 3
- 2
- 5
</sv-ask>

<sv-ask id="g1q3" round="1">
**Budget numbers.** The table above is educated guesses.
- * Record first: measure a full run without asserting, then set each budget to ~1.5× observed p95
- Adopt the table as hard budgets now
- Adopt the table now, tighten after a record run
</sv-ask>

<sv-ask id="g1q4" round="1">
**How is the network handled in a budget?**
- * Round-trip adjusted: `measured − roundTrips × measured RTT`. The same budgets hold on a laptop and on CI
- Raw milliseconds, with a separate budget table per environment (local / CI)
- Raw milliseconds, one table, and CI simply runs looser
</sv-ask>

<sv-ask id="g1q5" round="1">
**Pass rule per flow.**
- * K=5 repeats; median ≤ budget **and** max ≤ 2× budget
- K=10 repeats; p95 ≤ budget
- Every sample ≤ budget
</sv-ask>

<sv-ask id="g1q6" round="1">
**Convex server execution times** (per function, from the log stream):
- * Assert: query p95 ≤ 50 ms, mutation p95 ≤ 100 ms
- Report and trend only; never fail the run
</sv-ask>

<sv-ask id="g1q7" round="1">
**Where does the timing history live?**
- * `qc-results/history.jsonl`, gitignored, on your machine
- Committed to a `qc-history` branch
- CI artifacts only
</sv-ask>

<sv-ask id="g1q8" round="1">
**TanStack devtools** render in every build, bottom-right, where the contact form's save pane sits. May the builder gate them behind `import.meta.env.DEV`? That's a one-line product change, not test code.
- * Yes, gate them if step 0e shows they ship in the build
- Yes, gate them regardless
- No: leave the app alone, and tests work around them
</sv-ask>

<sv-ask id="g1q9" round="1">
**Should `pnpm check` include QC?** QC needs the network and live instances.
- * No: a separate `pnpm qc`
- Yes, `pnpm check` runs a 1-repeat smoke pass
</sv-ask>

<sv-ask id="g1q10" round="1">
**Test data between runs.**
- * Fresh tenants per run and per worker (`r<run>w<n>-a|b`), no wipe; reset on demand
- Reset every instance (`import --replace-all`) at the start of every run
</sv-ask>

<sv-ask id="g1q11" round="1">
**The seed function** (`platform/qcSeed:fixture`) lives under `convex/`, so it's pushed to every deployment, prod included. It's internal, like `devSeed`, so only the CLI or dashboard can call it.
- * Fine as an internal function, same as devSeed
- Also make it throw unless an env var like `QC_SEED_ENABLED` is set on the deployment
</sv-ask>

<sv-ask id="g1q12" round="1">
**Browsers.**
- * Chromium only
- Chromium + Firefox + WebKit (triples the run)
</sv-ask>

<sv-ask id="g1q13" round="1">
**Retries on functional failures.**
- * None: a flaky UI test is a failure to look at
- 1 retry in CI only
</sv-ask>

<sv-ask id="g1q14" round="1">
**Coverage gate.** Every route in `routeTree.gen.ts` must have a spec annotated with it.
- * Fails the run
- Warns only
- No gate
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: where it runs, budgets, data and guardrails. Each question has my recommendation pre-selected. Send when done.
</sv-ask>

<sv-ask id="g2q1" round="2">
**Concurrent runs.** Builders work in their own worktrees. Two `pnpm qc` runs at once would push *different code* to the same `dev/qc-*` instances and break each other.
- * A lock: `qc-instances` takes a lock file in the main checkout, and a second run waits (or fails fast with `--no-wait`)
- One pool per worktree (`dev/qc-<worktree>-1..3`): more instances, no waiting
- Only the main checkout runs QC; builders don't
</sv-ask>

<sv-ask id="g2q2" round="2">
**Who runs it and when?**
- * Any builder whose change touches `src/` or `convex/` runs `pnpm qc` before reporting DONE, and puts the summary table in its report
- Only the human runs it, before merging
- The controller runs it once per merged batch
</sv-ask>

<sv-ask id="g2q3" round="2">
**Changing a budget later.** A flow goes over budget after a change.
- * The builder fixes the code. Raising a budget needs your explicit OK, given in the task or on the page
- The builder may raise a budget by up to 20% if it says so in its report
- Budgets move freely; the trend page is the check
</sv-ask>

<sv-ask id="g2q4" round="2">
**Record mode.** How many recorded runs set the initial budgets?
- * 3 full runs, possibly at different times of day; the budget is 1.5× the worst p95 across them
- 1 run
</sv-ask>

<sv-ask id="g2q5" round="2">
**Bad network.** On a tethered or congested link the RTT probe could read 200 ms or more, and the round-trip allowance would hide real slowness.
- * When the median RTT is over 150 ms, the run still checks behaviour but skips the latency asserts, and says so loudly
- Fail the run outright when RTT is over 150 ms
- No ceiling; the allowance handles it
</sv-ask>

<sv-ask id="g2q6" round="2">
**Viewport.** Small-charity volunteers will use phones.
- * Desktop (1280×800) only for now; add a phone viewport when the UI gets its designed pass
- Desktop and a phone viewport (390×844) from the start; doubles the functional run, budgets checked on desktop only
</sv-ask>

<sv-ask id="g2q7" round="2">
**ADR.** The suite is a standing decision: live dev instances, RTT-adjusted budgets, and a coverage gate.
- * The step 0 spike drafts ADR 0018 for your review once the mechanics are confirmed
- No ADR; the spike doc and `qc/README.md` are enough
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: how the suite is shared and governed: concurrent runs, who runs it, budget changes, record mode, bad networks, viewport, ADR.
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
**Final confirmation.** The frontier is empty: every branch above is settled, and nothing is left silently assumed. Approve and this page is the plan the controller hands to builders, starting with the step 0 spike. Choose revise, with a note, if anything in the design tree or steps reads wrong.
</sv-ask>
</sv-page>
