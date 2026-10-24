# rs/ — Rust + SQLite spike

The experiment in `factory/plans/rust-spike.sv`: the contacts slice
rebuilt on axum + rusqlite, one SQLite file per organisation. `convex/`
and `main` are untouched; the SPA picks a backend with
`VITE_BACKEND=convex|rust`.

```
cargo test                       # from rs/: every crate; also re-exports the TS types
KEEP_DEV_AUTH=1 cargo run -p api # http://127.0.0.1:8787, data in rs/data/
```

Env: `KEEP_DATA_DIR` (default `data`), `KEEP_PORT` (default 8787),
`KEEP_DEV_AUTH=1` (dev login; without it no session is honoured),
`KEEP_QC_SEED=1` (with dev auth: `POST /api/dev/qc-seed` and `qc-crowd`).

The 10k measurement (`scripts/perf-search10k-rs/`):

```
node scripts/perf-search10k-rs/export-jsonl.mjs $TMPDIR/rs10k      # from the repo root
cargo build --release -p seed -p api                               # from rs/
./target/release/seed --data data --slug perf-a --admin perf-a@example.com --jsonl $TMPDIR/rs10k/a.jsonl --prefix perfa
./target/release/seed --data data --slug perf-b --admin perf-b@example.com --jsonl $TMPDIR/rs10k/b.jsonl --prefix perfb
KEEP_DATA_DIR=data KEEP_DEV_AUTH=1 ./target/release/api &
node ../scripts/perf-search10k-rs/measure.mjs --out $TMPDIR/rs-measure
node ../scripts/perf-search10k-rs/analyze.mjs $TMPDIR/rs-measure/raw.json --rtt 30
```

## Crates

| crate | owns |
|---|---|
| `store` | `platform.db` (tenants, users, memberships, sessions) and `orgs/<tenant-id>.db`; pragmas (WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout`); one writer per file behind a mutex + a read-only reader pool; migrations on open |
| `contracts` | `Contract` trait, `execute`, revisions, command groups, restore through upcasters, child-row reconcile |
| `contacts` | the Contact aggregate: slices as contracts, dropdown fields, the FTS projection, list/search/get/history (no `store::Platform`, no tenant) |
| `api` | axum app: dev session cookie, `/api/t/{slug}` → one `OrgDb`, `Server-Timing`, JSON errors; `schema.rs` is the org migration list; `routes/` the domain routes and the QC seed |
| `seed` | bin: the perf generator's JSONL into one organisation, through the same contract functions the API calls |

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

Domain crates (`contacts`) depend on `contracts` and take `&OrgTx` /
`&OrgRead` / `&Ctx`. They never depend on `store::Platform` and never
name an organisation.

## HTTP conventions (what the SPA codes against)

- **Paths.** Reads are `GET /api/t/{slug}/<resource>[/{id}[/…]]`. Each
  contract command is one `POST` (RPC, not REST):
  `POST /api/t/{slug}/contacts` (create),
  `POST /api/t/{slug}/contacts/{id}/save` (the form: several slices, one
  transaction, one command group), `POST …/{id}/archive`, `…/{id}/restore`.
- **JSON**, `camelCase` field names (as the Convex side), ids are
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
  | 409 | `stale` | `{contract, counter, current}` |
  | 409 | `duplicate` | `{id}`: create with a pre-generated id that exists |
  | 422 | `invalid` | `{problems: [{field, message}]}`: unstorable input, including a malformed body |
  | 422 | `rejected` | `{reason, message}`: refused (e.g. `identity_immutable`) |
  | 500 | `internal` | details only in the server log |

  Tier-2 warnings (ADR 0015) aren't errors: they ride along in read
  responses.
- **Auth (stub).** `POST /api/dev/login {email}` sets the `kt_session`
  cookie (HttpOnly, SameSite=Lax); `POST /api/dev/logout`; `GET /api/me`
  → `Me {email, memberships: [{slug, name, role}]}`;
  `POST /api/dev/tenants {slug, name}` makes an org with the caller as
  admin; `GET /api/t/{slug}` → `TenantInfo`. All dev endpoints are
  refused unless `KEEP_DEV_AUTH=1`. In dev, Vite proxies `/api` to :8787,
  so the cookie is same-origin.
- **Timing.** Every `/api` response has
  `Server-Timing: platform;dur=…, db;dur=…, total;dur=…` (ms).
  `platform` = session + membership lookup, `db` = time inside org-file
  closures (writer lock wait included).
- **Types.** `#[derive(TS)] #[ts(export)]` on every request/response type;
  `cargo test` writes them to `src/lib/data/rust-types/` (committed, like
  `convex/_generated`; never edit by hand). Payload JSON with no fixed shape
  is typed `unknown`.

## Writing a domain route (for step 2a)

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
`Router` with `api::app(state, routes)`; add schema steps to
`api::schema::org_migrations()` (append-only).

## Contracts

`Contract` = `NAME`, `VERSION`, `ENTITY` (root table, `id TEXT`),
`COUNTER` (an `INTEGER NOT NULL DEFAULT 0` column on the root), `Payload`,
`State`, and `prepare` → `load` → pure `apply(current, payload, command)`
→ `write` → `project`, plus `upcast(from, payload)` steps and
`restore_payload`. `execute` runs inside the caller's transaction:
counter check (stale ⇒ nothing written), apply, write, counter bump,
revision row (prepared payload, name, version, counter, actor, source,
group), projection. `command_group(ctx, name)` labels several commands
in one transaction. `restore` re-executes a revision as a new command
through the upcaster chain; `restore_entity_to(at)` restores every slice
that differs from its state at `at`. Child rows: `mint_ids` in `prepare`,
`reconcile` in `write` (by id; identity fields immutable per id).

## Contacts (step 2a)

Slices, each a contract with its own counter column on `contacts`:
`contacts.details` (v1), `contacts.methods` (emails + phones; the
address / number is the identity per key), `contacts.addresses` (no
identity: editable in place), `contacts.archive`, `contacts.fields`
(dropdown values: rows of `contact_field_values`, not Convex's slots).
Field definitions are `contacts.field` and `contacts.fieldOption`. The
contact number is the rowid (`number INTEGER PRIMARY KEY`), handed out from
`contact_number_sequence` on create; `id` is the API's UUIDv7.

Routes under `/api/t/{slug}` (types in `src/lib/data/rust-types/`):

| route | |
|---|---|
| `GET contacts?includeArchived&kind&fields&cursor&limit` | `ContactPage`: keyset pages on `(sort_key, id)`, ≤100 rows |
| `GET contacts/search?q&includeArchived&kind&fields&fts` | `SearchResult`: exact matches first, then FTS |
| `GET contacts/{id}` | `ContactView`: every slice, counters, warnings |
| `GET contacts/{id}/history?before&limit` | `HistoryPage`, newest first |
| `POST contacts` | `CreateContact` → `Created {id, number}`; a seen `clientKey`/`id` is `409 duplicate` |
| `POST contacts/{id}/save` | `SaveForm` → `SaveFormResult` (below) |
| `POST contacts/{id}/archive` | `{expected, archived}` → `Executed`, or `409 stale` |
| `POST contacts/{id}/restore` | `{revisionId}` or `{at}` → `Restored` |
| `GET fields` · `POST fields` · `POST fields/options` | definitions; saving them needs admin |

`fields` filters are `fieldId:optionId` or `fieldId:none`, comma-separated.

**The form save answers 200, not 409, on a stale slice**, the way Convex's
`saveForm` does: stale and invalid slices are reported (`stale: {slice:
counter}`, `current: {slice: state}`, `problems`) and the other slices
save in one command group. `current` is what a 409 would have carried, so
the form merges and retries without another read.

**Search** keeps Convex's matching rules (every term a whole word, the
last a prefix; names with their joined forms, emails whole and split,
phones as digits and tail, postcodes compact and spaced). Two FTS5 tables
are kept side by side for the measurement; `fts=words` (unicode61 with
prefix indexes, the default) or `fts=trigram`. Words is the choice: the
rules are a plain `MATCH`, it was faster on every case, and its index is
half the size. Trigram matches substrings, so it needs the word rules
checked per row, and entries under three characters fall back to a scan.
