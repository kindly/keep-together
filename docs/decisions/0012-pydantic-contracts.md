# 0012 — Pydantic contracts: one validation layer, API deferred

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: accepted (2026-07)

## Context

Input validation must be defined once, work for HTML forms today, be
extensible per client (ADR 0010), and be able to back a JSON API later
without re-modelling. Django forms are template-friendly but weak as a
contract; a hand-rolled OpenAPI layer without an API consumer is
speculative surface.

## Decision

Every write operation gets a **contract**: a Pydantic model registered
under a stable dotted name (`apps/core/contracts.py`):

- Core: `@contract("contacts.ContactCreate")`.
- Extensions: `@extend_contract("contacts.ContactCreate",
  extension="acme")` contributes a field group that appears as a
  **namespaced nested model** (`acme: AcmeFields`) in the composed
  contract — collisions are structurally impossible.
- `get_contract(name)` returns the composed model (core only when no
  extensions contribute).
- HTML forms use dotted input names (`acme.legacy_ref`); `parse_form()`
  rebuilds the nesting; `field_errors()` maps `ValidationError` locations
  back to input names; the Jinja form macros render any contract —
  including extension groups — from `form_fields()` metadata, so simple
  extension fields need no templates.

**The JSON API is deferred, not designed out**: django-ninja accepts
Pydantic models natively, so exposing `get_contract(...)` per endpoint
gives an OpenAPI spec that automatically reflects each instance's enabled
extensions. Add it when a real consumer exists (donor-facing forms as a
service, Swiftaid-style integrations, bulk import tooling) — per feature,
not wholesale.

## Consequences

- Contracts are the single source of truth for input validation; view
  code must not re-validate ad hoc.
- HTML form semantics (absent checkboxes, empty strings) are handled by
  conventions on `ContractModel` — extend the base class, not individual
  contracts.
- Extension persistence: `execute_contract` dispatches each extension's
  validated field group to its `@applies_extension` hook inside the
  command transaction — saves and restores behave identically. Groups
  whose fields all have defaults compose as optional, so stock payloads
  validate with the extension enabled and enable/disable is bridgeable.
- Widget hints go in `Field(json_schema_extra={"widget": "textarea"})`.
