# 0002 — Django + Postgres; admin as back-office

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: accepted (2026-07) · revised alongside 0011/0012

## Context

The domain is financial and compliance-heavy (contributions, Gift Aid
claims, consent logs) — relational integrity, mature migrations and an
audit-friendly ORM matter more than novel datastores. Convex was evaluated
(see research.md §A5) and rejected: no UK region, document-store integrity
in application code. The maintainer's core expertise is Django.

## Decision

Django on PostgreSQL. Views render server-side (ADR 0011); input
validation flows through Pydantic contracts (ADR 0012). Django admin stays
enabled as the operator's internal back-office; it is not the product UI.

django-ninja was originally chosen as the API layer; with the UI
server-rendered there is no API consumer, so no API ships until one exists
(ADR 0012 records the reintroduction path — ninja over the same
contracts).

## Consequences

- Money/compliance entities are real columns with FK constraints — never
  JSON blobs (see ADR 0007).
- Domain models extend `apps.core.models.BaseModel` (uuid pk +
  timestamps).
- The server is ASGI/uvicorn from day one (see ADR 0004).
