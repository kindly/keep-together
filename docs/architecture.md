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
| `convex/schema.ts` | all tables; `tenants`, `memberships`, `tenantSettings`, `revisions`, domain tables |
| `convex/lib/tenancy.ts` | `tenantQuery`/`tenantMutation`/`tenantAction` + internal variants; membership check; tenant-wrapped `db` |
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
| `contacts` | Individual/Household/Organization contacts, relationships (ADR 0014) |
| `giving` | Contribution, LineItem, RecurringContribution, Pledge, Batch |
| `giftaid` | Declaration chain, claims, HMRC submission (GovTalk + IRmark in a Node action) |
| `consent` | Immutable consent log; derived communication preferences |
| `comms` | Activities, transactional-vs-marketing suppression, mailing |
| `sources` | Source codes (category → detail → version; the version id is the code), the `used` marker; exports `describe` / `markUsed` (ADR 0022) |
| `platform` | Everything cross-tenant; never imported by domain modules |

These mirror the CiviCRM entity groupings analysed in research.md
§B2–B6. Domain modules may import `lib`, never each other's internals —
go through a module's exported functions.

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
