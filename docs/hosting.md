# Hosting (ngo-go, August 2026) — superseded

> **Status in keep-together: superseded by [ADR 0017](decisions/0017-convex-react-shared-tenancy.md),
> then by [ADR 0024](decisions/0024-rust-sqlite-per-org.md)** (a Rust api
> with a SQLite file per organisation, on Fly in London: `docs/ops.md`).
> This page is kept because ADRs 0016 and 0017 cite it, and as the
> starting point for any future hosting or UK-residency conversation. Prices and incident records are
> as of August 2026 — re-verify before reuse.

Decision date: 2026-08-17. Research method: parallel web research across
eight platforms; prices and regions are time-sensitive — re-verify at
signup. This supersedes the "Northflank / Clever Cloud / Fly.io
undecided" note in ADR 0001 (which is itself due to be superseded by the
multi-tenant hosting ADR).

## Decision

**DigitalOcean App Platform + DigitalOcean Managed Postgres, both in
LON1 (London).** One shared always-on Django/uvicorn app (+ worker +
cron jobs) serving all tenants; one managed Postgres cluster holding
tenant schemas. Graduated/dedicated instances are stamped out as a new
App Platform app + new Postgres cluster via the DO API or the official
Terraform provider.

Why DO:

- **London region for both apps and managed Postgres** — UK data
  residency, which is a go-to-market pillar. (Operator is a US company;
  the residency claim is "UK datacenter", not "UK operator".)
- **Managed Postgres is genuinely managed at the entry price**: daily
  full backups + WAL archiving giving 7-day point-in-time recovery
  *included on the $15/mo single node*; built-in PgBouncer; optional HA
  standby with automatic failover (~+$30/mo) addable later.
- **Boring reliability**: no notable 2025–26 platform outages surfaced;
  actively developed (cron jobs GA, buildpack updates through 2026).
  David has prior positive experience with DO.
- **App and DB co-located in the same region/VPC** — private
  networking, no cross-cloud latency question, one vendor, one bill.
- **Programmatic provisioning**: full REST API + official
  `digitalocean` Terraform provider covering apps, database clusters,
  and connection pools — the graduation path is automatable.
- Cost at start: roughly $32–39/mo (web $10–12 + worker $5–12 +
  Postgres $15); ~$75+/mo once HA Postgres is warranted.

## Consequences / constraints

- **Connection budget favours schema-per-tenant.** DO Managed Postgres
  allows ~25 connections per GiB RAM. Database-per-tenant would
  accumulate persistent connections per (worker process × tenant DB)
  and exhaust that quickly; schema-per-tenant on one database keeps the
  connection count flat regardless of tenant count. Lean
  schema-per-tenant for the shared tier (spike before the ADR).
- **Pooler vs `search_path`**: PgBouncer in transaction mode does not
  honour per-connection `SET search_path`. Fixes: per-tenant Postgres
  role with `ALTER ROLE <tenant> SET search_path` (applied at login,
  survives transaction pooling), or bypass the pooler and use Django
  persistent connections direct — viable at this scale.
- Don't pair DO with an external AWS-hosted Postgres (Neon etc.):
  LON1 ↔ AWS eu-west-2 is low-single-digit-ms RTT but over the public
  internet, and it compounds with chatty ORM request patterns. DO's own
  Postgres removes the reason to.
- Cron minimum interval is 15 minutes, 30-minute job timeout — fine for
  billing rollups; anything tighter belongs in the worker.

## Rejected alternatives (August 2026 state)

| Platform | Why not |
|---|---|
| **Railway** | No UK region (nearest Amsterdam). Five major incidents Nov 2025–May 2026, incl. an 8h platform outage (GCP account auto-suspension, May 2026) and a Feb 2026 abuse-system misfire that killed legitimate deployments. Databases are containers you own, not an SLA-backed service. Best DX and cheapest (~$20–35/mo), but unacceptable for payment-webhook ingestion + the UK pillar. |
| **Northflank** | Strong runner-up: UK-registered company, London region, Patroni HA Postgres, native templates for stamping tenant app+DB pairs, BYOC escape hatch, best incident record of all candidates. Rejected on startup risk (~$22M raised, marketing pivoting to AI workloads) and an undisclosed underlying cloud for its managed London region. |
| **Fly.io** | Has lhr, but Managed Postgres is a $38/mo floor mid-rebuild (v2 beta is their fourth Postgres story), ~13 incidents/month, Terraform provider dead, no native cron. |
| **Render** | Solid managed Postgres and uptime, official Terraform — but Frankfurt only (no UK) and ~2× DO's cost ($60–80/mo with 7-day PITR, which needs the $25/mo Pro workspace). |
| **Clever Cloud** | European operator + London zone (IONOS, Sept 2025) is a good sovereignty story, but PITR and replication require support tickets — not self-service, undermines automated provisioning. |
| **Heroku** | London exists only in enterprise Private Spaces; cheap tier is US/Dublin with no PITR below $50/mo Postgres; 24h global outage June 2025. |
| **External DB specialists** (Neon, Crunchy Bridge, Supabase — all with London regions) | Only needed when the app host's Postgres is weak; DO's isn't. Noted for the record: Neon's project-per-tenant model is uniquely cheap if a true database-per-tenant tier is ever wanted; Crunchy Bridge has the best included backup/HA but Snowflake's 2025 acquisition leaves Bridge's future uncommitted; Supabase gates PITR behind a ~$100/mo add-on. |

## Verify at signup

- Current App Platform instance and Managed Postgres prices (figures
  above are August 2026).
- PgBouncer pool-count limits per cluster (relevant if any per-schema
  pools are wanted).
- Terraform provider coverage for cron-type jobs.
