<sv-page label="plan: external identifiers" category="plans">

<sv-prose id="b1">
## Design tree

*Confirmed by the human in round 3 (2026-10-18). Round 2 changed type management (g2q3) and how an empty type list looks (g2q4); everything else as recommended. Ready for building.*

- Multiple external identifiers: **its own plan, before the first real import** (contact-model g1q6 / g2q9)
  - **Own slice `contacts.identifiers`, counter `identifiersVersion`**; details v2 drops `externalIdentifier` (upcaster)
  - **System = a per-tenant `identifierTypes` list** (named, unique per tenant case-insensitively, archivable); rows hold `typeId`
    - **payment-provider ids (GoCardless, Stripe) live on giving's records**, not here; webhooks look up the mandate
    - no "HMRC ref" type: HMRC gives donors no reference
  - **Uniqueness: a (type, value) pair belongs to at most one contact, blocking**; one contact may hold several values of one type
  - **Matching: trimmed, case-insensitive** (`valueNormalized`); shown as typed
  - **Lookup: `findByIdentifier(type, value)` + exact-identifier match in the contact list search**; one index `[tenantId, valueNormalized, typeId]`
    - no cross-type "possible duplicate" warning
  - **Old field: proper two-phase migration** into an "External reference" type (loosen / backfill / tighten)
  - **Merge: live class, rows re-parented with their keys** like email and phone rows; ADR 0019 needs a one-line amendment
  - **Erasure: identifier rows are removed** on anonymisation
  - **Contact form: an "Identifiers" section after Addresses**, autosaved; a saved row's type and value are read-only with remove; a new row saves once both are filled
    - **shown only when the group has an active type, or the contact already has rows**; a group that never adds a type never sees it (*human, g2q4*)
    - **a duplicate value is "to fix" on the row, naming and linking the other contact** (same group only)
  - **Types: managed on an admin-only settings page now** (create, rename, archive); the form's picker only selects (*human, g2q3*)
    - **no seeded types**; the backfill creates "External reference" only where old values exist
    - **page at `/t/<slug>/settings/identifiers`**, under a "Settings" nav link only admins see; tags management joins it later
    - **archive only, never delete**: an archived type leaves the picker; its rows stay (marked "archived type") and `findByIdentifier` still finds them; reactivate any time
  - **Shown nowhere else for now**; the list search finds an exact identifier
  - **QC flows:** admin adds a type and it appears in the picker; add + remove an identifier; duplicate "to fix" naming the other contact while other sections save; list search by identifier; same value in another group doesn't clash
  - Import: **out of scope**; it will match on `findByIdentifier`
</sv-prose>

<sv-prose id="b2">
## Goal

A contact can carry any number of external identifiers, each a `{type, value}` child row, replacing the single `contacts.externalIdentifier` string on the details slice. Typical identifiers: the id from the charity's old CRM or spreadsheet, a membership number, a donor id from JustGiving / Enthuse / a payroll-giving agency. This follows CiviCRM's Identity Tracker extension (705 installs), which stores `{identifier_type, identifier, used_since}` rows per contact and offers a "find contact by identity" lookup that XCM and importers use for matching. It also records the ids of contacts merged away so lookups still land on the survivor; we get that for free from ADR 0019's identity set or from re-parenting the rows (q8).

Do it now because the only data in the field is seed data (20 % of `testSeedData` contacts carry `LEGACY-nnnn`). After the first real import, this becomes a live-data migration.

**Out of scope:** the import itself (it will match on these identifiers); integration-owned ids if q3 puts them in giving; identifiers on organisations as a register (charity number, Companies House) — that is "org identifiers" (#12, later), though the same rows could hold them.

**Facts checked:**
- HMRC gives donors no reference. Gift Aid claims identify donors by name, house name/number and postcode (B4.3). The charity's own HMRC reference is per-tenant, not per-contact. So there is no "HMRC ref" identifier type.
- `externalIdentifier` today: `convex/schema.ts:122` (+ index `by_tenant_external`), the details contract's uniqueness check (`convex/contacts/contracts.ts:48`), `rules.ts:45` (trim), the form's "External reference" field (`src/components/contact-form.tsx:345`), seeds (`devSeed`, `qcSeed`, `testSeedData`) and `externalIdentifier: ''` in eight test fixtures.
- ngo-go pinned "`externalIdentifier` unique per tenant when non-empty (import idempotency key)" (`docs/inherited-from-ngo-go.md:113`). Import idempotency is now also covered by `clientKey`, so identifiers become the *matching* key rather than the retry guard.
</sv-prose>

<sv-prose id="b3">
## Contracts and tables

| What | Shape | Contract / counter |
|---|---|---|
| `identifierTypes` (new aggregate) | `{name, nameNormalized, isActive, saveVersion}`; indexes `by_tenant`, `by_tenant_nameNormalized` (unique name, like tags) | `contacts.identifierType` / `saveVersion` |
| `contactIdentifiers` (new child table) | `{contactId, key, typeId, value, valueNormalized}`; `typeId` and `value` are identity fields, immutable per key; indexes `by_tenant_contact`, `by_tenant_key`, `by_tenant_valueNormalized_type` (`[tenantId, valueNormalized, typeId]`, serving both "this type + value" and "any type, this value") | `contacts.identifiers` / `identifiersVersion` on the contact |
| `contacts.details` | **v2**: `externalIdentifier` leaves the payload; upcaster v1→v2 drops it. Its uniqueness check moves to `contacts.identifiers` | `detailsVersion` (unchanged) |
| `contacts` | `externalIdentifier` and `by_tenant_external` removed; `identifiersVersion` added | — |

**Schema phases** (CLAUDE.md "two-phase"):
1. **Loosen:** add both tables; `identifiersVersion: v.optional(v.number())`; `externalIdentifier: v.optional(v.string())`; details v2 + upcaster (it stops writing the field, which keeps its old value for the backfill).
2. **Backfill** (migrations component, per contact with a non-empty value): ensure the tenant has an "External reference" type, add one identifier row, set `identifiersVersion: 0`, unset `externalIdentifier`. Contacts with no value get `identifiersVersion: 0` only. The identifier row goes through `contacts.identifiers` with `source: 'system'` so it has a revision (the migrations rule says contract-owned data changes through its contract).
3. **Tighten:** drop `externalIdentifier` and its index; `identifiersVersion` required; delete the backfill and its test.
</sv-prose>

<sv-prose id="b4">
## Steps (draft)

1. **X1 loosen** — schema (both tables, optional fields), `identifierType` + `identifiers` contracts, `prepareIdentifiers` in `rules.ts` (trim, normalise, duplicate value within one payload rejected), details v2 + upcaster, `findByIdentifier` query, `contactSlices` and `saveForm` gain `identifiers`, `currentPayloads` returns the slice, the list query matches an exact identifier. Files: `convex/schema.ts`, `convex/contacts/{validators,rules,contracts,queries,mutations}.ts`, fixtures dropping `externalIdentifier`.
2. **X2 backfill** — `contacts/migrations.ts` + test; run on every dev deployment and QC instance.
3. **X3 tighten** — schema; delete the backfill. *After X2 reports done everywhere.*
4. **X4a types settings page** — first settings route (`src/routes/t.$slug.settings.identifiers.tsx`, "Settings" nav link for admins), `saveIdentifierType` / `listIdentifierTypes` with `minRole: 'admin'` for writes, admin-only nav link. Parallel with X2 once X1 is merged.
5. **X4b contact form section** — `src/components/contact-form.tsx` + `src/lib/contact-form-state`: Identifiers section (hidden when no active types and no rows), select-only type picker of active types, read-only saved rows, duplicate "to fix" with a link; list search by exact identifier in `t.$slug.contacts.index.tsx`. Parallel with X4a.
6. **X5 seeds + QC** — `devSeed`, `qcSeed`, `testSeedData` write types and identifier rows (and one group with no types, to cover the hidden section); QC flows from the design tree in `qc/flows/contact.spec.ts`, `contacts.spec.ts` and a new `settings.spec.ts`. After X4a/X4b.
7. **ADR 0019 amendment** (for the human to accept): identifier rows join the email and phone rows re-parented in step 2, and the Live list. Drafted: `factory/out/planner-extid-adr-0019-amendment.md`.
</sv-prose>

<sv-prose id="b5">
## Tests (draft)

- Two tenants, same type name and value in each: both save; `findByIdentifier` in tenant A never returns B's contact (isolation).
- Same (type, value) on a second contact in one tenant → `duplicate_identifier`, naming nothing from another tenant.
- Value or type edited on a kept key → `immutable_child`; remove + add works.
- Saving identifiers never bumps `detailsVersion` and vice versa (no false stale between sections).
- Archived type: can't be newly added; kept rows survive; restore re-adds rows of an archived type (same rule as tags).
- Restore of a details **v1** revision (with `externalIdentifier`) succeeds through the upcaster and leaves identifiers alone.
- `saveIdentifierType` as staff or viewer → refused; as admin → saved. Renaming a type keeps every row.
- Backfill: a seeded `LEGACY-0001` contact ends with one row of type "External reference", a revision with source `system`, `externalIdentifier` unset; running it twice is a no-op.

## Domain rules that apply

- **3 (erasure)**: anonymisation removes identifier rows (the contact itself stays; no cascade delete).
- **6 (tenancy)**: both tables carry `tenantId` with tenantId-first indexes; all functions use the scoped constructors; uniqueness is per tenant.
- Rules 1, 2, 4, 5, 7 don't apply: no Gift Aid, consent, reclaim, comms or money here.
</sv-prose>

<sv-prose id="b6">
## Grill: round 1

Everything that doesn't depend on another open answer. UI and QC flows come in round 2.
</sv-prose>

<sv-ask id="g1q1" round="1">
**Where do the identifier rows live?**
- * their own slice `contacts.identifiers` with counter `identifiersVersion` (like tags). An import or integration adding an id never makes someone editing the name see a stale notice, and details stays biographical
- child rows inside `contacts.details` (details v2 carries an `identifiers` array; one counter for both)
</sv-ask>

<sv-ask id="g1q2" round="1">
**What is an identifier's "system"?**
- * a per-tenant `identifierTypes` list (like tags and relationship types): named, unique per tenant, archivable. Rows hold the type's id, so renaming keeps every row
- free text typed per row (typos split one system into several; uniqueness per system gets unreliable)
- a fixed list in code (old CRM, membership number, …) plus "other"
</sv-ask>

<sv-ask id="g1q3" round="1">
**GoCardless / Stripe customer ids.** Webhooks arrive with a mandate or customer id. Where does that id live?
- * on giving's own records (the mandate / customer row), which point at the contact. Webhooks look up the mandate, not the contact. Contact identifiers are for ids staff and imports know about
- as contact identifiers of reserved, system-owned types that staff can see but not edit
</sv-ask>

<sv-ask id="g1q4" round="1">
**Uniqueness within a tenant.**
- * a (type, value) pair belongs to at most one contact: blocking error. One contact may hold several values of one type (two old-CRM ids after merging duplicates)
- same, plus at most one value per type per contact
- not unique: an advisory warning naming the other contact (like shared emails)
</sv-ask>

<sv-ask id="g1q5" round="1">
**How do values match?** (for uniqueness and lookup)
- * trimmed, case-insensitive (`m123` = `M123`); shown as typed, like emails
- trimmed, exact case
- trimmed, case-insensitive, and spaces/dashes ignored (`AB-12 3` = `ab123`)
</sv-ask>

<sv-ask id="g1q6" round="1" pick="many">
**Lookup.** Which do we build in this plan? (one index `[tenantId, valueNormalized, typeId]` serves all three)
- * `findByIdentifier(type, value)` query: the import's match key
- * the contact list's search box also finds an exact identifier (any type), like exact email
- a "possible duplicates" warning when a value exists under a *different* type
</sv-ask>

<sv-ask id="g1q7" round="1">
**The existing single field.** Only seed data has values today.
- * proper two-phase migration (loosen / backfill into an "External reference" type / tighten). It is also the rehearsal for migrating real data later
- drop the values: loosen, clear the field, tighten. Seeds are regenerated anyway
</sv-ask>

<sv-ask id="g1q8" round="1">
**Merge (ADR 0019).** What happens to the loser's identifiers?
- * live class: rows are **re-parented with their keys** to the survivor, like email and phone rows (one-line ADR 0019 amendment). Lookup by an old id lands on the survivor directly
- left on the tombstone; `findByIdentifier` resolves through `mergedInto` (Identity Tracker's approach)
</sv-ask>

<sv-ask id="g1q9" round="1">
**Erasure (anonymisation).** What happens to a contact's identifiers?
- * removed: they link the person to records in other systems and carry no financial or tax history (contributions keep their own import references)
- kept: an old-CRM id may be needed to reconcile history later
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: data model, uniqueness, lookup, migration, merge and erasure. Round 2 will cover the contact-form UI, type management and QC flows. Send when done.
</sv-ask>

<sv-prose id="b7">
## Grill: round 2

How it looks, who manages types, and what QC proves. Facts: the form autosaves each slice through `saveForm` (700 ms debounce); a blocking rejection shows as "N to fix" on that section while other sections still save. Writes need `staff`, reads `viewer` (ADR 0020). There is no tags admin page yet.
</sv-prose>

<sv-ask id="g2q1" round="2">
**Contact form section.**
- * an "Identifiers" section after Addresses, autosaved like the others. Each row: type picker + value. A saved row's type and value are read-only with a remove button (change = remove + add); a new row saves once both are filled
- inside the Details section, under the name fields
- read-only on the form; added only by import or a separate dialog
</sv-ask>

<sv-ask id="g2q2" round="2">
**A duplicate value.** Another contact in this group already has that (type, value).
- * "to fix" on the row, naming and linking the other contact (same group only, so nothing leaks)
- "to fix" without naming the other contact
</sv-ask>

<sv-ask id="g2q3" round="2">
**Creating and managing types.**
- * staff create a type inline from the picker ("New type: …"); rename and archive wait for a settings page shared with tags (later)
- a settings page for types now (create, rename, archive), admin only; the picker only selects
- inline create now, and the settings page now too
</sv-ask>

<sv-ask id="g2q4" round="2">
**Types every new group starts with.**
- * none: types appear on first use or from the import's column mapping (the backfill creates "External reference" only where old values exist)
- seed "Membership number" and "Previous system ID"
</sv-ask>

<sv-ask id="g2q5" round="2">
**Where identifiers show besides the form.**
- * nowhere else for now; the list's search box finds an exact identifier
- also as a column in the contacts list
- also under the name in the contact page header
</sv-ask>

<sv-ask id="g2q6" round="2" pick="many">
**QC flows** (each step under 100 ms, K=5, per the QC suite). Untick any to drop.
- * add an identifier with a new inline type, then remove it
- * a duplicate value shows "to fix" naming the other contact; other sections still save
- * list search by an exact identifier opens that contact
- * a contact in another group with the same value doesn't clash (isolation)
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: contact form, types, QC. After this I fold everything in and send a final confirmation round.
</sv-ask>

<sv-prose id="b8">
## Grill: round 3 (confirmation)

Round 2 folded in above: types get an admin-only settings page now, and the Identifiers section stays hidden until a group has a type. Two small questions that fall out of that, then the confirmation. **Sending this round as approved confirms the whole plan** and I hand it to the controller for building.
</sv-prose>

<sv-ask id="g3q1" round="3">
**Where the settings page lives.** It is the first settings page in the app.
- * `/t/<slug>/settings/identifiers`, under a "Settings" nav link that only admins see; tags management joins it later
- a standalone "Identifier types" link in the main nav, admins only
</sv-ask>

<sv-ask id="g3q2" round="3">
**Archiving a type.**
- * archive only, never delete: an archived type leaves the picker, its rows stay on contacts (marked "archived type") and `findByIdentifier` still finds them, so old ids keep matching on import. Reactivate any time
- archive as above, plus delete for a type with no rows
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
Round 3: settings placement, archiving, and confirmation of the whole plan (design tree, steps X1–X5 + the ADR 0019 amendment, tests). **Approve = confirmed for building**; revise = tell me what's wrong.
</sv-ask>

</sv-page>
