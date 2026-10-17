# Spike 2 — tenancy hardening: scoped db, two-tenant fixture, auth

Date: 2026-10-17 · Status: **done**

ADR 0017's rule 6: *domain code never mentions tenants; the runtime
enforces them.* The scaffold had the scoped constructors and row-level
rules; this spike closed the gap that rules alone leave open.

## The gap

Row-level security (convex-helpers) filters what a query *returns* and
checks what a write *touches*. It does not change what a query *scans*.
A domain handler writing `ctx.db.query('contacts').withIndex('by_tenant_sort')`
without an `eq('tenantId', …)` range would scan every tenant's contacts
and then have the other tenants' rows filtered out — correct output, a
cross-tenant scan underneath, and over the 32k-document limit the moment
the fleet grows. And inserts had to carry `tenantId` by hand, which is
exactly the "filter a handler remembers to write" rule 6 forbids.

## What changed (`convex/lib/tenancy.ts`)

`tenantQuery` / `tenantMutation` / `internalTenant*` now hand handlers a
**scoped db**:

- `insert` and `replace` stamp `tenantId`; the value type omits it, so a
  handler *cannot* pass one.
- `query(table)` exposes only `withIndex` and `withSearchIndex`. There is
  no unindexed scan and no `.filter()` entry point. Every index range is
  prefixed with `q.eq('tenantId', tenant)` before the handler's range
  function runs, and the type of the range builder starts at field 1 — so
  `withIndex('by_tenant_contact', q => q.eq('contactId', id))` is what
  handlers write, and the schema test guarantees field 0 is `tenantId`.
  Search filters get `.eq('tenantId', tenant)` appended.
- `get` / `patch` / `delete` keep the row-level rules: another tenant's
  document reads as `null` and writes throw.

Domain code in `convex/contacts/` never mentions `tenantId`; grep proves
it. The ESLint ban on raw constructors outside `convex/platform/` was
already in place and caught the first attempt to register a raw
`internalAction` under `convex/giftaid/`.

## Fixture (`test/fixture.ts`)

`setup()` builds tenants **alpha** and **beta**, each with an owner user, a
membership and the seeded relationship types, and returns an identity
accessor per tenant (`a.as`, `b.as`) using Convex Auth's `userId|session`
subject encoding. `snapshot(t, tenantId)` serialises every domain row of
one tenant; the isolation test takes beta's snapshot before any
operation on alpha and asserts it is unchanged after — plus: beta's list
is empty, beta's `get` of alpha's contact is `null`, beta's write to it is
`not_found`, and beta's member calling with alpha's `tenantId` is
`forbidden`.

The fixture lives outside `convex/` because the Convex bundler pushes
everything under it; `import.meta.glob` in a pushed module fails the
deploy. Vitest's `include` already covers `convex/**/*.test.ts`.

## Auth

`npx @convex-dev/auth` is interactive, so `scripts/convex-auth-keys.mjs`
generates the same RS256 key pair and `scripts/dev-instance.sh` sets
`JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL`. David's dev deployment
(`zany-bird-247`) now has them; sign-in works.

## Still open

- `tenantAction` verifies membership through an internal query but gives
  the action no scoped db (actions have none); every action must re-enter
  through `internalTenant*` functions — true by construction, but there is
  no test yet that an action cannot reach `ctx.runQuery` on a raw platform
  function with a foreign `tenantId`.
- Rate limiting per tenant (imports, bulk mail) is not started.
