# 0016 — Tiered hosting: shared schema-per-tenant service, dedicated instances as graduation

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: draft (2026-08) · supersedes 0001. On acceptance: flip 0001's
status, update CLAUDE.md rule 6 and architecture.md to match.

## Context

The product is repositioning toward small UK community groups (village
halls, community centres, CICs with £5–10k/yr income — see
`community-crm-brief.md`). That market demands a hosted service at
~£10/mo with self-serve signup. ADR 0001's instance-per-charity model
fails those economics twice over: a Django process per tenant costs more
than the tenant pays, and signup must provision in seconds, not as a
fleet operation.

But the *reasons* behind 0001 still hold. The single-org data model is
why the contract/revision architecture is simple, why erasure and
"your data is your database" are easy stories, and why a shared-schema
redesign (tenant FK on every table, a filter on every query, one missed
filter = cross-charity data leak) was rejected then and remains wrong
now.

Hosting is decided (docs/hosting.md): DigitalOcean App Platform +
Managed Postgres, both LON1. DO's connection budget (~25 connections per
GiB RAM) makes database-per-tenant hazardous — persistent connections
accumulate per (worker process × tenant database) — while
schema-per-tenant keeps the connection count flat regardless of tenant
count.

## Decision

**Tenancy is an infrastructure concern, never a domain concern.** Domain
code remains exactly as single-org as today; what changes is how many
tenants one deployment serves.

Two tiers, same codebase:

1. **Shared tier (default).** One Django deployment + one Postgres
   cluster serves all tenants, **one Postgres schema per tenant**. The
   request's subdomain resolves the tenant; the connection is switched to
   that tenant's schema before any domain code runs. The pooling-safe
   mechanism is a **Postgres role per tenant with
   `ALTER ROLE <tenant> SET search_path`** (applied at login, survives
   PgBouncer transaction mode); per-request `SET search_path` over
   direct persistent connections is the fallback — a spike picks the
   mechanism, this ADR fixes only the shape.
2. **Dedicated tier (graduation).** A tenant that outgrows the shared
   tier (scale, bespoke extensions, procurement demands) moves to its own
   app + cluster — ADR 0001's model, now the premium tier. Because every
   tenant schema is structurally identical to a dedicated database, the
   move is `pg_dump` the schema + stamp out app and cluster via the DO
   API/Terraform. **No data transformation, ever.**

Supporting decisions:

- **Rule 6 survives, restated:** *no tenant/organisation FK in any
  domain table.* Tenant isolation is schema (or instance) isolation.
  Domain apps, contracts, handlers, and templates never know tenancy
  exists.
- **Users live inside tenant schemas.** A volunteer belongs to their
  group; sessions and allauth are per-tenant (cookies scoped to the
  tenant subdomain); treasurer handover is a within-tenant role change,
  not a platform operation.
- **A control plane owns everything cross-tenant**, in its own schema
  the domain apps can never see: org registry and subdomains, signup and
  schema provisioning, free-cohort flags, billing tallies
  (percentage-vs-cap computation fed by payment webhooks). Domain apps
  never import it; it touches tenants only by provisioning schemas and
  running migrations.
- **Migrations run once per tenant schema** via a management command
  that iterates schemas. Deploy time grows with tenant count — accepted
  at the target scale (hundreds, not tens of thousands).
- **Extensions (amends ADR 0010):** a shared deployment serves one code
  image, so `NGO_EXTENSIONS` composes *platform-wide* on the shared
  tier — an enabled extension's pages/slots may additionally be gated
  per-tenant by a control-plane flag, but per-client *bespoke code*
  now requires the dedicated tier. Extensions remain the customisation
  mechanism; the shared tier just isn't where bespoke work runs.

## Consequences

- Everything built so far (contracts, revisions, the contacts aggregate)
  carries over untouched; the tenancy work is routing middleware, the
  provisioning/migration commands, and the control-plane app.
- Cross-tenant queries are impossible by construction — a feature.
  Platform analytics and billing derive from control-plane records
  (webhooks, rollups), never from reaching into tenant schemas.
- Blast radius: one cluster means a bad migration or DO incident touches
  every shared-tier tenant. Mitigations: 7-day PITR from day one, HA
  standby when revenue justifies it, migrations tested against a copy
  schema before the fleet run, and the dedicated tier as pressure
  release.
- GDPR: each group is data controller, the platform is processor.
  Erasure stays the ADR 0007 anonymise-don't-delete model *within* a
  schema; a group folding = drop (after export) their schema. Per-schema
  `pg_dump` gives the easy full-data export the brief's churn/trust
  point demands.
- Payment credentials are per-tenant connected accounts (GoCardless /
  Stripe OAuth), not platform env vars — the platform's cut rides
  app-fees on the tenant's own account. Detail belongs to the giving ADR
  when that app is built.
- Seed/dev tooling (`just seed`, tests) needs a "one local tenant"
  mode so day-to-day development still feels single-org.
- What this deliberately does not decide: the tenant-routing mechanism's
  internals (role-based vs per-request `search_path` — spike), billing
  engine design, and signup UX.
