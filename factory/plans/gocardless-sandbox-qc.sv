<sv-page label="plan: GoCardless sandbox QC" category="plans">

<sv-prose id="b1">
## Design tree

*Revised 2026-11-01 for your two decisions (a dedicated **keep-qc** app; QC from **GitHub Actions**). **Approved by the human, 2026-11-01** (through the controller): rounds 1 and 2 all as suggested ("happy to approve all with your suggestions"). That includes g1q5 (the GoCardless spec untimed; app routes that call GoCardless held to a separate line, **amended by the human 2026-11-01: 500 ms for any route that calls an external service**, not 3 s; a route measured over it goes back to the human with its numbers, never raised by a builder) and g2q6 (per-target budgets, the Actions set recorded from 3 runs at 1.5× and shown to you as a diff). The (gNqN) marks say which answer settled each branch. **Final: ready for builders.***

- **Three environments, three jobs.**
  - **keep-qc** (new Fly app, London): for QC alone. It is wiped and reseeded on every deploy, as staging is today, and runs GoCardless against a **dedicated QC sandbox account**. Nobody uses it by hand.
  - **keep-staging** becomes **yours**. Its data is kept across deploys (`KEEP_RESET_SEED` no longer resets it on deploy), it is backed up like prod, and `scripts/fly/staging-reset.sh` resets it when you ask. Your sandbox account and partner app stay as they are. Its QC surface is switched off *(g2q3)*.
  - **keep-prod**: unchanged.
  - Both keep-qc and staging deploy on every push to main.
- **QC runs on GitHub Actions** (`.github/workflows/qc.yml`) against keep-qc, after each keep-qc deploy, nightly at 03:00, and on demand. It **never runs on `pull_request` or `pull_request_target`**. Its secrets sit in a GitHub **environment `qc`** that only `main` may use.
  - Deploy and QC share one concurrency group, so a deploy never lands on keep-qc in the middle of a run.
  - A failure opens or comments on the `qc-nightly` issue, as the house nightly does today.
  - **The house nightly retires** once Actions has had 7 green nights *(g2q5)*.
- **Budgets for the Actions target are recorded, not guessed** *(g2q6)*: 3 record-mode runs on Actions, and each flow's line is 1.5× its worst sample, for your OK. The local pool keeps its own budgets.
- **The LINK and netem banners are for the house network**: on Actions the first-hop watch is off, and the report says so *(g2q10)*.
- **No secret in an artifact.** Traces and request attachments are public on a public repo, so the QC token never goes through a traced browser context, and a check step refuses to upload any artifact that contains the token.
- **GoCardless in QC:**
  - **The server holds every GoCardless credential; the runner holds only `KEEP_QC_TOKEN`.** A token-gated surface, `/api/qc/gocardless/*`, acts for the test with the qc- org's own token. It is refused unless `KEEP_ENV=staging`, `KEEP_QC_TOKEN` is set and `KEEP_GOCARDLESS=sandbox` (or `fake` locally), and it reaches only `qc-` orgs and only resources that org made.
  - **Connecting** *(g1q1)*: the QC sandbox account gets **its own partner app** *(g2q1)*, whose redirect and webhook point at keep-qc. You connect the account to it **once, through OAuth**, and the script stores the account's permanent token and organisation id on keep-qc as Fly secrets. Each run, `POST /api/qc/gocardless/connect` connects the run's qc- org with that token through the same code as the OAuth callback. From there on it is production's path: partner webhook, partner secret, routing by `links.organisation`, and the catch-up through `GET /events`.
    - Reconnecting a merchant disables its earlier token, so the QC account is never connected anywhere by hand.
    - One GoCardless account maps to one org. `connect` moves it from an older qc- org, and refuses (409) if a non-qc org holds it.
  - **The donor's side goes through the API** *(g1q2)*: the billing request's actions (customer details, bank account 200000 / 55779911, confirm, fulfil). The sandbox allows this.
  - **GoCardless's moves are driven by scenario simulators** (allowlisted). Specs read the app's own data, plus a trimmed GoCardless view (`peek`) where an assertion needs GoCardless's side.
  - **Waiting:** poll the app's reads, backing off up to 90 s, then run the catch-up for that org and poll again *(g1q3)*. Never a sleep.
  - **The GoCardless spec is untimed** *(g1q5)*. **Isolation:** it runs serially in one worker. **Cleanup** *(g1q7)*: it deletes its run's customers at the end.
  - **The two open questions become assertions:** the first charge date matches what the app shows, and a cancel leaves no payment to collect *(g1q10)*.
</sv-prose>

<sv-prose id="b2">
## Goal

QC proves on every push and every night that the hosted app works, Direct Debit included, against the real GoCardless sandbox, with nobody clicking. It runs on keep-qc, an app that exists only for that, from GitHub Actions. You found the webhook 403 testing by hand on 2026-10-31 (fixed in 0d65a2a); it is the kind of bug this run must catch. Staging becomes a place you can keep data in.

**Out of scope:** live mode; QC against prod; GoCardless's hosted pages (unless g1q2 says otherwise); payouts; the import of existing GoCardless accounts (D4) until it is built; a QC gate on prod deploys (g2q9 asks).
</sv-prose>

<sv-prose id="b3">
## Facts this rests on

GoCardless facts are from their docs, with a URL per fact in `factory/out/planner-gsq-gc-docs.md` (research 2026-11-01).

| Fact | Source |
|---|---|
| No OAuth auto-approve: a human must log in and agree. The code is good for 5 min. The token is **permanent**, and reconnecting issues a new one and **disables the old one**. The exchange returns `organisation_id`. | https://docs.gocardless.com/docs/api-reference/oauth-reference |
| OAuth tokens may not create customers, customer bank accounts or mandates directly unless the app's pages are approved; **billing requests are not restricted**. | same |
| `links.organisation` is on events only when they go to an OAuth app's webhook. A merchant's own endpoint gets events without it, so a dashboard token would need test-only webhook routing. | https://docs.gocardless.com/docs/api-reference/event |
| Headless billing request: create (`mandate_request`, bacs) → `collect_customer_details` → `collect_bank_account` → `confirm_payer_details` → `fulfil`. `confirm_payer_details` needs the custom payment pages add-on, which **is enabled in sandbox**. Payer name verification is on for UK, so a mismatched name gets a 422. | https://docs.gocardless.com/docs/api-reference/billing-request, https://docs.gocardless.com/integration-types/custom-payment-pages |
| Sandbox Bacs test account: sort code 200000, account 55779911. | https://docs.gocardless.com/docs/developer-resources/test-bank-details |
| Scenario simulators: `POST /scenario_simulators/{id}/actions/run` with `links.resource`. Payment simulators need the payment `pending_submission` and its mandate `activated`. There is no subscription simulator. | https://docs.gocardless.com/docs/api-reference/scenario-simulator, https://docs.gocardless.com/docs/developer-resources/scenario-simulators |
| A subscription without `start_date` first charges on the mandate's `next_possible_charge_date`. `upcoming_payments` lists up to 10. Bacs needs 3 business days' notice. | https://docs.gocardless.com/docs/api-reference/subscription |
| **Cancelling a subscription does not cancel the payments it already created**: they "will still be collected unless you also manually cancel them". | same |
| Webhooks: `Webhook-Signature` is the HMAC-SHA256 hex of the body. `Origin: https://api-sandbox.gocardless.com`. 10 s timeout, up to 9 retries, 498 for a bad signature. `GET /events` is the recommended reconciliation. | https://docs.gocardless.com/docs/api-reference/webhooks |
| The sandbox can't be reset. `DELETE /customers/{id}` removes a customer, irreversibly. 1,600 requests/min. | https://docs.gocardless.com/docs/api-reference/customer, https://docs.gocardless.com/docs/api-reference/limits |
| `Idempotency-Key`: up to 128 chars, kept ≥ 30 days. | https://docs.gocardless.com/docs/api-reference/limits |

**Not confirmed by the docs** (the first keep-qc run checks them): when a subscription's first payment is created; whether a `.invalid` email passes `collect_customer_details`; whether cancelling a mandate cancels its pending payments (I believe it does; the cancel flow asserts it); whether one partner app can have more than one webhook endpoint (g2q1 avoids depending on it).

**In our code and setup today:**
- **GoCardless:** cancelling a regular gift cancels its **mandate**. A gift sharing a mandate with an adopted one, and an adopted gift with no mandate of its own, cancel **only the subscription** (`server/crates/api/src/routes/gocardless.rs` ~l.473), so by the fact above an already-created payment still collects. The first subscription is created with `day_of_month` and no `start_date` (`gocardless/process.rs` ~l.600).
- **Deploys:** `deploy.yml` deploys staging on every push, with a repo-wide `FLY_API_TOKEN` (staging's), and prod by hand from the `prod` environment. `/healthz` doesn't say which commit is running.
- **Reset:** `scripts/ops/entrypoint.sh` wipes `/data` when `FLY_IMAGE_REF` differs from `/data/.image` and `KEEP_RESET_SEED` is set, and replicates to a fresh Litestream prefix per image (`staging/<generation>`). Without a bucket it runs the api with no Litestream.
- **QC:** the house nightly (`scripts/qc-nightly/run.sh`) works out which commit staging runs from the Deploy workflow's runs, takes `.qc.lock`, runs `pnpm qc --target staging`, writes `runs.log` and `history.jsonl`, and opens or comments on the `qc-nightly` issue. The cutover gate counts its streak of green nights.
- **Timing:** `qc/rtt.json` is 13 ms (the house to staging). `RTT_CEILING_MS` is 150. The LINK banner watches the house's first hop. Netem is for the local pool only. On a failure, a failed test or an over-budget flow attaches requests and a trace.
</sv-prose>

<sv-prose id="b4">
## Contracts and tables

**No domain contract, table or schema change.** `gocardless_connections` gets its row through the existing connect path, factored out of `oauth::callback`. The token goes into the existing org secret (`gocardless.accessToken`). The g1q10 fix changes only which GoCardless calls the cancel route makes.

**Domain rules** (CLAUDE.md):
- **3, anonymise, don't delete**: deleting customers touches only GoCardless's sandbox. Our gifts are never deleted, and qc- orgs go with keep-qc's next reset. Staging's on-demand reset wipes a whole environment, not a contact.
- **6, tenancy is the file**: the QC routes take a slug, reach only `qc-` orgs, and act only on resources that org's rows name.
- **7, money is pence**: amounts cross the QC surface as integer pence.
- **No optimistic financial UI**: every gift assertion waits for the server-confirmed status.
- Rules 1, 2, 4 and 5 aren't touched.
</sv-prose>

<sv-prose id="b5">
## Steps

| # | Who | What | Files | Order |
|---|---|---|---|---|
| **A1** | builder | **keep-qc exists in the repo:** `fly.qc.toml`, the setup script `scripts/fly/qc.sh` (spec below), and `gocardless-secrets.sh` taking `qc`. `deploy.yml` gains a `deploy-qc` job in environment `qc`, which **skips (doesn't fail) while the `qc` environment's `QC_URL` is unset**, so pushes before H1 stay green. `/healthz` gains `commit` (build arg `KEEP_RELEASE=$GITHUB_SHA`). docs/ops.md gets a "keep-qc" section. | `fly.qc.toml`, `scripts/fly/qc.sh`, `scripts/fly/gocardless-secrets.sh`, `.github/workflows/deploy.yml`, `server/Dockerfile`, `server/crates/api/src/health.rs`, `docs/ops.md` | now |
| **S1a** | builder | **Reset on demand, the mechanism:** `KEEP_RESET_ON=deploy\|demand` and `KEEP_RESET_GENERATION` in the entrypoint (spec below), and `scripts/fly/staging-reset.sh`. **Staging's config is not changed**: the default `deploy` keeps today's behaviour, so the house nightly keeps working. | `scripts/ops/entrypoint.sh`, `server/crates/api/src/reset.rs`, `scripts/fly/staging-reset.sh`, a shell test | now |
| **G4** | builder | **The g1q10 fix:** cancelling only a subscription also cancels its `pending_submission` payments. The fake learns GoCardless's real subscription-cancel behaviour. | `routes/gocardless.rs`, `gocardless/fake.rs`, `tests/gocardless.rs` | now |
| **G1** | builder | **Token script** `scripts/fly/gocardless-qc-token.sh` (spec below). Small: it can share a builder with A1. | `scripts/fly/gocardless-qc-token.sh`, `docs/ops.md` | now, or with A1 |
| **G2** | builder | **The QC GoCardless surface** (spec below), on the fake and the sandbox. Cargo tests on the fake. | `routes/qc_gocardless.rs` (new), `gocardless/oauth.rs`, `lib.rs`, `main.rs`, `routes/qc_seed.rs`, `tests/gocardless.rs` | after G4 merges (same files) |
| **H1** | **You** | After A1 merges, in this order: (1) create the **QC sandbox account** (a second email, e.g. a `+qc` alias) and, in it, a **partner app** with redirect `https://keep-qc.fly.dev/api/gocardless/callback` and webhook `https://keep-qc.fly.dev/api/gocardless/webhook`; (2) `scripts/fly/qc.sh`, which ends by running `gocardless-secrets.sh qc`, since `KEEP_GOCARDLESS=sandbox` won't boot without the partner secrets; (3) `fly deploy -c fly.qc.toml --ha=false`; (4) `gh variable set QC_URL --env qc …` (qc.sh prints it), which switches on `deploy-qc`. | your terminal, GoCardless | after A1 |
| **A2** | builder | **QC on Actions:** `.github/workflows/qc.yml` (spec below). A `qc` target in `qc/target.ts` (`QC_TARGET_URL`). Per-target budgets in `qc/budgets.ts` (Actions empty until A3), the LINK watch off on Actions, the artifact token check, history as an artifact chain, and the issue step. qc/README and docs/ops.md "Nightly QC" are rewritten. | `.github/workflows/qc.yml`, `.github/workflows/deploy.yml` (the call), `qc/`, `scripts/qc-actions/`, `docs/ops.md` | after A1 merges |
| **A3** | controller, then **you** | **Record budgets:** dispatch `qc.yml` with `mode=record` 3 times. A builder turns the 3 histories into 1.5× the worst sample per flow, as a `qc/budgets.ts` diff for your OK. | `qc/budgets.ts` | after A2, H1 |
| **H2** | **You** | After G1 and H1: `scripts/fly/gocardless-qc-token.sh`. Log in **as the QC account**, approve, paste the code, and type keep-qc's partner client id and secret. Then deploy keep-qc. | your terminal | after G1, H1 |
| **G3** | builder | **The GoCardless spec** `qc/flows/gocardless-sandbox.spec.ts` plus helpers (spec below), green on the fake locally. Untimed. | `qc/flows/`, `qc/fixtures.ts`, `qc/budgets.ts`, `qc/reporter.ts` | after G2 merges; best after A2 (both touch `qc/budgets.ts`, `qc/reporter.ts`) |
| **G5** | controller | First green run of G3 on keep-qc from Actions. Record the unconfirmed GoCardless facts and both open questions' answers in `factory/plans/gocardless.sv`. | `factory/plans/gocardless.sv` | after G3, H2, A3 |
| **S1b** | builder | **Staging becomes yours:** `fly.staging.toml` gets `KEEP_RESET_ON=demand`; the first `KEEP_RESET_GENERATION` is set **only as a Fly secret** by `staging-reset.sh`, never in the toml's `[env]` (review S1a M3), its QC token is removed (`fly secrets unset --stage`, a human step the builder writes down), and docs/ops.md "Staging" is rewritten. | `fly.staging.toml`, `docs/ops.md` | after A3 is green, so there is always one working nightly |
| **R1** | controller | After 7 green Actions nights: you uninstall the house timer, and `scripts/qc-nightly/` is removed. | `scripts/qc-nightly/` | last; after S1b the house nightly can't reach staging anyway, so do S1b and R1 together |

### Order

- **Now, in parallel (separate worktrees):** A1 (+G1), S1a, G4. They touch disjoint files except `docs/ops.md`, where different sections make the merge trivial.
- **After A1:** A2 and H1, in parallel.
- **After G4:** G2. It shares `tests/gocardless.rs`, `routes/gocardless.rs`'s neighbourhood and the fake with G4, so running them side by side means a painful merge. G2 doesn't need A1 or A2: it is server code tested on the fake, so it can run alongside A2.
- **After G2 (and preferably A2):** G3.
- **After A2 + H1:** A3. **After G1 + H1:** H2. **After G3 + H2 + A3:** G5.
- **Last:** S1b with R1, once Actions QC is green, so the house nightly against staging never stops before its replacement works.

**Against your sequence:** G4 and A1+S1 now is right, except S1 should be split. The mechanism (S1a) can go now, but flipping staging off reset and removing its QC token (S1b) would break tonight's house nightly, so that waits until Actions QC is green. G1 and G2 don't depend on A2: G1 can ride with A1, and G2 can start as soon as G4 merges. Only G3 is better after A2.

### A1: `scripts/fly/qc.sh` (you run it once; re-runs are safe)

In the style of `staging.sh`: `say`/`run`/`die`, every secret on stdin through `import_secrets`, every step checks first.

1. The app `keep-qc` in `lhr`, and a 3 GB volume `keep_data`. It checks for one machine and one volume.
2. Secrets it generates, never printed: `KEEP_SETTINGS_KEY` and `KEEP_AUTH_PEPPER`, the riverside sign-ins (`KEEP_RIVERSIDE_*`; nobody signs in there; `fly ssh console` if ever needed), and `KEEP_QC_TOKEN`. No Litestream or snapshot buckets: keep-qc is thrown away on every deploy, and the entrypoint already runs without them. `SENTRY_DSN` is optional (asked, blank skips).
3. The GitHub environment `qc`: `gh api -X PUT repos/{owner}/{repo}/environments/qc` with a deployment branch policy of **main only**. Then `KEEP_QC_TOKEN` goes to `gh secret set KEEP_QC_TOKEN --env qc` (stdin), and a deploy token to `fly tokens create deploy -a keep-qc --expiry 8760h | gh secret set FLY_API_TOKEN --env qc`, piped and never shown. Then `gh variable set QC_URL --env qc --body https://keep-qc.fly.dev`.
4. **No DNS or certificate** *(g2q2)*: `https://keep-qc.fly.dev` is the origin.
5. It prints the next steps: deploy with `--ha=false`, create the QC sandbox account and partner app (H1), then `gocardless-secrets.sh qc`.

`fly.qc.toml` is staging's without Litestream: `KEEP_ENV=staging` (the QC surface needs it, and the boot rules are the same), `KEEP_RESET_SEED=riverside` (reset on every deploy), `KEEP_APP_ORIGIN=https://keep-qc.fly.dev`, `KEEP_MAIL=off` (QC already treats mail as off), `KEEP_ADDRESS_LOOKUP=fake`, `KEEP_GOCARDLESS=sandbox`, always on, shared-cpu-1x / 512 MB, the same as staging so timings are comparable *(g2q11)*.

### S1a/S1b: staging resets only when asked

- `KEEP_RESET_ON=deploy` (the default, keep-qc) keeps today's behaviour. `KEEP_RESET_ON=demand` (staging) resets only when **`KEEP_RESET_GENERATION`** differs from `/data/.generation`. The Litestream prefix is `staging/<generation>`, so a wiped database never meets its predecessor's replica, and a lost volume restores from the generation the config names.
- `scripts/fly/staging-reset.sh`: asks you to type `reset keep-staging`, then runs `fly secrets set -a keep-staging KEEP_RESET_GENERATION=<UTC timestamp>`. That isn't a secret, but it's how to change the env without a deploy. Fly restarts the machine, and the entrypoint wipes, reseeds riverside (same sign-ins) and starts a fresh replica prefix. The script waits for `/healthz` and prints the generation.
- Snapshots stay on (staging gets the snapshot fallback that reset environments skip today). docs/ops.md says staging is now kept, how to reset it, and that the old per-image prefixes can be deleted.
- Staging's `KEEP_QC_TOKEN` is removed (`fly secrets unset --stage`), so `/api/qc/*` is 404 there *(g2q3)*.

### A2: `.github/workflows/qc.yml`

- **Triggers:** `workflow_call` (from `deploy.yml`, after `deploy-qc`), `schedule: '0 3 * * *'`, and `workflow_dispatch` (input `mode`: `assert` or `record`). **No `pull_request` or `pull_request_target`**, and the job also refuses unless `github.ref == 'refs/heads/main'`.
- **Permissions:** `contents: read`, `issues: write`, `actions: read` (to fetch the previous history artifact). Nothing else.
- **Environment `qc`:** this is the only place `KEEP_QC_TOKEN` exists. It goes into the QC step's `env` only, never `run:` text, and GitHub masks it in logs.
- **Concurrency:** group `keep-qc`, shared with `deploy-qc`, with `cancel-in-progress: false`. A deploy waits for a running QC run, and a newer pending run replaces an older pending one.
- **Which commit:** the job reads `commit` from `QC_URL/healthz` and checks that commit out, so the specs always match the app. If `/healthz` reports a different commit at the end, the run is `void`, not failed.
- **Steps:** checkout; pnpm install (cached); Playwright chromium (cached); `pnpm qc --target qc`. Then the artifact check: grep every report, trace and attachment for the token's value, and fail closed. Then upload `qc-results/` and `qc-report/`, and append to the history chain (download the last run's `qc-history` artifact, add this run's lines, upload).
- **Failure:** `fail` or `error` comments on the open `qc-nightly` issue or opens one, with the commit, the failing flows and the run's URL. Voids that keep coming are treated the same way the house nightly treats them. `scripts/qc-actions/status.sh` shows the streak from `gh run list --workflow qc.yml` for the cutover gate.
- **LINK and netem:** no netem (as for any hosted target). The first-hop watch is off; the header says "link: not watched (Actions runner)". The RTT check stays: each run records its RTT to keep-qc, and the ceiling for the Actions target is set from A3's runs.

### G1: `scripts/fly/gocardless-qc-token.sh`

Mints the QC account's token and stages it on keep-qc. **The token is never printed, never in argv, never in a file.**

1. The same preamble as `gocardless-secrets.sh` (fly, jq, curl, a TTY, `fly auth whoami`). It targets only `keep-qc`.
2. It reads keep-qc's partner **client id** and **secret** without echo.
3. It prints the authorize URL (`connect-sandbox.gocardless.com/oauth/authorize`, `scope=read_write`, the redirect `https://keep-qc.fly.dev/api/gocardless/callback`, a random `state`).
4. You log in **as the QC account** and approve. keep-qc's callback doesn't know that `state`, so it lands on "expired" **without exchanging the code** (`oauth.rs` takes the state first). You paste the URL or the code at a hidden prompt. The script checks the `state` and has 5 minutes.
5. `curl … /oauth/access_token --data-urlencode @-`, with the body on **stdin**. On failure it prints only GoCardless's `error` field.
6. `jq` takes `access_token` and `organisation_id`. Only the `OR…` id is printed. `KEEP_QC_GOCARDLESS_TOKEN` and `KEEP_QC_GOCARDLESS_ORGANISATION` are piped to `fly secrets import -a keep-qc --stage`.

### G2: the QC GoCardless surface

Behind `QcAccess` (the token, rate limit and `qc-` rule of `/api/qc/*`), with dev twins under `KEEP_DEV_AUTH=1` + `KEEP_QC_SEED=1` for the fake. Every route is **404 unless GoCardless is `sandbox` or `fake`**, and on the sandbox it also needs both QC secrets. The boot **refuses** `KEEP_QC_GOCARDLESS_*` with `KEEP_ENV=prod` or `KEEP_GOCARDLESS=live`.

| Route | Does |
|---|---|
| `POST /api/qc/gocardless/connect {slug}` | Connects the qc- org with the QC token, moving the account from an older qc- org (409 if a non-qc org holds it). Answers `{organisationId}`, never the token. |
| `POST /api/qc/gocardless/sign {slug, regularGiftId, givenName?, familyName?}` | The billing request's four actions and fulfil, on the gift's own `billing_request_id`. Email `qc+<run>@example.com`, a fixed UK address, 200000/55779911. Answers `{mandateId}`. |
| `POST /api/qc/gocardless/simulate {slug, scenario, resource}` | An allowlisted simulator (`mandate_activated`, `mandate_failed`, `payment_confirmed`, `payment_failed`, `payment_charged_back`, `payment_late_failure`, `payment_paid_out`) on a resource this org's rows name. |
| `GET /api/qc/gocardless/peek/{slug}/{kind}/{id}` | A trimmed GoCardless view of the org's own mandate, subscription or payment (status, charge date, upcoming payments, the subscription's payments). |
| `POST /api/qc/gocardless/catchup {slug}` | `catchup::catch_up` for this org; answers how many events it queued. |
| `POST /api/qc/gocardless/cleanup {slug}` | Deletes, at GoCardless, the customers this org made, and sweeps QC-tagged customers older than 2 days. |

Each call carries an `Idempotency-Key` and gets one retry on a 5xx or a timeout.

### G3: the GoCardless spec

Serial and in one worker. `beforeAll` seeds and connects; `afterAll` cancels anything live through the app, then runs `cleanup`. Every flow starts from the app's own "Set up Direct Debit".

| Flow | Asserts |
|---|---|
| **Set up → active** | `sign` → mandate `pending_submission`. Simulate `mandate_activated` → the app shows `active` and a subscription. A processed `gocardless_events` row proves the signed webhook got through CSRF with its `Origin`. |
| **First charge date** (open q1) | Gifts for the 1st, the 28th, and today + 2 days. GoCardless's first `charge_date` equals the app's next payment date; a difference fails with both dates. |
| **Payment → confirmed → gift** | The first payment shows as a **pending** gift that doesn't count as received. `payment_confirmed` → `completed` with the right pence and date. |
| **Failed** / **Charged back** | `payment_failed` → gift `failed`, no income. Confirm, then `payment_charged_back` → `charged_back`, out of income. |
| **Cancel** (open q2) | Staff cancel → mandate, subscription and **every payment** `cancelled` (peek); the gift has ended. The subscription-only path (shared mandate) is pinned, and after G4 it ends with no payment to collect. |
| **Webhook signature** | A bad and a missing signature → **498**. |
| **Catch-up** | At the end, `catchup` reports 0 missed. A non-zero count gets a warning banner (g1q3). |

**Waiting:** polls at 0.5 s, 1, 2, 5, … up to 90 s, then `catchup` once and 30 s more (`GOCARDLESS LATE WEBHOOK` banner). **Sandbox down:** network errors or 5xx after the retry skip the rest with a `GOCARDLESS SANDBOX UNREACHABLE` banner (g1q4).
</sv-prose>

<sv-prose id="b6">
## Tests

- **Cargo (G2):** `qc_gocardless_routes_404_without_the_qc_token`, `…_outside_staging_or_dev`, `…_when_gocardless_is_off_or_live`; `boot_refuses_qc_gocardless_secrets_with_prod` / `…_with_live`; `qc_connect_moves_the_account_from_an_older_qc_org`; `qc_connect_refuses_when_a_real_org_holds_the_account`; `qc_connect_never_answers_the_token`. **Two-tenant isolation:** `qc_gocardless_routes_refuse_non_qc_slugs`, `qc_simulate_and_peek_refuse_another_orgs_resource` (A's mandate under qc- B's slug → 404), `qc_cleanup_deletes_only_its_own_customers`. Also `qc_sign_on_the_fake_activates_like_the_hosted_page` and `simulate_allowlist`.
- **Cargo (G4):** `cancelling_a_shared_mandates_gift_cancels_its_subscriptions_pending_payments`.
- **Cargo (S1, A1):** `healthz_reports_the_commit`. The entrypoint is checked by a shell test over a temp `/data`: same generation → kept, new generation → wiped, `KEEP_RESET_ON=deploy` → today's behaviour.
- **QC:** G3's flows green on the fake locally, then on keep-qc. Every existing flow runs green on keep-qc from Actions (A3 records first).
- **Workflow (A2):** a vitest over `qc.yml` (parsed YAML): no `pull_request*` trigger; the token only in `env` of the QC step under environment `qc`; `permissions` exactly as listed; the artifact check comes before every upload. The shell scripts get shellcheck.
</sv-prose>

<sv-ask id="g1q1" round="1">
**How QC's org connects to GoCardless.** OAuth needs a human click, so the click happens **once**: a dedicated QC sandbox account's permanent token is kept as a Fly secret, and each run connects its qc- org with it, so webhooks and catch-up go production's way. A dashboard access token needs no OAuth, but its webhooks come without `links.organisation`, so the server would need test-only routing.
- * OAuth once, on a dedicated QC sandbox account
- Dashboard access token, with test-only webhook routing
</sv-ask>

<sv-ask id="g1q2" round="1">
**The donor's side.** Through the API, the server runs the billing request's actions (headless, quick, stable; sandbox allows it). Through Playwright, a browser fills GoCardless's hosted page: closer to what a donor does, but slower, at the mercy of their page changes and bot checks, and that page is theirs to test, not ours.
- * API only
- API every run, plus the hosted page once a week
- Hosted page through Playwright
</sv-ask>

<sv-ask id="g1q3" round="1">
**A webhook that hasn't arrived after 90 s** (but the catch-up then finds it).
- * Pass, with a `GOCARDLESS LATE WEBHOOK` banner line
- Fail the test: webhooks must arrive on their own
</sv-ask>

<sv-ask id="g1q4" round="1">
**The sandbox unreachable** (network errors or 5xx after a retry).
- * The GoCardless spec skips with a `SANDBOX UNREACHABLE` banner; the rest of the run is judged as usual
- The run fails
- The whole run is `void`
</sv-ask>

<sv-ask id="g1q5" round="1">
**Timing of GoCardless calls.** The GoCardless spec is **untimed**. But the app's own routes that call GoCardless synchronously (set up, cancel) would break the 100 ms server-call line. Proposal: they are tagged `remote`, held to a 3 s line, and listed under KNOWN OVER. **Amended by the human, 2026-11-01: the `remote` line is 500 ms, for any route that calls an external service (GoCardless, address lookup, mail).**
- * Untimed spec; remote routes held to 3 s
- Untimed spec; remote routes not judged at all
- A different line (say it in the rider)
</sv-ask>

<sv-ask id="g1q7" round="1">
**Sandbox clean-up.** The sandbox can't be reset.
- * Each run deletes its own customers; a sweep also removes QC customers older than 2 days
- Leave them: it's a sandbox
</sv-ask>

<sv-ask id="g1q8" round="1">
**The same GoCardless spec on the fake.** The QC surface works on the fake too, so the spec runs locally and in CI, and reaches keep-qc already proven.
- * Yes, on both
- keep-qc only
</sv-ask>

<sv-ask id="g1q9" round="1" pick="many">
**GoCardless flows to cover.**
- * Set up → active (signed webhook through CSRF)
- * First charge date matches the app (open q1)
- * Payment → confirmed → gift
- * Failed
- * Charged back
- * Cancel leaves no payment to collect (open q2)
- * Bad webhook signature → 498
- * Catch-up finds nothing missed
- Late failure (`payment_late_failure`)
- Paid out (`payment_paid_out`: the gift stays completed)
</sv-ask>

<sv-ask id="g1q10" round="1">
**Open q2 looks like a bug.** GoCardless says cancelling a subscription leaves its already-created payments to be collected. Our cancel usually cancels the mandate, which is fine. But a gift sharing a mandate (adopted) cancels only the subscription, so a payment could still be taken after staff "cancelled".
- * Fix it (G4): also cancel that subscription's pending payments; the spec proves both paths
- Only pin today's behaviour; decide later
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: GoCardless in QC. Connecting, the donor's side, late webhooks and outages, timing, clean-up, the fake, coverage, and the cancel bug. (Former q6, staging's reset, is settled by your keep-qc decision.)
</sv-ask>

<sv-ask id="g2q1" round="2">
**keep-qc's GoCardless partner app.** Staging's sandbox partner app sends its webhooks to staging. keep-qc needs its own webhooks, and the docs don't say whether one app can have two endpoints.
- * A second partner app, made inside the QC sandbox account, pointing at keep-qc (fully separate from your staging setup)
- Reuse staging's partner app (only if it can take a second webhook endpoint; QC's events would also hit staging)
</sv-ask>

<sv-ask id="g2q2" round="2">
**keep-qc's address.**
- * `https://keep-qc.fly.dev`: no DNS, no certificate step
- `qc.keep-together.org.uk` (a Route 53 record, as staging has)
</sv-ask>

<sv-ask id="g2q3" round="2">
**Staging's QC surface** (`/api/qc/*`, `KEEP_QC_TOKEN`).
- * Remove it: QC never touches your staging data
- Keep it, for running QC against staging by hand now and then
</sv-ask>

<sv-ask id="g2q4" round="2">
**Staging's on-demand reset.** What should `staging-reset.sh` reset to?
- * A fresh riverside seed, same sign-ins (as a deploy does today)
- A choice: riverside, or `perf` (the big world)
</sv-ask>

<sv-ask id="g2q5" round="2">
**The house nightly** (`~/.local/share/keep-qc-nightly`).
- * Retire it after 7 green Actions nights; remove `scripts/qc-nightly/`
- Keep it as a backup, pointed at keep-qc at another hour (the two must not overlap: the QC token and the GoCardless account are shared)
- Keep it on staging (needs g2q3's "keep it")
</sv-ask>

<sv-ask id="g2q6" round="2">
**Budgets for the Actions target.** You prefer numbers measured against the deployed app: 3 record-mode runs on Actions, then 1.5× the worst sample per flow, as a diff you approve. The local pool keeps its current budgets.
- * Yes: separate per-target budgets, Actions ones recorded this way
- One set of budgets: replace the current ones with the Actions numbers
</sv-ask>

<sv-ask id="g2q7" round="2">
**Where the runner is.** GitHub's hosted runners usually sit in US Azure regions (not guaranteed), so their round trip to London is probably ~70–90 ms, against your 13 ms. Recorded budgets absorb it, but they then time a transatlantic user.
- * keep-qc stays in London; the runner's RTT is measured and recorded each run, and the ceiling is set from A3
- Put keep-qc in `iad`, next to the runners, to time the app rather than the Atlantic
- A self-hosted runner on the house machine (UK latency, but a self-hosted runner on a public repo needs care)
</sv-ask>

<sv-ask id="g2q8" round="2">
**Where QC history lives** (drift flags, trend, the green-night streak).
- * An artifact chain: each run downloads the last history, appends, uploads (kept 90 days)
- Committed to a `qc-history` branch (needs `contents: write` on the QC job)
</sv-ask>

<sv-ask id="g2q9" round="2">
**A red QC and prod.**
- * Not a gate yet: a failure opens or comments on the `qc-nightly` issue, and that's all
- Prod's manual deploy refuses while the last keep-qc QC on that commit is red
</sv-ask>

<sv-ask id="g2q10" round="2">
**LINK and netem on Actions.**
- * Both off: the header says the link isn't watched; only the RTT is recorded
- Keep the first-hop watch (it watches the Azure network, not yours)
</sv-ask>

<sv-ask id="g2q11" round="2">
**keep-qc's machine.**
- * Always on, the same size as staging (comparable timings), no backups, 3 GB volume
- Auto-stop between runs (cheaper; the first request and GoCardless's webhooks wake it, with a cold start that would land in timings)
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: keep-qc and QC on Actions. GoCardless app, address, staging's QC surface and reset, the house nightly, budgets, runner location, history, a prod gate, LINK/netem, the machine.
</sv-ask>

</sv-page>
