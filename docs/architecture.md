# Architecture overview

One paragraph: a static React SPA talks over WebSocket to **one Convex
deployment that holds every tenant**; tenancy is enforced by scoped
function constructors, so domain code is single-org. Every domain write
is a *contract* (a transactional mutation over a full-state slice, with a
per-slice counter and an appended revision). Paying or bespoke clients
get a *dedicated* deployment running the same multi-tenant code.
Decisions and rationale live in [decisions/](decisions/) (start with
[0017](decisions/0017-convex-react-shared-tenancy.md)); the domain
reference is [research.md](research.md).

## System shape

```
┌──────────────────────────────────────────────────┐
│  Browser — React SPA (static files)              │
│  TanStack Router · shadcn/Tailwind               │
│  hostname → tenant  (platform routing lookup)    │
└───────────────┬──────────────────────────────────┘
                │ WebSocket (live queries, mutations) · HTTPS (HTTP actions)
┌───────────────▼──────────────────────────────────┐
│  Convex deployment (shared tier)                 │
│  convex/lib/tenancy   scoped ctx — every call    │
│  convex/<domain>/     contracts, queries, warns  │
│  convex/platform/     tenants, memberships,      │
│                       settings, routing, billing │
│  auth · scheduler · crons · file storage         │
│  http.ts   webhooks (GoCardless, Stripe, email)  │
│  Node actions: HMRC GovTalk/IRmark, PDFs         │
└───────────────┬──────────────────────────────────┘
                │ streaming export
┌───────────────▼──────────────────────────────────┐
│  Postgres mirror (reporting + exit insurance)    │
└──────────────────────────────────────────────────┘

Dedicated tier = another Convex deployment, same bundle (+ client
modules), one tenant inside, registered with the shared platform.
```

## Request flow

- **Boot:** the SPA reads `window.location.hostname`, asks the platform
  HTTP action for `{deploymentUrl, tenantId}`, creates the Convex client
  for that deployment, and mounts `ConvexAuthProvider`.
- **Reads:** `useQuery(api.contacts.get, { tenantId, id })` — the scoped
  constructor verifies membership and filters by tenant; the result is a
  live subscription, so every list and form updates when anyone writes.
- **Writes:** the form calls a contract mutation with the slice's full
  state plus `expected` (its counter). `executeContract` checks the
  counter, runs the pure apply function, writes the root/children, and
  appends a revision — one transaction. Side effects (email, payment
  provider calls) are scheduled from the mutation and run only if it
  commits.
- **Conflicts:** a stale `expected` returns the current state; the form
  does a per-field three-way merge (base / local / remote) and retries;
  only a field changed by both sides is shown as a conflict. The form
  ignores subscription echoes of its own last save by counter.
- **Webhooks:** one HTTP route per provider; the path carries the tenant
  slug; the handler loads that tenant's secret from `tenantSettings`,
  verifies the signature, then calls an internal scoped mutation.
- **Background:** crons list tenants and enqueue one Workpool job per
  tenant; jobs re-enter through the scoped constructors.

## Repo map

| Path | What lives there |
|---|---|
| `convex/lib/appSchema.ts` | all app tables; `tenants`, `memberships`, `tenantSettings`, `revisions`, domain tables (`convex/schema.ts` adds Convex Auth's `authTables`) |
| `convex/lib/tenancy.ts` | `tenantQuery`/`tenantMutation`/`tenantAction` + internal variants; membership check; tenant-wrapped `db` |
| `convex/lib/fieldSlots.ts` | `FIELD_SLOTS` and the generators for the dropdown-field slots' schema fields, indexes and search filter fields (ADR 0023) |
| `convex/lib/contracts.ts` | `executeContract`, counter/`expected` handling, revision append, restore + upcaster chain |
| `convex/platform/` | the only module allowed to import raw `query`/`mutation`/`action`: tenant lifecycle, memberships, routing HTTP action, billing rollups |
| `convex/contacts/` … | one folder per domain module: `schema.ts` fragment, contracts, queries, `warnings.ts`, tests |
| `convex/auth.ts`, `auth.config.ts`, `http.ts` | Convex Auth and HTTP routes |
| `src/routes/` | file-based routes (`__root.tsx` wraps providers) |
| `src/lib/` | Convex client bootstrap, tenant resolution, form-merge helpers |
| `src/components/ui/` | shadcn components (generated into the repo) |
| `docs/decisions/` | ADRs — 0017 first, then the still-applicable ngo-go ADRs it names |

## Domain module boundaries

| Module | Owns |
|---|---|
| `contacts` | Individual/Household/Organization contacts, relationships (ADR 0014); dropdown fields and their values (`fields.ts`, ADR 0023); tags until they're removed |
| `giving` | Contribution, LineItem, RecurringContribution, Pledge, Batch |
| `giftaid` | Declaration chain, claims, HMRC submission (GovTalk + IRmark in a Node action) |
| `consent` | Immutable consent log; derived communication preferences |
| `comms` | Activities, transactional-vs-marketing suppression, mailing |
| `sources` | Source codes (category → detail → version; the version id is the code), the `used` marker; exports `describe` / `markUsed` (ADR 0022) |
| `platform` | Everything cross-tenant; never imported by domain modules |

These mirror the CiviCRM entity groupings analysed in research.md
§B2–B6. Domain modules may import `lib`, never each other's internals —
go through a module's exported functions.

## Dropdown fields

Admin-defined single-choice fields on contacts, which replace tags
(ADR 0023). They live in `convex/contacts/`: definitions, options and the
retire action are in `fields.ts`, and the values' contract
`contacts.fields` is in `contracts.ts`. The tables in
`convex/lib/appSchema.ts`:

| Table / field | Written by | Notes |
|---|---|---|
| `contactFields` | `contacts.field` (`saveVersion`) | one row per field: label, `appliesTo` (kinds), `isActive`; system-owned `slot` (absent once retired) and `retiring`. Index `by_tenant_slot` |
| `contactFieldOptions` | `contacts.fieldOption` (`saveVersion`) | one row per option: `fieldId`, label, `position`, `isActive`; system-owned `used`. Index `by_tenant_field_position` |
| `contacts.field1…N` | `contacts.fields` (`fieldsVersion`) | the option id held in each slot; absent = not set |
| `contactSearch.field1…N` | the projection hook only | copied from the contact; two indexes per slot and one `search_text` filter field each, generated from `FIELD_SLOTS` |
| `tenantPreferences.staffCanManageFields` | `tenantPreferences.fields` (`fieldsVersion`) | the staff switch (`ListKind` `fields`) |

N is `FIELD_SLOTS` (5). Raising it is loosen-only, but the push rebuilds
`search_text` and waits for it. The search index's 16 filter fields cap it
at 10 slots, and past about 8 values would move to a join table (ADR 0023
decisions 3–5). Tags are gone: plan steps 7–9 removed their code, data
and tables; their revisions stay in history, read-only.

## Invariants the tests enforce

- Every domain table has `tenantId` and every index on it starts with
  `tenantId` (schema test).
- No file outside `convex/platform/` imports raw `query`/`mutation`/
  `action` from `./_generated/server` (ESLint `no-restricted-imports`).
- Two-tenant fixture: after any operation on tenant A, tenant B's view is
  unchanged.
- Every aggregate root ships as a set: counter fields, contracts,
  revisions, restore — a meta-test lists registered contracts against
  schema fields, as ngo-go's `test_commands.py` did.
