# 0004 — Real-time deferred; SSE invalidation is the designed upgrade

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: accepted (2026-07) — deliberately not built yet · updated for 0011

## Context

Live-updating UI was seriously considered (it motivated evaluating Convex
and ElectricSQL). Decision: not needed for launch. Server-rendered pages
are fresh on every load and htmx fragments refetch on interaction; the
stale-screen problem that bites long-lived SPA views barely exists here.

## Decision

Ship without a push channel. Keep the upgrade cheap with one standing
constraint: the dev and prod server is **uvicorn/ASGI from day one**
(long-lived streams need it; never `runserver`).

### The designed upgrade (when wanted, ~1–2 days, purely additive)

- Models opt in via a signal registry; `post_save`/`post_delete` emit
  `NOTIFY entity_events, '{"entity","id","action"}'` inside
  `transaction.on_commit`.
- An async, session-authenticated Django view opens a psycopg
  `AsyncConnection`, `LISTEN entity_events`, and streams SSE with
  keepalives.
- Templates use **htmx's SSE extension**: elements subscribe to entity
  events and re-fetch their fragment when a relevant one arrives.
- No Redis, no Channels, no schema changes.

## Consequences

- No real-time code in the scaffold; anything found there predating this
  ADR's revision is a bug.
- Keep htmx fragments idempotent and addressable by URL — that is what
  makes "re-fetch on event" trivial later.
