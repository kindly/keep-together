# 0017 — keep-together: Convex backend, React SPA, one multi-tenant deployment with dedicated instances as a tier

Status: accepted (2026-10) · the founding decision of this repo.
Superseded in part by [0024](0024-rust-sqlite-per-org.md) (2026-10-28):
the stack, the tenancy mechanism, the dedicated-instance tiers and the
export/import between deployments. The rest stands.

Supersedes the *mechanism* ADRs inherited from ngo-go: 0001 (instance per
charity), 0002 (Django + Postgres), 0004 (SSE upgrade path), 0005
(allauth), 0009 (uv/just tooling), 0011 (Jinja + htmx), 0012 (Pydantic
contracts), 0016 (schema-per-tenant on DigitalOcean). It reinstates the
*direction* of 0003 (Vite SPA, TanStack Router, shadcn, Tailwind).

Still in force, unchanged in substance: 0006 (AGPL-3.0), 0007 (domain
invariants — rule 6 restated below), 0008 (Stripe + GoCardless, each
tenant's own connected account), 0010 (extensions as the customisation
mechanism — now realised as a different *bundle* on a dedicated
deployment), 0013 (aggregates, partitioned contracts, counters,
revisions, restore — re-expressed on Convex below), 0014 (Contact data
model), 0015 (blocking vs advisory validation).

## Context

ngo-go (Django + Postgres, server-rendered) works, but running it for
small community groups at ~£10/mo means operating servers, databases,
backups and a migration fleet — the costs ADR 0016 spent most of its
words managing. The question behind this repo: **what is the cheapest
managed CRUD stack where nobody maintains a server, and does the ngo-go
domain architecture survive the move?**

Candidates weighed: Cloudflare Workers + Durable Objects (SQLite per
tenant; cheapest, most to build — no scheduler/crons/webhook/Node story
out of the box), Convex + Vercel/Cloudflare, and Rust on Fly
(`../ngo-go-rs`, still a server). Convex won on fit, not just cost:

- **Mutations are serializable transactions in deterministic JS with no
  network access.** That is the ngo-go contract rule ("handlers are pure
  state application; side effects happen after commit") enforced by the
  runtime rather than by review. `ctx.scheduler` only fires if the
  mutation commits.
- Scheduler, crons, HTTP actions (webhooks), Node actions (npm, 10 min,
  512 MiB — enough for HMRC IRmark XML and PDFs), file storage, text
  search and live queries are all in the one product. Live queries
  retire ADR 0004's SSE plan.
- Pricing is a flat seat (Pro, $25/mo for one developer) with pooled
  allowances; the free/pay-as-you-go tier is enough to start.
- Exit exists: the backend is source-available (FSL, each release
  Apache-2.0 after two years), self-hostable on Postgres/SQLite, same
  code as the cloud. Streaming export to Postgres keeps a queryable copy
  of the data outside Convex.
- Sustainability: $57M Series B (Aug 2026), ~10k paying teams, EU hosting
  live. Our estimate: roughly even odds of being the same independent
  product in ten years; near-zero odds of being stranded without data
  or code, given the above.

Costs accepted knowingly:

- **No SQL.** Queries are TypeScript over declared indexes; joins and
  aggregates are code; per-function limits (32k documents scanned,
  16 MiB read, 1 s of user code) shape how reports are written. Data
  access code is Convex-specific — leaving means rewriting it, not
  swapping a driver. Domain logic stays in plain TypeScript modules so
  that layer is as thin as possible.
- **Residency is EU (AWS Ireland), not UK.** Adequate under UK GDPR,
  fine for community groups; "London datacenter" stops being a selling
  point. Accepted.
- **Real-time means client JavaScript.** The "server-rendered, barely
  any JS" ethos of 0011 does not survive; a small React SPA with a live
  WebSocket does. React over Svelte because Convex's React client is the
  complete one (optimistic updates, auth helpers, components' hooks).

## Decision

### Stack

Convex (cloud) for all backend state and compute · Vite + React 19 +
TanStack Router (file-based) + Tailwind v4 + shadcn/ui as a static SPA ·
Convex Auth (email + password) to start · pnpm · vitest + `convex-test`.
Hosting for the SPA is anything static: GitHub Pages or a Tailscale-served
local build to begin with; nothing in the app may depend on where the
static files are served from.

### Tenancy: every deployment is multi-tenant

Rule 6 of ADR 0007 is restated for this stack: **domain code never
mentions tenants; the runtime enforces them.** Concretely:

- Every domain table carries `tenantId: v.id("tenants")`; every index on
  a domain table starts with `tenantId`; search indexes put `tenantId`
  in `filterFields`. A schema test asserts this for all tables.
- Domain functions are declared only through the scoped constructors in
  `convex/lib/tenancy.ts` (`tenantQuery`, `tenantMutation`,
  `tenantAction`, and their `internal*` twins). They resolve the tenant
  from the request, verify the caller's membership, and hand the handler
  a `ctx.db` wrapped so every read is filtered by and every write stamped
  with the tenant. Raw `query`/`mutation`/`action` are importable only
  under `convex/platform/`; ESLint enforces the ban elsewhere.
- Scheduled and cron work re-enters through the same constructors: a
  cron lists tenants and schedules one job per tenant (never a
  cross-tenant scan in one function).
- Per-tenant secrets (payment provider tokens, webhook secrets, sender
  identities) live in `tenantSettings`, encrypted with a deployment-level
  key — never deployment env vars.
- Every test fixture creates two tenants and a shared assertion checks
  that tenant B observes nothing of tenant A's operations.

### Tiers

1. **Shared (default):** one Convex deployment holds all tenants. Signup
   is an insert, code rollout is one deploy, platform admin and billing
   are ordinary queries.
2. **Dedicated:** a paying or bespoke client gets their own deployment
   (or several). It runs the *same multi-tenant code* with one tenant in
   it — or that client's several. Bespoke customisation is a different
   build of the bundle (core + their modules) deployed there, never a
   per-tenant feature flag in shared code.

Moving between tiers is a data move, not a code change: a per-tenant
export in Convex's snapshot ZIP format (which preserves `_id` and
`_creationTime`, so `v.id` references survive) imported into the target
deployment. Proven 2026-10-17 between two cloud deployments
(`docs/spikes/01-export-import.md`) with one constraint: ids encode a
per-deployment table number, so **a deployment that will receive tenants
is born from a snapshot import (`--replace-all`) before any schema push,
and every deployment takes schema changes in the same order**. Two
deployments whose tables were created independently cannot exchange
documents by id.

### Control plane

Lives in `convex/platform/` inside the shared deployment: `tenants`,
`memberships`, `tenantSettings`, hostname → `{deploymentUrl, tenantId}`
routing exposed via an HTTP action the SPA calls at boot, billing
rollups. Dedicated deployments register their routes with it and expose
an internal HTTP action for billing summaries. A separate platform
deployment is not built until a second dedicated instance exists.

### Contracts and revisions on Convex (re-expressing 0013)

- A **contract** is a `tenantMutation` with a validator for its
  full-state slice. Contracts still partition the aggregate: disjoint
  fields, one integer counter field per contract on the root document,
  `expected` passed from the form; a mismatch throws `ConvexError` with
  the current state so the client can merge and retry.
- **Revisions** are rows in one `revisions` table (per entity type or
  shared — decided with the first aggregate), payload stored as `v.any()`
  with the contract name and declared version. History is immutable and
  never under schema pressure; only live documents are strictly typed.
- **Restore** re-executes a stored payload as a new command via the
  declared-version upcaster chain, exactly as 0013.
- **Schema changes are two-phase** because Convex validates the schema
  against every existing document on deploy: loosen (optional field /
  union) → deploy → backfill with the migrations component → tighten →
  deploy. Bumping a contract's version still requires registering an
  upcaster.
- Child rows live inside the root's command payload and carry ids,
  reconciled per ADR 0014 (identity fields immutable per id, addresses
  editable in place); handlers preserve system-owned child fields.
- Money is integer pence in `v.int64()`; no arithmetic in pounds.

### Validation (0015 unchanged)

Convex validators carry the blocking tier (types, references,
invariants) and stay deliberately loose on format. Advisory warnings are
pure TypeScript functions over the saved entity, shared by backend and
UI. Zod is not used; `convex-helpers`' Zod bridge is available if
refinements are ever needed.

## Consequences

- The Postgres mechanics of 0016 (schema-per-tenant, PgBouncer, roles)
  and all of `docs/hosting.md` are gone. The tenancy *principle* of 0016
  — infrastructure concern, never domain concern — is kept and made
  structural.
- The Django admin back-office disappears; internal tooling is the
  Convex dashboard plus platform routes in the SPA.
- One deployment shares concurrency and write throughput across tenants:
  rate-limit expensive paths (imports, bulk mail) per tenant with the
  rate-limiter component; fan crons out with Workpool.
- A noisy or failed schema migration touches every shared tenant at
  once; the dedicated tier is the pressure release, as in 0016.
- Spike order before any product feature: (1) per-tenant export/import
  between two deployments preserving ids; (2) scoped constructors,
  schema invariant test, two-tenant fixture; (3) Contact contract with
  counters, revisions, restore; (4) live form with per-field merge and
  echo handling; (5) IRmark generation in a Node action against HMRC
  samples; (6) one self-hosted run on a VPS to prove the exit. Reports:
  `docs/spikes/`. (6) was swapped for scripted cloud dev instances on
  2026-10-17; the self-host run is still owed.
