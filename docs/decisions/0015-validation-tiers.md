# 0015 — Validation tiers: blocking errors vs advisory warnings

Status: accepted (2026-07)

## Context

Real charity data is dirty — spreadsheet imports carry malformed emails,
typo'd postcodes, missing fields. If validation *blocks* on all of it,
imports die and staff can't record a supporter until every field is
perfect. There is a real difference between **"cannot save"** (the data
is unstorable or breaks an invariant) and **"probably wrong"** (storable,
but a human should look). Conflating them — e.g. `EmailStr` on the
contract — makes a bad email unsaveable, which is the wrong behaviour.

## Decision

Two tiers:

1. **Blocking (contract validation).** A contract's types and
   `@model_validator`s enforce only what is truly required to store the
   record: structural integrity and invariants — money is numeric,
   references exist, no duplicate child-row ids, kind rules, at most one
   primary. These raise `ValidationError` and the section does **not**
   save. Format-strict types that merely mean "looks wrong" are
   deliberately loosened (email is `str`, not `EmailStr`; postcode is
   normalised but never rejected).

2. **Advisory (warnings).** A single entity-level function
   (`apps/contacts/warnings.py::contact_warnings`) runs against the
   **saved** Contact and its children and returns
   `{anchor, label, message}` items. Warnings never block a save.

Both tiers surface the same two ways, so warnings and errors read
consistently:

- **Inline**, in a per-field slot: the field's error shows if present,
  otherwise its warning (error wins the one slot — red over amber). Row
  warnings render in the row; details-field warnings in the field's
  `err-<name>` slot.
- **In the save pane**, which always lists *everything* — every error and
  every warning, field-scoped or not, each linking to its field.

Messages that belong to no single field — whole-contact warnings ("no
email, phone or address yet") and section-level errors (conflicts,
cross-field failures) — additionally render in a **form-notices
placeholder** at the top of the form (`_form_notices.html`), as well as
in the pane. Everything is swapped out-of-band on save so the focused
input is never disturbed.

The warning layer is deliberately **one entity-level tier**, not
per-contract: it reads persisted models, so it is identical whether one
`ContactSave` or the partitioned details/methods/addresses contracts
wrote them — and it can express cross-section rules ("no email, phone or
address yet") that a per-contract check structurally cannot. Per-field
warning methods on contracts were considered and rejected as unneeded
complexity.

## Consequences

- Dirty data lands and is flagged rather than rejected — imports and
  quick data entry aren't blocked by imperfect values.
- The blocking set stays minimal, guided by: *block only when the data is
  unstorable or violates an invariant; warn for everything else.*
- **Downstream filtering** (a mailing list skipping malformed emails)
  will want a persisted, queryable flag — deferred until a consumer
  exists (no mailing feature yet). When it lands, the flag is computed by
  the same check the warning uses (a pure function of the value, like
  `display_name`), denormalised onto the row (`ContactEmail.is_valid`),
  and validity is likely modelled **per-purpose** (mailable vs
  Gift-Aid-ready), not one global boolean.
- Cross-entity warnings ("has contributions but no valid Gift Aid
  declaration") can't be save-time checks; they're derived at the point
  of consumption. Out of scope here.
- A "data quality" worklist (contacts with warnings) becomes a natural
  future feature on top of this.
