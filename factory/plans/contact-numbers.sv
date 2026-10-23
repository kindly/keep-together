<sv-page label="plan: contact numbers" category="archive">
<sv-prose id="done">
**Complete 2026-10-23: all 6 steps merged and deployed; every contact numbered, `contacts.number` required (e3ae3db); last commit `e9d10fc`.**
</sv-prose>


<sv-prose id="b1">
# Plan: contact numbers

## Design tree

*Confirmed by the human (round 3, 2026-10-23). Ready to build.*

- **Goal**: every contact gets a short sequential number, per organisation, that staff can write on a paper Gift Aid form and type into quick search. *(human, cash-gifts chat 3)*
- **Allocated in the create transaction** from one counter row per tenant, in its own table `contactNumberSequences` (not on `tenants`). Imports take a block per batch. *(g1q1)*
  - **Higher number = newer contact** is an invariant worth keeping: it's tested, and imports number their rows in order. The only exception is the one-off rollout gap, acceptable because there's no real data yet. *(g1q7 + rider)*
- **Format:** sequence from **10001**, plus a **Luhn** check digit, written as six plain digits: `100016`. Spaces and hyphens are ignored when typed. *(g1q2, g1q3)*
- **Shown** in the contact page header (with a copy button), the contacts list (its own column), and search results and the contact picker. Not in history; export comes later. *(g1q4)*
- **Old-system numbers are external identifiers**, never contact numbers. *(g1q5)*
- **Never reused, never changed.** Kept by archive, erasure (rule 3) and merge (a tombstone keeps its own, and its number finds the survivor). No renumbering, not even by admins. *(g1q6)*
- **QC:** new flow `contacts.search.number`, repeatable (100 ms); `contacts.create` stays infrequent (150 ms), re-measured. *(g1q8)*
- **Search** reads digits-only entries both ways: the number through `by_tenant_number`, and the phone as today. *(round 2)*
  - Known limit (step 3 review, 2026-10-23): number search stops at sequence 99999; widening needs a way to tell a 7-digit number from a phone fragment. A bare 5-digit term ranks after exact email/identifier matches (old member numbers).
  - **An exact number match ranks first** with a "contact no." badge, then phone matches, then full text. *(g2q1)*
  - **A wrong check digit is flagged**: "100018 isn't a valid contact number. Check the last digit." Other matches still show. *(g2q2)*
  - **The 5-digit sequence without its check digit also finds the contact**, ranked first and shown as the full `100016`. *(g2q3)*
  - **Exact only**: no prefix matching, and the number stays out of `contactSearch.text`. *(g2q4)*
  - **The contact picker offers a number match first and highlighted, but never picks it automatically.** No contact picker exists yet; the cash-gifts plan builds one and inherits this rule. *(g2q5)*
</sv-prose>

<sv-prose id="b2">
## Goal

Each contact has a **contact number**: a short integer, unique within its organisation, handed out in order (10001, 10002, …) and written with a Luhn check digit (`100016`). Staff write it on paper forms (Gift Aid declarations, cash-gift slips) and type it into quick search. An exact match comes first, the way an email or identifier match does now. The number never changes and is never reused. A merged-away contact's number still finds the survivor, and an anonymised contact keeps its number.

**Out of scope:** numbers for anything other than contacts (gifts, batches, claims); numbers the organisation chooses or edits; carrying an old system's member numbers over as contact numbers (those are external identifiers, ADR 0019 amendment / `external-ids` plan; see g1q5); printing forms; barcodes or QR codes.

### Rules that apply

- **3** (erasure anonymises): the number isn't personal data on its own and is kept, so paper forms still link to the anonymised record for HMRC's 6-year audit.
- **6** (no tenants in domain code): the counter row is tenant-scoped like any domain table, allocated through the scoped db, `tenantId`-first index.
- **1** (Gift Aid chain) indirectly: the number exists so a paper declaration can be tied to the right contact.
- Rules 2, 4, 5 and 7 aren't touched.
</sv-prose>

<sv-prose id="b3">
## Contracts and tables

**`contacts.number`**: the sequence integer (10001…). The check digit isn't stored. It's derived by one pure function in `convex/contacts/number.ts` (`checkDigit`, `formatNumber`, `parseNumber`), shared by the backend and the SPA. The field is **system-owned**: no contract payload carries it, `contacts.details` sets it on create (the `root === null` branch, beside the `clientKey` check) and no save, reconcile or restore touches it. `details.apply` patches only its named fields, so restore already leaves it alone; a test pins that.
- New index `by_tenant_number` `['tenantId', 'number']`: exact lookup for search, and a uniqueness check in tests.
- Revisions don't carry it, so no contract version bump or upcaster is needed.

**`contactNumberSequences`** (new domain table): `{ tenantId, next: number }`, index `by_tenant` `['tenantId']`. One row per tenant, created lazily by the first allocation. Writers: the details contract's create branch and the backfill, both through one helper `allocateNumbers(db, n)` in `contacts/number.ts`. A writers test fails on any other writer, the way `sources/code.ts` guards `sourceCodes`.

*Why not a field on `tenants`:* tenancy reads the tenant row (or the membership) in nearly every function, and Convex's OCC conflicts on a read set. A counter there would make every create conflict with every concurrent query and mutation in that tenant. Its own row conflicts only with other creates.

**Allocation cost (g1q1):** creating a contact adds one indexed read and one write. The read goes out alongside the existing `clientKey` lookup, so it should add about one read level (~2.5 ms on the deployment) to `contacts.create` (150 ms budget). Two creates in one tenant at the same instant conflict on the row, and Convex retries the loser automatically. That's rare for a small group's staff. A future CSV import allocates a block of numbers once per batch mutation (`allocateNumbers(db, batch.length)`), so a 500-row import touches the row once per batch, not once per contact, and it can only collide with a UI create that happens during that batch's few milliseconds.

**Schema, two-phase** (CLAUDE.md, `docs/migrations.md`):
1. **Loosen:** `contacts.number: v.optional(v.number())`, the index, the new table; creates start allocating.
2. **Backfill** (`contacts/migrations:backfillContactNumbers`): unnumbered contacts in `_creationTime` order, each tenant drawing from its own counter. Re-runnable: numbered contacts are skipped.
3. **Tighten:** `number: v.number()`. It refuses to deploy until the backfill is done. New row in `docs/migrations.md`.

**Lineage:** the counter is an ordinary tenant-scoped row, so a tenant exported to another deployment (snapshot import, `docs/spikes/01-export-import.md`) takes its counter with it, and numbers carry on where they left off. No extra work, only a test assertion that the export set includes the table.

**Merge (ADR 0019, not built yet):** a tombstone keeps its `number`. `by_tenant_number` finds the tombstone and search redirects to `mergedInto`, as it already does for names. The dedupe/merge plan inherits one line: "number search resolves tombstones". Until merge exists, nothing extra is needed.
</sv-prose>

<sv-prose id="b4">
## Steps

Step 3 in detail: `parseNumber(term)` in `contacts/number.ts` strips spaces and hyphens. Five digits are a sequence. Six digits with a valid Luhn digit are a full number. Six digits with an invalid one come back as `{ invalid: true }`. `queries.search` runs the number lookup in the same `Promise.all` as `contactsWithEmail` / `contactsWithIdentifier`, puts the hit ahead of `byEmail`/`byIdentifier`/`byPhone` (dedupe with the existing `once`), and returns `invalidNumber` so the list can show the hint. `parseSearch` is unchanged, so a 6-digit entry still runs the phone path too. A tombstone hit redirects to `mergedInto` once merge exists.

1. **Loosen + allocate** (`convex/lib/appSchema.ts`, `convex/contacts/number.ts` new, `convex/contacts/contracts.ts` details create branch, `convex/contacts/view.ts` / list row shape, tests). Every create gets a number from this deploy on. Test fixtures and `platform/devSeed` create through the contract, so they get numbers without changes.
2. **Backfill** (`convex/contacts/migrations.ts`, `docs/migrations.md` row). Can run in parallel with 3.
3. **Search** (`convex/contacts/search.ts` `parseSearch` learns number shapes, `convex/contacts/queries.ts` exact lookup beside email/identifier, contact picker if it has its own search path). Can run in parallel with 2.
4. **Display** (`src/routes/…` contact page header, list column (not history, per g1q4); uses `formatNumber`).
5. **QC** (`qc/flows/search.spec.ts` new flow `contacts.search.number`; `qc/budgets.ts`). `contacts.create` is re-measured as it stands.
6. **Tighten** (`appSchema.ts`). Deploy only where step 2 is done.

Steps 3 and 4 depend on 1. Step 6 is last and goes in its own commit.
</sv-prose>

<sv-prose id="b5">
## Tests

- Creates in one tenant get consecutive numbers in creation order (higher = newer, also across an import batch); **two tenants each start at the first number** and never see each other's counter or numbers (isolation).
- A number is unchanged by `saveDetails`, `saveForm`, archive/unarchive, `restoreTo` (including restore to the first revision) and erasure once it exists.
- A duplicate `clientKey` create is rejected **without** using a number (the check runs before allocation).
- The backfill numbers old contacts in creation order per tenant, skips numbered ones, and is idempotent.
- `checkDigit` / `parseNumber`: round-trips; rejects every single-digit change and the adjacent swaps the chosen algorithm promises to catch.
- Search: exact number first, then phone matches for the same digits, then full text. A number from tenant B finds nothing in tenant A.
- Search: the 5-digit sequence finds the contact; a wrong check digit returns `invalidNumber` and still lists phone/text matches; `1000` matches no number (no prefix); the number isn't in `contactSearch.text`.
- UI: the header shows the number with a working copy button, the list has the column, and the invalid-number hint renders.
- Writers test: only `contacts/number.ts` writes `contactNumberSequences`.
</sv-prose>

<sv-prose id="b6">
## Grill
</sv-prose>

<sv-ask id="g1q1" round="1">
**Allocation.** When does a contact get its number?
- * **In the create transaction** (one counter row per tenant). The number is there the moment the contact exists. Adds ~1 read level to create (~2.5 ms). Same-instant creates retry on OCC (rare). Imports take a block per batch.
- Pre-allocated blocks (each create takes from a block reserved ahead of time). Fewer counter writes, but numbers can come out of order and gaps appear. Only worth it at high create rates we don't have.
- Asynchronously after create (scheduled job; "—" until set). Create doesn't touch the counter, but staff creating a contact to write its number on a form might see "—" for a moment.
</sv-ask>

<sv-ask id="g1q2" round="1">
**Check digit.** Should the written number end in a check digit so a mistyped number is caught instead of finding the wrong person?
- * **Yes, Luhn** (mod 10, as on bank cards). Catches every single wrong digit and every swap of two neighbouring digits **except 09↔90**. Widely known, with spreadsheet formulas available.
- Yes, Damm. Catches every single wrong digit and **every** neighbouring swap. Less known, same amount of code.
- No check digit. Shorter, but "10243" for "10234" silently opens someone else.
</sv-ask>

<sv-ask id="g1q3" round="1">
**Starting value and how it's written.** The sequence starts at 10001, so it's five digits until 99,999 contacts (far beyond a small group). How is it shown and written?
- * **Six digits, no separator: `100016`** (sequence 10001 + check digit 6). One thing to copy. Search ignores spaces and hyphens if someone adds them.
- Check digit split off: `10001-7`. The structure is visible, but people may leave off the `-7`.
- Smaller start (1001, so `10017`). Shorter, and four-digit sequences run out at 9,999 contacts and then grow.
</sv-ask>

<sv-ask id="g1q4" round="1" pick="many">
**Where is the number shown?**
- * Contact page header, next to the name, with a copy button
- * Contacts list, its own narrow column
- * Search results and the contact picker (e.g. the cash-gift page's donor field)
- History: the "created" entry says "contact no. 100016"
- Printed or exported output (CSV export). Later, when export exists.
</sv-ask>

<sv-ask id="g1q5" round="1">
**Numbers from an old system.** A group moving from a spreadsheet often already has member numbers written on old forms. What happens to those?
- * **They're external identifiers** (type "Old member no."), found by search exactly as now. Contact numbers are always ours and always sequential.
- Let an import set a contact's number from the old system. Breaks "always sequential", and gives clashes to resolve.
- Let each organisation choose its starting number (once, before its first contact), so new numbers sit above its old range.
</sv-ask>

<sv-ask id="g1q6" round="1">
**Never reused, never changed.** Is that the rule, including after **erasure** (the anonymised record keeps its number, so the paper form still points to it for HMRC) and **merge** (the survivor keeps its number, and the loser's number still finds the survivor)?
- * **Yes, all of that**
- Yes, but staff with admin rights can renumber in exceptional cases (with a revision)
</sv-ask>

<sv-ask id="g1q7" round="1">
**Rollout window.** Step 1 deploys allocation on create, and the backfill runs a little later. Contacts created in that gap get numbers **before** older contacts are backfilled, so for a handful of contacts the number order wouldn't match creation order. Acceptable?
- * **Yes.** The gap is minutes, nobody relies on number order meaning age, and it happens once.
- No: deploy the loosening without allocation, backfill, then turn allocation on (one more deploy, and the backfill re-runs to catch the gap).
</sv-ask>

<sv-ask id="g1q8" round="1">
**QC.** New flow `contacts.search.number` (type a number, see the contact first). Which budget class?
- * **Repeatable, 100 ms**, like every other search flow. `contacts.create` stays infrequent (150 ms) and is re-measured with allocation in it.
- Something else (say which)
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: allocation, format, display, old numbers, the never-change rule, rollout, QC. Round 2 will cover how search reads typed numbers (with or without the check digit, telling a number apart from a phone tail), shaped by your format answers.
</sv-ask>

<sv-prose id="b7">
### Round 2: reading a typed number

Today a digits-only entry of 6+ digits becomes a phone search: digits match a whole phone number or its **last 6 digits** (`PHONE_TAIL`), ranked first. A contact number is also 6 digits, so `100016` could be both. The plan: a 6-digit entry always runs **both** lookups, the number one through the `by_tenant_number` index (one indexed read, alongside the email and identifier lookups). These questions are about everything around that.
</sv-prose>

<sv-ask id="g2q1" round="2">
**Ranking a 6-digit entry.** Staff type `100016`. One contact has that number, and someone else's phone ends in `100016`.
- * **The contact number match first**, with a "contact no." badge on the row, then the phone matches, then full text. A number is what staff copied off a form, and a phone-tail match is the coincidence.
- Phone match first. Keeps today's behaviour for anyone who searches by phone tail.
</sv-ask>

<sv-ask id="g2q2" round="2">
**The check digit is wrong.** Staff type `100018` (a typo, or a misread paper form). No contact has that number, because its Luhn digit is invalid.
- * **Say so**: a line above the results reading "100018 isn't a valid contact number. Check the last digit." Phone and text matches still show below it.
- Show nothing special; it's simply not found.
</sv-ask>

<sv-ask id="g2q3" round="2">
**Typed without the check digit.** Staff type the 5-digit sequence `10001`, leaving off the last digit.
- * **Find it anyway, ranked first, showing the full `100016`** on the row. The name on the row is what staff confirm against, so a typo shows up as a wrong name.
- Don't: only the full six digits find a number. Strictest, and it's how the check digit catches typos in the box itself.
</sv-ask>

<sv-ask id="g2q4" round="2">
**Partial numbers while typing.** Should `1000` (on its way to `100016`) list every contact whose number starts `1000`?
- * **No: exact matches only.** At 4 digits a prefix matches thousands of contacts. The search text never carries the number, so it never adds noise to name or postcode searches.
- Yes, prefix matching on numbers.
</sv-ask>

<sv-ask id="g2q5" round="2">
**The contact picker** (e.g. the cash-gift page's donor field). When a typed number matches exactly:
- * **Offer it as the first option, highlighted.** Staff still pick it (Enter or click), so a wrong number never silently attaches a gift to someone.
- Select it automatically. One less key, and a typo attaches the gift to the wrong person.
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: how search reads a typed number. If nothing else is open after this, round 3 is just your confirmation of the whole plan.
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
**Confirm the plan.** The design tree at the top is the whole of it: allocation in the create transaction, `100016`-style numbers with a Luhn digit, the display places, never changed or reused, the two-phase rollout and search. The brief sections spell out the steps and tests. Approve to hand it to the controller for building, or send "revise" with what's wrong.
</sv-ask>
