<sv-page label="plan: dropdown fields" category="archive">
<sv-prose id="done">
**Complete 2026-10-23: all 10 steps merged and deployed to every dev deployment; tags removed (data dropped, schema tightened at c3a98e1); last commit `e9d10fc`.**
</sv-prose>


<sv-prose id="b1">
# Plan: dropdown fields (replacing tags)

**Status:** confirmed by the human (round 2, 2026-10-21). Ready to build. Planner `planner-dropdowns`.

## Design tree

- **Tags go.** They were never important, and they make complex selections painful later. *(2026-10-21)*
- **They're replaced by admin-defined dropdown fields**, a few per organisation, **5 slots for now**. *(2026-10-21)*
  - **Single choice:** a field holds one option or nothing. *(g1q1)*
  - **Kinds:** each field applies to the kinds chosen for it, defaulting to all three. The form and the filter show it only for those kinds, and setting it on another kind is rejected. *(g1q2)*
  - **Storage:** each slot is a plain optional field on the contact (`field1`…`field5`, absent means not set). It's copied onto `contactSearch` by the projection hook and indexed there. Ids only, so renaming an option never rewrites contacts.
  - **The slot count comes from one constant.** Raising 5 to 8 adds optional fields and indexes: loosen only, no backfill, no tighten.
  - **Known limit: about 8–10 slots.** Past that, values move to a join table (see "The slot ceiling").
  - **Combining fields** is a later saved-segment background job, not an index.
- **The value is one contract slice, `contacts.fields`,** with its own counter, history and restore. The payload names fields by id. *(g1q3)*
- **Options:**
  - in the order the admin sets; *(g1q6)*
  - a hidden `used` marker is set on first use and never cleared. An option can be deleted while unused and only archived after that. An archived option leaves the dropdown, and contacts that already have it keep it. *(g1q4)*
- **Whole fields:**
  - **archive** hides a field and keeps its values and its slot;
  - **retire** clears every value through the contract and frees the slot, with the rows kept for history;
  - a field none of whose options was ever used can be deleted outright. *(g1q5)*
- **Rights:** fields and options are managed by admins, plus staff when "staff can manage fields" is on (off by default). Any staff member can set any value. *(g1q8)*
- **On the contacts list:**
  - a filter dropdown per active field, including "not set";
  - values show as labelled chips on each row, with no extra columns; *(g1q9)*
  - several field filters can be combined while browsing: the first is the index range, the rest are checked per row; *(g1q10)*
  - option labels are **not** in the search text. *(g1q11)*
- **Bulk "set field"** replaces bulk tag: up to 100 contacts, set or clear. Contacts of the wrong kind are skipped and counted. There's one contract per contact, under one command group. *(g1q7)*
- **Removing tags:** after fields are built and their QC flows pass. The tag data is dropped, and old tag revisions stay read-only in history. *(g1q12, g1q13)*
- **QC:** the tag flows are replaced with the field flows, at the budget classes of the flows they replace. *(g1q14)*
- **Erasure** clears every field value through the contract. *(g1q15)*
- **Merge:** staff choose each field's value, defaulting to the survivor's, or the other contact's if the survivor has none. *(g1q16)*
- **No starter fields:** a new tenant starts with five empty slots. *(g1q16)*
- **The parked `perf/tag-fields` branch** is abandoned. Deleting the branch is up to you or the controller.
</sv-prose>

<sv-prose id="b2">
## Goal

Let an organisation define up to five single-choice dropdown fields for its contacts, for example "Volunteer status: Active / Lapsed / Prospect" or "Region: North / South". Staff set a contact's value on the form, singly or in bulk, and filter the contacts list by any field with or without search text. Tags are then removed completely: their UI, contract, tables, search words and QC flows. Their history stays readable.

**Out of scope:**
- other field types (text, number, date, checkbox) and required fields;
- multi-choice;
- combinations of fields, which become saved segments, a later background job;
- fields on gifts or other entities;
- email segments by field (the comms plan will use these fields where the product brief said "tagged segments");
- importing field values from CSV (the import plan will).
</sv-prose>

<sv-prose id="b3">
## The slot ceiling

`contactSearch` has 7 indexes today: `by_tenant_contact` and the six source-code ones. It also has one search index, whose 6 filter fields are tenant, archived, kind and the three acquisition ids.

Each slot adds 2 indexes, `(tenantId, fieldN, sortName)` and `(tenantId, fieldN, archived, sortName)`, the same pair the source filter uses, plus 1 search filter field. Every write of the projection row maintains all of them, and every contact save that changes the row pays for that.

| Slots | Indexes | Search filter fields |
|---|---|---|
| 5 | 17 | 11 |
| 8 | 23 | 14 |
| 10 | 27 | **16** |

**The hard limit is the search index's 16 filter fields.** The table limit of 32 indexes comes later. The builder confirms both numbers against Convex's limits page in step 1. So 10 slots is the absolute ceiling, and about 8 is the practical one once write cost is counted.

Past that, values move to a join table, `contactFieldValues (tenantId, fieldId, optionId, archived, sortName, contactId)`, with one row per contact per set field. Its indexes don't grow with the slot count. The cost is that "search text + field" can no longer use the search index, so it would fall back to the capped window that tags use today.

**Raising 5 to 8 is loosen-only:**
- `FIELD_SLOTS` in one module generates the optional schema fields, the index pairs and the filter fields.
- The contract payload names fields by id, not by slot (g1q3), so its shape doesn't change.
- Nothing needs backfilling, because absent means not set.
</sv-prose>

<sv-prose id="b4">
## Contracts and tables

Everything lives in **`convex/contacts/`**, beside identifier types and today's tags. Only contacts carry fields, so they don't need their own module the way source codes did.

| Table / field | Slice and contract | Counter | Notes |
|---|---|---|---|
| `contactFields` (new) | `contacts.field`, one row per field definition | `saveVersion` | `label`, `labelNormalized` (unique per tenant), `appliesTo: kind[]`, `isActive`, `slot?` (1…`FIELD_SLOTS`; absent once the field is retired, which frees the slot). Index `by_tenant_slot`. The slot is assigned on create, to the lowest free one, and is system-owned: the contract preserves it |
| `contactFieldOptions` (new) | `contacts.fieldOption`, one row per option, its own aggregate like a source-code part | `saveVersion` | `fieldId` (never changes), `label`, `labelNormalized` (unique within the field), `position`, `isActive`, plus a system-owned `used` marker. The marker is set the first time the option goes on a contact and is never cleared. The contract preserves it, and only an unused option can be deleted. Index `by_tenant_field_position` |
| `contacts.field1`…`field5` | `contacts.fields` (new) | `fieldsVersion` | `v.optional(v.id('contactFieldOptions'))`, optional for good. The payload is `{ values: [{ fieldId, optionId }] }`, and apply maps each field to its current slot. **Tier-1 checks:** the option belongs to the field, the field applies to the contact's kind, and an option that isn't already on the contact must be active. The first use marks the option `used` (read-only after that, so a popular option never becomes a write hot spot) |
| `contactSearch.field1`…`field5` | derived, no contract | none | copied by `projectContactSearch`, with 2 indexes each and a search filter field each (see "The slot ceiling") |
| `tenantPreferences.staffCanManageFields` | `tenantPreferences.fields` (new) | `fieldsVersion` | same pattern as tags and identifier types; `ListKind` gains `fields` and later loses `tags` |

**Retiring a field** that has values is a paginated action. It runs the `contacts.fields` contract on each contact carrying the field, under the command group "Retire field *Label*", and then clears the field's `slot`. The field and option rows stay, so history can still name them. **Restore** skips values whose field has been retired, and says so.

**Tags going away:** the `contacts.tags` and `contacts.tag` contracts are deleted. Their revisions stay: history shows them read-only as "Tags (retired)", and restore refuses them with a clear message. Tables and fields leave in three phases (steps 7–9).

**Schema changes are two-phase:**
1. *Loosen:* add the two new tables, `contacts.field1…5` (optional for good), `contacts.fieldsVersion` (optional for now), `contactSearch.field1…5` with their indexes and filter fields, and the two preference fields (optional for now).
2. *Backfill:* `fieldsVersion: 0` on every contact, and the switch set to `false` with counter `0` on every preferences row.
3. *Tighten:* make `fieldsVersion`, `staffCanManageFields` and the preference `fieldsVersion` required, in a separate deploy.
</sv-prose>

<sv-prose id="b5">
## Steps

1. **Schema loosen + backfill** for fields, with `FIELD_SLOTS = 5` and the generator for fields, indexes and filter fields. Files: `convex/lib/appSchema.ts`, a new `convex/lib/fieldSlots.ts`, `convex/contacts/migrations.ts`, `convex/platform/migrations.ts`.
2. **Field definitions backend:** contracts `contacts.field` and `contacts.fieldOption`; slot allocation; archive, reorder and delete-while-unused; `markOptionUsed`; the retire action; the `fields` query (definitions with their options); `ListKind` `fields`; preference contract `tenantPreferences.fields`. Files: `convex/contacts/fields.ts` (new), `convex/lib/lists.ts`, `convex/platform/preferences.ts`.
3. **Settings tab "Fields":** add and rename fields, choose which kinds they apply to, edit options (add, rename, reorder, archive, delete while unused), retire a field, and the staff switch. Files: `src/routes/t.$slug.settings.fields.tsx`, `t.$slug.settings.tsx`. **After step 2.**
4. **Contact values backend:** contract `contacts.fields`, its place in `saveForm`, `bulkSetField`, the `project` hook copying slots onto `contactSearch`, history labels and view; `list` and `search` take field filters. Files: `convex/contacts/contracts.ts`, `mutations.ts`, `searchProjection.ts`, `queries.ts`, `search.ts`, `history.ts`, `view.ts`. **In parallel with step 2**, against a stub of `fields`.
5. **Contact values UI:** a dropdown per field on the contact form and page; field filters and value display on the list; bulk set field. Files: `src/components/contact-form.tsx`, `src/lib/contact-form-state.ts`, `src/routes/t.$slug.contacts.index.tsx`, `t.$slug.contacts.$contactId.tsx`, `src/lib/paged-list.ts` if the filter key changes. **After steps 2 and 4.**
6. **QC:** the flows `fields.create`, `fields.option.add`, `fields.archive`, `fields.filter`, `contact.field.set`, `contact.field.clear` and `settings.staffFields.toggle` are `repeatable`. `contacts.bulkSetField` is `bulk` at 500 ms, and the server budget for `contacts/mutations:bulkSetField` is 370 ms (g1q14). The QC seed gives tenant A a field. Files: `qc/flows/fields.spec.ts` (new), `qc/flows/contact*.spec.ts`, `qc/budgets.ts`, `convex/platform/qcSeed.ts`. **After step 5.**
7. **Remove tags (code) + loosen their schema:**
   - Delete the tag routes (`t.$slug.tags.tsx`, `t.$slug.settings.tags.tsx`), `bulkTag`, the tag filter in `list` and `search`, tag words in the search text, `seedTags`, the tag parts of the QC seed, `qc/flows/tags.spec.ts` and the tag budget keys, and the tag tests.
   - History renders tag revisions read-only, and restore refuses them.
   - Make `contacts.tagsVersion` and the tag preference fields optional.
   - Re-project `contactSearch` so tag words leave the search text.
   - **After step 6** (g1q13).
8. **Drop tag data:** a migration deletes the `contactTags` and `tags` rows and unsets the loosened fields, run on every deployment. Files: `convex/contacts/migrations.ts`.
9. **Tighten**, in a separate deploy after steps 1 and 8 have run everywhere:
   - remove `tags`, `contactTags`, `contacts.tagsVersion`, the tag preference fields and `ListKind` `tags`;
   - make the new fields' counters required.
10. **Docs:**
    - ADR **0023 "Dropdown fields replace tags"**, written by the builder from this page: single choice, slots, the ceiling and the join-table fallback, tags retired;
    - `docs/architecture.md`;
    - the "tags" lines in `docs/product-brief.md`;
    - a note in `docs/research.md` B2 that CiviCRM's custom fields and tags were deliberately not copied.
</sv-prose>

<sv-prose id="b6">
## Tests

- **Two-tenant isolation:** tenant B can't see A's fields or options. Setting one of A's option ids on a contact in B is rejected, and so is filtering B's list by it.
- **Slots:** a field takes the lowest free slot. Creating a field when all 5 slots are full is refused. A retired field frees its slot, and the next field created reuses it without seeing the old values.
- **Value checks:** an option from another field is rejected, as is a field that doesn't apply to the contact's kind. An archived option is refused when newly set but kept when already on the contact. The first use marks the option `used`, a used option can't be deleted, and the marker survives a save and a restore.
- **Retire:** every carrier's value is cleared with history, under one command group per batch. The old values still show by name in history. Restoring a pre-retire revision skips the retired field.
- **List:** filtering by a field works with and without search text, with and without archived contacts, and for "not set". Renaming an option changes what the list shows without any write to contacts or `contactSearch`.
- **Bulk set field:** sets or clears up to the bulk limit, skips contacts of the wrong kind and reports how many it skipped. One contract and one projection rebuild run per contact.
- **Revisions and restore:** every new contract goes through the meta-test.
- **Tags gone:** tag revisions still render in history. Restoring one is refused. No tag words remain in any `contactSearch.text` after re-projection.
- **The `FIELD_SLOTS` generator:** the schema has exactly 2 indexes and 1 filter field per slot (a schema test, so raising the count can't forget one).

## Domain rules that apply

- **2 (consent):** a dropdown field is never consent. "Newsletter: yes" belongs in the consent log, and the Settings tab says so.
- **3 (erasure):** anonymisation clears every field value through `contacts.fields` (g1q15). Option rows aren't personal data and stay as they are. Neither erasure nor merge is built yet, so ADR 0023 records two rules for those plans to inherit: erasure clears the values, and merge chooses per field, defaulting to the survivor's value or the other contact's if the survivor has none.
- **6 (tenancy):** the two new tables get `tenantId` and tenantId-first indexes, and functions use the scoped constructors only.
- Rules 1, 4, 5 and 7 are not affected.
</sv-prose>

<sv-prose id="b7">
## Grill round 1
</sv-prose>

<sv-ask id="g1q1" round="1">
**Single or multi choice?** A contact who is both a member and a volunteer would need two fields ("Member: yes/no", "Volunteer: active/lapsed") rather than one multi-choice "Type".
- * single choice: each field holds one option or nothing. Multi-choice would be tags again: array values can't be indexed, and every combination is OR across rows.
- multi-choice allowed on some fields
</sv-ask>

<sv-ask id="g1q2" round="1">
**Which contact kinds does a field apply to?** (individual, organisation, household)
- * chosen per field, defaulting to all three. The form and the list filter show the field only for kinds it applies to, and setting it on another kind is rejected.
- every field applies to every kind
- individuals only, for now
</sv-ask>

<sv-ask id="g1q3" round="1">
**The value as a contract slice.**
- * one slice, `contacts.fields`, covers all the fields, with its own counter, full history and restore. Two people editing *different* fields on one contact at the same moment get the usual stale-merge prompt, which is rare and harmless. The payload names fields by id, so raising the slot count doesn't change its shape.
- one slice per slot (`contacts.field1`…), so editing different fields never conflicts. That's 5 counters, and 5 more contracts every time the slot count grows.
</sv-ask>

<sv-ask id="g1q4" round="1">
**Archiving and deleting an option.**
- * the same as source codes: a hidden `used` marker is set the first time the option goes on a contact and is never cleared. An option can be deleted while it's unused, and only archived after that. An archived option leaves the dropdown, but contacts that already have it keep it and it still shows.
- an option can be deleted at any time; deleting a used option clears it from every contact first (in history)
</sv-ask>

<sv-ask id="g1q5" round="1">
**Getting rid of a whole field**, which frees its slot for a new one.
- * archive hides the field and keeps its values and its slot. **Retire** clears every contact's value through the contract (all in history), then frees the slot. The field and its options stay as hidden rows so history can still name them. A field none of whose options were ever used can simply be deleted.
- archive only: once used, a field keeps its slot forever (slots then run out for good)
</sv-ask>

<sv-ask id="g1q6" round="1">
**What order are options in?**
- * the order the admin sets (drag to reorder), so "Bronze, Silver, Gold" reads right
- alphabetical
</sv-ask>

<sv-ask id="g1q7" round="1">
**Bulk "set field"**, replacing bulk tag.
- * select contacts on the list (up to 100, the same limit as bulk tag), pick a field and an option or "clear". Contacts of a kind the field doesn't apply to are skipped and counted. Each contact gets its own contract and history entry, under one command group.
- the same, but it also offers "set only where empty"
- no bulk edit in v1
</sv-ask>

<sv-ask id="g1q8" round="1">
**Who manages fields, and who sets values?**
- * fields and options are managed by admins, plus staff when an admin turns on "staff can manage fields" (off by default), like tags today. Values can be set by any staff member, on any field.
- the same, plus a per-field "only admins can set this" lock
- fields and options are managed by admins only
</sv-ask>

<sv-ask id="g1q9" round="1">
**How fields show on the contacts list.**
- * filters: one dropdown per active field in the filter bar (with "not set" as a choice), and a row shows its values as small labelled chips, the way tags show today. No extra columns.
- filters, plus a column for each field an admin marks "show in list"
- filters only; values are shown on the contact page
</sv-ask>

<sv-ask id="g1q10" round="1">
**Filtering by two fields at once while browsing** (no search text). The index serves one field; any others are checked row by row, the way a kind is checked under a source filter today.
- * allowed: the first field picked is the index range, the rest are checked per row, so pages can come up short and "Load more" carries on until the list ends. Proper combinations become saved segments later.
- one field filter at a time; combinations wait for saved segments
</sv-ask>

<sv-ask id="g1q11" round="1">
**Should an option's label be in the search text?** For example, typing "volunteer" finds everyone whose Type is Volunteer.
- * no: the field filters do that job exactly. Keeping labels out of the text also means renaming an option never re-indexes thousands of contacts, which today's tag rename has to do in scheduled batches.
- yes, like tags today (a rename re-indexes every carrier)
</sv-ask>

<sv-ask id="g1q12" round="1">
**Existing tag data.** As far as I know, there are no real tenants yet, only dev and QC deployments.
- * drop it: the migration deletes the tag rows. Old tag revisions stay in history, read-only.
- migrate: each tag becomes a yes/no field (one slot per tag, so only the first five)
- check the deployments for real data first, then decide
</sv-ask>

<sv-ask id="g1q13" round="1">
**When do tags come out?**
- * after fields are built and their QC flows pass (steps 1–6, then 7–9), so the app always has one way to segment
- first: remove tags straight away, and build fields after (simpler steps, but nothing to segment by in between)
- both together in one branch
</sv-ask>

<sv-ask id="g1q14" round="1">
**QC flows and budgets.** The proposed new flows are `fields.create`, `fields.option.add`, `fields.archive`, `fields.filter`, `contact.field.set`, `contact.field.clear` and `settings.staffFields.toggle`, plus bulk `contacts.bulkSetField`. All the `tags.*`, `contact.tag.*` and `contacts.bulkTag` flows are removed.
- * the same budget classes as the tag flows they replace: `repeatable` for each flow, `bulk` at 500 ms for bulkSetField, and a server budget of 370 ms for `contacts/mutations:bulkSetField`, the same as bulkTag's
- measure first: the builder runs the flows unbudgeted and brings you the numbers to set the budgets from
</sv-ask>

<sv-ask id="g1q15" round="1">
**Erasure (anonymise, don't delete).** A field can describe the person ("Volunteer status", or something sensitive an admin invents).
- * anonymising a contact clears every field value through the contract. Option rows aren't personal data and stay as they are.
- field values are kept on an anonymised contact (useful for counts)
</sv-ask>

<sv-ask id="g1q16" round="1">
**Merge, and starter fields.** On merge (ADR 0019), staff choose each field's value. The default is the survivor's value, or the other contact's if the survivor has none.
- * that merge rule, and **no starter fields**: a new tenant starts with five empty slots (today's seeded member/volunteer tags don't carry over)
- that merge rule, plus a seeded "Supporter type" field (Member / Donor / Volunteer)
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: the field model, values, options, the list, removing tags, QC. Send when done. Riders are welcome on any question.
</sv-ask>

<sv-prose id="b8">
## Round 2: confirmation

Round 1 came back with every answer as suggested, and the frontier is now empty. The design tree at the top is the settled design, and the brief below it is what builders will execute: steps 1–6 build fields, steps 7–9 remove tags, step 10 is docs. Approve if it all matches what you meant. Revise, with a note, if anything doesn't.
</sv-prose>

<sv-ask id="g2fin" round="2" role="close">
Final round: confirm the plan (design tree, brief, steps).
</sv-ask>

</sv-page>
