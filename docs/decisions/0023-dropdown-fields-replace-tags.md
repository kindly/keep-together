# 0023 — Dropdown fields replace tags

Status: Accepted (2026-10-21) · from the dropdown fields plan
(`factory/plans/dropdown-fields.sv`, confirmed by the human in grill
round 2). The answer behind each point is cited by question, e.g.
*(g1q3)*. Fields are built on `main` up to `cf59ef7` (plan steps 1–5).
Their QC flows (step 6) and the removal of tags (steps 7–9) are still
to come, so tags exist on `main` but are on their way out. Where the
build differs from the plan, this ADR follows the build and says so
("Differences from the plan" below).

## Context

Contacts had free-form tags (seeded "member" and "volunteer"):
a `tags` table, a `contactTags` link row per contact per tag, and the
`contacts.tags` / `contacts.tag` contracts. They were never important to
the product, and they make the selections a charity really wants
("active volunteers in the North") hard:

- **Convex has no array indexes.** A contact's tags can't be an indexed
  array on the contact, so "everyone tagged X" needs the link table, and
  "tagged X and Y" is an intersection across rows that no index serves.
- **With search text**, a tag filter can't use the search index. It falls
  back to a capped window (`LIST_SCAN_CAP`) that can report "too broad".
- **Tag names are in the search text**, so a rename re-indexes every
  carrier in scheduled batches.

What organisations actually do with tags is mostly single-valued
categorisation: a status, a region, a supporter type. CiviCRM offers
both tags and EAV custom fields (research.md B1, B2); we copy neither.

## Decision

**1. Admin-defined dropdown fields, single choice.** An organisation
defines up to five dropdown fields for its contacts, e.g. "Volunteer
status: Active / Lapsed / Prospect". A field holds one option or nothing
*(g1q1)*. Multi-choice would be tags again: array values can't be indexed
and every combination is OR across rows. A contact that is both a member
and a volunteer gets two fields. Each field applies to the contact kinds
chosen for it (default: all three). The form and the list filter show it
only for those kinds, and setting it on another kind is refused *(g1q2)*.
Other field types, required fields and fields on other entities are out
of scope.

**2. Values live in slots.** `FIELD_SLOTS` (`convex/lib/fieldSlots.ts`,
5 for now) is the one place the count lives. A field is assigned the
lowest free slot when it's created, and creating one when every slot is
taken is refused. The slot is system-owned: the field contract preserves
it. A contact's value for the field in slot N is the plain optional
`contacts.fieldN`, an option id; absent means not set. The `contactSearch`
projection copies the slots, and `fieldSlots.ts` generates their schema
fields, their indexes and their search filter fields, so raising the count
can't forget one (a schema test checks it). Contacts store ids only, so
renaming an option or a field never rewrites a contact.

**3. The ceiling.** Each slot costs `contactSearch` two indexes,
`(tenantId, fieldN, sortName)` and `(tenantId, fieldN, archived,
sortName)`, the same pair the source filter uses, plus one filter field
on `search_text`. Convex's limits (checked against the limits page for
convex 1.47.0, recorded in `fieldSlots.ts`) are 32 indexes per table,
16 filter fields per search index and 8 filters per search query.

| Slots | Indexes | Search filter fields |
|---|---|---|
| 5 | 17 | 11 |
| 8 | 23 | 14 |
| 10 | 27 | **16** |

Tenant, archived, kind and the three acquisition ids take 6 filter
fields, so **10 slots is the hard wall** (the 32-index limit would come at
12). About 8 is the practical limit, because every projection write
maintains every index. A search query has 8 filters, and tenant, archived,
kind and a source filter can take 4 of them, so **at most 4 field filters
go into the search index**. Any more are checked per row.

**4. Past the ceiling: a join table.** If organisations need more than
about 8 fields, values move to `contactFieldValues (tenantId, fieldId,
optionId, archived, sortName, contactId)`, one row per contact per set
field. Its indexes don't grow with the number of fields. The cost is that
"search text + field" can no longer use the search index and falls back
to the capped window that tags use today. The contract payload already
names fields by id, not by slot, so it wouldn't change.

**5. Changing `FIELD_SLOTS` is loosen-only, and the deploy waits.**
Raising the count adds optional fields and indexes. Absent means not set,
so there's no backfill and no tighten. But the push changes
`search_text`'s filter fields, so Convex rebuilds that search index (and
builds the new indexes) before the push completes. On a large deployment
the deploy waits for it. Plan for that; don't interrupt it. Lowering the
count is a different change: the slots being removed must be empty first.

**6. One contract slice for the values.** `contacts.fields` (counter
`fieldsVersion`) covers every field, with history and restore. Its
payload is `{ values: [{ fieldId, optionId }] }` and apply writes each
value to its field's current slot *(g1q3)*. Two people editing different
fields on one contact at once get the usual stale-merge prompt, which is
rare and harmless. **Tier-1 checks** (ADR 0015): the option belongs to
the field, the field applies to the contact's kind, and an option the
contact doesn't already hold must be active. **Restore** may bring back an
archived option. It skips a value whose field has been retired or no
longer suits the kind, and says so.

**7. Field and option definitions are their own aggregates.** In
`convex/contacts/`, beside identifier types, because only contacts carry
fields:

- `contactFields`, contract `contacts.field` (`saveVersion`): label
  (unique per tenant, case-insensitive), `appliesTo`, `isActive`, and the
  system-owned `slot`.
- `contactFieldOptions`, contract `contacts.fieldOption` (`saveVersion`):
  `fieldId` (never changes), label (unique within the field), `position`
  in the admin's order *(g1q6)*, `isActive`, and a system-owned `used`
  marker. The marker is set the first time the option goes on a contact
  (`markOptionUsed`, in the caller's transaction) and never cleared. After
  that it's a read-only check, so a popular option doesn't become a write
  hot spot.
- An option can be deleted while unused, and only archived after that.
  An archived option leaves the dropdown, and contacts that hold it keep
  it *(g1q4)*. Option labels are **not** in the search text: the field
  filters do that job exactly, and a rename re-indexes nothing *(g1q11)*.

**8. Archive, retire, delete, and slot reuse** *(g1q5)*.

- **Archive** hides a field and keeps its values and its slot.
- **Retire** frees the slot. It's a paginated action (`retireField`) that
  first clears every holder's value through `contacts.fields`, with
  history, under a command group "Retire field *Label*" per batch. Only
  then does it unset the field's `slot`. The field and option rows stay,
  so history can still name the old values. Because the values are gone
  before the slot is free, the next field created in that slot starts
  empty and never sees the old values.
- A field none of whose options was ever used can be **deleted** outright.

**9. Who manages.** Admins manage fields and options, and so do staff
when "staff can manage fields" is on (`tenantPreferences.staffCanManageFields`,
contract `tenantPreferences.fields`, counter `fieldsVersion`; off by
default), the same pattern as ADR 0020 decision 2. `ListKind` gains
`fields`. Any staff member can set any value *(g1q8)*. A new tenant starts
with no fields *(g1q16)*.

**10. The contacts list** *(g1q9, g1q10)*. There's one filter per active
field, including "not set", and values show as labelled chips on each row,
with no extra columns. Several field filters combine. While browsing, the
first is the index range and the rest are checked per row, so a page can
come back short and "Load more" carries on. With search text, decision
3's limit applies. **Bulk "set field"** replaces bulk tag: up to 100
contacts (`BULK_FIELD_LIMIT`), set or clear, one contract per contact
under one command group. Contacts of a kind the field doesn't apply to
are skipped and counted *(g1q7)*.

**11. Tags are retired** *(g1q12, g1q13)*. Once fields and their QC flows
are in (steps 1–6), tags come out in three steps:

- **Step 7:** remove the tag UI, the `contacts.tags` and `contacts.tag`
  contracts, `bulkTag`, the tag filters, tag words in the search text
  (re-projected) and the tag QC flows. Loosen the tag counters.
- **Step 8:** a migration deletes the `tags` and `contactTags` rows on
  every deployment. Tag data is dropped, not migrated, because there are
  no real tenants yet.
- **Step 9:** tighten. Remove the tables, the counters, the tag
  preference fields and `ListKind` `tags`.

Old tag revisions stay. History shows them read-only as "Tags (retired)",
and restore refuses them with a clear message. **Complex selections**,
such as combinations of fields, are not an index problem we solve here.
They become saved segments later: a background job that materialises the
matching contacts.

**12. Rules for plans not yet built.**

- **Erasure (rule 3):** anonymising a contact clears every field value
  through `contacts.fields`. Option rows aren't personal data and stay
  *(g1q15)*.
- **Merge (ADR 0019):** staff choose each field's value. The default is
  the survivor's value, or the other contact's if the survivor has none
  *(g1q16)*.
- **Consent (rule 2):** a dropdown field is never consent. "Newsletter:
  yes" belongs in the consent log, and the Settings tab says so.
- **Comms** segments by these fields where the product brief said
  "tagged segments". **Import** maps CSV columns onto them.

## Differences from the plan

The plan page predates review of the build. Where they differ, the build
is authoritative:

- **`contactFields.retiring`** (optional for good) is set while a retire
  is clearing values. A retiring field takes no new value, can't be
  reactivated, and refuses every field and option edit. The retire
  archives the field first, then marks it.
- **Retire finds holders from `contacts`**, in a paginated pass over the
  tenant's contacts (archived ones included), never from `contactSearch`.
  It frees the slot only after a whole pass finds no holder, and it's
  resumable. The retire's revisions and group names carry the caller as
  the actor.
- **A restore records what it wrote.** `executeContract` gained a
  `restorePayload` hook, run before apply, whose result is both applied
  and recorded. A restore leaves fields created after the revision alone
  and keeps their values. It reports each value it left out: retired,
  wrong kind, or added after this version.
- **Bulk clear** clears every holder, whatever its kind. Only setting is
  kind-checked.
- **Labels** are unique among live fields, so a retired field's label is
  free again. A field has at most 100 options (`FIELD_OPTION_LIMIT`).
- **A field change on the form** runs in a command group named after it,
  e.g. "Region: North, Type cleared".

## Alternatives rejected

- **Keep tags, or add multi-choice fields.** These need array values,
  which Convex can't index *(g1q1)*.
- **One contract slice per slot.** Editing different fields would never
  conflict, but each extra slot would add a counter and a contract *(g1q3)*.
- **Option labels in the search text.** A rename would re-index every
  holder *(g1q11)*.
- **Migrate tags into yes/no fields.** That needs one slot per tag, so
  only five would survive, and there's no real tag data to keep *(g1q12)*.
- **Remove tags first, build fields after.** The app would have nothing
  to segment by in between *(g1q13)*.
- **A join table from the start.** Search text + field filter would lose
  the search index, and five slots fit well inside the limits.
- **CiviCRM-style EAV custom fields** (research.md B1, B7). They're
  flexible, but every filter is a join and the query cost grows with them.

## Consequences

- **Schema** (two-phase): loosen (the two tables, `contacts.field1…5` and
  `contactSearch.field1…5` optional for good, the counters and the
  preference optional) → `backfillFieldsVersion` and
  `backfillFieldsPreference` → tighten in step 9, together with the tag
  removal. The order for a deployment that's behind is in
  `docs/migrations.md`.
- **Superseded here:** ADR 0019's "tags merged by union" (decision 12
  replaces it) and ADR 0014's "tags instead of `contact_sub_type`"
  (dropdown fields do that job). The tag half of ADR 0020's list-manager
  switch goes when step 9 removes it.
- **QC:** the tag flows are replaced by field flows at the same budget
  classes *(g1q14)*.
- **Raising `FIELD_SLOTS`** is a one-line change plus a deploy that waits
  for the search index rebuild (decision 5). Going past 8 means revisiting
  decision 4 first.
