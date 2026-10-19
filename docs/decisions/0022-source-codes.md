# 0022 — Source codes: three levels, the version id is the code

Status: Accepted (2026-10-19) · from the source codes plan
(`factory/plans/source-codes.sv`, confirmed by the human in grill round
4). The answer behind each point is cited by question, e.g. *(g2q3)*. Where
the build on `main` (up to `0e3cb26`) differs from the plan, this ADR
follows the build and says so ("Differences from the plan" below).

## Context

Charities need to know where each supporter came from and, once giving
exists, where each pound came from: street fundraising through one
agency, a particular mailing, an event. They then report income and
retention by that source. At Amnesty this was a source code with three
levels (category, detail, run), and one gift could be split across
several codes.

Prior art (full notes with sources in `factory/out/planner-sources-research.md`;
summary in the plan's "Prior art"):

- **CiviCRM** has a free-text `source` on contacts and contributions, plus
  CiviCampaign (a hierarchy via `parent_id`, dates, a goal, no cost).
  Line items carry a financial type but no campaign, so a contribution
  can't be split across campaigns.
- **Raiser's Edge**: Campaign → Fund → Appeal → Package. Fund is what the
  money is for. A donor's recruitment appeal is the appeal of their first gift.
- **Blackbaud CRM** builds a code from positional parts that lock when
  the mailing goes live.
- **Salesforce NPSP**: one primary campaign per gift, split across funds
  (GAUs). Recurring allocations are copied to each instalment, and
  editing them changes open instalments only.

Every one of them keeps "what the money is for" (fund, financial type,
GAU) as a separate axis from the source. None splits one gift across
several *sources*. We do, on purpose, because it's the Amnesty
requirement.

## Decision

**1. Three levels, one table, the version id is the code.** A *category*
says how we reached them (Street, Online, Event…), a *detail* says which
one (an agency, an event), and a *version* says which run. Each part is a
row in `sourceCodes` (`level`, `parentId`), owned by a new module
`convex/sources/`. Contacts and gifts store **only a version id**, and
the detail, the category and the readable code are derived from it.
Only a full three-part code can be assigned *(g1q1)*. Creating a detail
creates its first version, `001`, in the same command group, so a one-off
is usable at once *(g2q4)*. A part's parent is fixed at creation.

**2. The name is the code.** The full code is the three names joined by
hyphens: `Street-Wesser-001`. It's shown as typed and matched in any case.
A name can't contain a hyphen (at most 40 characters) and is unique among
its siblings regardless of case, so a full code is unique per tenant
*(g1q2, g2q1)*. A part records a required name, an optional description
(at most 1000 characters) and, on details and versions only, optional
start and end dates. There's no target, cost, owner or budget label in
v1 *(g1q6)*. **Renaming is allowed at any time**: every code under the
part reads differently from then on, including on past gifts, and the
part's revisions keep the old name *(g2q2)*. When a contact's code is
set, the command group is named after the code as it reads then, so
contact history keeps the old reading too.

**3. The `used` marker and `markUsed`.** `sourceCodes.used` is
system-owned. `sources.markUsed(ctx, versionId)` is exported for other
modules. It runs in the caller's transaction, checks that the id is a
version of this tenant that isn't archived and isn't under an archived
parent, and sets `used` on the version, its detail and its category. It
only writes a part that isn't marked yet, so after a code's first use
it's a read-only check and a popular code doesn't become a write
hot spot. It writes no revision and makes no list-manager check, because
staff assigning a code don't need to manage the list. The marker is
never cleared, even if the assignment is undone, because history still
names the code *(g2q3)*. The `sources.code` contract never touches it,
so every save and restore preserves it.

**4. Delete only while unused.** A part can be deleted while unmarked.
Deleting a detail or category also deletes its children, which are
unmarked too, because `markUsed` always marks both parents. Once marked,
a part can only be archived *(g1q5, g2q3)*. Delete isn't a contract
(there's no root left to carry a counter). It's the one other writer of
the table, it checks the counter and the list-manager rule itself, and
the deleted parts' revisions stay as history.

**5. Archive vs dates.** They do different jobs:

- **Dates guide, never block** *(g3q2)*. The picker lists codes in date
  first, then "not started", then "ended", by code within each. Late
  gifts to an ended appeal are normal. A version's effective dates are
  its own, with each bound falling back to its detail's.
- **Archiving** (`isActive: false`) takes a code out of the picker, and
  new assignments of it are refused. Archiving a parent hides everything
  under it. Children keep their own archived state, so reactivating the
  parent brings them back as they were *(g3q3)*. Anything already coded
  keeps its code and still shows it.

**6. Who manages: a per-category staff switch.** Admins always can.
Staff can when an admin turns on "staff can manage source codes"
(`tenantPreferences.staffCanManageSourceCodes`, default off). That
switch has its own contract, `tenantPreferences.sourceCodes`, with
counter `sourceCodesVersion`, the same pattern as the switches for tags
and identifier types (ADR 0020 decision 2). `ListKind` gains
`sourceCodes`. Viewers never write. The list has its own Settings tab
*(g1q4)*. New tenants are seeded with seven categories: Street, Door to
door, Online, Event, Direct mail, Telephone and Community. Each can be
deleted while unused, like any other part *(g1q5)*.

**7. The contact's acquisition code: contract and projection.**
`contacts.acquisitionCodeId` is a version id or absent. It's written
only by the new contract `contacts.acquisition` (counter
`acquisitionVersion`) *(g1q7)*:

- A **new** code must be a version of this tenant (checked with
  `sources.describe`) and not archived, though it may be out of date.
  The contract calls `markUsed`. Keeping an unchanged code skips both
  checks, so a code that has since been archived stays on the contact.
- **Restore** skips the archived check and `markUsed`. The code was
  assigned before, so it's already marked.
- It's set on the new-contact form (`contacts.create` runs both slices
  in one command group), editable afterwards (`setAcquisition`), and
  later by imports and online forms. Giving fills it from the first
  gift's code if it's still empty then.
- **Later sources** are derived from the contact's gifts, with no second
  store *(g1q8)*.
- **Erasure** (rule 3) keeps the acquisition code: codes aren't personal
  data, and retention figures depend on it.
- **Merge:** the acquisition code is a field on the contact, chosen in
  the merge UI. The default is the code of whichever contact was
  created first *(g1q9)*. ADR 0019's classification points here.

The `contactSearch` projection carries `acquisitionCodeId`,
`acquisitionDetailId`, `acquisitionCategoryId` and `sortName`. It's
rebuilt by the contract's `project` hook (`projectAcquisition`), never
written anywhere else. The three ids are filter fields on `search_text`,
and three `(tenantId, acquisition…Id, sortName)` indexes serve the
contacts list's category / detail / version filter when there's no
search text *(g3q4)*. A rename doesn't touch the projection, because it
stores only ids, and a part's parent never changes.

**8. Funds live on the code** *(g1q12, g3q1)*. A source code says *how
the money came in*. A fund says *what it may be spent on*. At Amnesty
a campaign's code effectively set the fund, and finance adjusted the
split per campaign, not per gift. So a **detail** carries a fund mapping
that its versions inherit: one fund, or a percentage split that finance
sets (e.g. 70% Ukraine response, 30% General). Gifts carry only
source-code allocations. Income by fund is allocations × mapping,
computed in reports, so when finance changes a campaign's split, reports
follow without touching any gift. This is built with giving.

**9. The giving interface** (specified here, built by the giving plan):

- **Allocations.** Each contribution carries
  `allocations: [{ key, sourceCodeId, amount }]` in its contract payload.
  These are child rows with client-minted keys (ADR 0014), and `amount`
  is `v.int64()` pence (rule 7). Allocations are optional, and an
  uncoded gift reports as "uncoded" *(g1q10)*. **Tier-1 invariant:** if
  present, the amounts sum to the contribution's total. Shares are
  amounts, not percentages, so nothing ever needs rounding. Every
  assigned code goes through `markUsed`.
- **A `contributionAllocations` table.** Each row copies the
  `contributionId`, the contribution's date and status, and the code's
  `detailId` and `categoryId`. These copies stay correct because a
  part's parent never changes. Indexes are `(tenantId, sourceCodeId,
  date)`, `(tenantId, detailId, date)` and `(tenantId, categoryId,
  date)`, so income by code, detail or category over a date range is an
  indexed range. A tenant-wide report is a paginated action because of
  the 32k-document limit. Contributions are *history* class under
  ADR 0019, so allocations stay with the original contact after a merge.
  Erasure anonymises the person, not the money.
- **Expected vs actual** (from CARE). An expected payment, one-off or
  scheduled, carries an expected amount and an expected split in the
  same shape (code + pence, summing to the expected amount). The actual
  contribution and its allocations are matched to it, and a report
  compares the two by code. The giving plan decides the tables.
- **Recurring gifts** *(g1q11)*. The schedule or mandate carries
  allocations. Each payment copies them when it's created and can then
  be edited on its own. A change to the schedule's split affects future
  payments only. The schedule's split is also what the expected splits
  are generated from.
- **Gift Aid** *(g1q13)*. Each claimed gift's reclaim is attributed to
  its codes pro rata through its allocations, **in reports only**. The
  claim stays one financial record (rule 4).

## Differences from the plan

The plan page (b4, b6) predates review of the build. Where they differ,
the build is authoritative:

- **The full code isn't stored.** The plan had a normalised full code
  and an index on it. Because a rename would rewrite every row under the
  part, step 2 dropped `codeNormalized` and `by_tenant_code` while the
  table was still empty everywhere. `describe` joins one code from three
  reads, and the Settings tree and the picker join every code in one
  in-memory pass over the tenant's parts. That pass is bounded by
  `SOURCE_CODE_LIMIT` (2000 parts, archived ones included), and the
  contract refuses one more.
- **`describe` returns effective dates**: the version's start and end,
  each falling back to its detail's, plus `isActive` resolved across
  all three parts.
- **Descriptions are capped at 1000 characters**, so the one-pass read
  stays well inside Convex's per-function read limit. Names are capped at
  40.
- **Restore skips `markUsed`** in `contacts.acquisition`, along with the
  archived check (decision 7).
- **The create command group's name carries the code**: "new contact,
  acquisition code Street-Wesser-001" or "acquisition code …", so history
  keeps the code as it read at the time.
- The seed category is "Door to door", because a name can't contain a
  hyphen.

## Deferred

- **Out of this plan:** contributions, recurring gifts, expected
  payments and the `contributionAllocations` table (all giving); the fund
  mapping on details (giving); income, cost and retention reports.
- **Not in v1:** targets, costs (cost per supporter acquired), owners
  and budget labels on a code *(g1q6)*; codes on mailings, activities,
  consent events or Gift Aid declarations; importing codes from a
  spreadsheet; any shared cross-tenant code list.
- **Plan step 5** (the picker on the new-contact form and the contact
  page, and the category / detail / version filter on the contacts list)
  isn't on `main` yet. The backend side (the projection fields and
  indexes, `setAcquisition`, `contacts.get`'s described code) is.
- Setting the acquisition code from imports, online forms and the first
  gift comes with those features. Choosing it in the merge UI comes with
  the dedupe/merge plan.

## Alternatives rejected

- **Codes assignable at detail level** with an optional version. Reports
  would group two ways *(g1q1)*.
- **A short code separate from a display name**, or a stored slug.
  These add two names for one thing *(g2q1)*.
- **Locking a name once used**, as Blackbaud does. Gifts and contacts
  hold ids, so a rename costs nothing *(g2q2)*.
- **Deleting when nothing carries the code right now** (no marker).
  History would then name a part that no longer exists *(g2q3)*.
- **Dates that hide codes** from the picker. Late gifts to an ended
  appeal are normal *(g3q2)*.
- **Archiving a parent archives its children.** Reactivating would then
  be one by one, and the children's own state would be lost *(g3q3)*.
- **A fund copied onto each gift**, correctable per gift. Finance would
  then edit gifts instead of one mapping *(g3q1)*.
- **Percent shares on allocations.** These need rounding, whereas pence
  amounts summing to the total don't.

## Consequences

- **Schema** (two-phase): loosen (the table and optional fields) → the
  backfills plus the seed for existing tenants → tighten
  `acquisitionVersion`, `staffCanManageSourceCodes` and
  `sourceCodesVersion`. The order for a deployment that's behind is in
  `docs/migrations.md`.
- **Other modules** use `sources.describe` and `sources.markUsed`, never
  the `sourceCodes` table.
- **The giving plan inherits decision 9 and the fund mapping.**
- **The dedupe/merge plan** carries the acquisition code as a merge
  choice (ADR 0019).
