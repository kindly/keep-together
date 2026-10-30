<sv-page label="plan: bank transfers" category="plans">

<sv-prose id="b1">
## Design tree

*Confirmed by the human 2026-10-29: rounds 1–3 all as suggested, and the final round approved. Ready for a builder once the terms plan's schema step has landed. Unmarked branches are my calls from the facts below, confirmed with the rest.*

- **A statement line is the outside record**, the way `direct_debit_payments` is for GoCardless (ADR 0025 decision 3, gocardless b4). Its content (date, amount, payer, narrative) is never edited. A line is `unmatched`, `matched` (to gifts, or to a paying-in batch), or `not a donation`.
  - **Credits only** *(g1q3)*: debits are dropped while the file is read and never stored.
  - **Several bank accounts per group.** An admin names each one (e.g. "CAF current", "Unity deposit"). Lines belong to an account.
- **Where a transfer gift comes from**: made from a statement line, or entered by hand and matched to its line later.
  - **Entered by hand, it is `completed` at once** *(g1q1)*: someone saw the money arrive. It's flagged "not on a statement yet" until a line is matched to it.
  - **The gift date is the date the money reached the bank** (the line's posted date). HMRC asks for "the date you received the donation", and the statement is its evidence for transfers and standing orders.
  - **A gift made from a line takes its amount and date from the line**, locked against edits as a provider gift's are. Staff can still void it, which frees the line.
- **New methods**: `bank_transfer` and `cheque` join `cash`, `card` and `direct_debit`. A standing-order payment is a `bank_transfer` linked to a standing-order regular gift. A reference is allowed on both. HMRC counts a cheque only once it clears.
- **Getting statements in: files now** *(g1q2)*: CSV (a preset per common bank, plus column mapping saved per account), OFX and QIF. No Excel, and open banking later. **Presets first** *(g2q7)*: CAF Bank, Unity Trust, Co-op Business, NatWest/RBS Bankline, Barclays and Lloyds. *(g3q1)* NatWest is written from its official spec, Barclays and Lloyds from third-party write-ups, each marked "unverified" until a real anonymised file from a group confirms it. CAF, Unity and Co-op wait for a sample from the first group that banks there (the human has no accounts at them), and column mapping covers them until then.
- **Duplicates across overlapping imports** are found by content, because most UK CSVs carry no transaction id. A line is keyed by account, date, amount, payer and narrative. When a file holds the same key *n* times and we already hold it *m* times, only *n − m* are new, so two identical £10 standing orders on one day both survive. A bank id is used as well when the format has one (Monzo, OFX `FITID`). Each import reports "41 new, 12 already imported".
- **Matching suggests; staff confirm** *(g1q5)*. Nothing is applied on its own. A strong match (contact number in the reference, or a known payer or standing order, with the exact amount and the date in its window) is pre-ticked, and one "Accept ticked" saves them all. Each unmatched line gets ranked suggestions:
  - **The donor's contact number in the reference** (a Luhn-valid six-digit `100016` anywhere in the narrative) is the strongest signal. Groups ask donors to quote it; it fits the 18-character Faster Payments / BACS reference.
  - **A payer the group has matched before** (the line's payer name and reference, remembered per account) *(g1q8)*. Shown and removable on the contact, and anonymised with it on erasure (rule 3).
  - **A gift already entered by hand** with the same amount, from the same donor, within a few days.
  - **A standing order's expected payment** (amount exact, date −1/+1 days, tolerated −5/+15, as CiviBanking does).
  - **A name-only match is never strong**: always a suggestion, never in a bulk accept.
  - **Suggesters are pluggable.** Each one is a function from a line (plus the org's read access) to suggestions. A suggestion is the line, a proposed contact, gift(s) or split, a confidence, a human-readable reason ("contact no. 100016 in the reference; amount matches the standing order due 3 Nov") and which suggester made it. The rule-based suggesters above come first. Applying a suggestion goes through the same confirm path whoever made it, so no suggester writes anything itself.
  - **Later: an AI suggester** (human, 2026-10-29, via the controller). It would slot in as one more suggester, behind an org opt-in, never stronger than "suggested" unless the round-1 auto-apply rules say otherwise. It sends statement lines and donor names to a third party, so it needs a DPA and a privacy-notice line before any org can switch it on. Same idea later for bulk imports and report writing. Not built in this plan.
- **A line can be split into several gifts** *(g1q6)*, for different contacts if need be. A remainder is marked "not a donation" with a note, and the parts must add up to the line exactly.
- **Unmatching** a line voids the gifts that were made from it (never deleted; a claimed one is repaid through the next claim's adjustment, as any void is). Gifts that were entered by hand and later matched only lose the link, and go back to "not on a statement yet".
- **An unknown payer**: the match form can create the contact inline, with the name prefilled from the line's payer.
- **Standing orders are regular gifts of kind `standing_order`** *(g1q4)*, with no provider. The terms chain (`regular-gift-terms.sv`) gives their expected payments, and matched lines become their instalments. A payment still unmatched 14 days after it was due is flagged **missed**.
  - **Monthly, quarterly or yearly** *(g2q1)*. Direct Debit stays monthly and yearly, so the frequency CHECK widens and a rule refuses `quarterly` on a Direct Debit.
  - **After a miss, staff decide** *(g2q2)*. The gift shows "missed" and appears in a list of standing orders with a missed payment, and stays active until someone ends it. A late payment that turns up still matches the missed one.
  - **Set up two ways** *(g2q3)*: by hand on the contact ("Record a standing order": amount, frequency, day, the donor's reference, source code), or offered by the match form ("make this a standing order", prefilled) when the same payer pays the same amount at a regular interval for the second time. No bulk import.
- **Paying-in batches are in this plan** *(g1q7)*. Staff open a batch (account, slip number), enter its cash and cheque gifts into it, and close it with its total. The batch is matched to its one statement line, and any difference is shown, never forced.
  - **Batches are optional** *(g2q5)*. Record-gift gains a "paying-in batch" picker that remembers the open batch. Cash gifts outside a batch work as they do now.
  - **A cheque is `pending` until it clears** *(g2q4)*: it becomes `completed` when its batch is matched to a statement line, and `failed` if it bounces. A cheque outside a batch can be marked cleared by hand. Cash is `completed` on entry.
- **The source code on a gift made from a line** *(g2q6)* is the contact's acquisition code. If they have none, it's the bank account's default code (set by an admin, e.g. "Unsolicited bank transfer"). A standing-order payment takes its terms' split. Staff can change it before saving.
- **Not a donation**: a line can be marked so, with a note (a grant, a refund, a GoCardless payout). Staff can save a rule ("narrative contains GOCARDLESS → not a donation") so recurring non-donations stop showing.
- **Who does what** *(g1q9)*: admins set up bank accounts; staff and admins import and match. Viewers never see statement lines.
- **Out of scope here**: telling donors their contact number is their bank reference (receipts and letters belong to comms); Gift Aid ticks inside the match form.
</sv-prose>

<sv-prose id="b2">
## Goal

Money that reaches a group's bank account without a payment provider becomes gifts, and every gift entered by hand can be checked against the bank. Three flows land as lines on the group's bank statement:

- **One-off bank transfers**: a donor pays by Faster Payments or BACS, often with a reference. This is how gifts over GoCardless's £1,000 one-off cap should come.
- **Standing orders**: the donor sets up a recurring transfer in their own bank. The group can't start, change or stop it, and nothing tells it when one stops.
- **Paying-in**: cash and cheques banked together on one paying-in slip, which is one statement line for many gifts (ADR 0025 decision 6).

Staff import a statement (or, later, connect a read-only bank feed), and each credit line is matched: to a new gift, to gifts already entered, to a standing order's expected payment, to a paying-in batch, or marked as not a donation. Nothing counts until the money is in.

**Out of scope** *(draft)*: debits and bookkeeping (this is not accounts software); refunds paid out by bank; GoCardless and Stripe payouts beyond recognising them as "not a donation"; donor-facing payment pages; CAF/Charities Trust/payroll-giving agency remittances (a later import shape).
</sv-prose>

<sv-prose id="b3">
## Facts this rests on

Sources: `factory/out/planner-bank-research.md` (web research 2026-10-29; every fact there has a URL).

**In the code today** (main, after step 19):

- `gifts.method` is `cash | card | direct_debit`; there is **no cheque and no bank transfer**. A reference is refused on cash.
- Every gift has one origin: `provider` set with `provider_payment_id`, or entered by hand (ADR 0025 decision 1). Provider-sourced fields are locked against staff edits (decision 2).
- `regular_gifts` is GoCardless-shaped (`billing_request_id`, `mandate_id`, `subscription_id`), with no `kind` column.
- The terms chain and expected-vs-actual are planned, not built (`regular-gift-terms.sv`): expected is **derived** from the chain and matched to gifts by `scheduled_on`.
- Contact numbers are six digits with a Luhn check digit (`100016`), and search already finds them.

**How others do it:**

| | Standing orders | Statement matching |
|---|---|---|
| **CiviCRM + CiviBanking** | Recurring contribution; a matcher creates each instalment from its line, date −1/+1 days (tolerated −5/+15) | Import → analyse → match. Suggestions carry a probability, and only high ones apply automatically; a name-only match is capped below that. One line can become several contributions. Its "spread one deposit over a batch" matcher has no known users. |
| **Beacon** | A subscription creates each payment on its date as **unpaid** (expected); staff tick "Paid?" against the statement. Missed: wait a couple of weeks, then archive and cancel. | No statement import for these; it advises against CSV import. A **Payout** record groups payments into one bank lump sum (Stripe, GoCardless, or a paying-in of cash and cheques). |
| **Donorfy** | A standing-order instruction; staff import the bank's BACS Standard 18 file and lines match **only by reference**. Unmatched lines are skipped. | A line matches only when exactly one transaction has that reference and the exact amount. Bank reconciliation proper is left to Xero. |
| **Nonprofit Cloud** | A commitment schedule pre-creates future gifts as Unpaid | None for UK banks |
| **Xero** (where small charities actually reconcile) | | Find & Match: tick several recorded items against one line (a paying-in), split a line, add an adjustment |

**UK statement files.** There is no common format, and layouts change without notice (Co-op, HSBC).

- **CSV**: every bank's columns differ: a signed amount (Barclays, Starling) or paid-in / paid-out columns (Lloyds, Co-op, HSBC), day-first dates, header and footer rows (CAF Bank's CSV looks like a printed statement).
- **Most have no transaction id.** Monzo has one; Bankline only in one of its two exports.
- **CAF Bank** exports at most **31 days** at a time. **Santander Business** offers Excel, QIF, PDF and MS Money but no CSV. Lloyds and First Direct offer QIF only (FreeAgent's list).
- **OFX** `FITID` is meant to be unique per account, but some banks issue new ones on each download.
- **CAMT.053**: no sign of it for small UK accounts. **MT940** only on corporate platforms.

**Open banking** (read-only feeds, 2026):

- GoCardless Bank Account Data (ex-Nordigen) **stopped taking new accounts in July 2025**.
- TrueLayer and Yapily are sales-led, roughly £150–500 a month. Salt Edge lets an unlicensed app act as its FCA-registered **agent**.
- Since September 2022 the provider (not the bank) must **reconfirm consent every 90 days**, without a bank login; if nobody does, the feed stops.
- `TransactionId` is optional in the UK standard, and NatWest/RBS gave none (2020). Import only booked transactions, since pending ones change.
- No confirmed feed for CAF Bank or Co-op Business.

**References and Gift Aid:**

- Faster Payments and BACS references are **18 characters**: upper case, digits and `. & / -`. A six-digit contact number fits, with room for a short appeal code.
- Confirmation of Payee has been universal since October 2024, so a group should publish its exact account name.
- HMRC: transfers and standing orders are valid Gift Aid gifts. **The claim date is the date received.** Auditors review standing orders "directly from the charity's bank statements". A declaration can sit inside a standing-order form. For a joint account, the charity may assume the gift is the declarant's.
</sv-prose>

<sv-prose id="b4">
## Contracts and tables

*Sketch, pending round 1. Table names are provisional.*

- **New domain crate `banking`**: accounts, imports, lines, the file parsers and the match scoring, all pure where possible. It depends on `contracts` and on `giving`'s and `contacts`' public functions. Commands that make gifts from lines span modules, so they live in `api` as named command groups.
- `bank_accounts` (contract `banking.account`, counter `version`): name, sort code, last four digits of the account number, active.
- `bank_imports` (`banking.import`, create-only): account, file name, format, who and when, date range, new/duplicate counts.
- `bank_lines`, the outside record: account, import, posted date, amount in pence, payer, reference, raw narrative, the bank's id when it has one, the dedupe key and occurrence. Content is written once by the import. Its match state is the `banking.lineMatch` slice (counter `match_version`): state, note, the gifts or batch it's matched to.
- **Suggestions are computed on read**, not stored: `banking::suggest(line)` runs each registered suggester and merges their ranked output. A stored suggestion table can come later if an AI suggester (slow, paid per call) needs caching.
- `bank_payers` (derived, written by `banking.lineMatch`'s `project` hook): payer key → contact, per account, for suggestions.
- `gifts` gains `method` values `bank_transfer` and `cheque` (a table rebuild for the CHECK), `bank_line_id` and `paying_in_batch_id`.
- `regular_gifts` gains `kind` (`direct_debit | standing_order`).
- `paying_in_batches` (`giving.payingInBatch`, counter `version`): account, slip number, banked-on date, total, status, the line it matched.
</sv-prose>

<sv-prose id="b5">
## Steps

*Draft after round 1. Schema steps come after the terms plan's, which also rebuilds `gifts`.*

| # | Step | Touches | Runs |
|---|---|---|---|
| **1** | **ADR 0027** "Statement lines are the outside record for gifts entered by hand" (proposed here; the builder writes it from the confirmed page, since 0026 is the terms chain). One schema step: `bank_accounts`, `bank_imports`, `bank_lines`, `bank_payers`, `bank_rules`, `paying_in_batches`; `gifts` rebuilt with `method` widened to `bank_transfer` and `cheque` plus `bank_line_id` and `paying_in_batch_id`; `regular_gifts.kind` (default `direct_debit`). Fixture and migration test. | `api/src/schema.rs`, `api/tests/schema.rs`, `docs/decisions/` | first, after the terms plan's schema step |
| **2** | **`banking` crate: reading files.** Accounts contract; the parsers (CSV presets and saved mappings, OFX, QIF) as pure functions over bytes, NatWest, Barclays and Lloyds presets marked unverified with hand-made sample files (g3q1); debits dropped; the dedupe key and occurrence count; the import contract. | `server/crates/banking/`, manifest test | parallel with 3 |
| **3** | **`giving`: methods and batches.** `bank_transfer` and `cheque` in `Method` and its rules (a reference allowed on both); `giving.payingInBatch`; the line lock on a gift made from a line, as a provider gift's; "not on a statement yet". | `server/crates/giving/` | parallel with 2 |
| **4** | **Matching.** The suggester interface and the rule suggesters (contact number, known payer, gift entered by hand, standing-order expected payment, name only); `banking.lineMatch` with its `bank_payers` projection; the api commands (make gifts from a line, split, match to existing gifts, match to a batch, not a donation, rules, unmatch, accept ticked) as named command groups; routes with isolation tests. | `server/crates/banking/`, `server/crates/api/src/routes/` | after 2 and 3 |
| **5** | **Standing orders.** `kind = standing_order` set-up and end; expected payments from the terms chain; the missed flag (a job over `each_org`); its suggester feeds step 4. | `giving`, `api/src/jobs.rs`, routes | after 4 and the terms plan's expected side |
| **6a** | **UI: settings and import.** Bank accounts (admin); import a file, map columns, see "41 new, 12 already imported". | `src/routes/`, `src/lib/data/` | after 2 |
| **6b** | **UI: reconcile.** Unmatched lines with ranked suggestions and reasons, pre-ticked strong matches, "Accept ticked", the split dialog, inline new contact, not-a-donation rules; record-gift gains bank transfer and cheque; paying-in batch pages; the standing-order card. | `src/routes/`, `src/lib/domain/` | after 4 (card after 5) |
| **7** | **QC flows and docs.** QC flows for import and accept-ticked; `server/README.md`, `docs/architecture.md`. | `qc/`, `docs/` | last |

</sv-prose>

<sv-prose id="b6">
## Tests

*Draft. Each is a named Rust test unless marked.*

- **Parsers**: each preset reads its sample file to the expected credits; debits never reach a row; day-first dates; signed amounts and paid-in/paid-out columns both give positive pence; header and footer rows are skipped; a malformed row is reported by line number, and nothing from that file is stored.
- **Dedupe**: re-importing the same file adds nothing; an overlapping file adds only the new days; two identical lines in one file are both kept, and re-importing that file keeps exactly two; a bank id is used when present.
- **Money**: amounts are integer pence end to end (rule 7); a split must add up to the line exactly, or `422`.
- **Gifts from lines**: date and amount come from the line and staff can't edit them; void frees the line; unmatch voids the gifts made from the line and only unlinks the hand-entered ones; a claimed gift voided this way appears as an adjustment in the next claim.
- **Never optimistic**: an unmatched line counts for nothing; "Accept ticked" applies only the ticked suggestions, and only those that are still unmatched (a line matched meanwhile answers `409 stale`).
- **Suggesters**: a Luhn-valid contact number in the reference is strong and an invalid one isn't; a name-only match is never pre-ticked; a known payer is suggested after one confirmed match and not after the contact is erased; a standing order's expected payment matches inside −5/+15 days and not outside.
- **Standing orders**: missed after 14 days; a late payment still matches the missed period; nothing expected after it ends; `quarterly` is refused on a Direct Debit; the "make this a standing order" offer appears on the second regular payment, not the first.
- **Cheques**: pending until their batch matches a line; bounced → failed; never counted or claimable while pending.
- **Isolation**: every route under two orgs; B never sees A's accounts, imports, lines, batches or suggestions; A's line ids under B's slug answer 404; a suggester never proposes a contact from another org (it reads only `Tenant`'s file).
- **Roles**: a viewer gets 403 on every line, import and batch route; a staff member gets 403 on bank-account set-up.
- **Erasure (rule 3)**: anonymising a contact clears their `bank_payers` rows and leaves their gifts and the statement lines' amounts and dates intact.
- **Schema**: the migration fixture; no `REAL` column; the `banking` manifest names no `store`, `platform`, `auth` or `api`.
- **QC** (`pnpm qc`): import a CAF-style file; accept ticked.

</sv-prose>

<sv-ask id="g1q1" round="1">
**A transfer entered by hand.** Staff often see a transfer in online banking, or the donor emails to say they've paid, before anyone imports a statement. If such a gift is entered by hand, what status does it get?
- * `completed` at once (the money is in; someone saw it), flagged "not on a statement yet" until a line is matched to it
- `pending` until a statement line is matched to it, so it counts for nothing until then
- No hand entry for transfers: they come only from statement lines
</sv-ask>

<sv-ask id="g1q2" round="1" pick="many">
**Getting statements in, first build.** There's no free open-banking feed now that GoCardless's has closed to new sign-ups. The paid ones cost £150–500 a month and need an agent arrangement and 90-day consent reconfirmation. Which file formats should the first build read?
- * CSV, with a preset per common bank and column mapping for the rest (saved per account)
- * OFX
- * QIF (Lloyds, Santander, First Direct)
- Excel (Santander Business)
- Open banking now as well
</sv-ask>

<sv-ask id="g1q3" round="1">
**Debits.** A statement also holds salaries, suppliers and refunds paid out. This isn't accounts software, so should we keep them?
- * Credits only: debits are dropped while the file is read and never stored
- Store every line, and show only credits for matching
</sv-ask>

<sv-ask id="g1q4" round="1">
**Standing orders.** The donor controls them; we can't start, change or stop one, and nothing tells us when it stops.
- * A regular gift of kind `standing_order` with no provider. The terms chain (`regular-gift-terms.sv`) gives its expected payments, matched lines become its instalments, and a payment still unmatched 14 days after it was due is flagged "missed" for staff to chase or end
- As above, but no expected side: just link payments to it
- No standing-order record: each payment is a one-off transfer gift
</sv-ask>

<sv-ask id="g1q5" round="1">
**How much is applied without a click?** Every match makes or completes a financial record.
- * Nothing is applied on its own. A strong match (contact number in the reference, or a known payer or standing order, with the exact amount and date in its window) is pre-ticked, and one "Accept ticked" saves them all. Everything else needs a pick
- Strong matches apply during the import; staff only see the rest
</sv-ask>

<sv-ask id="g1q6" round="1">
**One line, several gifts.** A couple pays £100 from a joint account for two donors, or £60 is £50 donation plus a £10 raffle.
- * A line can be split into several gifts (different contacts allowed). Any remainder is marked "not a donation" with a note. The parts must add up to the line exactly
- One line = one gift; anything else is "not a donation"
</sv-ask>

<sv-ask id="g1q7" round="1">
**Paying-in batches** (cash and cheques banked together; gocardless b4 promised this table "when banking reconciliation is built").
- * In this plan. Staff open a batch (account, slip number), enter its cash and cheque gifts into it, and close it with its total. The batch is matched to its one statement line, and a difference is shown, never forced
- Later: this plan is transfers and standing orders only
</sv-ask>

<sv-ask id="g1q8" round="1">
**Remembering payers.** When staff match a line to a contact, keep the line's payer name and reference against that contact, so the next statement suggests it. That's personal data held on the contact's behalf, and erasure would anonymise it with the contact.
- * Yes, remember them (per bank account), shown and removable on the contact
- No: suggest only from contact numbers, gifts already entered and standing orders
</sv-ask>

<sv-ask id="g1q9" round="1">
**Who does what.** Statement lines show every payer into the account, donors or not.
- * Admins set up bank accounts. Staff and admins import and match. Viewers never see statement lines
- Admins only, for all of it
- Admins set up accounts and import; staff and admins match
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: where transfer gifts come from, statement files, standing orders, matching, paying-in batches, who.
</sv-ask>

<sv-ask id="g2q1" round="2">
**Standing-order frequencies.** Regular gifts today are monthly or yearly (GoCardless's). Donors set standing orders quarterly too, and occasionally weekly.
- * Monthly, quarterly and yearly for standing orders (Beacon's set). Direct Debit stays monthly and yearly
- Monthly, quarterly, yearly and weekly
- Monthly and yearly only, as now
</sv-ask>

<sv-ask id="g2q2" round="2">
**After a missed standing-order payment.** We can't tell whether the donor cancelled it or the bank was late.
- * Staff decide: the regular gift shows "missed" (and a list of standing orders with a missed payment), and stays active until someone ends it. A late payment that turns up still matches the missed one
- End it on its own after 2 missed payments in a row, with a note
</sv-ask>

<sv-ask id="g2q3" round="2" pick="many">
**Setting a standing order up.**
- * By hand on the contact ("Record a standing order": amount, frequency, day, the reference the donor uses, source code), usually from the donor's form
- * Suggested from the statement: when the same payer pays the same amount at a regular interval for the second time, the match form offers "make this a standing order", prefilled
- A bulk import from a spreadsheet of existing standing orders
</sv-ask>

<sv-ask id="g2q4" round="2">
**When a cheque counts.** HMRC treats a cheque as a gift only once it clears, and it can bounce. Cash in hand can't.
- * A cheque gift is `pending` until its paying-in batch is matched to a statement line, then `completed`. A bounce marks it `failed`. A cheque outside a batch can be marked cleared by hand
- `completed` on entry, like cash; a bounce is a void
</sv-ask>

<sv-ask id="g2q5" round="2">
**Must cash and cheques go in a batch?**
- * No. Record-gift gains an optional "paying-in batch" picker that remembers the open batch. Cash gifts outside a batch work as they do now
- Yes, every cash or cheque gift must be in a batch
</sv-ask>

<sv-ask id="g2q6" round="2">
**The source code on a gift made from a line.** One-off transfers often arrive with no appeal attached.
- * The contact's acquisition code, as on the record-gift page; if they have none, the bank account's default code (set by an admin, e.g. "Unsolicited bank transfer"); a standing-order payment takes its terms' split. Staff can change it before saving
- Always picked by hand, so no bulk accept without one
</sv-ask>

<sv-ask id="g2q7" round="2" pick="many">
**Which banks get a preset first?** Every other bank works through column mapping. I can't get real export files from the web, so each preset needs an anonymised sample (a few rows with names changed). If you can get them from groups, say how in the rider.
- * CAF Bank
- * Unity Trust
- * Co-op Business
- * NatWest / RBS (Bankline)
- * Barclays
- * Lloyds
- HSBC
- Starling
- Monzo
- Metro
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: standing-order details, cheques and batches, source codes, bank presets.
</sv-ask>

<sv-ask id="g3q1" round="3">
**Sample statement files for the presets.** NatWest publishes an official Bankline CSV spec. The Barclays and Lloyds layouts come only from third-party write-ups, and CAF Bank, Unity Trust and Co-op have none I could find. A preset written without a real file may be wrong.
- * The builder writes NatWest from its spec and Barclays and Lloyds from the write-ups. Each preset is marked "unverified" until a real anonymised file from a group confirms it. CAF, Unity and Co-op wait for samples, and column mapping covers them until then
- Hold step 2 until you've collected samples from groups for all six
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
**Final confirmation.** The design tree above is the whole plan: approve to confirm it as ready for a builder (after the terms plan's schema step), or revise with what's wrong.
</sv-ask>

</sv-page>
