<sv-page label="plan: source codes" category="plans">

<sv-prose id="b1">
# Plan: source codes

**Status:** confirmed by the human (round 4, 2026-10-19). Ready to build. Planner `planner-sources`, 2026-10-19.

## Design tree

- **Shape:** three parts, *category* (how we reached them: street fundraising, online, event…), *detail* (which one: an agency or event) and *version* (which run). The meaning of each code is stored in the database. *(round 0)*
  - Only a **full three-part code** can be assigned to a contact or a gift. *(g1q1)* Creating a detail creates its first version, `001`, straight away. *(g2q4)*
  - **The version's id is the source code.** Each part is its own row: a version points at its detail, and a detail at its category. Contacts and gifts store only the version id, and everything else is derived from it. *(g2q1 thread)*
  - **The name is the code.** The full code is the three names joined by hyphens, e.g. `Street-Wesser-001`. It's shown as typed and matched in any case. A name can't contain a hyphen and is unique among its siblings, so a full code is unique per tenant. There are no fixed widths, and any longer explanation goes in the description. *(g1q2, g2q1)*
  - **Dates guide, never block:** the picker lists codes in date first, with out-of-date ones further down, marked "ended" or "not started". *(g3q2)*
  - **Archiving a parent** hides every code under it from the picker. Children keep their own archived state, and anything already coded keeps showing its code. *(g3q3)*
  - Each part records a **name, which is the only required field**, plus an optional description and optional start and end dates on details and versions. There's no target, cost, owner or budget label in v1. *(g1q6)*
  - **Renaming is allowed at any time**, even for a part already in use. Every code under it reads differently from then on, including on past gifts, and history keeps the old name. *(g2q2)*
  - **Deleting:** a hidden `used` marker is set the first time a code goes on a contact or a gift, on the version, its detail and its category. It is never cleared, because history still names the code. A part can be deleted while unmarked, and deleting a detail or category also deletes its unmarked children. Once marked, a part can only be archived. *(g1q5, g2q3)*
- **Who manages:** admins, plus staff when an admin turns on "staff can manage source codes" (off by default). It gets its own Settings tab. *(g1q4)*
- **Seeds:** Street, Door-to-door, Online, Event, Direct mail, Telephone, Community. Each can be deleted while unused, and archived after that. *(g1q5)*
- **Contacts:**
  - **Acquisition code:** picked on the new-contact form, and set by imports and online forms later. Staff can edit it afterwards and every change is in history. If it's empty when the first gift is recorded, giving fills it from that gift. *(g1q7)*
  - **Later sources** are derived from the contact's gifts, with no second store. *(g1q8)*
  - **Contacts list:** filter by category, detail or version, and the code is shown on the contact page. *(g3q4)*
  - **Merge:** staff choose which code to keep. The default is the code of whichever contact was created first. *(g1q9)*
- **Gifts (interface for the giving plan):**
  - **Allocations are optional.** If present, they're amounts in pence that sum to the total. An uncoded gift reports as "uncoded". *(g1q10)*
  - **Recurring gifts:** the schedule carries the allocations, and each payment copies them when it's created and can then be edited on its own. A change to the schedule affects future payments only. *(g1q11)*
  - **Funds:** the source code says how the money came in, and a fund says what it may be spent on. *(g1q12)* At Amnesty a campaign's code effectively set the fund, and finance adjusted the split per campaign, not per gift. **The fund mapping lives on the code:** a detail carries it and its versions inherit it. It's one fund or a percentage split set by finance. Gifts are split by source, codes are split by fund, and reports combine the two. *(g3q1 and its thread)*
  - **Expected vs actual:** expected payments carry the same kind of split as actual ones, including one-off gifts, so income can be compared expected against actual by code (from CARE). *(g3q1 thread)*
  - **The Gift Aid reclaim** is attributed to codes pro rata in reports, and the claim itself stays one record. *(g1q13)*
- **Scope:** the code list and the contact's acquisition code are built now. The transaction side is an interface the giving plan implements.
</sv-prose>

<sv-prose id="b2">
## Goal

Give a charity one list of source codes it manages itself, three levels deep, with each code's meaning recorded next to it. Staff can then record where each supporter came from, and later where each pound came from, and report income and retention by code, category and version.

**Out of scope here:** contributions, recurring gifts and their allocation tables (giving plan); income, cost and retention reports (they need giving); codes on mailings, activities, consent events or Gift Aid declarations; import of codes from a spreadsheet; any cross-tenant shared code list.
</sv-prose>

<sv-prose id="b3">
## Prior art

The full notes, with a URL on every claim, are in `factory/out/planner-sources-research.md`. The points that matter here:

- **CiviCRM** has two mechanisms side by side. One is a free-text `source` on contacts, contributions, memberships and participants ([contact schema](https://raw.githubusercontent.com/civicrm/civicrm-core/master/schema/Contact/Contact.entityType.php)). The other is the structured CiviCampaign: types, statuses, start and end dates, `parent_id` for a hierarchy, `goal_revenue`, and an `external_identifier` for legacy codes. There is **no cost field** ([campaign schema](https://raw.githubusercontent.com/civicrm/civicrm-core/master/schema/Campaign/Campaign.entityType.php)). `campaign_id` sits on contributions, recurring contributions, memberships, participants, activities and mailings.
- **CiviCRM splits** a contribution through line items by *financial type* ([key concepts](https://docs.civicrm.org/user/en/latest/contributions/key-concepts-and-configurations/)). Line items have no `campaign_id` ([schema](https://raw.githubusercontent.com/civicrm/civicrm-core/master/schema/Price/LineItem.entityType.php)), so a gift can't be split across campaigns. Recurring payments copy line items and the campaign from a template contribution ([dev docs](https://docs.civicrm.org/dev/en/latest/financial/recurring-contributions/)). There is no UK extension for source or appeal codes; the UK extensions cover only Gift Aid.
- **Raiser's Edge** uses Campaign → Fund → Appeal → Package. *Fund* is what the money is for and is the only required field on a gift. *Appeal* is the ask, and *Package* is a variant of it ([Blackbaud community](https://community.blackbaud.com/discussion/comment/315032), [Trellis](https://help.trellis.org/how-to-set-your-raisers-edge-campaign-fund-appeal-and-package-settings-for-a-specific-fundraiser)). The donor's recruitment appeal is the appeal of the first gift; the API exposes First, Latest and Greatest ([CData](https://cdn.cdata.com/help/JZJ/ado/pg_table-givingappeals.htm)).
- **Blackbaud CRM** builds a source code from *parts* in a positional layout, e.g. program + campaign + year = `MRENB10`. The layout locks when the mailing goes live ([help](https://webfiles-sc1.blackbaud.com/files/support/helpfiles/crm/us/40/Content/MKTSourceCodesWorkflow.html)). It records cost per segment, and RE NXT is adding appeal expense in early access.
- **Salesforce NPSP** gives a gift one Primary Campaign Source and splits it across *funds* (GAUs) by amount or percent. Recurring-donation allocations are copied to each instalment, and editing them changes **open instalments only, never closed ones** ([Trailhead](https://trailhead.salesforce.com/content/learn/modules/donation-management-basics-with-nonprofit-success-pack/create-and-edit-donation-allocations)).
- **thankQ (Access) and Dynamics:** no public documentation of their code models. There is no published UK convention for formats like `SF102` either.

**How our three parts map:** category ≈ RE Campaign or CiviCRM campaign type, detail ≈ Appeal, version ≈ Package. Every system keeps "what it's for" (Fund, financial type, GAU) as a **separate axis** from the source. That's question g1q12.

**Where this plan departs from them:** none of these systems splits one gift across several *sources*; they split across funds. Splitting by source code is your Amnesty requirement, so we're building it on purpose. Retention by recruitment source is recommended by practitioners, but no system ships it as a report.
</sv-prose>

<sv-prose id="b4">
## Contracts and tables (draft, sharpened after round 1)

**New module `convex/sources/`.** Contacts, giving and later comms all point at codes, so codes shouldn't live inside any one of them. This needs a row in `docs/architecture.md` "Domain module boundaries". I propose a new ADR, 0022 "Source codes", to record the model. The builder writes it from this page once the plan is confirmed.

| Table / field | Slice and contract | Counter | Notes |
|---|---|---|---|
| `sourceCodes` (new) | `sources.code`, one row per part at any of the three levels | `saveVersion` | `level`, `parentId`, `name` (required), `description?`, `startDate?`/`endDate?` (detail and version only), `isActive`, plus a system-owned `used` marker. The marker is set by the first contract that assigns the code: it checks `used` on the version and its parents through `sources`' exported `markUsed`, and patches only if it's not yet set. Every use after the first is read-only, so a popular code doesn't become a hot spot for write conflicts. The `sources.code` contract preserves the marker on every save, the way email `onHold` was preserved. The full code is derived (the names joined with hyphens) and indexed for the picker. Indexes `by_tenant_parent`, plus one on the normalised full code |
| `contacts.acquisitionCodeId` | `contacts.acquisition` (new contract) | `acquisitionVersion` | a version id only, validated through `sources` (it must exist in this tenant, be a version, and not be archived; it may be out of date). The first assignment calls `sources.markUsed`. Index `by_tenant_acquisition` |
| `contactSearch` (derived projection, no contract) | rebuilt by `projectContactSearch` from `contacts.acquisition` too | none | gains `acquisitionCodeId?`, `acquisitionDetailId?`, `acquisitionCategoryId?` and `sortName`. Filter fields go on `search_text`, and indexes `(tenantId, acquisition…Id, sortName)` serve the list without search text. Renames don't touch it, because only ids are stored |
| `tenantPreferences.staffCanManageSourceCodes` | `tenantPreferences.sourceCodes` (new) | `sourceCodesVersion` | same pattern as tags / identifier types; `ListKind` gains `sourceCodes` |

**Schema changes are two-phase:**
1. *Loosen:* add the `sourceCodes` table. Add `contacts.acquisitionCodeId` (optional for good), the new `contactSearch` fields (optional for good; the backfill rebuilds the projection), `contacts.acquisitionVersion`, and the two `tenantPreferences` fields, all optional.
2. *Backfill* through the migrations component: `acquisitionVersion: 0` on every contact, and the switch `false` with counter `0` on every preferences row.
3. *Tighten:* make `acquisitionVersion`, `staffCanManageSourceCodes` and `sourceCodesVersion` required. This ships separately, after the backfill has run everywhere.
</sv-prose>

<sv-prose id="b5">
## Transaction interface for the giving plan (specified, not built)

- Each contribution carries `allocations: [{ key, sourceCodeId, amount }]` inside its contract payload. These are child rows with client-minted keys (ADR 0014), and `amount` is `v.int64()` pence.
- **Invariant (tier 1):** if allocations are present, the amounts sum to the contribution's total. Shares are amounts, not percentages, so no rounding is ever needed.
- The allocation rows get their own table, `contributionAllocations`. Each row copies `contributionId`, the contribution's date and status, and the code's `categoryId` and `detailId`. A code's parent never changes, so these copies stay correct. Indexes are `(tenantId, sourceCodeId, date)`, `(tenantId, detailId, date)` and `(tenantId, categoryId, date)`. Income by code, detail or category over a date range is then an indexed range. A tenant-wide report runs as a paginated action, because of the 32k-document limit per function.
- Contributions are *history* class under ADR 0019, so their allocations stay with the original contact after a merge. Erasure anonymises the person, not the money, so allocations stay as they are.
- **Recurring gifts** (g1q11): the schedule carries allocations. Each payment copies them when it's created and can then be edited on its own. A change to the schedule affects future payments only.
- **Expected vs actual** (b3 thread, from CARE): there is an *expected* side shaped like the actual one. Each scheduled or expected payment carries an expected amount and an expected split, as allocations of code + pence summing to the expected amount, and this applies to one-off gifts too. The actual contribution and its allocations are matched to it, and a report compares expected with actual by code. For recurring gifts, the schedule's split is what the expected splits are generated from. The giving plan decides the tables.
- **Funds** (g3q1): a fund mapping on the code (detail level, inherited by its versions) gives one fund or a percentage split that finance sets. Income by fund = allocations × that mapping, computed in reports. Finance never edits individual gifts.
- **Gift Aid reclaim** (g1q13): attributed to codes pro rata through each claimed gift's allocations, in reports only. The claim stays one financial record (rule 4).
</sv-prose>

<sv-prose id="b6">
## Steps

1. **Schema loosen + backfill.** Add the `sourceCodes` table; the optional fields on `contacts`, `contactSearch` and `tenantPreferences`; and the backfills (`acquisitionVersion: 0`, the preference switch and its counter). Seed the starter categories for existing tenants. Files: `convex/schema.ts`, `convex/contacts/migrations.ts`, `convex/platform/migrations.ts`.
2. **`sources` module backend.** Files: `convex/sources/*`, `convex/lib/lists.ts`, `convex/platform/preferences.ts`, tenant creation seeds. It covers:
   - the contract `sources.code` (create, rename, describe, dates, archive / reactivate). Creating a detail also creates version `001`, and the contract preserves the `used` marker.
   - `delete`, which works only while unmarked and cascades to unmarked children.
   - `markUsed` (exported), which marks the version, its detail and its category.
   - queries: the tree for Settings, a picker search over the full code text (date-ordered, hiding archived parts and anything under an archived parent), and `describe(versionId)` returning the three names and ids.
   - `ListKind` gains `sourceCodes`, with the preference contract `tenantPreferences.sourceCodes`.
3. **Settings tab "Source codes":** a tree editor (add, rename, describe, dates, archive / reactivate, delete while unused) and the staff switch. Files: `src/routes/t.$slug.settings.sources.tsx`, `t.$slug.settings.tsx`. **After step 2.**
4. **Contact acquisition code (backend):** contract `contacts.acquisition`, its `project` hook into `contactSearch`, a history label, and `contacts.get` / view returning the described code. Files: `convex/contacts/contracts.ts`, `mutations.ts`, `queries.ts`, `view.ts`, `searchProjection.ts`, `history.ts`. **In parallel with step 2**, against a stub of `sources.describe` / `markUsed`.
5. **Contact acquisition code (UI):** a picker on the new-contact form and the contact page, and a category / detail / version filter on the contacts list. Files: the `t.$slug.contacts.*` routes and `convex/contacts/search.ts`. **After steps 2 and 4.**
6. **Tighten** in a separate deploy, once the backfills have run on every deployment: make `acquisitionVersion`, `staffCanManageSourceCodes` and `sourceCodesVersion` required.
7. **Docs:** ADR **0022 "Source codes"**, written by the builder from this page: the model, the version id as the code, the used marker, funds on the code, and the giving interface. Also a `sources` row in `docs/architecture.md`, a pointer in ADR 0019's classification (the acquisition code is a field on the contact and is chosen in the merge UI, so the future dedupe plan carries it), and a note in `docs/research.md` B3 linking here.
</sv-prose>

<sv-prose id="b7">
## Tests (draft)

- **Two-tenant isolation:** tenant B can't see tenant A's codes, and assigning one of A's code ids to a contact in B is rejected.
- The full code is unique per tenant regardless of case. A name can't contain a hyphen and is unique among its siblings regardless of case. A rename changes how every code under the part reads, and its ids don't change. Delete works while the part is unmarked, and deleting a parent also deletes its unmarked children; once marked, delete is refused. The `used` marker survives a `sources.code` save and a restore.
- Archiving a code takes it out of the picker. Contacts that already carry it keep it and still show it.
- Only a version-level code can be assigned. Assigning a category or a detail is rejected.
- The staff switch: off means staff are refused, on means staff can manage codes, and admins always can. Viewers never write.
- Every contract gets revisions and restore through the meta-test.
- The acquisition code accepts only a version of this tenant. Archived is rejected and out of date is accepted. The first assignment marks the version and both parents. Renaming the category changes the code shown on the contact without any write to the contact.
- Archiving a category hides its versions from the picker, and reactivating it restores them with their own state. The contacts list filters by category, detail and version, both with and without search text.
- Seeds: a new tenant gets the seven categories, and an unused seed can be deleted.

## Domain rules that apply

- **3 (erasure):** codes are not personal data, and an anonymised contact keeps its acquisition code so retention figures stay correct.
- **4 (Gift Aid reclaim):** untouched. See round 1 on how reports attribute it.
- **6 (tenancy):** a new table means `tenantId` and tenantId-first indexes, scoped constructors only.
- **7 (money):** allocations and any costs are pence.
- Rules 1, 2 and 5 are not affected.
</sv-prose>

<sv-prose id="b8">
## Grill round 1: the code model, contacts, and the giving interface
</sv-prose>

<sv-ask id="g1q1" round="1">
**Does every assignable code have all three parts?** A detail that never runs twice (one gala dinner) could be assigned directly, or it could be given a single version `01`.
- * yes: only a full category-detail-version code can be put on a contact or a gift. A one-off gets version `01`. Reports always group the same way.
- no: a code can be assigned at detail level, and a version is optional
</sv-ask>

<sv-ask id="g1q2" round="1">
**How is a code written?** The full code is stored, so typing it into a picker finds it whatever the format.
- * `SF102-03`: category and detail run together as at Amnesty, a hyphen before the version
- `SF-102-03`: a hyphen between every part
- `SF10203`: no separators, fixed widths
</sv-ask>

<sv-ask id="g1q3" round="1">
**Can a code's letters change after it's created?** Codes get printed on forms and agency paperwork.
- * no: a part's code can't be changed once the part exists. The name and description stay editable. A mistake is archived and recreated.
- yes, until something is assigned to it
- yes, always (every full code under it changes too)
</sv-ask>

<sv-ask id="g1q4" round="1">
**Who manages the code list?** This is the same pattern as tags and identifier types.
- * admins, plus staff when an admin turns on "staff can manage source codes" (off by default). It gets its own Settings tab.
- admins only
- all staff, always
</sv-ask>

<sv-ask id="g1q5" round="1">
**Starter categories for a new tenant?**
- * seed a few common categories (Street, Door-to-door, Online, Event, Direct mail, Telephone, Community), each archivable
- seed nothing; the charity builds its own
</sv-ask>

<sv-ask id="g1q6" round="1" pick="many">
**What does a code record about itself in v1?** Pick all that apply.
- * name and description
- * start and end dates, on details and versions
- target income (pence)
- costs: dated cost entries against a version, so cost per supporter acquired can be reported later
- owner (a staff member)
- budget / cost-centre label
</sv-ask>

<sv-ask id="g1q7" round="1">
**The contact's acquisition code: how is it set?**
- * picked on the new-contact form (and by imports and online forms later), editable by staff afterwards with every change in history. If it's still empty when the first gift is recorded, giving fills it from that gift's code.
- the same, but locked once set
- never stored: always derived from the first gift's code
</sv-ask>

<sv-ask id="g1q8" round="1">
**A contact's later sources** (they came in via street fundraising, later gave to a Christmas appeal):
- * derived: the contact page lists the codes from their gifts. There's no second store on the contact.
- a separate per-contact list of source touches, entered by hand
</sv-ask>

<sv-ask id="g1q9" round="1">
**Merging two contacts with different acquisition codes** (ADR 0019 merge produces the survivor's payloads):
- * staff choose in the merge screen; the default is the code of whichever contact was created first
- always keep the survivor's
- always keep the earlier-created contact's, with no choice
</sv-ask>

<sv-ask id="g1q10" round="1">
**Does every gift need a code?**
- * no: allocations are optional. An uncoded gift shows as "uncoded" in reports. If allocations are given, they must sum to the total.
- yes: every gift needs at least one allocation (each tenant gets a seeded "General" code to fall back on)
- optional by default, but a tenant setting can make it required
</sv-ask>

<sv-ask id="g1q11" round="1">
**Recurring gifts.**
- * the schedule/mandate carries allocations. Each payment copies them when it's created and can be edited on its own. Changing the schedule's split (e.g. an upgrade call adds £2 under a telephone code) affects future payments only.
- payments carry no allocations and always read them from the schedule
- only individual payments carry codes
</sv-ask>

<sv-ask id="g1q12" round="1">
**"Allotted to budgets": is that the same thing as a restricted fund?** UK charities have to account for restricted income separately. CiviCRM calls it a financial type; Salesforce calls it a General Accounting Unit.
- * no, they're separate. A source code says *how we got* the money; a fund says *what it may be spent on*. Giving adds funds later as a second dimension on each allocation.
- yes: the budget is a property of the code, and each code maps to a fund
- not sure; discuss
</sv-ask>

<sv-ask id="g1q13" round="1">
**The Gift Aid reclaim in income-by-code reports.**
- * attributed: each claimed gift's 25% follows its allocations pro rata, computed in the report. The claim itself stays one financial record (rule 4).
- not attributed: reports show donated income only, with Gift Aid as a separate total
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: the code model, the contact's acquisition code, and the giving interface. Send when done. Riders welcome on any question.
</sv-ask>

<sv-prose id="b9">
## Grill round 2: descriptive codes, renaming, deleting
</sv-prose>

<sv-ask id="g2q1" round="2">
**What is a part's code: its name, or something separate?** You want readable codes like `street-agency-01`.
- * **The name is the code.** Each part has one required name, e.g. `Street`, `Wesser`, `01`. The full code is the three names joined by hyphens, `Street-Wesser-01`, shown as typed and matched in any case. Names can't contain a hyphen, so the parts stay unambiguous. A longer explanation goes in the description.
- a short code and a separate display name: the code defaults to a slug of the name (`street-fundraising`) and can be overridden (`street`)
- the name is the code, but stored as a lowercase slug (`street-wesser-01`), with spaces turned into hyphens
</sv-ask>

<sv-ask id="g2q2" round="2">
**Renaming a part that's already in use** (you said these aren't fixed codes any more):
- * allowed at any time. Gifts and contacts point at the part, not its text, so every code under it shows the new name straight away, including on past gifts. History records the old name.
- allowed only while the part is unused, locked once anything carries it
- locked after creation (a mistake gets archived and recreated)
</sv-ask>

<sv-ask id="g2q3" round="2">
**Deleting, and the hidden "used" marker.**
- * The marker is set **the first time** a code goes on a contact or a gift, and stays set even if that's undone later, because history still names it. A version can be deleted while unmarked. A detail or category can be deleted while nothing under it is marked, which deletes its unused children with it. Once marked, archiving is the only option.
- no marker: at delete time, check whether anything carries the code *right now*, and allow the delete if nothing does
</sv-ask>

<sv-ask id="g2q4" round="2">
**A new detail and its first version.**
- * Creating a detail creates its first version, named `01`, at the same time, so a one-off is usable straight away. Rename it if you like.
- versions are always added by hand
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: descriptive codes, renaming and deleting. Send when done.
</sv-ask>

<sv-prose id="b10">
## Grill round 3: funds, dates, archiving, the contacts list
</sv-prose>

<sv-ask id="g3q1" round="3">
**Where does the fund live?** Gifts don't need it now, but the code model should leave room for it.
- * **On the code.** A detail carries a fund mapping and its versions inherit it. The mapping is one fund or a percentage split that finance sets, e.g. 70% Ukraine response, 30% General. Gifts carry only source-code allocations, and income by fund is worked out in reports. When finance changes a campaign's split, reports follow without touching any gifts. Built with giving.
- a default fund on the code, copied onto each gift's allocation and correctable per gift
- decide in the giving plan
</sv-ask>

<sv-ask id="g3q2" round="3">
**What do a code's start and end dates do?**
- * they guide, never block: the picker lists codes in date first, with out-of-date ones further down, marked "ended" or "not started". Late gifts to an ended appeal are normal.
- the picker hides codes outside their dates
- record only: they have no effect
</sv-ask>

<sv-ask id="g3q3" round="3">
**Archiving a category or a detail.**
- * this hides every code under it from the picker. The codes keep their own archived state, so reactivating the parent brings them back as they were. Contacts and gifts that already carry them keep showing them.
- archiving a parent also archives every child (reactivating them is then one by one)
</sv-ask>

<sv-ask id="g3q4" round="3">
**The contacts list and the acquisition code, now** (before giving exists):
- * a filter on the contacts list by category, detail or version, e.g. "everyone recruited by Street", plus the code shown on the contact page. The contact search projection carries the three ids.
- the contact page only; filters wait for reporting
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
Round 3: funds, dates, archiving, the contacts list. Send when done.
</sv-ask>

<sv-prose id="b11">
## Round 4: confirmation

The frontier is empty. The design tree at the top is the settled design, the brief below it is what the builder executes, and the "Transaction interface" section is what the giving plan inherits. Approve if it all matches what you meant. Revise, with a note, if anything doesn't.
</sv-prose>

<sv-ask id="g4fin" round="4" role="close">
Final round: confirm the plan (design tree, brief, giving interface).
</sv-ask>

</sv-page>
