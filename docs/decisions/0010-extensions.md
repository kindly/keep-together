# 0010 — Per-client extensions: plain Django apps, env-composed

Status: accepted (2026-07) · simplified alongside 0011 (the original
version also composed per-client JS bundles; server rendering removed
that entire axis)

## Context

Clients will need a few custom fields and occasionally bespoke behaviour.
Real columns and real code beat a generic metadata engine at this fleet
size — but client-specific code must never leak into core, and enabling
an extension must be pure configuration. Metadata-driven self-serve custom
fields (definitions + JSONB + runtime rendering) remain the intended
*product feature* later; extensions are the mechanism until then and the
escape hatch after.

## Decision

An **extension** is one directory, `extensions/<name>/backend/`, holding a
normal Django app. One env var, `NGO_EXTENSIONS` (comma-separated names),
composes everything:

- settings appends `extensions.<name>.backend` to `INSTALLED_APPS`
  (AppConfig label convention: `ext_<name>` — collisions impossible);
- models/migrations/admin work exactly as core apps do;
- `urls.py`, if present, mounts at `/ext/<name>/`;
- template partials register into named **slots** from
  `AppConfig.ready()` via `apps.core.extensions.register_partial`; core
  templates render slots with `slot_partials("dashboard.main")`;
  extension Jinja templates live in the app's `jinja2/` dir;
- contract field groups register via `@extend_contract` (ADR 0012), so
  extension fields appear in core forms and validation with no template
  work.

`extensions/example/` stays in-tree as the living proof and template: a
model + migration, an htmx-loaded dashboard-slot widget, a mounted view,
and tests that CI runs both with and without it.

## Consequences

- Client-specific code lives **only** in `extensions/` — never in core
  apps.
- Enabling/disabling an extension is env + migrate — no build step, no
  asset variants; every instance serves identical static files.
- Compliance-relevant data never goes in extensions' convenience storage
  (ADR 0007).
- Every "add a field" request is currently a deploy; when that gets
  tedious, build the self-serve metadata/JSONB custom-fields feature.
