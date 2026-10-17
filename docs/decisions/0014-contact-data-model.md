# 0014 — Contact data model (CiviCRM-informed)

Status: accepted (2026-07)

## Context

CiviCRM's contact model (verified against current core schema; analysed
in research.md §B2) is the distilled shape of a charity CRM after 20
years. We keep its load-bearing ideas and drop what our architecture
makes obsolete.

## Decision

**Kept from CiviCRM:** one contact table with three kinds
(individual/organization/household — household in the enum from day one,
UI later); multi-value emails/phones/addresses as child rows with a
label + `is_primary`; bounce state (`on_hold`) on the email row; typed,
directional, dated relationships with charity-editable **seeded
RelationshipType rows**; `is_deceased` + date; `external_identifier` for
import idempotency; stored computed `display_name`/`sort_name`.

**Dropped, and why:** all `do_not_*`/opt-out flags and preferred-channel
fields (channel permissions are *derived from the consent log* —
ADR 0007); the greeting machinery (computed salutation later); US-shaped
address parsing, state/county tables, geocoding, shared-address
`master_id` (UK-shaped lines + town + postcode + ISO country; HMRC's
"house name or number" is derived at claim time); `contact_sub_type`
(tags/extensions instead); trash flag (revisions + restore + `archived`);
`source` column (`revision.source` records provenance better);
`employer_id` denormalisation (employment is just a relationship —
CiviCRM's sync between the two is a bug farm); relationship permission
flags (no donor portal); `hash`/`api_key`/`sic_code` etc.

**Contracts (partition per ADR 0013):**

| Contract | Counter | Owns |
|---|---|---|
| `contacts.ContactDetails` | `details_version` | kind + biographical/name columns; per-kind rules in the validator (flat model, not a discriminated union — extension groups compose better and form names stay flat) |
| `contacts.ContactMethods` | `methods_version` | email + phone child rows (replace-set) |
| `contacts.ContactAddresses` | `addresses_version` | address child rows (replace-set) |
| `contacts.ContactArchive` | `archive_version` | the archived flag |
| `contacts.RelationshipSave` | `save_version` | the Relationship aggregate |

Kind is immutable after creation (handler-enforced). Relationship is its
own aggregate (spans two contacts); kind compatibility against the
RelationshipType is handler-enforced. Recording a donation against a
contact never bumps any contact counter (cross-aggregate references
don't conflict with edits).

**Child-row identity (revised twice in review discussion):** child rows
carry ids in contract payloads (`ChildRow` base; server-minted UUIDv7 at
form render / import, omitted = new row) and are reconciled by id —
removed ids deleted, new ids created, kept ids **updated in place**,
except **identity fields**, which are immutable per id. An identity
field is a value the row *is* and that state may hang off: email
`address` (bounce state), phone `number`. Changing one means delete +
re-add (the UI may present that as edit-in-place by clearing the row's
id). **Addresses have no identity field** — the row id is the identity
and every field is freely correctable (fixing a postcode typo is an
update, not a replacement; history lives in revisions). This keeps
revision diffs structural (id sets + per-id field changes), keeps child
`created_at` honest, and lets `on_hold` follow the row safely. The
"nothing FKs a child row" rule is enforced by a meta-test over
`_meta.related_objects`.

**Pre-generated root ids:** create contracts accept an optional `id`
(minted at form render or by import pipelines) — duplicate id =
`DuplicateEntityError` (idempotent creates: double submits and retried
imports can't duplicate donors), and grouped actions can cross-reference
entities before they exist. On update the payload id must match the
target entity.

**No generic soft delete.** Children hard-delete (history lives in
revisions); lifecycle is explicit domain state on roots (`archived`,
relationship `end_date`, future contribution statuses). A `deleted_at`
flag would be a second history mechanism, a permanent query-filter
footgun, and a GDPR liability.

## Consequences

- Edit UI is **one autosaving form** (per David's preference, replacing
  the initial panel-per-contract layout): the whole form posts on field
  change (and via a reassurance Save button) to a single endpoint that
  splits the payload by contract field-sets, **diffs each section against
  current state, and executes only what changed** — unchanged sections
  produce no command, no counter bump, no revision. Multi-section saves
  share a `command_group("contact form save")`. Responses are
  out-of-band swaps only (status line, fresh counters, row containers
  after structural changes) so typing focus is never disturbed;
  `source="autosave"`. A tiny static app.js drops a saved row's id on
  the first keystroke into an identity field, expressing the edit as
  remove + add.
- Dedupe/merge is a later slice; merge will be an action
  (`command_group`) so it reads as one event.
- Anonymisation (consent/GDPR slice) is an action over the section
  contracts plus revision scrubbing.
- Households: relationship types are seeded (`Member of household`), UI
  deferred.
