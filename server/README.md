# server/ — the Rust + SQLite backend

keep-together's api: axum + rusqlite, **one SQLite file per
organisation** plus `platform.db` (ADR 0024). The SPA (`src/`) talks only
to it. Comments that cite `convex/…` name the Convex code a piece was
ported from; it is at the tag `convex-final`.

```
cargo test                                 # from server/: every crate; also re-exports the TS types
cargo clippy --all-targets -- -D warnings
cargo run -p cli --bin keep -- sql <slug> "SELECT count(*) FROM contacts"
```

From the repo root, `pnpm dev` runs this api (rebuilt on every save)
behind Vite, with riverside seeded in `server/data/` (README, "Dev
loop"). By hand: `KEEP_DEV_AUTH=1 KEEP_PORT=8788 cargo run -p api` (data
in `server/data/`, gitignored), and `KEEP_PORT=8788 vite dev` from the
root proxies `/api` to it (or to `KEEP_API`). Each checkout uses its own
`KEEP_PORT` (8787 + n); with no api running, `/api` calls get proxy
errors.

Env (`api`):

| var | default | |
|---|---|---|
| `KEEP_DATA_DIR` | `data` | `platform.db`, `orgs/`, `files/`, `premigrate/` |
| `KEEP_BIND` | `127.0.0.1` | Fly sets `0.0.0.0` |
| `KEEP_PORT` | `8787` | |
| `KEEP_MAX_OPEN_ORGS` | `64` | org files kept open beyond those in use |
| `KEEP_DEV_AUTH=1` | off | the dev login (below). **Dev auth is no auth**: anyone who can reach the port signs in as anyone. It is honoured only on a loopback bind; on any other address it is ignored with a warning. Loopback is not the whole story: Vite's `/api` proxy is reachable wherever Vite is (`tailscale serve` puts it on the tailnet, `allowedHosts: ['.ts.net']`), and a DNS-rebinding page in your browser can reach `127.0.0.1`. Fine for seed data; never put real data behind dev auth |
| `KEEP_ENV` | unset | `dev`, `staging` or `prod` (anything else stops the boot). Deployed = `prod`/`staging`, or a non-loopback bind unless `dev`: refuses `KEEP_DEV_AUTH` and `KEEP_MAIL=log`, needs `KEEP_APP_ORIGIN` (https), `KEEP_CLIENT_IP_HEADER`, `KEEP_SETTINGS_KEY` and `KEEP_AUTH_PEPPER` (`api::auth::boot`); the dev keys only on loopback; `prod` refuses `KEEP_MAIL=off` and `KEEP_MAIL_ONLY_TO` |
| `KEEP_APP_ORIGIN` | `http://localhost:3000` | the SPA's origin: links in emails, the trusted `Origin` for writes |
| `KEEP_CLIENT_IP_HEADER` | unset (peer address) | the proxy's client-address header for rate limits (`Fly-Client-IP` on Fly); never where clients reach the api directly. Its value counts only if it is one IP (IPv6 by /64); `X-Forwarded-For`/`Forwarded` are refused |
| `KEEP_SETTINGS_KEY`, `KEEP_AUTH_PEPPER` | published dev keys | 32 bytes, base64: TOTP secrets sealed (AES-GCM), codes HMAC (`auth::keys`) |
| `KEEP_MAIL` | `log` | `log` only for dev on a loopback bind; `smtp`: send via `KEEP_SMTP_URL` (`smtp://localhost:1025`, Mailpit) as `KEEP_MAIL_FROM` (`comms::mail`); `off`: no mail, and what needs it is refused (`mail_off`) |
| `KEEP_MAIL_ONLY_TO` | unset | staging: mail only these recipients (`a@x.org,@y.org`: full addresses or `@domain`, exact, case-insensitive); anyone else is exactly `KEEP_MAIL=off` for them (`mail_off`). QC's `@qc.keep-together.invalid` is never listed. Empty or malformed entries stop the boot; `prod` refuses it |
| `KEEP_QC_SEED=1` | off | with dev auth: `POST /api/dev/qc-seed` and `qc-crowd` (≤ 10k) |
| `KEEP_QC_TOKEN` | unset | with `KEEP_ENV=staging` only: `/api/qc/{seed,crowd,hold,session}` for the nightly QC run, the token in `x-keep-qc-token` (≥ 64 chars); `qc-` groups and `@qc.keep-together.invalid` users only; 404 when off or wrong; with `KEEP_ENV=prod` the boot stops (`routes::qc_seed`) |
| `KEEP_AUTH_POLICY` | `strict` | `relaxed`: no required second factor (a user who enrolled one is still asked), no step-up, any non-empty password (≤ 128); invites, roles, rate limits, sessions and hashing unchanged (`auth::policy`, ADR 0020 amendment 2026-10-25). For the tailnet preview and local runs reached over the network. `/api/me` (`authPolicy`) and `/api/auth/state` (`policy`) say which; the SPA shows a banner unless strict. `KEEP_ENV=prod` refuses `relaxed`; any other value stops the boot |
| `KEEP_ADDRESS_LOOKUP` | `off` | the contact form's postcode lookup (`api::address`): `fake` (fixed addresses, no network; `KEEP_ENV=prod` refuses it) or `ideal` (Ideal Postcodes, needs `KEEP_IDEAL_POSTCODES_KEY` or the boot stops). Any other value stops the boot. `/api/me` says `addressLookup: true` when on |
| `KEEP_IDEAL_POSTCODES_KEY` | unset | the platform's key for `ideal`; sent in the `Authorization` header, never in a URL, never logged |
| `KEEP_ADDRESS_LOOKUP_CAP` | `100` | lookups per organisation per calendar month (UTC): then `429 lookup_cap` |
| `KEEP_ADDRESS_LOOKUP_DAILY_CEILING` | `2000` | lookups across the platform per UTC day: then `503 lookup_unavailable` |
| `KEEP_GOCARDLESS` | `off` | Direct Debit (`api::gocardless`; "GoCardless" below): `fake` (a GoCardless mock mounted on this server at `/api/fake-gocardless`, no network; `KEEP_ENV=prod` refuses it), `sandbox` (`prod` refuses it), `live` (only with `KEEP_ENV=prod`). Any other value stops the boot |
| `KEEP_GOCARDLESS_CLIENT_ID`, `KEEP_GOCARDLESS_CLIENT_SECRET`, `KEEP_GOCARDLESS_WEBHOOK_SECRET` | unset | the partner app's OAuth client and webhook secret; `sandbox`/`live` stop the boot without them (`scripts/fly/gocardless-secrets.sh`). Never logged, never in a URL or an error |
| `KEEP_FILES_CAP_BYTES` | unset: no cap | bytes of scanned pages an organisation's files db may hold (`422 rejected files_full` past it). Unset, none: the volume's reserve (`507`) is the only stop (human, 2026-10-29) |
| `KEEP_FILES_DISK_RESERVE_BYTES` | see `api::scans::limits` | free bytes the data volume keeps after a scan upload (`507 storage_full` otherwise). Default: twice the largest database on the volume (the snapshot's copy and its `.zst`), and deployed (`prod`/`staging`) at least a quarter of the volume. `0` turns the guard off |
| `KEEP_RESET_SEED` | unset | `riverside`: seed `seed::riverside` at boot (`api::reset`; `KEEP_ENV=dev\|staging` only, staging with `KEEP_RIVERSIDE_<ROLE>_{PASSWORD,TOTP}`; on dev under `KEEP_AUTH_POLICY=relaxed` a missing password is `riverside` and a missing TOTP is none) |

The 10k measurement (`scripts/perf-search10k-rs/`):

```
node scripts/perf-search10k-rs/export-jsonl.mjs $TMPDIR/rs10k      # from the repo root
cargo build --release -p seed -p api                               # from server/
./target/release/seed --data data --slug perf-a --admin perf-a@example.com --jsonl $TMPDIR/rs10k/a.jsonl --prefix perfa
./target/release/seed --data data --slug perf-b --admin perf-b@example.com --jsonl $TMPDIR/rs10k/b.jsonl --prefix perfb
KEEP_DATA_DIR=data KEEP_DEV_AUTH=1 ./target/release/api &
node ../scripts/perf-search10k-rs/measure.mjs --out $TMPDIR/rs-measure
node ../scripts/perf-search10k-rs/analyze.mjs $TMPDIR/rs-measure/raw.json --rtt 30
```

(`measure.mjs` still asks for `fts=trigram`; that variant is gone, so the
parameter is ignored and both columns measure the words index.)

## Crates

| crate | owns |
|---|---|
| `store` | `platform.db` (tenants, users, memberships, sessions, snapshots), `orgs/<tenant-id>.db` and each org's files db `files/<tenant-id>.db` (`store::files`: immutable blobs by SHA-256, opened with the org's handle, capped only if `KEEP_FILES_CAP_BYTES` says); pragmas (WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout`, no `ATTACH`); per file one writer behind a fair mutex + a read-only reader pool + a checkpointer thread, none under Litestream (no checkpoint in a commit: `docs/ops.md`); locks waited for by 1 ms polls; the handle LRU; boot migration; each file's event channel |
| `contracts` | the **only write path**: `transact`, `Contract`, `execute`, revisions, command groups, restore through upcasters, child-row reconcile, events |
| `contacts` | the Contact aggregate: slices as contracts, dropdown fields, the FTS projection, list/search/get/history |
| `sources`, `giving`, `giftaid`, `comms` | domain crates: source codes, gifts (and their Gift Aid claim lock), Gift Aid declarations and claims (HMRC's schedule and claim XML), email suppressions |
| `platform` | control plane: preferences (the three "staff can manage" contracts, `may_manage_list`), encrypted tenant settings, memberships and "last used" group as functions on a `platform.db` transaction, its own `platform.db` schema list |
| `auth` | staff auth: credentials, second factors, sessions, invites, resets, rate limits, the auth log, in `platform.db` (its own `PlatformSchema`); `api::auth` is its HTTP |
| `api` | axum app: dev session cookie, `/api/t/{slug}` → one `OrgDb`, SSE, `/boot`, jobs, `/healthz`, `Server-Timing`, JSON errors; `schema.rs` is the org migration list; `routes/` the domain routes and the QC seed. Commands spanning modules live here, in one transaction |
| `cli` | bin `keep`: `keep sql`, `keep tenant create`, `keep auth …`, `keep dev …` |
| `seed` | seeded worlds through the same contract functions the API calls: `riverside` (Convex's `testSeed`: staging's reset seed and `keep dev seed-riverside`) and `perf` (the 10k generator's JSONL; its bin `seed` lives in `api/src/bin/seed.rs`, since `api` depends on this crate) |

Domain crates depend on `contracts` (and each other's public functions),
**never on `store`, `platform`, `auth` or `api`** — a test in
`api/tests/schema.rs` reads their manifests. They can't name an
organisation or open a file.

## Tenancy

There is no `tenantId` column anywhere. A request reaches
`/api/t/{slug}/…`, its session cookie resolves to a user, the user's
membership of `slug` (in `platform.db`) to a `TenantId`, and that to the one
`OrgDb` for `orgs/<id>.db`. Tenant handlers live in a **stateless**
`Router` and get a `Tenant` extension: `tenant.read(|r| …)` and
`tenant.write(|ctx| …)` are the only way to the data, and they reach that
one file. Not a member, or unknown slug: `403 {kind:"forbidden"}` (the same
response, so slugs can't be probed). Writes need role `staff` or `admin`.

Belt and braces: `TenantId` is 32 hex chars and can only come from a
`platform.db` row, so a slug never becomes a path; every org file is
stamped with its tenant id and refused if it doesn't match; connections
can't `ATTACH` (limit 0); reader connections are `query_only`.

Domain functions take `&Ctx` (writes) or `&Connection` (reads, from
`OrgRead` or `ctx.tx.read()`), and nothing that names an organisation.

**Handles (M2).** `Store::org(id)` opens a file under that org's own lock
(an open or a migration of one org never blocks a request to another),
then keeps it in an LRU capped at `KEEP_MAX_OPEN_ORGS`; the `idle-close`
job closes handles unused for 10 minutes. A handle someone holds (a
request, an SSE stream) is never closed.

## HTTP conventions (what the SPA codes against)

- **Paths.** Reads are `GET /api/t/{slug}/<resource>[/{id}[/…]]`. Each
  contract command is one `POST` (RPC, not REST):
  `POST /api/t/{slug}/contacts` (create),
  `POST /api/t/{slug}/contacts/{id}/save` (the form: several slices, one
  transaction, one command group), `POST …/{id}/archive`, `…/{id}/restore`.
- **JSON**, `camelCase` field names, ids are
  strings (UUIDv7, 32 hex chars). `i64` fields (counters, timestamps,
  revision ids) are JSON numbers and typed `number` in TS (they stay below
  2^53); timestamps are ms since the epoch.
- **Saves carry `expected`**, the slice's counter as last read; the
  response is `Executed {id, counter}` (per slice, for a multi-slice
  save). On mismatch: **`409 {kind:"stale", contract, counter, current}`**,
  where `current` is the slice's state now, so the form merges and retries
  with `counter` as the new `expected`, with no extra read.
- **Errors** are always a JSON `ApiError` tagged by `kind`:

  | status | kind | when |
  |---|---|---|
  | 401 | `unauthenticated` | no valid session |
  | 403 | `forbidden` | not a member / unknown slug / role too low / dev auth off |
  | 404 | `not_found` | |
  | 410 | `gone` | a phone pairing's link ended, timed out or never was (`/api/scan/{token}`) |
  | 409 | `stale` | `{contract, counter, current}` |
  | 409 | `duplicate` | `{id}`: create with a pre-generated id that exists |
  | 422 | `invalid` | `{problems: [{field, message}]}`: unstorable input, including a malformed body |
  | 422 | `rejected` | `{reason, message}`: refused (e.g. `identity_immutable`) |
  | 429 | `rate_limited` | auth's rate limits |
  | 429 | `lookup_cap` | the organisation's address lookups for the month are used up |
  | 503 | `lookup_unavailable` | the address lookup provider is down, slow (5 s), out of credit, or the daily ceiling is reached |
  | 503 | `gocardless_unavailable` | GoCardless didn't answer or failed; nothing changed here |
  | 503 | `busy` | too many scan uploads in flight (8); nothing stored; send it again |
  | 507 | `storage_full` | the data volume is down to its reserve; no scan stored |
  | 500 | `internal` | details only in the server log |

  Tier-2 warnings (ADR 0015) aren't errors: they ride along in read
  responses.
- **Auth** (A4; next section). `GET /api/me` → `Me {email, memberships:
  [{slug, name, role}]}` for a signed-in session; `GET /api/t/{slug}` →
  `TenantInfo`. The dev login stays for local QC: `POST /api/dev/login
  {email}` signs in as that email, no password, and `POST /api/dev/tenants
  {slug, name}` makes an org with the caller as admin. Both, and every
  dev-login session, are refused unless `KEEP_DEV_AUTH=1`, the server binds
  a loopback address (M1) and the request's `Host` is loopback; the api
  won't start with `KEEP_DEV_AUTH=1` and `KEEP_ENV=prod|staging`.
- **Cold load.** `GET /api/t/{slug}/boot` → `Boot {me, org, fields,
  firstPage, seq}`: one request seeds the SPA's cache; `seq` (the cursor
  at the same snapshot) is where its event stream resumes.
- **Live changes.** `GET /api/t/{slug}/events` (`text/event-stream`, any
  member): one unnamed message per committed contract, `id:` = the cursor
  `<generation>.<seq>`, `data:` = `OrgEvent {seq, entity, id, contract,
  counter}` — ids only, never data. `Last-Event-ID: g.n` replays revisions
  after `n` (at most 1000); further behind, an unreadable cursor, or one
  of another generation gets one `event: reset` and the client refetches
  everything. The generation is a random id in the org file (`recovery`),
  rotated by `restore.sh` and `rollback-migration.sh`: a file put back
  from a copy reuses revision ids, so a tab's old cursor must not replay
  from them. Keep-alive comment every 20 s.
- **Health.** `GET /healthz` (no session) → `{ok, db, walBacklogBytes,
  diskFreeBytes, diskTotalBytes, backup}`; 503 when the data dir can't be
  read. The disk and backup fields are reported, never judged here:
  `.github/workflows/health.yml` judges them (docs/ops.md, Monitoring).
- **Timing.** Every `/api` response has
  `Server-Timing: platform;dur=…, db;dur=…, total;dur=…` (ms).
  `platform` = session + membership lookup, `db` = time inside org-file
  closures (writer lock wait included).
- **Types.** `#[derive(TS)] #[ts(export)]` on every request/response type;
  `cargo test` writes them to `src/lib/data/rust-types/` (committed:
  typechecking needs them; never edit by hand). Payload JSON with no fixed shape
  is typed `unknown`.

## Auth (ADR 0020 §3, without Google)

Staff only, invite-only. A sign-in is two requests: `POST
/api/auth/sign-in {email, password}` makes a partial session
(`second_factor`, or `enrol` when no second factor is set up yet), and
`POST /api/auth/second-factor {code}` completes it with a new token. The
code is from an authenticator app (TOTP), emailed (sent at sign-in;
`send-code` for another), or one of 10 recovery codes. A partial session
reaches nothing but `/api/auth/*` (`/api/me` is 401).
Under `KEEP_AUTH_POLICY=relaxed` a user with no second factor is signed
in by the password alone (`signed_in`, no `enrol`), and may enrol one
from their account with the password only; step-up always passes.

| route | |
|---|---|
| `GET auth/state` | `AuthState {stage, email, method, stepUpUntil}`, signed out included |
| `POST auth/sign-in {email, password, emailCode?}`, `auth/second-factor`, `auth/send-code` | the steps (`check_email`: send the password again with the emailed code) |
| `POST auth/enrol/totp` → `TotpEnrolment {secret, url, qrSvg}`; `auth/enrol/email`; `auth/enrol/confirm {method, code, emailCode?, password?, currentCode?}` → `Enrolled {recoveryCodes, state}` | set up, or (with the password and the current factor) change, the second factor |
| `POST auth/step-up {password, code}` | admin actions work for an hour after a sign-in or step-up; else `403 step_up_required` |
| `POST auth/sign-out` | ends the session and its live streams |
| `POST auth/reset/request {email}` · `reset/check {token}` · `reset/complete {token, password}` | 15-minute single-use link to `/reset#<token>`; completing it ends every session of the user |
| `POST auth/invite/check {token}` · `invite/accept {token, password}` | 7-day single-use link to `/invite#<token>`; a new address sets a password and enrols, an existing account gives its password |
| `GET auth/account` · `POST auth/account/password {current, new}` · `auth/account/recovery-codes` · `GET auth/account/sessions` · `POST auth/account/sessions/sign-out-others` | your own account |
| `GET /api/t/{slug}/members` | `MembersPage {members, invites}`, any member |
| `POST …/members/invite {email, role}` · `members/invites/{id}/revoke` · `members/{userId}/role {role}` · `members/{userId}/remove` · `members/{userId}/reset-2fa` | admin within the step-up hour; a group always keeps an admin; 2FA reset only for someone in no other group |

Rules (after the S1 security review):
- Passwords: argon2id, 12–128 characters, not on the bundled breached list
  (`auth::password`). An unknown email is verified against a dummy hash
  and answers exactly like a wrong password; a sign-in re-checks inside
  its write that the hash it verified is still the account's.
- Reset requests answer `{ok: true}` for any address; the lookup, link
  and mail happen after the response. No `Server-Timing` on `/api/auth/*`.
- TOTP codes are accepted once (the step is stored). TOTP secrets are
  sealed under `KEEP_SETTINGS_KEY`; recovery codes (≈99 bits) and emailed
  codes (10 minutes) are HMAC under `KEEP_AUTH_PEPPER`.
- Rate limits (`auth::limits`, in memory): per client IP and per email on
  sign-in passwords, per user on a signed-in user's passwords and on
  codes, per address on emails. Past the per-email limit a sign-in answers
  `check_email` and needs an emailed code with the password
  (`auth::gate`): it slows guessing without locking the owner out.
- Wrong codes are counted in `platform.db` (`auth::failures`): 5 end a
  partial sign-in, 10 in an hour lock the user's second factor for the
  rest of it (emailed; a password reset lifts it).
- After a 2FA reset, enrolling needs an emailed code as well. Changing a
  signed-in user's factor needs the password and the current factor, and
  doesn't renew the step-up hour; any completed enrolment signs the
  user's other sessions out.
- Password, factor and recovery-code changes and 2FA resets are mailed to
  the account (`auth::notices`; transactional, never suppressed).
- Bodies are read in full within 30 s before routing (`api::body`; 16 KiB
  on `/api/auth/*`), and `Tenant::write` re-checks the session and role.
- `Tenant::require_admin` is role admin plus the step-up hour, for
  admin-only domain routes too.

Sessions (`auth::sessions`, invariants in its docs): the cookie
`__Host-kt_session` (`kt_session` without `Secure` on a loopback `Host`)
is a 256-bit token, only its SHA-256 stored; `HttpOnly; SameSite=Lax;
Path=/`; 7 days, ended sooner by 12 idle hours; "Your account" lists
your sessions and signs the others out; the token
rotates on sign-in completion, step-up and your own role change;
revoke-all on password reset, 2FA reset, removal and someone else
changing your role; streams end within a moment of a revocation in this
process (30 s for one from `keep`). Every non-`GET` `/api` request must
come from the app's origin (`Sec-Fetch-Site`, else `Origin` against
`KEEP_APP_ORIGIN` or the request's host); a request with neither header
isn't a browser and passes. Mail is plain text through `comms::mail`
(transactional: never suppressed).

Operator (logged in `auth_log` as `operator`): `keep auth reset-2fa
<email> [--reason …]`; `keep tenant create` invites its first admin
(`auth::operator_invite`, sent with `KEEP_MAIL=smtp`, else printed); `keep
auth invite <slug> <email> [--role …]` sends a new link, also to an
existing member without credentials (that admin, if theirs expired).

## Writing a domain route

```rust
#[derive(Deserialize)]
struct Save { expected: i64, #[serde(flatten)] slice: DetailsPayload }

async fn save(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>, // never Path<String>: {slug} is a param too
    Body(s): Body<Save>,                 // api::Body: bad JSON → 422 invalid
) -> Result<Json<Executed>, ApiError> {
    let out = t.write(move |ctx| {
        Ok(execute(ctx, &ContactDetails, s.slice, Exec::update(&id, Some(s.expected), Source::Ui))?)
    }).await?;
    Ok(Json(out))
}
```

`ContractError` converts into `ApiError` with `?`. Mount the domain
`Router` with `api::app(state, routes)`. Every route gets an isolation
test: under two orgs, B never sees A, and A's ids under B's slug answer
404. A create, archive or restore answers with the entity's view, read in
the same transaction (one round trip).

## The write path (M3)

`contracts::transact(&db, actor, |ctx| …)` is the only way to write an
org file; `Tenant::write` calls it. Inside, `ctx.tx` is an `OrgTx`: it has
no `Deref` to a connection and no write method. `ctx.tx.read()` gives the
transaction's connection with `query_only` on, so it sees the
transaction's own writes and refuses any of its own. The only writable
connections are the `WriteTx` a contract's `write` gets and the
`ProjectionTx` its `project` hook gets, which only `execute` (and
`reproject`, for a projection's backfill) construct; `WriteTx::take_sequence`
hands out system-owned numbers. While `project` runs, the writer's
authorizer allows writes only to the tables the contract lists in
`PROJECTIONS` (and their five FTS5 shadow tables), so a hook can't change a slice
without its counter and revision. Each `execute` runs under a savepoint: a
command that fails part-way leaves nothing, even if its caller catches the
error and commits the rest. `compile_fail` doctests on `OrgTx` prove that
domain code can't call `execute` on raw SQL, deref an `OrgTx`, or forge a
`WriteTx`/`ProjectionTx`/`OrgTx`. Domain crates don't depend on `store`, so
they never see `OrgDb::write_raw`.

The seal stops at `read()`: it is a `&Connection` with `query_only` on,
which a deliberate `PRAGMA query_only=OFF` or a `COMMIT` could get round.
`api/tests/schema.rs` therefore greps domain sources for `query_only`,
`authorizer(`, `unchecked_transaction` and SQL literals starting with
`COMMIT`/`BEGIN`/`ROLLBACK`/`SAVEPOINT`/`RELEASE`/`ATTACH`/`DETACH`/`PRAGMA`/`END`.

Each executed contract emits an `OrgEvent`; `OrgDb::write_raw` publishes
them after the commit, in commit order. A refused or rolled-back command
publishes nothing.

Ids a client chooses (a pre-generated entity id, a child row's key) are 32
lower-case hex characters; anything else is `422 invalid`.

## Schema and migrations

`api::schema::org_migrations()` is the org schema: append-only, one
transactional step per change (no loosen/tighten dance: SQLite doesn't
re-validate rows, so a step that adds a constraint backfills or refuses in
the same step).

**At boot**, before listening, `Store::open` migrates `platform.db` and
`Store::migrate_all()` brings every `orgs/*.db` to head, 4 at a time. Each
file with steps pending is first copied with `VACUUM INTO` into this boot's
directory, `premigrate/boot-<ms>/<name>.v<from>.db` (`platform` or the
tenant id), beside a `manifest` of the org files present at boot. A boot
that finishes marks it `complete`; a failed boot leaves it open and the
retry reuses it (no file copied twice, the first manifest kept), so the
copies always predate the release still rolling out. Only a migrating
boot after a completed one starts a new directory and deletes the old. Any failure stops the boot
naming the file, so a deploy fails visibly. Rollback = the previous image
plus `scripts/ops/rollback-migration.sh <data> --apply` (API stopped): it
restores every copy of the last migrating boot, platform included, and
sets aside org files created after it (not in the manifest, so at the new
schema). Replaced files are kept as `<file>.rolled-back-<utc>` with their
`-wal`/`-shm`.

**A new step adds its fixture** to `FIXTURES` in `api/tests/schema.rs`:
representative rows at that version. The test builds a file at every past
version, migrates it to head, and checks row counts and
`integrity_check`. The same file guards rule 7 (no `REAL`; any
`*amount*`/`*pence*` column is `INTEGER`) and that every contract owns its
own `INTEGER NOT NULL DEFAULT 0` counter and has its upcasters.

## Jobs

`api::jobs`: named in-process interval jobs (`Job` trait, `Jobs::register`,
`standard(&store)`). A job touching organisations uses
`each_org(&store, |id, db| …)`: one file at a time, never two in one
transaction; one org's failure doesn't stop the others. Running now:
`idle-close` (1 min), `session-purge` (1 h: expired sessions, spent
reset links, old invites), `field-retire` (1 min: retires left part
way, as whoever started them, in only the orgs `platform.db`'s
`pending_jobs` names; one field failing is reported and the rest carry
on), and `scan-pairing-sweep`, `scan-orphan-sweep` and
`scan-discard-purge` (daily: Declaration scans, below). F2's hourly snapshot
registers the same way. With GoCardless on: `gocardless-events` (30 s),
`gocardless-catchup` (daily) and `regular-terms-sync` (hourly, first
run 10 minutes after boot; also run for one organisation after a terms
change is saved). A job's first run is `first_after()` after boot
(default: one period), so the snapshot needn't wait an hour after every
deploy.

## `keep`

```
keep [--data <dir>] sql <slug> "<select…>" [--json]
keep [--data <dir>] tenant create --slug <slug> --name <name> --admin-email <email>
keep [--data <dir>] auth reset-2fa <email> [--reason <text>]
keep [--data <dir>] auth invite <slug> <email> [--role admin|staff|viewer]
keep [--data <dir>] dev seed-demo [--slug demo] [--admin-email <email>]
keep [--data <dir>] dev seed-riverside        # KEEP_ENV=dev (or staging, credentials from env)
keep [--data <dir>] giftaid-xml <slug> <claim-id>   # a claim's HMRC XML on stdout, IRmark on stderr
keep giftaid-xml --hmrc-sample                # HMRC's sample data: their GAValidSample.xml, byte for byte
keep [--data <dir>] giving-consistency <slug>       # provider payments vs their gifts (ADR 0025); exit 1 on any
keep [--data <dir>] expected <slug> <YYYY-MM>       # each regular gift's expected payment that month against what happened (ADR 0026)
```

`keep sql` opens the org file `SQLITE_OPEN_READ_ONLY` with `query_only`,
`ATTACH` limited to 0, an authorizer that allows only `SELECT`, column
reads, functions and recursive CTEs, one statement, and a 10 s timeout:
SQL text from anywhere (an agent) can't change the file. Output is CSV, or
JSON objects. `keep tenant create` makes the org row, its file with every crate's
reference data (`api::schema::seed_new_org`) and the admin's membership in
one go (all or nothing), then invites the admin (a printed stub until A4).
`keep dev seed-demo` is the same plus three contacts. `keep dev
seed-riverside` is `seed::riverside`, staging's reset seed: the
`riverside` org with Convex's 100 fixed-seed donors and a password +
TOTP user per role, refused unless `KEEP_ENV` is `dev` or `staging`;
on dev, credentials missing from `KEEP_RIVERSIDE_<ROLE>_{PASSWORD,TOTP}`
are generated and printed (under `KEEP_AUTH_POLICY=relaxed`: the password
`riverside` and no TOTP).

## Platform

`platform.db` has a frozen base schema (store) and one migration list per
control-plane crate (`store::PlatformSchema`, versions in
`platform_schema` by name; composed in `api::schema::PLATFORM_SCHEMAS`).
`Platform::with_write` / `with_read` hand a transaction to `platform` and
`auth` functions so several compose into one.

Preferences are org data: `tenant_preferences` (one row, created by the
first save) in the org file, three contracts with a counter each. Routes
check a list manager with `platform::may_manage_list(conn, role, kind)`.
Tenant settings are AES-256-GCM under `KEEP_SETTINGS_KEY` (32 bytes,
base64), the name as associated data; only ciphertext reaches the file
and its revisions.

| route | |
|---|---|
| `GET /api/groups` | `Group[]`: the caller's groups with role, `lastUsedAt`, the switches and `canManage*` |
| `POST /api/groups/{slug}/opened` | `OpenedResult`; not a member: `404` |
| `GET /api/t/{slug}/preferences` | `Preferences` |
| `POST /api/t/{slug}/preferences/{identifierTypes\|sourceCodes\|fields}` | `{expected?, staffCanManage}` → `Executed`; admin only; `409 stale` |

The tenant middleware refuses any non-`GET` from a viewer before the
handler runs; `api/tests/roles.rs` reads the route table from
`src/routes/` and proves it for every write route. **No writes on GET**:
the guard lets a viewer's GET through, so a handler that writes must be
a `POST`. The same test pins the route table, so a new route is looked at.

## Contracts

`Contract` = `NAME`, `VERSION`, `ENTITY` (root table, `id TEXT`),
`COUNTER` (an `INTEGER NOT NULL DEFAULT 0` column on the root), `Payload`,
`State`, and `prepare` → `load` → pure `apply(current, payload, command)`
→ `write` → `project`, plus `upcast(from, payload)` steps and
`restore_payload(tx, payload, current, restored_at)` (`restored_at`: when
the restored revision was written). `execute` runs inside the caller's transaction:
counter check (stale ⇒ nothing written), apply, write, counter bump,
revision row (prepared payload, name, version, counter, actor, source,
group), projection. `command_group(ctx, name)` labels several commands
in one transaction. `restore` re-executes a revision as a new command
through the upcaster chain; `restore_entity_to(at)` restores every slice
that differs from its state at `at`. `contracts::history::page` reads an
entity's revisions as moments (one per command group, newest first,
`before`/`limit` keyset pages); each module names its slices with a
`SliceLabel`. Child rows: `mint_ids` in `prepare`,
`reconcile` in `write` (by id; identity fields immutable per id).

## Contacts

Slices, each a contract with its own counter column on `contacts`:
`contacts.details` (v1), `contacts.methods` (emails + phones; the
address / number is the identity per key), `contacts.addresses` (no
identity: editable in place), `contacts.archive`, `contacts.fields`
(dropdown values: rows of `contact_field_values`, not Convex's slots).
Field definitions are `contacts.field` and `contacts.fieldOption`;
`contacts.fieldRetire` moves a field live → retiring → retired (system-
owned columns, only forward, never restored), and `contacts.fieldDelete` /
`contacts.fieldOptionDelete` remove what was never used (each a row of its
own delete log). A retire archives the field, marks it retiring (no new
values, no edits), clears it from every holder in batches of 500 (one
transaction and one "Retire field *Label*" group each, in the
background after the route has answered), then marks it retired. A
retire is marked pending in `platform.db` (`pending_jobs`) while it runs;
the `field-retire` job carries on any a stopped server left, opening only
the orgs so marked.
The
contact number is the rowid (`number INTEGER PRIMARY KEY`), handed out from
`contact_number_sequence` on create; `id` is the API's UUIDv7.

Routes under `/api/t/{slug}` (types in `src/lib/data/rust-types/`):

| route | |
|---|---|
| `POST address-lookup {postcode}` | `AddressLookupResult {addresses: [{line1, line2, line3, town, postcode}]}`, `Cache-Control: no-store`: staff and admin (a viewer `403`, by the write guard); a `POST` because each lookup spends. The postcode is trimmed, upper-cased and shape-checked first (`422 invalid`, nothing counted or sent); not found `404`; `429 lookup_cap`; `503 lookup_unavailable`; lookup off `404`. Counted per organisation per month and per platform day in `platform.db` (`api::address::SCHEMA`), before the call and given back if the provider was never reached. Nothing returned is stored or logged (ADR 0014 amendment) |
| `GET contacts?includeArchived&kind&fields&cursor&limit` | `ContactPage`: keyset pages on `(sort_key, id)`, ≤100 rows |
| `GET contacts/search?q&includeArchived&kind&fields` | `SearchResult`: exact matches first, then FTS |
| `GET contacts/{id}` | `ContactView`: every slice, counters, warnings |
| `GET contacts/{id}/history?before&limit` | `MomentPage {moments, nextBefore}`: `limit` revisions (default 10) as moments, newest first; a group cut by the page boundary comes back as two halves with one `key`; unknown id `404` |
| `POST contacts` | `CreateContact` → `CreatedContact {id, number, view}`; a seen `clientKey`/`id` is `409 duplicate` |
| `POST contacts/{id}/save` | `SaveForm` → `SaveFormResult` (below) |
| `POST contacts/{id}/archive` | `{expected, archived}` → `ArchivedContact {id, counter, view}`, or `409 stale` |
| `POST contacts/{id}/restore` | `{revisionId}`, or `{toRevision}` ("Restore to here": every slice that differs from its state up to that revision, archive and retired contracts excepted, in one "restore to *ISO time*" group; `{at}` (ms) bounds by time instead) → `RestoredContact {restored, skippedFields, view}`; a retired contract's revision is `422 rejected {reason: retired_contract}` |
| `POST contacts/bulk-set-field` | `{contactIds, fieldId, optionId}` (`null` clears) → `BulkSetResult {changed, skipped, group}`: ≤1000 contacts, one command group, all or nothing; staff |
| `GET fields` | live definitions with `retiring` and `deletable` |
| `POST fields` · `POST fields/options` | save (`id` + `expected`) or create; a new option goes last |
| `POST fields/{id}/delete` · `POST fields/options/{id}/delete` | `{expected}` → `{deleted}`; `422 rejected {reason: used}` once used; needs a recent sign-in |
| `POST fields/{id}/reorder` | `{order}` naming every option → `{moved}`; anything else `409 stale` |
| `POST fields/{id}/retire` | → `{phase: "retiring"}` once started; the field leaves `GET fields` when it ends; needs a recent sign-in |

The field routes need a list manager (admin, or staff while "staff can
manage fields" is on: `platform::may_manage_list`); retire and delete are
irreversible, so they also need a sign-in (or step-up) within the last
hour, whatever the role (`Tenant::require_step_up`). Bulk set is ordinary
staff editing.

`fields` filters are `fieldId:optionId` or `fieldId:none`, comma-separated.
Caps (L6): 50 emails, 50 phones and 50 addresses per contact; 200 live
fields per organisation (a retired one frees its place) (`422 rejected {reason: field_limit}`).

**The form save answers 200, not 409, on a stale slice**, the way Convex's
`saveForm` does: stale and invalid slices are reported (`stale: {slice:
counter}`, `current: {slice: state}`, `problems`) and the other slices
save in one command group. `current` is what a 409 would have carried, so
the form merges and retries without another read.

**Search** keeps Convex's matching rules (every term a whole word, the
last a prefix; names with their joined forms, emails whole and split,
phones as digits and tail, postcodes compact and spaced) as a plain FTS5
`MATCH` on `contact_search_words` (unicode61 with prefix indexes). The
spike's trigram variant was measured and dropped (org schema step 3): it
was slower on every case and its index twice the size.

## Gifts (ADR 0025)

`gifts` is every payment attempt, CiviCRM-style: status `pending |
completed | failed | cancelled | refunded | charged_back | void`. Staff
set `completed` or `void` (a mistake: kept, counts for nothing); the
others are a payment provider's (`422 rejected provider_status` from
staff). Every gift has one origin: `provider` (`gocardless`, later
`stripe`) with `providerPaymentId` (unique per provider: one gift per
payment for its whole life) and `regularGiftId` (empty for a one-off),
or entered by hand (`provider` empty). Provider tables
(`direct_debit_payments`) stay the provider's raw record; no cash table
(a paying-in batch table comes with banking reconciliation).

**Only `completed` is money received.** Income, reports, dashboards and
Gift Aid read gifts through `giving::RECEIVED` (`status = 'completed'`,
spliced into SQL; `NOT_RECEIVED` its negation); `received_total` is
income over dates. `api/tests/schema.rs`
(`every_gifts_read_counts_only_money_received_or_says_why`) fails on any
SQL literal in server code that reads `gifts` or `gift_allocation_index`
without it, unless it says why in a `/* any status: … */` comment (one
gift by id, a list that marks each status). Lists show every gift,
marked; the SPA's `src/lib/domain/gift-status.ts` (`isReceived`,
`receivedTotal`) mirrors the rule.

`giving.gift` v2 carries the origin (create-only, the system's; a save
may leave it out). On a provider's gift, staff may correct the split
across codes or void it; method, amount, date, reference and status are
the provider's (`direct_debit_fixed`), and a Direct Debit gift can't be
entered by hand (`direct_debit_by_hand`). A staff void outlives later
provider updates; un-voiding gives the gift its payment's status again
(with the provider's reason), not "completed".

Org schema step 18 rebuilds `gifts` and `direct_debit_payments` (foreign
keys deferred) and gives every existing Direct Debit payment exactly one
gift: a confirmed one keeps its gift, which takes the payment's status
(a staff void stays void); one never confirmed gets a new gift with its
status, to its regular gift's code; a D2 gift a retry superseded keeps
`provider` with no payment id (void, out of the unique pair).

## Gift Aid claims

A claim is a financial record (rule 4): `gift_aid_claims` with its
`gift_aid_claim_lines` (the gift, its covering declaration, and the donor
as sent: kept through later edits and erasure) and
`gift_aid_claim_adjustments` (tax paid back on gifts that stopped
counting, voided or their payment charged back, failed or cancelled,
after an earlier claim may have gone to HMRC). `giftaid.claim` is the claim as
made (create-only, **at most 1,000 lines**: HMRC's schedule limit, one
schedule per Charities Online claim); `giftaid.claimStatus` moves it
`draft → ready → submitted → paid`, or `rejected` (from ready or
submitted, with a reason), or a draft `deleted` (kept, unlisted).
Neither is restorable. Reclaim = floor(amount / 4) per line, in pence.
"Create" over more than 1,000 eligible gifts makes several claims,
numbered in turn, oldest gifts first; the adjustments ride on the
first.

**Ready** means the claim may go to HMRC: from then on it can't be
deleted, and only then do its schedule and XML download (`claim_draft`
before). A gift voided out of a draft holds the draft back
(`voided_gifts`: delete it and claim again), and so does one whose
payment moved (`payment_moved`) or a gift it pays back that is money
received again, a chargeback cancelled since (`received_again`); deleting
or rejecting a claim lets a Direct Debit gift take its payment's amount
and date again. One voided out of a ready,
submitted or paid claim is paid back by the next claim.

**A gift is in at most one live claim**: a partial unique index on the
lines' `gift_id` where `live = 1` (deleted and rejected claims set their
lines not live). The gift itself carries the lock (`giving.claimLock`,
its own counter, set and cleared only by its claim's commands): while
locked, `giving.gift` refuses a new amount or date and `giving.status`
needs a reason to void and refuses an un-void (`422 rejected`:
`claimed_gift`, `void_reason_required`), on every path, restores
included. The declaration a completed claimed gift was claimed under
can't be voided, nor cancelled from on or before that gift's date
(`claimed_declaration`).

Eligible: completed (money received, `giving::RECEIVED`), unclaimed, received in the last 4 years and by the
end date, covered by a declaration on its date, from a person whose
name fits HMRC's name patterns once folded to ASCII (Zoë → Zoe, O’Brien
→ O'Brien), with a house name or number and a UK postcode (or an address
outside the UK, the Isle of Man and Channel Islands included; `UK`,
`United Kingdom`, England and the like count as GB). The preview lists
every other gift in range with its reasons, and counts the unclaimed
gifts too old to claim (`tooOld`).

Routes under `/api/t/{slug}`, **admin only** (reads too):

| route | |
|---|---|
| `GET giftaid/claims` | `GiftAidClaims {claims}`: newest first, deleted drafts left out |
| `GET giftaid/claims/preview?periodEnd` | `GiftAidClaimPreview {lines, adjustments, excluded, tooOld, totals, claims, …}` |
| `POST giftaid/claims {periodEnd, expectedLines?, expectedDonations?, expectedAdjustment?}` | `GiftAidClaimsCreated {claims}` (drafts); `422 rejected`: `nothing_to_claim`, `preview_changed` |
| `GET giftaid/claims/{id}` | `GiftAidClaimView`: summary, lines, adjustments, `voidedGifts` |
| `POST giftaid/claims/{id}/status {expected, status, submittedOn?, hmrcReference?, paidOn?, paidAmount?, reason?}` | `GiftAidClaimSaved` (`view` null once deleted); `expected` = `statusVersion`; `409 stale`; `422 rejected`: `claim_status`, `voided_gifts`, `payment_moved` (a draft's Direct Debit gift was collected on another day or for another amount since: delete the draft), `received_again` (a gift the draft pays back is money received again: delete the draft), `adjusted_later` (a later claim, whatever its status, pays back one of its gifts: let that go first) |
| `GET giftaid/claims/{id}/schedule?format=excel\|libreoffice` | HMRC's Gift Aid schedule (`.ods`), filled from HMRC's own template (`giftaid/assets/hmrc`); ready or later |
| `GET giftaid/claims/{id}/xml` | the claim as HMRC's R68 XML, IRmark stamped (`X-IRmark`: base32), generated and never sent; ready or later; `422 rejected`: `missing_hmrc_details`, `org_name` |
| `GET giftaid/hmrc-details` · `POST giftaid/hmrc-details {expected?, …}` | `HmrcDetailsView {…, version, warnings}`: HMRC reference, regulator and number, the authorised official (name, postcode, phone); stored as typed, what HMRC would refuse is a warning |
## Declaration scans

Plan `factory/plans/declaration-scans.sv` (confirmed 2026-10-29); ADR
0024's amendment (an organisation is two files). Staff on a laptop scan
paper Gift Aid declarations with a phone that isn't signed in. HMRC
3.7.2: the image is the record, not the typed fields.

**Storage.** Page images are blobs in the org's files db
(`files/<tenant-id>.db`, `store::files`): SHA-256 keys, immutable, no cap
per org unless `KEEP_FILES_CAP_BYTES` sets one (`422 rejected
files_full` past it). The org file holds
`declaration_scans` and their `declaration_scan_pages` (`giftaid::scans`,
org schema step 19). Three contracts partition a scan:
`giftaid.scan` (via, pairing, who and when, the pages; edited only as a
draft), `giftaid.scanReview` (accept onto a `paperForm` declaration of the
contact on screen that isn't void and holds no other scan, or discard;
once) and `giftaid.scanRetention` (the images went: a discard after 30
days, the admin's report, erasure; the row stays). None can be restored.
Accepting writes nothing on the declaration (declarations stay
create-only) and never changes coverage (rule 1). Uploads go blob first,
then the contract; deletions go contract first, then blob. A daily sweep
removes blobs no live page names that were put over a day ago, and
nothing it removes was put in the last hour.

**Pairing** (`api::scans`): `POST scan-pairings` (staff or admin, a
sign-in or step-up within the hour) makes a 256-bit token. Only its
SHA-256 is kept, in `platform.db` (`scan_pairings`: tenant, user, the
laptop's session, purpose, expiry, device, uploads). The QR code holds
`/scan.html#<token>`: the token is in the fragment, so no page request or
`Referer` carries it. The phone page reads it from `location.hash` and
calls `/api/scan/{token}`. A pairing is live while it isn't ended, is
under 2 h old and was used in the last 15 min, its laptop session is
live, and its user is still staff or admin of the org. Triggers on
`auth_sessions` end it whenever its session row goes (sign-out,
revoke-all, expiry, removal) and follow a token rotation (step-up);
"sign out other sessions" and a password change end all the user's
pairings, this session's too. The
first `GET` claims it for that device. The device cookie is `__Host-kt_scan`,
`kt_scan` on a loopback host: `HttpOnly; SameSite=Strict; Secure`, 256
bits, stored hashed. Another device gets `403 forbidden`. Dead, unknown
or malformed: `410 gone`. An upload's token and cookie are checked before
its body is read (`api::body`), and the body is held to 1 MB (0 on the
phone's `GET`). At most 8 uploads are in flight across the process,
counted before their bodies are read (`503 busy` past that), and an
upload that would take the data volume below its reserve is refused
(`507 storage_full`; `KEEP_FILES_DISK_RESERVE_BYTES`). Each page
uploaded counts towards 300 per pairing (`422 rejected upload_limit`).
The token is never logged, and Sentry events have `/api/scan/<token>` and
any 64-hex run redacted.

**Upload pipeline** (`api::scans::image`): JPEG or PNG by magic bytes
only. Over 6000 px a side, 16 MP or 64 MB decoded (a 16-bit PNG counts
double) in the header is refused before decoding (decompression bombs),
and the decoder runs under `image::Limits`, one at a time. The page is greyscaled, its long side capped at 1754 px
(A4 at 150 dpi) and re-encoded as JPEG from raw pixels, so no EXIF or GPS
survives. Quality steps 80 → 50 until it fits 400 KB; still over is `422
invalid`. Not an image or unreadable: `422 invalid {field: "image"}`.

The phone's routes (outside the tenant prefix; `ScanSitting`, `ScanUploaded`):

| route | |
|---|---|
| `GET /api/scan/{token}` | claims the link for this device (sets the device cookie if it has none) or reopens it → `ScanSitting {orgName, purpose, expiresAt, idleExpiresAt, uploadsLeft, maxPages, maxPageBytes, scans: [{id, pages, open}]}`, `Cache-Control: no-store`; another device `403`; dead `410` |
| `POST /api/scan/{token}/scans?id=` | body: one page's image (raw bytes, any content type) → `ScanUploaded {scanId, pages, uploadsLeft}`: a new draft. `id` (32 hex, optional) is the phone's key: a retry with it answers the same scan |
| `POST /api/scan/{token}/scans/{scanId}/pages?pageId=` | body: the next page → `ScanUploaded`; only onto one of this sitting's drafts (else `404`); `pageId` (32 hex, optional): a retry with a `pageId` the scan already holds answers as landed (the same scan and count, nothing stored or counted), even after the scan was accepted or discarded; a new page on a non-draft is refused; a 7th page `422 rejected page_limit` |

Under `/api/t/{slug}` (types in `src/lib/data/rust-types/`; live updates
are `declaration_scans` events on the org's stream):

| route | |
|---|---|
| `POST scan-pairings {purpose: stack\|contact\|gift}` | `ScanPairingStarted {pairing: ScanPairingView, path}`: `path` is `/scan.html#<token>`, shown once. Staff or admin; a viewer `403`; no recent sign-in `403 step_up_required` |
| `GET scan-pairings/{id}` | `ScanPairingView {id, purpose, startedBy, createdAt, expiresAt, idleExpiresAt, claimed, endedAt, uploads, scans: ScanView[]}`: the sitting's stack; staff or admin |
| `DELETE scan-pairings/{id}` | ends it now (the phone gets `410`) → `ScanPairingView` |
| `GET scans` | `ScanView[]`, "Scans to match": every draft, oldest first (≤ 500); staff or admin |
| `POST scans?id=` · `POST scans/{id}/pages?pageId=` | a signed-in phone's upload (`via: direct`), as the phone routes → `ScanUploaded` (`uploadsLeft: null`) |
| `GET scans/{id}` | `ScanView {id, status: draft\|accepted\|discarded, via, pairingId, scannedBy, scannedAt, declarationId, reviewedBy, reviewedAt, discardReason, imageDeletedAt, deletionReason, pages: [{id, pageNo, width, height, size}], scanVersion, reviewVersion, retentionVersion}`; staff or admin |
| `GET scans/{id}/pages/{n}` | the page's image: `image/jpeg`, `Cache-Control: private, max-age=3600`, `nosniff`; no such page or its images gone `404`; staff or admin |
| `POST scans/{id}/reorder {expected, order}` | `expected` = `scanVersion`; `order` = the page ids to keep, in order (≥ 1) → `ScanView`; reviewed `422 rejected not_draft` |
| `POST scans/{id}/merge {expected, from, fromExpected}` | `from`'s pages appended here, `from` discarded ("Merged into another scan"), one group; `expected` = this `scanVersion`, `fromExpected` = `from`'s `reviewVersion` → `ScanView` |
| `POST scans/{id}/accept {expected, contactId, match}` | `expected` = `reviewVersion`; `match` = `{kind: "existing", declarationId}` or `{kind: "new", declaration: DeclarationPayload}` (recorded in the same command group: both or neither) → `ScanAccepted {declarationId, scan}`; `422 rejected`: `not_paper_form`, `voided_declaration`, `unknown_declaration` (not the contact's), `declaration_has_scan`, `reviewed` |
| `POST scans/{id}/discard {expected, reason?}` | → `ScanView`; images go after 30 days, the row stays |
| `POST scans/{id}/delete-images {expected}` | admin within the step-up hour; `expected` = `retentionVersion`; only a scan in the report (`422 rejected retention_running` otherwise) → `ScanView`; the image is unreachable at once, its blob goes after |
| `GET giftaid/scans/deletable?today` | admin within the step-up hour: `DeletableScan[] {scan, contactId, declarationMadeOn, lastCoveredOn}`, accepted scans whose declaration covered no gift (money received) for 7 years, counted from its last covered gift or, with none, from when it was made |
| `GET giftaid/{id}/scans` | `DeclarationScans {held: [{id, scannedAt, reviewedAt, imagesHeld}], scans: ScanView[] \| null}`: any member sees "✓ scan held" and when; `scans` for staff and admins only |
| `GET files-usage` | `FilesUsage {bytes, capBytes}` (Settings); staff and admins |

The phone's page is `scan.html` with `src/scan/` (step 5): its own Vite
entry with none of the app's bundle, served from `dist/` like the SPA.

Not built here (later steps or plans): the phone page for a signed-in
phone (`POST scans` under the tenant); erasure and
org deletion (`giftaid::scans::erasure_deletes` says what they must do:
keep a scan whose declaration covers a claimed gift, admin-only, until its
retention ends; delete the rest); viewer-only-once-erased image access
(admins only after erasure), which needs erasure's flag on the contact.
Pairing state (claimed, ended) is not an org event: the laptop refetches
`scan-pairings/{id}` on `declaration_scans` events and on a timer.

## GoCardless (Direct Debit)

`api::gocardless`, plan `factory/plans/gocardless.sv` (D1, D2, round 2:
ADR 0025). Each
organisation connects its own GoCardless account through GoCardless's
partner OAuth; donors' money goes straight to it. The organisation's
access token is an org secret (`platform::settings`,
`gocardless.accessToken`, sealed under `KEEP_SETTINGS_KEY`); `platform.db`
(`api::gocardless::SCHEMA`) holds which GoCardless organisation is which
of ours, the single-use OAuth states (10 minutes, bound to the admin's
session) and every webhook event by id.

Webhooks: `POST /api/gocardless/webhook`, one route for every
organisation. The raw body's HMAC-SHA256 must match `Webhook-Signature`
(constant time) or the answer is `498`; a signed batch is stored event by
event (`INSERT OR IGNORE` on the event id: a repeat is a no-op), routed by
`links.organisation` (an organisation not connected here is stored as
handled and logged by id only), answered `204`, and handled in the
background and by the `gocardless-events` job (30 s), one org file at a
time in arrival order, each event in its own transaction as the system
(`api::gocardless::process`). Nothing is dropped: a retryable failure
holds back that organisation's later events and waits 30 s doubling to
an hour; after 50 tries (about two days), or at once if GoCardless
refused the request, the event is parked (outcome `failed`: logged, sent
to Sentry, never purged, `failedEvents` in `GET gocardless`, requeued by
an admin's `POST gocardless/events/retry`). After each run a sweep gives
any connected organisation's regular gift with a mandate but no
subscription its subscription; if GoCardless refuses, a dead mandate
ends the regular gift and a live one is backed off, then given up on
after 8 refusals (reported). A connected organisation whose file has no
token (a connect still landing) retries, and an event for an account the
organisation no longer holds is set aside, never run with another
account's token. A mandate event identifies its regular
gift from the metadata GoCardless copies from our billing request, and
never makes a subscription itself.

Connecting: one connect at a time (the code exchange, the ownership check
and the token's install); the account is reserved in `platform.db`
before any token is sealed. "Connected" means owning that mapping, not
holding a token. An account another group holds is refused (`taken`) and
the new token, which GoCardless issues by disabling the old, is sealed
into the holder's file. Disconnecting takes the same lock; a revoke
GoCardless refuses outright counts as done, one it rate-limits or fails
(429, 5xx) is a 503. Switching accounts revokes the old account's
token and counts as disconnecting it. Disconnecting (or switching)
doesn't stop GoCardless collecting: the group's queued events for that
account are set aside and later ones kept from the purge, and connecting
the same account again replays them in order, once its token is in place
(runs are held off meanwhile). Another group connecting the account
never gets them.

Org schema step 17 rebuilds `gifts` (SQLite can't widen the method's
CHECK in place) with foreign keys deferred and checked after, carrying
every column and index it has by then, Gift Aid claims' void reason,
claim lock and partial indexes included.

Regular gifts (`giving::regular`): the set-up (`giving.regularGift` v2:
the donor; its terms are a dated chain, below), where it stands at GoCardless
(`giving.regularGiftMandate`: status `pending → active →
cancelled/failed`, billing request and hosted link, mandate and
subscription ids, why it ended), and one `giving.directDebitPayment` (v2)
per GoCardless payment: the raw record (amount, charge date, status,
reason, the mandate and regular gift) beside its gift.

**Every payment is one gift** (ADR 0025), made the first time we hear of
it and following it in the same transaction as its payment row
(`giving::regular::record_payment`): `pending` until GoCardless says
`confirmed` (only then money received), `failed`, `cancelled` or
`charged_back` after, with GoCardless's reason (`voidReason`); a cancelled
chargeback or a collected retry makes it `completed` again. Its amount
and date follow the payment: dated the day GoCardless collected it (the
charge date, which decides the tax year), so a retry collected on another
day moves the same gift. A gift in a Gift Aid claim keeps the amount and
date it was claimed on; its status still follows, and a claimed gift that
stops counting is paid back by the next claim (an adjustment); if its
money comes back before that claim, nothing is repaid (after it, the tax
stays repaid: re-claiming it is a follow-up).

Whose a payment is: its subscription's regular gift (an instalment;
also a subscription payment on its mandate before the subscription id is
recorded, and a payment stored unmatched that its regular gift turns out
to own);
else our one-off tag (`metadata.keep_contact`/`keep_source_code`, on a
payment staff took or an Instant Bank Pay request, whose `fulfilled`
event names its payment); else a mandate we know (a one-off from its
donor, to that regular gift's code; `regularGiftId` empty); else nobody
yet: stored **unmatched** (no gift; event outcome `unmatched`) and listed
for staff to match. A payment in another currency is logged and sent to
Sentry, never recorded. `keep giving-consistency <slug>` and
`giving::regular::consistency` check that every matched payment has
exactly one gift agreeing with it.

**Who asked** (review M2): a staff one-off or Instant Bank Pay link is
first recorded as the staff member (`giving.providerRequest`,
`provider_requests`: kind, donor, regular gift, amount, code, charge
date; the form's `clientKey` is its id, so a retry is the same request,
and a key reused for another donor or kind is `409 duplicate`), then
GoCardless is called with the request id as `metadata.keep_request`, and
GoCardless's id for what it made is added to the request. The gift that
comes from GoCardless's events is made with the requester as its actor:
`enteredBy` and its history ("…, as asked by staff") name them.

**Catch-up** (`api::gocardless::catchup`, job `gocardless-catchup`,
daily, first run 15 minutes after boot): for each connected
organisation, GoCardless's events for its account since the last run
(`GET events`, 500 a page; the cursor per organisation and account in
`platform.db`'s `gocardless_catchup`, read again from an hour before;
an account's first run from its connection, at most a week back; never
further back than 85 days, inside the 90 days handled events are kept;
only with a token sealed for that account, `gocardless.organisationId`
beside `gocardless.accessToken`, so a switch still landing is skipped)
go into
the same event store, a repeat being a no-op. How many were new is
logged, and sent to Sentry as a warning when not zero (webhooks are
being missed); then a processing run handles them.

| route | |
|---|---|
| `GET /api/gocardless/callback?code&state` | GoCardless's OAuth redirect: the state checked and spent, the code traded, the token sealed into the org file, the account recorded (one already another group's: refused). Lands on `/t/{slug}/settings?gocardless=connected\|denied\|taken\|failed\|forbidden`, or `/?gocardless=expired` |
| `POST /api/gocardless/webhook` | above |
| `GET /api/t/{slug}/gocardless` | `GoCardlessStatus {enabled, mode, connected, organisationId, connectedAt, connectedBy, failedEvents}`, any member; the only route that answers when off |
| `POST …/gocardless/events/retry` | parked events back in the queue, a run started → `GoCardlessStatus`; admin within the step-up hour |
| `POST …/gocardless/connect` | → `ConnectStart {url}`: send the browser there; admin within the step-up hour |
| `POST …/gocardless/disconnect` | revoke the token at GoCardless (one it no longer knows counts as revoked), forget it and the routing → `GoCardlessStatus`; admin within the step-up hour; regular gifts stay, `connected: false`, and GoCardless keeps collecting (kept for a reconnect) |
| `GET …/contacts/{id}/regular-gifts` | `RegularGiftView[]` (each with its latest 100 payments and `lastFailure`), newest first |
| `POST …/contacts/{id}/regular-gifts` | `SetUpRegularGift {amount, frequency: monthly\|yearly, dayOfMonth: 1–28, month?, sourceCodeId, clientKey?}` → `RegularGiftSaved {id, view}` with `view.flowUrl`, the donor's GoCardless page; staff. Checked first (`422`, `409 duplicate`), then GoCardless makes the billing request (Bacs, GBP) and the page, then it is stored; not connected `422 rejected not_connected` |
| `GET …/regular-gifts/{id}` | `RegularGiftView` |
| `POST …/regular-gifts/{id}/link` | `{expected}` (`mandateVersion`) → a new hosted page (one lasts 7 days) while pending; staff |
| `POST …/regular-gifts/{id}/one-off` | `TakeOneOff {amount, chargeDate?, sourceCodeId, clientKey}` → `OneOffStarted {requestId, paymentId, status, chargeDate}`: GoCardless takes a payment on the mandate once (idempotent per `clientKey`, 32 hex), tagged with the donor and code; the gift comes from its events; staff. No live mandate: `422 rejected no_mandate`; over £1,000 (`giving::rules::ONE_OFF_MAX`, admins too): `422 invalid` (`amount`: ask for a bank transfer) |
| `POST …/contacts/{id}/instant-payment` | `InstantPayment {amount, sourceCodeId, description?, clientKey}` → `InstantPaymentLink {requestId, billingRequestId, flowUrl, flowExpiresAt}`: an Instant Bank Pay request (a payment request, no mandate; the group switches Instant Bank Pay on in GoCardless) and its hosted page; only the request (who asked) is stored here; staff; over £1,000: `422 invalid`, as a one-off |
| `GET …/gocardless/unmatched` | `UnmatchedPayment[]`: payments nobody could be matched to (no gift), newest first, at most 500; any member |
| `POST …/gocardless/unmatched/{id}/match` | `MatchPayment {expected, contactId, sourceCodeId}` → `MatchedPayment {giftId, gift}`: the contact's gift, with GoCardless's amount, date and status; staff; `409 stale`; `422 rejected already_matched` |
| `POST …/regular-gifts/{id}/cancel` | `{expected}` → cancels the mandate (or the unsigned billing request; one the donor fulfilled meanwhile: the mandate it made) at GoCardless, then `cancelled` "Cancelled by staff" (or GoCardless's reason, if its webhook landed first), its scheduled changes withdrawn; staff. An adopted gift (no mandate of its own), or one whose mandate another live regular gift collects on, has only its subscription cancelled, never the shared mandate |

### Regular gift terms (ADR 0026)

A regular gift's amount, schedule and split by source code are a dated
chain (`giving::terms`, plan `factory/plans/regular-gift-terms.sv`):
`regular_gift_terms`, one row per change, in force from the first
payment it governs (`effectiveFrom`, or `appliesFrom` when it missed
that payment: `effectiveOn` is what the chain reads), with its split
(`regular_gift_term_allocations`, child rows, oldest money first,
summing to the amount). Set-up writes row 1 (one code, applied). A row
is three slices: `giving.regularGiftTerms` (`termsVersion`: terms,
split, note, withdrawn; staff edit or withdraw only while `scheduled`,
else `422 rejected term_sent`), `giving.regularGiftTermSync`
(`syncVersion`, the system's: `scheduled → sending → sent → applied`,
subscription, `sentAt`, `appliesFrom`) and `giving.regularGiftTermCode`
(`codeVersion`: the code credited with the change, at any state). The
pure rules (`giving::terms_rules`, twin `src/lib/domain/regular-terms.ts`)
move a split by layers, never dividing: an upgrade's difference to the
code that won it, a downgrade off the newest money first, a payment's
different amount on the newest layer. Each payment's gift copies the
split in force on its `scheduledOn` (the charge date GoCardless first
gave it, kept through retries: its period).

Sending (`api::gocardless::terms_sync`, job `regular-terms-sync`): a
scheduled row is taken (`sending`) 14 days before it takes effect; if
its payment exists already at the old terms (or on the old schedule) it
moves to the next one (`appliesFrom`); a gift's later rows wait while an
earlier one hasn't gone through; an amount on the same schedule is a `PUT
subscriptions/{id}`; a new day, frequency or month, or a change past
GoCardless's 10 per subscription (counted from the chain), makes a new
subscription on the same mandate from the effective date (idempotency
key `keep-sub-{term id}`, `start_date` its own payment date on the
new day, at least 5 days out), which becomes the regular gift's, and
cancels the old one (whose `cancelled` event then ends nothing; its
payments stay instalments). The row is `sent` only once the old one is
cancelled: a cancel that fails leaves it `sending`, and the next run
cancels again. A gift that ended mid-send has the new subscription
cancelled. GoCardless refusing a row for good (a 4xx) puts it back to
`scheduled` with `syncError`, for staff to edit or withdraw; it isn't
tried again until edited, and the gift's later rows wait for it. A
gift that ends while a new subscription is in flight has both the new
one (found again by the row's key if its id was lost) and the old one
cancelled. Then `sent`; GoCardless's
`subscriptions.amended`, or the first payment at the new terms, makes
it `applied`. An `amended` by API call that isn't ours to apply (a
replay, a late event) records nothing; one from elsewhere
(`details.origin` not `api`) records a row from the next
payment, `origin: gocardless`, noted "changed in GoCardless", uncoded
(`changeNotCoded` on the regular gift until staff code it). A payment
from a subscription nobody here set up, on a mandate we know, is a
one-off gift; the subscription is listed to adopt.

Expected against actual (`giving::expected`) is derived, never stored:
periods are months (a yearly row's in its month), from the regular
gift's first payment's period (active with none yet: its first row) to
its cancellation. Statuses: `collected`, `pending`, `failed` (arrears:
failed, charged back, refunded), `cancelled`, `missing` (no payment once
due), `upcoming`.

| route | |
|---|---|
| `GET …/regular-gifts/{id}` | `RegularGiftView`: as before, plus the chain (`terms: TermView[]`, withdrawn rows included, each with `changeKind`: `setup \| upgrade \| downgrade \| schedule \| reallocation \| unchanged`), `allocations` (the split in force), `scheduled` (the next change still to send), `changeNotCoded`, and `upcoming: {chargeDate, amount, changeable}[]` (GoCardless's forecast while connected, else the chain's; `changeable`: more than a week off and not created yet). `setupVersion` replaces `termsVersion` |
| `POST …/regular-gifts/{id}/terms` | `ChangeTerms {effectiveFrom, amount, frequency?, dayOfMonth?, month?, changeCodeId?, allocations?, note?, clientKey?}` → `RegularGiftSaved`: a scheduled row, a sync run started; staff. Without `allocations` the split is the row before's, moved; an upgrade needs `changeCodeId` (`422 invalid`); a new frequency needs `allocations`; `effectiveFrom` after today, after the last row GoCardless has (`term_too_early`), on no other live row's day (`term_clash`), and one of the new terms' payment dates (its day, up to 4 days after for a weekend or holiday; its month when yearly; `422 invalid effectiveFrom`); an ended gift: `regular_gift_ended` |
| `POST …/regular-gifts/{id}/terms/{termId}` | `EditTerms {expected (termsVersion), codeExpected? (codeVersion, needed when the code changes), …ChangeTerms}` → `RegularGiftSaved`; staff; scheduled only (`term_sent`); the same date checks; `409 stale` |
| `POST …/regular-gifts/{id}/terms/{termId}/withdraw` | `{expected}` (termsVersion) → `RegularGiftSaved`; staff; scheduled only |
| `POST …/regular-gifts/{id}/terms/{termId}/code` | `CodeTerms {expected (codeVersion), changeCodeId}` → `RegularGiftSaved`; staff; any state |
| `GET …/regular-gifts/{id}/expected?from&to` | `ExpectedRow[] {period, dueOn, expected, split, termId, status, giftId, amount}`, months `YYYY-MM` (default the 12 to this one, at most 120); any member |
| `GET …/reports/expected?from&to&by=code\|detail\|category` | `ExpectedReport {lines, total, upgrades, notRealised}`: per group `expected`, `received` (the matched gifts' own allocations), `failed`, `missing`, `pending`; `upgrades` by the code credited (`annual` = change in annual value, `monthly` beside it, counted in the period of the first payment collected at the new amount); `notRealised`: upgrades taking effect in range that never collected; any member |
| `GET …/gocardless/unknown-subscriptions` | `UnknownSubscription[] {subscriptionId, mandateId, contactId, payments, lastAmount, lastChargeDate}`; any member |
| `POST …/gocardless/unknown-subscriptions/{id}/adopt` | `{sourceCodeId, clientKey}` → `RegularGiftSaved`: active, the subscription its own, row 1 applied from GoCardless's terms from its next payment; nothing sent to GoCardless; staff; `422 rejected unsupported_schedule` (weekly, a day past the 28th), `subscription_not_active` |

Every row is financial history (rule 3): erasure keeps the chain.

The fake (`KEEP_GOCARDLESS=fake`, `api::gocardless::fake`) answers the
calls the client makes in GoCardless's shapes, hosts the consent page and
the donor's sign-up page, and signs its webhooks like GoCardless. Its
scenario simulators (`POST /api/fake-gocardless/simulate/…`: a mandate's
`activate|fail|cancel|expire` or a one-off `payment` on it (no metadata),
a subscription's next `payment`, a stranger's payment
(`organisations/{OR…}/payment`), a payment's
`retry|submit|confirm|fail|charge_back|cancel_chargeback`; `outage`
`{calls, status?, path?, delay_ms?}`; `webhooks/hold` and
`webhooks/release?reverse`) drive the rest, and its consent page can pick
an existing account. Beyond D2's calls it answers `POST payments` (a
one-off), `GET events` (newest first, `created_at[gte]`, `after`),
`PUT subscriptions/{id}` (the amount, at most 10 times, with an
`amended` event), `GET subscriptions/{id}` with `upcoming_payments`
(and `subscriptions.payment_created` with each simulated payment; the
simulators `subscriptions/{id}/amend?amount=` and
`mandates/{id}/subscription?amount=` are changes made in GoCardless's
dashboard) and Instant Bank Pay requests, whose page is "Pay by bank" (the payment it
makes carries no metadata: only the request's `fulfilled` event names
it). `api/tests/gocardless.rs` and `qc/flows/gocardless.spec.ts` run on
it.
