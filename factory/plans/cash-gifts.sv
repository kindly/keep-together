<sv-page label="plan: cash gifts" category="archive">
<sv-prose id="done">
**Complete 2026-10-23 (slice 1): steps 1a, 1b, 2, 3, 4, 5 merged and deployed; record-gift page, gift page, Gifts and Gift Aid panels live; last commit `e7ddc71`. Open: gift.save QC budget (human's call), void/unvoid optimistic (flag), erasure questions above.**
</sv-prose>


<sv-prose id="b1">
# Plan: cash gifts (first donations page)

*Planner: planner-cashgifts · started 2026-10-22 · status: **grill complete, confirmed by the human 2026-10-23, ready to build***

## Design tree (settled so far)

- **First slice:** one named cash gift → one contact → one source code, plus an optional Gift Aid declaration. *(human, chat 1)*
  - A gift can come from a **person or an organisation**. The Gift Aid declaration is offered **only for individuals**. *(chat 1)*
  - Splitting across codes: **no entry UI**. The data model still carries `allocations[]` per ADR 0022 and the page sends one. *(chat 1)*
- **Payment method:** `cash` or `card (taken on a separate reader)`. Card has an optional free-text **reference** (the receipt or transaction id from SumUp, Zettle and so on). No reader integration yet. *(chat 6)*
  - Later: smart readers driven by our server through the provider's API plus a webhook (SumUp Solo via the Cloud API is the leading candidate), and booth mode. See "Later" below.
- **Round 1 (all as recommended except where noted):**
  - **Declaration chain is add-only.** A gift is covered if any "yes" window covers its date and no later cancellation applies. *(g1q1)*
  - **Gift Aid panel on the contact page:** the list of declarations plus "Record cancellation" with an effective date. *(g1q2)*
  - **Inline new contact:** a person needs first and last name and an optional email, plus house number and postcode when Gift Aid is ticked. An organisation needs only its name. *(g1q3)*
  - **One save:** contact, acquisition code, gift and declaration in one mutation and one named command group. *(g1q4)*
  - **Gifts are editable with history and never deleted.** A mistake is marked void. Claimed gifts lock later. *(g1q5)*
  - **Amount ≤ £0 blocks.** A future date, a date over 4 years ago, or an amount over £10,000 warns. *(g1q6)*
  - **After saving**, the page clears for the next gift, keeps **date and method**, and shows a "Saved: £20 from Jo Bloggs (open)" line. **The source code is not carried over.** It comes from the **contact's acquisition code**, because a gift under a different source is normally a special giving event. *(g1q7 rider)*
  - **Gifts show up** in the Donations menu (my last 10), on a gift page with history, and in a Gifts panel on the contact page. *(g1q8)*
  - **The group home page** has: Record a gift · Find a contact · New contact · My recent gifts inline. *(g1q9)*
  - **The header loses the "keep-together" link.** The **group name links to the group home page**. Switching group moves to **Settings**, shown only to people in more than one group. *(g1q9 rider)*
  - **Staff and admins record gifts.** Viewers can only see them. *(g1q10)*
- **Round 2 (all as recommended except where noted):**
  - **Default source code:** if the contact has no acquisition code, or theirs is archived, the field starts **empty and required**. When the contact had none, the gift's code becomes their acquisition code. *(g2q1)*
  - **Picking a different code** shows a quiet note: "Differs from Jo's source …". *(g2q2)*
  - **Signing in never shows the groups list.** It goes straight to a group's home page. The list appears only through **Settings → Switch group**, for people in more than one group. *(g2q3 rider; which group a multi-group user lands in is asked in round 3)*
  - **Header:** group name (links home) · Contacts · Donations ▾ (Record a gift, then my last 10) · Settings. *(g2q4)*
  - **A new declaration defaults to "this, future and past 4 years"** (HMRC's model wording). The other choices are "this and future" and "this gift only". *(g2q5)*
  - **A contact who already has a current declaration** sees "✓ covered by declaration of …" instead of the tick. The tick comes back after a cancellation, or if the only declaration is "this gift only". *(g2q6)*
  - **Claims use the contact's current address.** The declaration's snapshot is the audit record, and the only part kept after erasure. *(g2q7)*
  - **The card reference** is optional free text, shown on the gift page. *(g2q8)*
- **Round 3 (all as recommended): plan confirmed 2026-10-23**
  - **Several groups:** sign-in lands in the group **last used** (`memberships.lastUsedAt`, so it works across devices). The first time, it's the first group by name. *(g3q1)*
  - **A gift's contact can't be changed.** A wrong donor means void and record again; a declaration stays with the person who made it. *(g3q2)*
  - **Gift Aid for an existing person with no address:** line 1 and postcode fields appear under the tick, are saved to the contact in the same save, and are copied into the snapshot. Left empty, the gift saves with a warning. *(g3q3)*
- **Gift Aid declarations get their own table** in `giftaid`, as a dated chain per contact. They're never a flag. *(chat 1)*
  - Evidence is usually **written**: a paper form, or a form or click the donor completes on a screen. Oral is the rarer case. *(chat 1)*
    - In practice the on-screen case means the device is handed to the donor, which would make it a written declaration. *(chat 2)*
    - **No donor view or confirmation mechanism in slice 1.** Staff tick Gift Aid and fill in the declaration fields themselves, accepting that many of those ticks are not yet valid declarations in HMRC's terms. *(chat 3)* Because the record says honestly **how** it was made, a later claim step can tell which declarations count. Nothing gets rewritten.
  - **Evidence held:** at least a "we have the form" mark, ideally an **uploaded scan** of it. *(chat 1; open: in slice 1 or next?)*
- **Erasure keeps what a Gift Aid audit needs** (the declaration, plus the name and address it was made under) for the 6-year retention period. *(chat 1; open: how exactly)*
  - Open for the erasure ADR (reviewers of step 1b, 2026-10-23): the 6-year clock should start at the end of the accounting period of the last claim relying on a declaration (only the claim step knows it); a voided declaration was never relied on, so its snapshot may be anonymised at once, keeping voidReason/voidedAt/voidedBy; free-text PII in voidReason and cancellationNote needs handling; a wrong-contact void holds another person's snapshot.
- ~~Visible short contact ids~~ → **their own plan**, handed back to the controller. This page only gains search by that number once it exists. *(chat 3)*
</sv-prose>

<sv-prose id="b2">
## What the law says (gov.uk, checked 2026-10-22)

Sources: HMRC *Charities detailed guidance notes*, chapter 3 (Gift Aid); *Claiming a top-up payment on small charitable donations* (GASDS).

| Rule | What it means for a cash page |
|---|---|
| **Cash qualifies** if it's the donor's own money (3.4.1). A bucket organiser can't declare for money others gave (3.10.5). | A named cash gift from an individual can be Gift Aided. |
| **Individuals only.** A declaration can't be in a company's name or joint names (3.6.7). | No Gift Aid tick for an organisation. |
| **Declaration content** (3.6.2, 3.9): donor's **name** (full name recommended) and **home address** (house number or name + postcode is enough in the UK), the charity's name, **which gifts** it covers ("this gift", "this and all future gifts", "…and the 4 years before"), the **tax explanation** ("I am a UK taxpayer" alone is *not* enough), and a **date** whenever the wording doesn't pin the period. No signature needed. | A tick isn't a declaration. We store a declaration record: who, scope, date, method, wording version. The donor must have a home address with house number and postcode before the gift is claimable. |
| **Oral declarations** (3.10.1, 3.7.2) only take effect once the charity **sends the donor a written record**, unless it has an auditable recording. Typing it into a database "will not satisfy the requirements". The donor then has **30 days to cancel retrospectively**. | If staff record "declared verbally", the gift isn't claimable until a confirmation letter or email has gone. That needs the date it was sent. |
| **Written declarations** (paper form, envelope): keep the paper or a scan (3.31.4). | Record "written: form held". The paper is the evidence. |
| **Cancellation** at any time; normally only affects gifts on or after the cancellation date (3.8.2). | This is exactly the dated chain (rule 1, research B4.1). |
| **Audit trail per gift** (3.27): each gift must be linkable to an identifiable donor with a valid declaration. Keep records **6 years** after the period (3.30). | Gifts and declarations are history. Erasure anonymises the person but has to keep what an HMRC audit needs (rule 3 vs a legal retention duty). |
| **Benefit limits** (3.20–3.22): 25% of gifts up to £100, and so on. | Not a cash-page issue unless gifts buy something. Out of scope. |
| **GASDS**: cash or contactless gifts **of £30 or less with no declaration**, top-up capped at £8,000 a year and at 10× the year's Gift Aid claims. Donors needn't be identified. Records are **per collection**: date and total by denomination, plus a statement that no single gift was over £30. Gifts *with* a valid declaration can't be included. | GASDS is about **anonymous collections**, not named gifts. It's a different entry (a "collection"), so it doesn't belong on a page that records gifts by named contacts. Nothing here blocks it later. |
</sv-prose>

<sv-prose id="b3">
## Brief

### Goal

Staff record a gift **by hand**: cash, or card taken on a separate reader. The gift is from one person or organisation, under one source code, with an optional Gift Aid declaration (people only). They can create the donor inline in the same save. They can then find their recent gifts and correct or void a gift with history. Alongside, the group gets a home page of common actions and a Donations menu. This is the first money in the system, so its shapes (`allocations[]`, method and status enums, the declaration chain) must leave room for splits, expected payments, recurring giving, smart card readers, booth mode, GASDS and HMRC claims without a migration.

**Out of scope:** split-entry UI · expected-vs-paid and pledges · recurring gifts and Direct Debit · card-reader integration and booth mode · Gift Aid claims, batches, HMRC submission, the charity's HMRC reference · GASDS collections · oral-declaration confirmations · uploaded scans · donor-facing declaration wording · receipts · refunds · income reports · erasure itself (only the snapshot it will keep) · short contact ids (their own plan) · fund mapping on details (ADR 0022 decision 8).

### Domain rules that apply

**1.** Declarations form a dated chain, and coverage is always derived, never stored on the gift. **3.** Gifts are *history*: erasure keeps them, and declarations keep their name and address snapshot. **4.** Nothing stores a Gift Aid amount; the future reclaim is its own record. **6.** Every function uses the scoped constructors, and every table has `tenantId`-first indexes. **7.** `amount` and allocation amounts are `v.int64()` pence. Rules 2 and 5 aren't touched.

### Tables and contracts

All three tables are **new**, so adding them is a single deploy with no loosen/tighten. The only change to an existing table is an optional field on `memberships`, which is added and never tightened.

| Table (module) | Contract → slice | Counter | Notes |
|---|---|---|---|
| `contributions` (giving) | **`giving.gift`**: `contactId` (create-only, g3q2), `receivedOn` (ISO date), `amount` (int64), `method` (`cash`\|`card`), `reference?`, `allocations[{key, sourceCodeId, amount}]` | `giftVersion` | Tier 1: amount > 0; allocations non-empty and summing to `amount` (the page sends one); `reference` only on card. New or changed codes must belong to this tenant and not be archived, then `sources.markUsed`; an unchanged code skips both, as in `contacts.acquisition`. **System-owned:** `enteredBy` (user id), set on create and preserved by every save and restore. Warnings (tier 2): future date, more than 4 years ago, over £10,000. |
| | **`giving.status`**: `status` (`completed`\|`void`) | `statusVersion` | Partitioned from the gift fields, so voiding never conflicts with an edit. The enum leaves room for `pending`/`failed`/`refunded` later (ADR 0008). |
| `contributionAllocations` (giving) | derived, via the `project` hook of **both** contracts | — | One row per allocation: `contributionId`, `contactId`, `sourceCodeId`, `detailId`, `categoryId`, `receivedOn`, `amount`, `status`. Indexes `(tenantId, sourceCodeId, receivedOn)`, `(…detailId…)`, `(…categoryId…)` per ADR 0022 decision 9. **This is also the (contact, source code) join:** add `(tenantId, sourceCodeId, contactId)`. |
| `giftAidDeclarations` (giftaid) | **`giftaid.declaration`**: `contactId`, `scope` (`thisGift`\|`future`\|`futureAndPast4y`), `contributionId?` (only for `thisGift`), `madeOn`, `method` (`paperForm`\|`onScreenByDonor`\|`oral`), plus the snapshot `firstName`, `lastName`, `addressLine1`, `postcode` | `declarationVersion` | **Create-only:** an update is refused, so a declaration's content is immutable (the chain is add-only, g1q1). Tier 1: the contact is an individual. Warning: no line 1 or postcode in the snapshot. |
| | **`giftaid.cancellation`**: `cancelledFrom` (date), `note?` | `cancellationVersion` | "Record cancellation" on the contact page runs this on **every declaration open at that date**, in one command group. |
| `memberships` (platform) | — (platform, not domain) | — | Optional `lastUsedAt` for landing a multi-group user (g3q1). |

**Indexes:** `contributions` by `(tenantId, enteredBy)` (recent, newest first via `_creationTime`) and `(tenantId, contactId, receivedOn)` (contact panel). `giftAidDeclarations` by `(tenantId, contactId, madeOn)`.

**Coverage** (plain TS in `convex/giftaid/`, shared with the UI): a gift dated *d* for contact *c* is covered if some declaration of *c* has a window containing *d* and isn't cancelled at or before *d*. The window is `[madeOn − 4y, ∞)` for `futureAndPast4y`, `[madeOn, ∞)` for `future`, and exactly its own gift for `thisGift`. A cancellation with `cancelledFrom` ≤ *d* removes coverage for gifts on or after that date. `giftaid` exports `coverage(ctx, contactId, date)` and `currentDeclaration(ctx, contactId)`. `giving` uses only those, never the table.

**The one-save command** `giving.recordGift` (a mutation, one named command group, e.g. "gift £20 cash, Street-Wesser-001") does these in order:
1. optionally `contacts.create`, with the code as the acquisition code; a person may also get an address through `contacts.addresses`;
2. `giving.gift` and `giving.status` (`completed`);
3. if the contact's acquisition code is empty, `contacts.acquisition` with the gift's code;
4. optionally `giftaid.declaration`.

Any refusal rolls back the whole save. Cross-module calls go through each module's exported functions.

### Steps

| # | Step | Files | Runs with |
|---|---|---|---|
| 1a | **Giving backend:** tables, `giving.gift`/`giving.status`, allocation projection, warnings, queries `myRecent` (10), `byContact` (paged like the contacts list), `get`, gift history | `convex/lib/appSchema.ts`, `convex/giving/*` | parallel with 1b and 4 |
| 1b | **Gift Aid backend:** table, both contracts, `coverage`/`currentDeclaration`, `byContact` query, warnings | `convex/lib/appSchema.ts`, `convex/giftaid/*` | parallel with 1a and 4 |
| 2 | **`recordGift` command** composing contacts, giving and giftaid; atomicity and acquisition-fill tests | `convex/giving/mutations.ts`, `contacts` exports as needed | after 1a + 1b |
| 3 | **Record-gift page** `/t/$slug/gifts/new`: contact quick search (reuse `contacts.search`), inline new person or organisation, code picker (reuse `source-code-picker`, defaulted from the contact's acquisition code, plus the "differs" note), amount and date, method plus reference, Gift Aid tick or "✓ covered", fast-entry reset, then a QC flow (ADR 0018, repeatable) | `src/routes/t.$slug.gifts.new.tsx`, `src/components/gift-form.tsx` | after 2 |
| 4 | **Navigation:** remove the "keep-together" link; the group name links to the new home `/t/$slug/` (four action links plus my recent gifts); a Donations ▾ menu; land on a group without the list; Settings → Switch group (more than one membership only); `memberships.lastUsedAt` | `src/routes/t.$slug.tsx`, `t.$slug.index.tsx`, `index.tsx`, settings, `convex/platform/*` | the menu and home page need `myRecent` from 1a; build against a stub first |
| 5 | **Gift page and contact panels:** `/t/$slug/gifts/$giftId` (view, edit, void/unvoid, history); a Gifts panel and a Gift Aid panel (declarations, coverage, Record cancellation) on the contact page | `t.$slug.gifts.$giftId.tsx`, `contact-gifts.tsx`, `contact-giftaid.tsx`, contact route | after 1a + 1b; parallel with 3 |

### Tests

- **Two-tenant isolation:** after every operation on tenant A, tenant B's contributions, allocations and declarations are unchanged and invisible. A `contactId` or `sourceCodeId` from B is refused in A, and so is a `contributionId` from B on a `thisGift` declaration.
- **Gift contract:**
  - amount ≤ 0 is refused; allocations not summing to the amount are refused; the int64 round-trips;
  - an archived new code is refused, an unchanged archived code is kept on edit, and `markUsed` marks the version and both parents;
  - `enteredBy` survives save and restore;
  - `contactId` can't change (g3q2);
  - a stale `expected` throws `stale`;
  - status and gift edits don't conflict;
  - the projection follows edits, voids and restores.
- **Declaration contract:**
  - refused for an organisation or household;
  - an update is refused (immutable);
  - cancellation applies to every open declaration;
  - a coverage truth table for `thisGift` / `future` / `futureAndPast4y`, the boundary at exactly `madeOn − 4y`, and cancellation on, before and after the gift date.
- **recordGift:**
  - a new contact gets the code as its acquisition code;
  - an existing contact with an empty acquisition code gets it filled; one with a code keeps theirs;
  - any refusal rolls back the contact too;
  - the command group is named.
- **Permissions:** a viewer is refused every write.
- **Recent gifts:** `myRecent` shows only the caller's own gifts, newest first, and void ones are marked.
- **Meta-test:** the new contracts are listed against their counter fields.
- **UI:** dom tests for the gift form (default code from the contact, the "differs" note, the ✓ covered state, the fast-entry reset) and for header and landing.

### Proposed ADR (the builder writes it after step 2)

**"Giving: hand-entered gifts and the Gift Aid declaration chain"** (next free number). It records:
- the two-contract split of a gift;
- the allocation projection doubling as the contact × code join;
- declarations as immutable create-only roots with a separate cancellation slice and derived coverage;
- the snapshot kept through erasure;
- why oral and on-screen declarations are stored but not validated yet.
</sv-prose>

<sv-prose id="b4">
## Later, not this plan: booth mode and card readers *(chat 4)*

**Booth mode** is a locked, donor-facing mode for a device at a stall or event. The donor enters their own details, makes the Gift Aid declaration on screen (a written declaration, so it's valid from the start), and pays. It needs:
- a restricted **device session**: a kiosk role that can create a contact, a gift and a declaration, and read nothing (ADR 0020 roles);
- versioned declaration wording;
- a payment path.

It reuses everything slice 1 builds: `contributions`, allocations and the declaration record with method `on-screen by donor`.

**Card readers from a web page** (researched 2026-10-22):

| Kind | Web page can drive it? |
|---|---|
| **Tap to Pay** on the phone itself (iPhone or Android as the reader) | **No.** Native app only (Stripe, SumUp and Zettle native SDKs). |
| **Small Bluetooth readers** paired to a phone (Stripe M2, SumUp Air, Zettle) | **No, in practice.** The vendors ship native SDKs, and Safari has no Web Bluetooth at all. |
| **Internet-connected "smart" readers** (Stripe WisePOS E / S700, SumUp Solo via the Cloud API, Square Terminal) | **Yes.** Our backend tells the provider "charge £X on reader Y". The donor taps their card on the reader, and the result comes back by **webhook**. No app of our own, and card data never touches us (ADR 0008's PCI stance). |
| **The provider's own app** used separately, with staff typing the gift in afterwards as `card` plus the provider's reference | Works today with no integration. It reconciles later by importing the provider's payouts. |

Rough UK prices, from third-party reviews as of 2026, ex-VAT; check before buying: **SumUp Solo ~£79**, 1.69% per payment, built-in 4G · **Square Terminal ~£149**, 1.75%, wifi only · **Stripe WisePOS E ~£179 / S700 ~£279**, ~1.4% + 10–20p. *(chat 5)*

Fit with this stack: a smart reader behind a webhook is exactly ADR 0008's pattern ("what actually cleared updates the contribution"). Slice 1's `method` and `status` enums and a `providerRef` field leave room for it. So that nothing gets painted into a corner, slice 1 adds **`card` (entered by hand, with a reference)** to `method` alongside `cash`. *(settled, chat 6)*
</sv-prose>


<sv-prose id="r1h">
## Grill round 1

The basic shape is settled (design tree above). This round covers how the page behaves and the rules around the records. Recommended answers are pre-selected; each question has a free-text box for anything else.
</sv-prose>

<sv-ask id="g1q1" round="1">
**How the declaration chain changes.** Each declaration is a record that is **never edited** afterwards. "Is this gift covered?" is worked out from them every time it's asked (rule 1). What happens when a second declaration arrives?
- * Add-only: each record has its own date window (a "this gift" one covers only its own gift). A gift is covered if any "yes" window covers its date and no later cancellation applies. Nothing is ever rewritten.
- Like CiviCRM: a new "yes" closes the previous open window by setting its end date, so only one window is open at a time
</sv-ask>

<sv-ask id="g1q2" round="1">
**Cancelling a declaration in slice 1.** HMRC says donors can cancel at any time and the charity must record when. Do we build that now?
- * Yes, a small **Gift Aid panel on the contact page**: the declarations (method, scope, date, who entered them) and a "Record cancellation" button with an effective date
- Show the panel read-only; cancellation comes later
- No contact-page panel in slice 1
</sv-ask>

<sv-ask id="g1q3" round="1">
**Creating a new contact inline: the minimum fields.** The quick search comes first. "New person / New organisation" appears under the results, filled in from what was typed.
- * **Person:** first and last name, optional email, plus house number/name and postcode (shown when Gift Aid is ticked, and saved to the contact). **Organisation:** name only
- Name only for both; addresses go on the contact page afterwards
- The full new-contact form in a side panel
</sv-ask>

<sv-ask id="g1q4" round="1">
**One save, or several?** A gift with a new contact and a declaration touches three records.
- * **One save.** One mutation creates the contact (with the acquisition code), the gift and the declaration under one named group ("cash gift £20, Street-Wesser-001"). Either all of it is saved or none of it is
- Two steps: create the contact first, then record the gift
</sv-ask>

<sv-ask id="g1q5" round="1">
**Correcting a gift.** Money records need an audit trail.
- * **Editable**, with history (a contract with revisions). **No delete**: a mistaken gift is marked **void** (a status), stays visible, and counts for nothing. Once Gift Aid claims exist, claimed gifts lock
- Editable, and can be deleted until it's claimed
- Never editable: only void and re-enter
</sv-ask>

<sv-ask id="g1q6" round="1">
**Gift date and amount rules** (blocks for impossible data, warnings for unlikely data, per ADR 0015).
- * **Block** an amount of £0 or less. **Warn** about a future date, a date more than 4 years ago (too old to claim Gift Aid), and an amount over £10,000
- Block future dates as well
- No warnings in slice 1
</sv-ask>

<sv-ask id="g1q7" round="1">
**Fast entry of several gifts in a row.** After saving, the page:
- * clears for the next gift, **keeping the source code, date and method** from the one just saved, and shows a "Saved: £20 from Jo Bloggs (open)" line
- goes to the new gift's page
- clears everything
</sv-ask>

<sv-ask id="g1q8" round="1" pick="many">
**Where gifts show up.** Pick everything that belongs in slice 1.
- * Donations menu: **my last 10 gifts** (contact, amount, date), each linking to the gift
- * A **gift page** to view or edit one gift and see its history
- * A **Gifts panel on the contact page** listing that contact's gifts, newest first
- A "My gifts" page with paging (more than the last 10)
- An all-gifts list for the group (with filters)
</sv-ask>

<sv-ask id="g1q9" round="1" pick="many">
**The group's home page.** Which action links?
- * Record a gift
- * Find a contact
- * New contact
- * My recent gifts (the same as the menu, shown inline)
- Source codes (settings)
</sv-ask>

<sv-ask id="g1q10" round="1">
**Who can record gifts?**
- * **Staff and admins.** Viewers see gifts but can't record them
- Admins only
- Everyone, viewers included
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: declaration chain mechanics, inline contact, saving, corrections, validation, fast entry, where gifts show, home page, permissions. Send when done.
</sv-ask>

<sv-prose id="r2h">
## Grill round 2

Round 1 is folded into the design tree. This round covers source-code defaults, navigation, and how the Gift Aid tick behaves.
</sv-prose>

<sv-ask id="g2q1" round="2">
**Default source code.** Picking a contact fills the code with their **acquisition code**. What if they have none, or theirs is archived (archived codes can't be assigned, ADR 0022)?
- * Leave it empty and **required**: staff must pick one. If the contact had no acquisition code, this gift's code **becomes** it (ADR 0022: giving fills an empty acquisition code from the first gift)
- Leave it empty and required, and never touch the contact's acquisition code from a gift
</sv-ask>

<sv-ask id="g2q2" round="2">
**Changing the code away from the contact's own.** Normally that means a special giving event.
- * Allowed, with a quiet note under the picker: "Differs from Jo's source, Street-Wesser-001"
- Allowed with no note
- Ask for confirmation before saving
</sv-ask>

<sv-ask id="g2q3" round="2">
**Signing in with only one group.** At the moment "/" lists your groups.
- * Belong to exactly one group: go **straight to its home page**. Belong to several: keep the list
- Always show the list
</sv-ask>

<sv-ask id="g2q4" round="2">
**Header layout.**
- * **Group name** (to home) · Contacts · **Donations ▾** (Record a gift, then my last 10) · Settings. "Switch group" sits in Settings, only for people in more than one group
- Same, but Donations is a plain link to a "My gifts" page instead of a dropdown
</sv-ask>

<sv-ask id="g2q5" round="2">
**Declaration scope: what the tick defaults to.** HMRC's model enduring wording is "this donation and any donations I make in the future or have made in the past 4 years".
- * Default **this, future and past 4 years**. Others: "this and future", "this gift only"
- Default "this and future"
- Default "this gift only"
</sv-ask>

<sv-ask id="g2q6" round="2">
**A contact who already has a current declaration.**
- * No tick. The page shows "✓ Gift Aid: covered by declaration of 3 Mar 2026 (paper form)". A **cancelled** or "this gift only" declaration shows the tick again
- Always show the tick, and record another declaration if it's ticked
</sv-ask>

<sv-ask id="g2q7" round="2">
**Which address a future claim uses.** The declaration keeps a snapshot of the name and address it was made under (the evidence). When the donor moves:
- * A claim uses the contact's **current** address. The snapshot is the audit record only, and the one thing kept after erasure
- A claim uses the snapshot address
</sv-ask>

<sv-ask id="g2q8" round="2">
**The card reference.**
- * Optional free text, and shown on the gift page
- Required whenever the method is card
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: source-code defaults, landing and header, declaration scope and "already covered", claim address, card reference. Send when done.
</sv-ask>

<sv-prose id="r3h">
## Grill round 3: the last questions, then confirmation

The full **Brief** above (tables, contracts, steps, tests) is written from rounds 1–2. Three small questions are left. After them, the close block's verdict is your confirmation of the whole plan: **approved** means a builder can start on step 1.
</sv-prose>

<sv-ask id="g3q1" round="3">
**Landing a person who belongs to several groups** (signing in never shows the list).
- * The group they **last used**, remembered on the server (works across devices). The first time, the first group by name
- Always the first group by name
</sv-ask>

<sv-ask id="g3q2" round="3">
**The wrong donor was picked.** Can a saved gift be moved to another contact?
- * No. **Void it and record it again** against the right contact. A declaration made with the gift stays with the person who made it
- Yes, the contact is editable like the other gift fields
</sv-ask>

<sv-ask id="g3q3" round="3">
**Gift Aid ticked for an existing person with no address.**
- * Show line 1 and postcode fields under the tick. Whatever is entered is saved to the contact's addresses in the same save and copied into the declaration's snapshot. Leaving them empty saves with a warning
- Just warn and point to the contact page
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
Round 3: the last three questions. **Approved = the plan is confirmed** and goes to the controller for building. Choose revise, with a note, for anything in the brief you want changed.
</sv-ask>

</sv-page>
