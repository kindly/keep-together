# 0011 — Server-rendered UI: Jinja + htmx + Tailwind (supersedes 0003)

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: accepted (2026-07) · supersedes 0003

## Context

The project initially scaffolded a Vite/React/TanStack SPA (ADR 0003),
justified largely by live-updating UI and a typed OpenAPI contract. Both
justifications weakened: live updates were deferred (ADR 0004), and the
maintainer's deep recent experience is a large production Django+htmx
system (GEM). The SPA brought concrete costs observed during scaffolding:
JS toolchain churn, a client build per extension combination, duplicated
logic across the API boundary, and frontend plumbing time not spent on the
domain (Gift Aid/GDPR/Direct Debit — the actual product moat).

## Decision

Server-rendered UI:

- **Jinja** templates for app pages (Django engine retained for
  admin/allauth); **htmx** (vendored, ~36KB) for partial updates.
- **Tailwind v4 via the standalone binary** — no node/npm anywhere; the
  modern visual identity is CSS, not a client framework.
- **Pydantic contracts** (ADR 0012) replace the OpenAPI spec as the
  validation contract; no JSON API until a real consumer exists.
- Rich, genuinely app-like screens, if ever needed, get an **island**
  (a small Vite-built widget on one page — the proven GEM pattern), not a
  return to a full SPA.
- Alpine.js may be added for local client state when a screen needs it;
  not installed until then.

## Consequences

- One deployable, no client build variants: every instance ships
  byte-identical static assets; extensions are pure Python/templates.
- No server↔markup type contract: template regressions are caught by
  server-side view tests, which the compliance domain requires anyway.
- All UI state lives in URLs and the database; htmx fragments must stay
  idempotent and addressable.
- The realtime upgrade path (ADR 0004) maps to htmx's SSE extension fed
  by Postgres LISTEN/NOTIFY — still additive, still deferred.
