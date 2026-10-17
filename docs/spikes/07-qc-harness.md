# Spike 7: the QC harness, step 0 of the QC plan

Date: 2026-10-17 · Status: **done**. Every unknown in step 0 has an
answer. Two findings change the plan (server-timing scope and the
sandbox), see "Changes to the plan" at the end.

The plan is `factory/plans/qc-suite.sv`. Everything here ran against two
new cloud dev deployments in the EU:

| Pool name | Deployment | URL |
|---|---|---|
| `dev/qc-1` | `expert-oriole-119` | `https://expert-oriole-119.eu-west-1.convex.cloud` |
| `dev/qc-2` | `vibrant-ermine-992` | `https://vibrant-ermine-992.eu-west-1.convex.cloud` |

Both have Convex Auth keys and `SITE_URL` set the way
`scripts/dev-instance.sh` sets them, and each has a deploy key named
`qc-<i>-push`. Throwaway scripts lived in `$TMPDIR`. The repo gained
only this file and ADR 0018.

Creating a deployment took **2.7 s and 1.6 s** (both in parallel), so
"creation is slow" isn't a reason for the pool. Reuse still makes sense
because there's no CLI delete.

```sh
npx convex deployment create mr-raznick:keep-together:dev/qc-1 --type dev --region eu
# ✔ Created new dev deployment: mr-raznick:keep-together:dev/qc-1 … https://expert-oriole-119.eu-west-1.convex.cloud
# qc-1 create took 2726ms
```

From a checkout with no `.env.local`, the plain `dev/qc-1` reference
fails ("Cannot create a deployment in anonymous mode … configure a
project first"). The full `team:project:ref` form works without any
project configured.

## a. Do `convex logs --jsonl --success` events carry timing and function name?

**Yes.** Each event is one JSON object per line on stdout. The banner
("Showing logs of deployment …") goes to stderr, so stdout is clean
JSONL. One event from qc-1:

```json
{"kind":"Completion","udfType":"Mutation","identifier":"platform/qcSpike:tenant",
 "executionTime":0.004907195,"userExecutionTime":0.00323491,"cachedResult":false,
 "caller":"Action","parentExecutionId":"9cece22b-…","requestId":"6c60f264d333da1e",
 "usageStats":{"databaseReadDocuments":0,"databaseWriteDocuments":2,…},
 "identityType":"instance_admin","environment":"isolate", …}
```

- `identifier` is `module:function` (`contacts/queries:list`), or
  `GET /path` for HTTP actions.
- `udfType` is `Query` / `Mutation` / `Action` / `HttpAction`.
- `executionTime` is in **seconds**.
- `caller` separates the SPA's WebSocket traffic from `HttpApi`
  (CLI, HTTP probes) and `Action` (calls nested in an action).
- `cachedResult: true` marks a query served from Convex's cache, at
  about 0.0 ms.

The stream runs over plain HTTPS. It worked inside the Claude sandbox
with `*.convex.cloud` allowed, and it takes a deploy key
(`CONVEX_DEPLOY_KEY=… npx convex logs --success --jsonl`). One page run
(sign-in ×7, five flows ×6) produced 154 events, all `Completion`.
Aggregated per function:

```
   n   p50ms   p95ms   maxms  function
  22    21.7   171.8   174.8  Action   auth:signIn
  28    10.2   150.0   150.1  Mutation auth:store
   6    12.8    16.4    16.4  Mutation contacts/mutations:create
   6    15.6    19.0    19.0  Mutation contacts/mutations:saveForm
  12    12.2    17.3    17.3  Query    contacts/queries:get
  11    10.7    16.4    16.4  Query    contacts/queries:history
   8    11.7    13.8    13.8  Query    contacts/queries:list
  14     0.0     0.1     0.1  Query    contacts/queries:list (cached)
   6     8.2    11.5    11.5  Query    platform/tenants:mine
  11     0.0     0.0     0.0  Query    platform/tenants:mine (cached)
   …
```

Two things the collector in step 5 has to handle, or the asserts are
wrong from day one:

- **`auth:store` hits 150 ms p95.** Convex Auth hashes the password
  inside that mutation. With the planned "mutation p95 ≤ 100 ms" over
  all functions, every run fails on sign-in. Scope the asserts to our
  own modules (exclude `auth:*`), or give `auth:*` its own line.
- **Cached queries report ~0 ms.** Left in, they pull the query p95
  down and hide slow queries. Count only `cachedResult: false`, and
  report the cache hit rate separately if it's interesting.

Our own functions run at 8–19 ms p95, well under the 50/100 ms
asserts.

## b. A parallel-safe push to several deployments that leaves `.env.local` alone

**Use deploy keys with `convex deploy`:**

```sh
npx convex deployment token create qc-1-push --deployment mr-raznick:keep-together:dev/qc-1 --save-env .env.qc-1.local
CONVEX_DEPLOY_KEY=<key from .env.qc-1.local> npx convex deploy --codegen disable -y
```

Evidence: a sentinel `.env.local` in the worktree
(`CONVEX_DEPLOYMENT=dev:qc-sentinel-000`), then both pushes started at
once:

```
✔ Deployed Convex functions to https://expert-oriole-119.eu-west-1.convex.cloud
rc=0 qc-1 push took 13898ms      ← first push: schema, 32 indexes
✔ Deployed Convex functions to https://vibrant-ermine-992.eu-west-1.convex.cloud
rc=0 qc-2 push took 10908ms
wall 13902ms
sentinel unchanged: yes
_generated dirty files before/after: 0/0
```

A repeat push with no changes (typecheck on) took **4.2 s wall for
both**. The deploy key won over the `CONVEX_DEPLOYMENT` in `.env.local`.

The other candidates:

- **`convex dev --once` rewrites `.env.local` even with a deploy key.**
  The same sentinel test came back as
  `CONVEX_DEPLOYMENT=dev:vibrant-ermine-992 # team: mr-raznick, project: keep-together`
  plus a new `VITE_CONVEX_SITE_URL` line. That's the race the plan
  warned about, and a key doesn't avoid it.
- **A scratch cwd** (copy of the tree in `$TMPDIR`) works and is how
  item c pushed a throwaway function. It needs the **whole tree**,
  though. Copying only `convex/` failed typecheck because the
  `convex/**/*.test.ts` files import `../../test/fixture`. It isn't
  needed for QC.
- `convex deploy` has no `--deployment` flag. The key is the only way
  to choose the target.

Rules for `qc-instances.mjs` (step 2):

- **Never run `convex deploy` without a key.** Its help says that with
  `CONVEX_DEPLOYMENT` set and no key, it targets the project's
  **production** deployment, and the main checkout's `.env.local` sets
  `CONVEX_DEPLOYMENT`. The script should refuse unless the key starts
  with `dev:` and names a pool deployment. A dev deploy key reads
  `dev:<deployment-name>|…`.
- **`--codegen disable` on the parallel pushes.** With codegen on, N
  processes write `convex/_generated/` at once. The generated files are
  committed and must already be current for `pnpm check`. Any regen
  belongs in one serial step before the fan-out.
- Keys go in `.env.qc-<i>.local`. `*.local` is gitignored
  (`git check-ignore` → `.gitignore:5:*.local`). The keys made for this
  spike sit in `$TMPDIR/keys/` (`/tmp/claude-1000/keys/`). Step 2 can
  copy them or make new ones; delete the old `qc-<i>-push` keys from the
  dashboard if it makes new ones.
- `convex env set --deployment <ref>` works over HTTP from the sandbox.
  `convex env list` and `env get` **hang inside the sandbox**
  (`WebSocket closed with code 1006`, retrying forever) and work outside
  it. The existing `dev-instance.sh` check
  `env list | grep -q '^JWKS='` hangs there, so the shared create logic
  needs a timeout or a different "already set up" test.

## c. `createAccount` from an internal action, then sign in through the UI

**Yes, both.** A throwaway `platform/qcSpike.ts` (in the scratch copy
only, now overwritten on qc-1 by a normal push) did:

```ts
const { user } = await createAccount(ctx, {
  provider: 'password',
  account: { id: email, secret: password },
  profile: { email, name: `${slug} qc user` },
})
// then runMutation → insert tenant + owner membership
```

```
$ CONVEX_DEPLOY_KEY=… npx convex run platform/qcSpike:fixture '{"email":"qc-spike-a@example.com","password":"spike-pass-a-123","slug":"spike-a"}'
{ "ms": 168, "tenantId": "m570tc89…", "userId": "m97fy2zd…" }      wall 1538ms
```

The logs show `createAccount` running `auth:store`
(`createAccountFromCredentials`, 150 ms: the password hash) as a nested
mutation. `createAccount` doesn't copy the account id into the profile,
so pass `profile.email` yourself.

In the built SPA (Playwright, Chromium):

```
c: signed in; groups list = ["spike-a qc group\nspike-a · owner"]
c: storageState localStorage keys = ["__convexAuthRefreshToken_httpsexpertoriole119euwest1convexcloud",
                                     "__convexAuthJWT_httpsexpertoriole119euwest1convexcloud"]
isolation: A on /t/spike-b -> "No group called "spike-b" that you belong to."
```

So `storageState` captures the session, and the auth keys are named
per deployment URL. A wrong password is refused, but **the UI shows the
raw server error with a stack trace and local file paths**:

```
c: wrong password -> "[CONVEX A(auth:signIn)] [Request ID: be396d5b2fcdb708] Server Error Uncaught Error:
InvalidSecret at retrieveAccount (../../../../../home/david/projects/keep-together-builder-qc0/node_modules/…"
```

That's a product bug for later. `SignIn` renders `err.message`
verbatim. The step 6 "wrong password" spec should assert a friendly
message, so it fails until this is fixed.

## d. Playwright Chromium under the sandbox

**`executablePath: '/usr/bin/chromium'` works. Playwright's own download
doesn't.** But the bigger finding is that **`pnpm qc` can't run inside
the Claude sandbox at all**.

- `@playwright/test@1.63.0` (released 2026-09-04, older than the
  two-week minimum age) installed into `$TMPDIR` and launched the system
  Chromium headless: `launched+loaded ms 958 version 153.0.8010.52`.
- `npx playwright install --only-shell chromium` with
  `PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/…` failed:
  `deny network-outbound cdn.playwright.dev:443`. It would work with
  that host allowed, or in CI.
- Playwright 1.63 is built against Chromium 153.0.8010.12. Arch's
  153.0.8010.52 is the same major. When Arch moves to 154 first, CDP can
  drift. Make the path overridable (`QC_CHROMIUM`) and fall back to
  Playwright's own browser when the variable is unset and
  `/usr/bin/chromium` is missing (CI).

**Why QC must run unsandboxed.** The sandbox gives each Bash command
its own network namespace and lets traffic out only through an HTTP
proxy:

1. **WebSockets fail through the proxy.** The SPA's Convex socket died
   on every attempt:
   ```
   ws open wss://expert-oriole-119.eu-west-1.convex.cloud/api/1.47.0/sync
   ws error Proxy authentication failed
   console log WebSocket closed with code 1006
   ```
   (That was with the proxy credentials passed to Playwright's
   `proxy` option. Plain HTTPS through the same proxy worked.) Node's
   WebSocket fails the same way (`convex env list` above). The app
   can't sign in, so nothing works.
2. **The proxy inflates latency anyway.** The HTTP RTT probe read
   **79 ms** median inside the sandbox and **45 ms** outside, so
   sandboxed timings would be wrong even if sockets worked.
3. **A server started in one command is gone in the next.**
   `vite preview` in the background was unreachable from the following
   command (`ERR_CONNECTION_REFUSED`). Playwright's `webServer` starts
   the preview in the same process tree, so the harness is fine, but
   ad hoc debugging has to start the server and the browser in one
   command.

All the browser timings below ran with the sandbox disabled. For
builders this means "run `pnpm qc` before DONE" needs either a
sandbox exclusion for `pnpm qc` in the project settings (the human's
call) or an approval each time.

## e. Do the devtools ship in `vite build`? Do they overlap the save pane?

**No, they don't ship.** `@tanstack/devtools-vite` strips them from
production builds by default (`removeDevtoolsOnBuild ?? true` in its
`plugin.js`), and the build says so:

```
$ VITE_CONVEX_URL=… npx vite build
[@tanstack/devtools-vite] Removed devtools code from: /src/routes/__root.tsx
✓ built in 370ms
```

`grep` finds no `TanStack Router` / devtools strings in `dist/assets/*`.
The only `devtools` matches are React's own
`__REACT_DEVTOOLS_GLOBAL_HOOK__` probe. In the browser, the same DOM
probe on both builds:

```
prod (vite preview): devtools probe {"tsd":0,"bodyChildren":["DIV#app"]}
dev  (vite dev):     devtools probe {"tsd":6,"bodyChildren":["DIV#app","SCRIPT","DIV"]}
```

The dev screenshot shows the round TanStack trigger at about
x 1216–1272, y 736–792 (1280×800 viewport). The production screenshot
has nothing there. On the contact page the save pane's box is
`{"x":952.8,"y":742,"width":311.2,"height":42}` (x 953–1264,
y 742–784), so **they overlap in `vite dev` only**. QC runs the
production build, so the plan's conditional guardrail ("gate behind
`import.meta.env.DEV` if 0e shows they ship") doesn't fire. No product
change.

## f. RTT and three flows by hand

Built for qc-1 (`VITE_CONVEX_URL=… vite build --outDir $TMPDIR/dist-qc-1`),
served by `vite preview`, Chromium headless at 1280×800, sandbox off.
Timing as the plan describes: `performance.now()` just before the
dispatch, inside the page, then
`page.waitForFunction(pred, { polling: 'raf' })` and `performance.now()`
again in the page. Cold load is `performance.now()` at the predicate,
which counts from navigation start. Each flow ran 6 times and the first
was discarded as warm-up. Evening, home broadband, one run.

**RTT.**

| Probe | Samples (ms) | Median |
|---|---|---|
| HTTP `POST /api/query platform/tenants:mine` from the page, warm keep-alive | 52 51 48 44 102 40 37 42 46 44 | **45** |
| The SPA's own WebSocket: `ModifyQuerySet` sent → `Transition` received (CDP frame timestamps), 24 search queries | 25–29 | **27** |
| Server time of those queries (`contacts/queries:list`, logs) | p50 9.3, p95 13.7 | |

So the network round trip on the socket is **about 15–18 ms**. HTTP
reads ~45 ms, nearly 3× that, because each fetch pays for request
headers and the HTTP API's own path. **The probe should time the
WebSocket**, as the plan says, not HTTP. A clean way: open a CDP
session, change a subscription to a trivial cached query (or the search
box on a fixed page), and take the frame `timestamp` difference. A
cached `platform/tenants:mine` costs ~0 ms on the server, so the
difference is the network alone.

**Flows** (budget = the plan's starting table plus the round-trip
allowance at a 17 ms RTT):

| Flow | Samples (ms) | Median | Max | Budget + RT allowance |
|---|---|---|---|---|
| Sign in → groups list rendered | 423 381 412 379 434 | 412 | 434 | 2000 + 3×17 |
| Cold load `/t/<slug>/contacts` → list rendered | 309 430 279 312 780 | 312 | 780 | 1200 + 4×17 |
| Create click → contact page rendered | 104 124 123 109 106 | 109 | 124 | 500 + 2×17 |
| Save click → "All changes saved" | 104 70 71 75 88 | 75 | 104 | 300 + 1×17 |
| Search keystroke → list updated | 48 49 49 49 49 | 49 | 49 | 250 + 1×17 |

Everything is 3–6× under the starting guesses, so record mode will
tighten them. Search is the clearest case. 49 ms = 27 ms socket round
trip (with ~10 ms of server time) + ~22 ms render. Cold load spreads
the most (one 780 ms sample in five), so the K=5 "max ≤ 2× budget" rule
will bite there first if budgets come out of a quiet run. Sign-in is
~410 ms, not 2 s: hashing is ~150 ms server side, and the rest is two
round trips plus the auth handshake.

## g. ADR 0018

Drafted as `docs/decisions/0018-qc-live-dev-instances.md`, status
**proposed**, for the human to review.

## Changes to the plan

1. **Server-timing asserts (step 5):** count only `cachedResult: false`
   completions from our own modules. `auth:store` (password hashing,
   150 ms) would fail the 100 ms mutation p95 on every run. Actions,
   including `auth:signIn` at ~170 ms, aren't asserted, as planned.
2. **`pnpm qc` runs outside the Claude sandbox.** WebSockets don't pass
   its proxy, and the proxy distorts timing. The builder obligation in
   `roles/builder.md` needs a matching sandbox exclusion or a standing
   approval. That's the human's decision.
3. **Pushes (step 2):** `CONVEX_DEPLOY_KEY=<dev key> convex deploy
   --codegen disable -y`, in parallel, never without a key. Don't use
   `convex dev`. `env list` needs a timeout under the sandbox.
4. **RTT probe (step 4):** WebSocket frame timing over CDP, not HTTP.
   It's Chromium-only, which the plan already is.
5. **Chromium:** `executablePath` from `QC_CHROMIUM`, defaulting to
   `/usr/bin/chromium` when present, else Playwright's own browser (CI).
6. **Devtools:** no gating needed (0e).
7. **Product bug for later:** the sign-in form shows raw server errors
   with stack traces and local paths.

## Left on the instances

qc-1 holds two spike users (`qc-spike-a@example.com`,
`qc-spike-b@example.com`), tenants `spike-a` / `spike-b` and 6
`Alpha<n> Spike…` contacts in `spike-a`. The run-scoped tenant names in
the plan won't collide with them. `--reset` (step 2) clears them. qc-2
is empty. The throwaway `qcSpike` functions were replaced by a normal
push from the worktree.
