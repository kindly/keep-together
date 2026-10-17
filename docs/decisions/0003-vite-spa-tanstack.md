# 0003 — Vite SPA with TanStack Router/Query, shadcn/ui, Tailwind

Status: **superseded by [0011](0011-server-rendered-jinja-htmx.md)** (2026-07)

## Original decision (kept for the record)

A single-page app built with Vite + React + TypeScript: TanStack Router
(file-based routes) and TanStack Query as the only data layer; shadcn/ui +
Tailwind v4; a typed API client generated from django-ninja's OpenAPI spec
by @hey-api/openapi-ts, committed and CI drift-checked; the production
build served by Django/whitenoise from the same process.

This was scaffolded, verified end to end, and then replaced within days —
before any domain code existed — by the server-rendered approach. See
ADR 0011 for the full rationale (in short: live updates had already been
deferred, the SPA required per-client bundle composition for extensions,
and it duplicated logic across the API boundary while consuming effort
better spent on the Gift Aid/GDPR domain).
