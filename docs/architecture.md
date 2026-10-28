# Architecture overview

One paragraph: a static React SPA talks JSON over HTTP, plus one
server-sent event stream, to **one Rust api per environment** (axum +
rusqlite) that keeps **each organisation in its own SQLite file**;
`platform.db` holds the users, groups, memberships and sessions. The file
is the tenancy boundary, so domain code is single-org. Every domain write
is a *contract* (a full-state slice applied in a transaction, with a
per-slice counter and an appended revision). Litestream streams every
file to S3 and an hourly job snapshots changed files to a separate,
locked bucket. Decisions and rationale live in [decisions/](decisions/)
(the stack is [0024](decisions/0024-rust-sqlite-per-org.md); the
founding decision is [0017](decisions/0017-convex-react-shared-tenancy.md));
the domain reference is [research.md](research.md); how it runs is
[ops.md](ops.md); the api's own conventions are `server/README.md`.

## System shape

```
┌──────────────────────────────────────────────────┐
│  Browser — React SPA (static files, same origin) │
│  TanStack Router + Query · shadcn/Tailwind       │
│  one EventSource per open group                  │
└───────────────┬──────────────────────────────────┘
                │ HTTPS: JSON (/api/…) · SSE (/api/t/{slug}/events)
┌───────────────▼──────────────────────────────────┐
│  Fly machine (lhr), one per environment          │
│  litestream replicate (PID 1)                    │
│  └─ api (axum)                                   │
│     auth · /api/t/{slug} → that org's file       │
│     contracts · SSE · jobs · /healthz · the SPA  │
│  volume /data: platform.db, orgs/<tenant>.db     │
└───────┬───────────────────────────────┬──────────┘
        │ WAL frames, every second       │ hourly, changed files
┌───────▼──────────────┐      ┌─────────▼──────────────────┐
│ S3 (keep-prod)       │      │ S3 (keep-backup), Object   │
│ Litestream, 7 days   │      │ Lock: 48 h / 30 d / 12 mo  │
└──────────────────────┘      └────────────────────────────┘
```

## Request flow

- **Boot:** the SPA asks `GET /api/me` for the session and the user's
  groups; on a group's pages one `GET /api/t/{slug}/boot` seeds the
  query cache (the first contacts page, the fields), then the page opens
  the group's event stream.
- **Tenancy:** a request reaches `/api/t/{slug}/…`; the session cookie
  resolves to a user, the user's membership of `slug` to a tenant id, and
  that to the one org file (opened once, kept in an LRU). Handlers get a
  `Tenant` and can only `read` or `write` that file. Not a member or an
  unknown slug: the same `403`.
- **Writes:** the form posts the slice's full state plus `expected` (its
  counter). `contracts::execute` checks the counter, runs the pure apply,
  writes the rows, bumps the counter, appends a revision and runs the
  projection hook, in one transaction (a savepoint per contract). A
  command over several slices is one transaction under a named command
  group.
- **Live updates:** after the commit, each executed contract is one SSE
  event `{seq, entity, id, contract, counter}` (ids only); the SPA
  invalidates the queries that show that entity and refetches. A
  reconnect replays from `Last-Event-ID`.
- **Conflicts:** a stale `expected` answers `409 stale` with the slice's
  current state; the form does a per-field three-way merge (base / local /
  remote) and retries; only a field changed by both sides is shown as a
  conflict. An event for the open contact with a newer counter merges the
  same way while the user types.
- **No optimistic financial records:** gifts and other financial records
  are never shown optimistically; the UI shows a change once the server
  confirms it (human, 2026-10-23).
- **Background:** in-process jobs (`api::jobs`) visit org files one at a
  time (`each_org`): session purge, field retires, idle handle close,
  the hourly snapshot.
- **Schema:** every org file is migrated to head at boot, copied first,
  failing the boot if one can't be.

## Repo map

| Path | What lives there |
|---|---|
| `server/crates/store` | the files: pragmas, writer + reader pool per file, handle LRU, boot migration, event channels |
| `server/crates/contracts` | `transact`, `execute`, revisions, command groups, restore + upcaster chain, child-row reconcile |
| `server/crates/{contacts,sources,giving,giftaid,comms}` | domain modules: contracts, pure rules, reads, their tests |
| `server/crates/{platform,auth}` | control plane and staff auth (`platform.db`) |
| `server/crates/api` | the HTTP app, routes, SSE, jobs, backups, `schema.rs` (org migrations); commands spanning modules |
| `server/crates/{cli,seed}` | `keep`, and the `riverside`/`perf` seeds |
| `src/routes/` | file-based routes (`__root.tsx` wraps providers) |
| `src/lib/data/` | TanStack Query over the api, the SSE client, wire adapters, generated ts-rs types |
| `src/lib/domain/` | the shapes the pages render; pure rules shared with the server |
| `src/components/ui/` | shadcn components (generated into the repo) |
| `qc/` | Playwright QC flows and budgets |
| `docs/decisions/` | ADRs: 0024 for the stack, 0017 for the founding decision and the ngo-go ADRs that still apply |

## Domain module boundaries

| Module | Owns |
|---|---|
| `contacts` | Individual/Household/Organization contacts, their slices, identifiers, notes, relationships (ADR 0014); dropdown fields and their values (ADR 0023); the search projection |
| `giving` | Contributions (gifts) and their allocations; later recurring giving, pledges, batches |
| `giftaid` | Declaration chain, coverage, HMRC IRmark; later claims and submission |
| `consent` | Immutable consent log; derived communication preferences (not built yet) |
| `comms` | Transactional-vs-marketing suppression, mail; later activities and mailing |
| `sources` | Source codes (category → detail → version; the version id is the code), the `used` marker (ADR 0022) |
| `platform` | Everything cross-organisation (`platform.db`); never a dependency of a domain crate |

These mirror the CiviCRM entity groupings analysed in research.md
§B2–B6. Domain crates depend on `contracts` and on each other's public
functions, never on `store`, `platform`, `auth` or `api`.

## Dropdown fields

Admin-defined single-choice fields on contacts, which replace tags
(ADR 0023), in `server/crates/contacts/src/fields.rs`. A field's
definition is the `contacts.field` contract (label, `appliesTo`,
`isActive`), its options `contacts.fieldOption` (label, `position`,
`isActive`; system-owned `used`). A contact's values are the
`contacts.fields` slice, rows of `contact_field_values` (one per field),
so there is no slot limit. A retire (`contacts.fieldRetire`) moves a
field live → retiring → retired, clearing its values in batches in the
background; a field or option never used can be deleted. Details:
`server/README.md`, "Contacts".

## Invariants the tests enforce

- Domain crates' manifests never name `store`, `platform`, `auth` or
  `api`; domain sources contain no `query_only`, `authorizer(`,
  `unchecked_transaction` or transaction-control SQL
  (`server/crates/api/tests/schema.rs`).
- Domain code can't execute raw SQL or forge a write handle
  (`compile_fail` doctests on the contracts crate).
- No `REAL` column; money columns are `INTEGER` (schema test).
- Every schema version has a fixture that migrates to head with its rows
  intact and `integrity_check` ok.
- Every contract owns its counter and its upcasters (a registry
  meta-test).
- Every route is isolation-tested: under two orgs, B never sees A, and
  A's ids under B's slug answer 404; SSE streams carry only their org's
  events.
