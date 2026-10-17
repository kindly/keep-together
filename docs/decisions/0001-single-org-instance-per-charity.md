# 0001 — One instance per client charity (single-org)

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: accepted (2026-07)

## Context

The product will be operated as a managed fleet: each client charity gets
their own deployment. UK data-protection posture and procurement optics
favour hard isolation. A shared multi-tenant deployment (Postgres RLS,
tenant FK on every table) was considered and rejected: it complicates every
query, weakens the GDPR-erasure and "your data is your database" story, and
the fleet is expected to stay small enough that per-instance cost is fine.

## Decision

Single-org data model. One Django process + one Postgres database per
client. Strictly 12-factor: all configuration via `NGO_*` env vars, no
provider-specific code. Hosting provider deliberately undecided
(Northflank / Clever Cloud / Fly.io are the candidates — UK-based hosting
is a go-to-market pillar); container packaging is deferred until that
choice is made.

## Consequences

- **Never add a tenant/organisation FK.** Tenant isolation *is* instance
  isolation.
- Provisioning a client = stamping out the same app + database pair with
  different env; keep everything derivable from (code version, env).
- Per-client customisation cannot rely on runtime feature flags in a shared
  DB — it composes at build/deploy time (see ADR 0010).
- GDPR: each charity is a data controller with a physically separate
  database, which simplifies the processor story and erasure requests.
