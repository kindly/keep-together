<sv-page label="plan: regular-gift terms" category="archive">

<sv-prose id="b1">
## Design tree

*Confirmed by the human 2026-10-29 (rounds 1–2 all as suggested, round 3 approved). Ready for a builder once `feat/unified-gifts` has merged.*

- **The terms are a dated chain** *(g1q1)*. A regular gift has a chain of term rows. Each row holds the amount, frequency, day (and month), and a split by source code in pence that sums to the amount, in force from the first payment it governs. Nothing is overwritten: a change adds a row.
  - **Setting a gift up** writes its first row, with one code for the whole amount, as now.
  - **An upgrade** *(g1q2)* is a new total. The difference goes to the code that won it, and the existing split is unchanged. "Edit split" covers anything else.
  - **A downgrade** *(g1q3)* comes off the newest money first: the last upgrade is undone before the original recruitment code loses anything.
  - **Each change records the code that won it** *(g1q4)*: required on an upgrade, optional on anything else.
  - **The type is derived, never chosen**: upgrade, downgrade, schedule or reallocation, from the old row compared with the new one (as NPSP and Nonprofit Cloud do).
- **Getting the change to GoCardless** *(g1q5–q7)*. GoCardless has no effective date: an amount change applies to payments it creates afterwards.
  - We hold a future change and a job sends it when it falls due. An amount is amended in place; a frequency or day change, or an 11th amount change, cancels the subscription and makes a new one on the same mandate.
  - If the payment it was meant for already exists at the old amount, the change moves to the next payment and staff see the new date.
  - GoCardless emails the donor the advance notice.
- **Each payment copies the split in force on its scheduled date.** If GoCardless collected a different amount, the newest layer absorbs the difference *(g1q11)*. After that the gift's split can be edited on its own (ADR 0022 decision 9).
- **The expected side is derived from the chain, not stored** *(g1q9)*. Expected amount and split per period come from the row in force then. They are matched to gifts by the date GoCardless first scheduled each payment.
  - **A failed payment** stays expected and unpaid (arrears). **Cancellation** ends what is expected from then on *(g1q10)*.
- **Upgrade value is reported annualised** (monthly delta × 12), with the monthly figure beside it *(g1q8)*.
- **Pause is later** *(g1q12)*.
- **Changes made in GoCardless itself** *(g2q1)*. An `amended` we didn't send is recorded as a row from the next payment GoCardless creates. It has no change code and the note "changed in GoCardless". The difference goes on (or comes off) the newest layer, and the gift is flagged "change not coded" until staff pick a code.
- **An upgrade counts from its first collected payment at the new amount** *(g2q2)*. One that never collected shows as "not realised".
- **One gift at a time**: bulk uplifts and agency imports come later *(g2q3)*.
- **Staff and admins change terms**; viewers never do *(g2q4)*.
- **The regular-gift card shows the last 12 periods** *(g2q5)*: expected, what happened, and any scheduled change.
- **A payment from a subscription we didn't create**, on a known mandate, is a one-off gift, not expected *(g2q6)*. The unknown subscription is listed for staff to adopt as a new regular gift or leave.
</sv-prose>

<sv-prose id="b2">
## Goal

A regular gift's amount and its split by source code change over time, and every change is kept. Take the example of £10 a month recruited by `Street-Wesser-001`, upgraded by a phone call to £12 from 1 December. From that date each payment's gift is split £10 Street and £2 to the telephone code. Reports then show the £2 a month (£24 a year) as won by the telephone campaign. The same dated history gives the **expected** side, as in CARE: for any month, what each regular gift should have brought in and under which codes, against what was actually collected, failed, or never came. Changes reach GoCardless at the right moment and within its rules.

**Out of scope:** pausing (GoCardless supports it; a later row type, like NPSP's `IsPause__c`); expected one-off payments and pledges (they would produce the same expected shape later); our own donor notices or "thank you for upgrading" emails (comms); Stripe; the fund mapping on details (ADR 0022 decision 8); importing change history from an existing GoCardless account (D4).

**Sits on:** the unified `gifts` table (`factory/plans/gocardless.sv` b3/b4, builder-ugt on `feat/unified-gifts`, schema step 18). This plan's schema steps come after it.
</sv-prose>

<sv-prose id="b3">
## Facts this rests on

**GoCardless** (sources in `factory/out/planner-rgt-research.md`):

| Fact | Consequence |
|---|---|
| `PUT /subscriptions/{id}` changes only `amount` (plus name, metadata, reference, app fee). Interval, `day_of_month`, `month` and `start_date` are fixed. | A frequency or day change means cancelling the subscription and creating a new one on the **same mandate**. The donor doesn't sign again. |
| At most **10 amount changes** per subscription (`number_of_subscription_amendments_exceeded`). | The 11th change goes the recreate route too. We count amendments per subscription. |
| **No effective date.** An amendment applies to payments created after it. Payments that already exist keep the old amount, and on Bacs GoCardless creates them a few working days ahead. | We hold future changes and send them when due. If a change is too late for its target payment, it moves to the next one. |
| `upcoming_payments` lists up to 10 future charge dates and amounts. Events: `subscriptions.amended` and `subscriptions.payment_created`. | Staff pick the effective payment from a real date list. The `amended` event confirms a change was sent. |
| Bacs advance notice: GoCardless's own default is 3 working days, stating the effective date. GoCardless sends it by default. A partner's own notices need GoCardless's approval. | We rely on GoCardless's email and send nothing ourselves for now. |

**How others do it:**

- **NPSP and Nonprofit Cloud** keep effective-dated schedule rows (`RecurringDonationSchedule__c`, `GiftCommitmentSchedule`) and a change log whose type (Upgrade, Downgrade, Neutral, Pause, Resume) is **derived** from the old and new values. Each schedule row carries its own campaign. Future instalments are **projected, not stored**, apart from the next one.
- **Blackbaud CRM (UK)** stores expected instalments as real rows with a balance, past due, skip and write-off. An upgrade carries its own source code and appeal and a "revenue function" code. I found no public docs for legacy CARE itself.
- **Raiser's Edge**: an amendment applies to future instalments and can change the campaign, fund and appeal split. RE7 has a "starting on" date. There's no structured upgrade type.
- **CiviCRM**: one amount on `contribution_recur`, with the split held on a hidden template contribution. It keeps no history and has no upgrade concept.

Nobody splits one recurring gift across several *sources* the way we do (ADR 0022 already says so). The layer rule for downgrades below is our own.
</sv-prose>

<sv-prose id="b4">
## Contracts and tables

**New tables** (org schema, no tenant column):

- `regular_gift_terms`: one row per change.
  - Identity and dating: `id`, `regular_gift_id`, `effective_from` (ISO date: the scheduled date of the first payment it governs).
  - The terms: `amount`, `frequency`, `day_of_month`, `month`.
  - What staff record: `change_code_id` (the version credited with the change, or NULL), `note`, `entered_by`, `entered_at`.
  - Sync, system-owned: `state` (`scheduled | sent | applied | withdrawn`), `subscription_id` (the GoCardless subscription it runs under), `sent_at`, `applies_from` (the payment it really starts on, when the change missed its intended one).
  - Counters: `terms_version`, `sync_version`, `code_version`.
  - Index: `(regular_gift_id, effective_from)`.
- `regular_gift_term_allocations`: `id`, `term_id`, `position`, `source_code_id`, `amount`.
  - Child rows with ids (ADR 0014). `position` is the layer order, oldest money first.
- `subscription_amendments` is not a table. Amendments are counted from terms in state `sent`/`applied` with the same `subscription_id`.

**Changed tables:**

- `gifts` gains `scheduled_on` (NULL except for provider payments of a regular gift): the charge date GoCardless first gave the payment, which keys it to its period. `direct_debit_payments` gains the same column. Both are backfilled from `charge_date`, the best we know for old payments.
- `regular_gifts` loses `amount`, `frequency`, `day_of_month`, `month` and `source_code_id`, which move into its first terms row. This is two steps: first add and backfill, then drop the columns once nothing reads them.

**Contracts:**

| Contract | Slice | Counter | Writes |
|---|---|---|---|
| `giving.regularGift` **v2** | contact, client key, set-up facts | `terms_version` → renamed `setup_version` | Created with its first terms row in one command group. An upcaster turns v1 revisions (which held the terms) into v2 plus the first row's payload. |
| `giving.regularGiftTerms` (new) | one terms row: dates, amount, schedule, allocations (children), note | `terms_version` | Created by staff (a change) or by set-up. It can be **edited or withdrawn only while `scheduled`**; once sent it is immutable (`term_sent`). Tier-1: allocations sum to the amount; every code goes through `sources::mark_used`; `effective_from` is after the last sent row's. |
| `giving.regularGiftTermSync` (new) | `state`, `subscription_id`, `sent_at`, `applies_from` | `sync_version` | Written only by the system (the sync job, webhook processing). `applies_from` is the first payment it really governs: the staff's `effective_from`, or a later one if the change missed its payment. The chain reads `applies_from` when set, so the two contracts share no field. |
| `giving.regularGiftTermCode` (new) | `change_code_id` only | `code_version` | Staff, at any state, so a change made in GoCardless can be coded later and a wrong code fixed. A change is entered as both slices in one command group, as `contacts.create` does. A new code goes through `mark_used`. |
| `giving.regularGiftMandate` | unchanged; `subscription_id` is now "the current one" | `mandate_version` | Recreating a subscription sets the new id. |
| `giving.gift` / `giving.status` | unchanged; `scheduled_on` is provider-sourced, set by processing | as now | Payments copy the split in force (pure rule `split_for_collected`). |

**Pure rules** (`giving::rules`, mirrored in `src/lib/domain/`):

- `term_in_force(chain, date)`.
- `upgrade_split(split, new_amount, code)`: adds the difference to `code` as a new last layer, merged if it is already the last layer.
- `downgrade_split(split, new_amount)`: removes pence from the last layer backwards.
- `split_for_collected(split, collected)`: `downgrade_split` if less was collected, and the extra to the last layer if more.
- `change_kind(old, new)`: upgrade, downgrade, schedule or reallocation, by annual value, then by schedule, then by split.
- `annual_value(terms)` = amount × 12 or × 1.
- `expected_periods(chain, ended_at, from, to)` gives (period, due date, amount, split).

**Domain rules that apply:**

- **6:** no tenant column; the job loops orgs with `each_org`.
- **7:** pence everywhere, and the split arithmetic never divides.
- **3:** terms rows are financial history: erasure anonymises the contact and keeps every row and its codes.
- **1 (by analogy):** the terms are a dated chain, like a declaration, so "what was in force on date X" is a lookup, never a stored flag.
- **4:** Gift Aid is untouched. It still reads only completed gifts, and the reclaim follows each gift's own allocations in reports.
- **5:** the donor notice is GoCardless's. If we add our own later, it goes through `comms` as transactional.
- **2:** doesn't apply.
</sv-prose>

<sv-prose id="b5">
## Steps

Each step is one builder session, run in order unless marked **parallel**. All of this waits for `feat/unified-gifts` to merge.

1. **ADR 0026 "Regular gift terms are a dated chain"** (proposed here; the builder writes it from the confirmed page). Also the schema step that adds `regular_gift_terms` and `regular_gift_term_allocations` and backfills one `applied` row per regular gift (from its old columns, `effective_from` = its first payment's charge date or the set-up date). That step also adds `scheduled_on` to `gifts` and `direct_debit_payments` and backfills it. Touches `api/src/schema.rs`, `api/tests/schema.rs` (fixture) and `docs/decisions/`.
2. **Pure rules and their twins** (**parallel** with 3's fake work): `giving/src/rules.rs` or a new `giving/src/terms_rules.rs`, plus `src/lib/domain/regular-terms.ts`, with a named test per rule on both sides.
3. **Contracts.** `giving/src/regular.rs` (or split it into `regular/terms.rs`): `RegularGift` v2 with its upcaster, `RegularGiftTerms`, `RegularGiftTermSync`. Payment processing copies `split_for_collected` from the row in force on `scheduled_on`. Set-up writes row 1. No new place hard-codes one code per gift. Regenerate ts-rs.
4. **GoCardless sync.**
   - In `api/src/gocardless/client.rs`: `update_subscription` (amount) and `get_subscription` (`upcoming_payments`).
   - The fake gains `PUT`, the 10-change cap, `upcoming_payments`, and `amended` and `payment_created` events.
   - A job `regular_terms_sync` on `api::jobs`, run hourly and on save, which for each due `scheduled` row:
     - amends, or recreates with `start_date` = the effective date and idempotency key `keep-sub-{term id}`;
     - moves the row to the next payment if its target already exists;
     - otherwise marks it `sent`. The `amended` event, or the first payment at the new amount, marks it `applied`.
   - Processing: an `amended` we didn't send records a row (`changed in GoCardless`, no code, flagged "change not coded" until staff set its code through `giving.regularGiftTermCode`). A payment from an unknown subscription on a known mandate becomes a one-off gift, and the subscription is listed (`GET …/gocardless/unknown-subscriptions`; adopt = a new regular gift whose first row is applied from the subscription's terms).
   - Routes: `POST /api/t/{slug}/regular-gifts/{id}/terms` (a change); `PUT …/terms/{termId}` (`expected`, while scheduled); `POST …/terms/{termId}/withdraw`; `GET …/regular-gifts/{id}` gains the chain and the upcoming dates.
   - Isolation tests for each route.
5. **Expected vs actual reads** (**parallel** with 4 once 3 is in):
   - `giving::expected` turns the chain plus the gifts matched by `scheduled_on` into rows per period: expected, completed, failed, cancelled, missing.
   - Routes: by regular gift, and a report by code, detail or category over a period range, with the upgrade value (annualised and monthly) by change code, counted from the first collected payment at the new amount, and "not realised" upgrades separately.
   - A `keep expected <slug> <month>` check.
6. **SPA** (with or after the D3 screens):
   - On the regular-gift card, "Change amount or schedule": new total, the code that won it, effective payment picked from the upcoming dates, and the split shown and editable.
   - Also on the card: the terms history, a scheduled change you can edit or withdraw, the "change not coded" flag with its code picker, and the last 12 periods of expected vs actual.
   - Settings or GoCardless page: unknown subscriptions to adopt or leave.
   - Staff and admins see the change button; viewers don't.
   - A report page for expected vs actual and upgrades.
   - QC flow: the change dialog is repeatable (100 ms).
7. **Tighten:** a later schema step drops the old columns from `regular_gifts`, once nothing reads them (a grep test).
</sv-prose>

<sv-prose id="b6">
## Tests

- **Split rules (Rust and TS twins):**
  - £10 Street up to £12 Telephone gives [Street 1000, Telephone 200].
  - Down to £11 gives [Street 1000, Telephone 100]. Down to £8 gives [Street 800].
  - Collected £10 under a £12 row gives [Street 1000]. Collected £13 gives [Street 1000, Telephone 300].
  - Allocations always sum to the amount, and no rule divides.
- **The chain:**
  - The row in force for a date, including on the effective date itself.
  - An edit after `sent` is refused, and so is a withdraw after `sent`.
  - `effective_from` must be after the last sent row's.
  - Restoring an old revision of a scheduled row works; restoring a sent row is refused.
- **Payments:** a payment scheduled before the effective date copies the old split, and one on or after it copies the new split. A retry collected later keeps its period. Editing one gift's split leaves the chain alone.
- **Sync, against the fake GoCardless:**
  - An amount change sends one `PUT` when due and none before.
  - The 11th change recreates the subscription on the same mandate, and so does a frequency or day change. Recreating is idempotent across job retries.
  - A change too late for its payment moves to the next one, with `applies_from` set and `effective_from` kept.
  - A cancelled gift's scheduled rows are withdrawn.
  - An `amended` we didn't send records an uncoded row, and coding it clears the flag.
  - A payment from an unknown subscription is a one-off gift and lists the subscription. Adopting it makes a regular gift without creating a subscription.
  - A viewer's change is refused (403).
- **Expected:**
  - The months before and after an upgrade.
  - A failed month shows as arrears, a missing month as missing, and nothing is expected after cancellation.
  - The report sums by code, detail and category. Upgrade value is £24 a year for the example, and an upgrade cancelled before its first payment is "not realised".
- **Isolation:** for every new route, org B never sees A's terms, and A's regular-gift and term ids under B's slug are 404.
- **Schema:** the backfill fixture gives exactly one applied row per regular gift, with a split equal to its amount. `scheduled_on` is filled. There is still no `REAL` column.
</sv-prose>

<sv-prose id="b7">
## Round 1

Twelve questions. Every one has my recommendation pre-selected; change only what you disagree with.
</sv-prose>

<sv-ask id="g1q1" round="1">
**Where the terms live.** A regular gift's amount, schedule and split change over time.
- * A dated chain: one row per change, each in force from the first payment it governs; old rows are never overwritten (NPSP/Nonprofit Cloud style)
- One current set of terms, overwritten on change; history only in revisions
- The chain as a child list inside the regular gift's own payload
</sv-ask>

<sv-ask id="g1q2" round="1">
**Entering an upgrade.** £10 Street → £12 after a phone call.
- * Staff type the new total and pick the code that won it; the difference (£2) goes to that code and the existing split is kept. "Edit split" opens the whole split for anything else (partial or mixed credit)
- Staff always edit the whole split by hand
- Staff type only the difference (+£2) and its code
</sv-ask>

<sv-ask id="g1q3" round="1">
**Which code loses on a downgrade.** £10 Street + £2 Telephone → £11, or → £8.
- * Newest money first: the last upgrade's layer shrinks first, then the one before (→ £11 is Street 10 + Tel 1; → £8 is Street 8). Staff can edit the split
- Pro rata across the codes (needs rounding)
- Staff choose every time, with no default
</sv-ask>

<sv-ask id="g1q4" round="1">
**The code that made the change.** Separate from the split: the campaign credited with the change itself (the upgrade call, or the retention call that saved a cancel as a downgrade).
- * Every change records one, required on an upgrade and optional otherwise; on an upgrade it is also the code the difference goes to
- Only upgrades record one
- None: the split says it all
</sv-ask>

<sv-ask id="g1q5" round="1">
**Changing frequency or collection day.** GoCardless can't change these on a live subscription.
- * Supported: we cancel the subscription and create a new one on the same mandate from the effective date; the donor doesn't re-sign, and the chain just gains a row
- Not now: cancel the regular gift and set up a new one
</sv-ask>

<sv-ask id="g1q6" round="1">
**When a change takes effect.** GoCardless applies an amount change to payments it hasn't created yet, a few working days before each charge date, and has no effective date.
- * Staff pick the first payment at the new terms from the upcoming dates (default: the earliest still changeable). We hold it and send it when due. If its payment was already created at the old amount, it moves to the next one and the regular gift says so
- Same, but if too late, cancel the already-created payment and charge a one-off at the new amount
- No future dates: changes go to GoCardless immediately and apply to whatever payment comes next
</sv-ask>

<sv-ask id="g1q7" round="1">
**Telling the donor.** The Direct Debit Guarantee needs advance notice of an amount or date change. GoCardless sends it by default; our own would need GoCardless's approval.
- * GoCardless's own notice email for now
- Our own notice (through comms), approved by GoCardless as a partner
</sv-ask>

<sv-ask id="g1q8" round="1">
**How upgrade value is reported.**
- * Annualised (+£2/month = £24/year) as the headline, monthly delta beside it, by the code that made the change; downgrades as negative value the same way
- Monthly delta only
- Actually collected extra since the change (realised value)
</sv-ask>

<sv-ask id="g1q9" round="1">
**Expected payments: stored or derived.** CARE / Blackbaud CRM stores expected instalments as rows with balances; NPSP stores only the next one and projects the rest.
- * Derived: computed from the chain for any period, matched to gifts by the date each payment was first scheduled. No table, nothing to regenerate when terms change. A table can come with pledges later
- Stored: an `expected_payments` table with expected splits, generated ahead by a job and regenerated on change, gifts linked to rows
</sv-ask>

<sv-ask id="g1q10" round="1">
**Expected payments on failure and cancellation.**
- * A failed payment stays expected and unpaid (arrears) unless a retry collects it; after cancellation nothing more is expected, and the lost annual value is reported against the codes in the split at the time
- As above, but a failed month stops being expected (no arrears)
- Also write off or skip individual expected payments by hand (Blackbaud style)
</sv-ask>

<sv-ask id="g1q11" round="1">
**GoCardless collected a different amount from the terms** (a change that missed its payment, a one-off adjustment).
- * The gift copies the split in force; the newest layer absorbs the difference (less: it shrinks first; more: it grows); the expected-vs-actual report shows the gap
- Scale the split pro rata (rounding)
- The whole difference goes to an "unallocated" line
</sv-ask>

<sv-ask id="g1q12" round="1">
**Pause** (a donor takes three months off). GoCardless supports pausing a subscription.
- * Later, as its own row type in the chain (expected = nothing for those periods)
- Now, in this plan
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: the shape of the chain, upgrades and downgrades, getting changes to GoCardless, and the expected side. Send when done.
</sv-ask>

<sv-prose id="b8">
## Round 2

Round 1 came back all as suggested. These are the questions it opened.
</sv-prose>

<sv-ask id="g2q1" round="2">
**A change made directly in GoCardless.** Someone edits the amount in the GoCardless dashboard and we get `subscriptions.amended`, a change we didn't send.
- * Record it automatically as a new row from the next payment GoCardless creates, with no change code and the note "changed in GoCardless"; the difference goes to (or comes off) the newest layer; the regular gift is flagged "change not coded" until staff pick a code
- Same, but don't flag it
- Don't record it: the expected side shows the gap until staff enter the change by hand
</sv-ask>

<sv-ask id="g2q2" round="2">
**When an upgrade counts in the upgrade report.** A change can be entered in November for December, then the donor cancels before paying.
- * From its first collected payment at the new amount: an upgrade that never collected shows as "not realised", separately
- From the day it was entered
- From its effective date, collected or not
</sv-ask>

<sv-ask id="g2q3" round="2">
**Bulk changes** (an annual uplift: ask every donor for +£1 and apply it to those who agree, or a list of upgrades from a telephone agency).
- * Later: one gift at a time now; a bulk tool (or an import of agency results) once this is built
- Include a bulk change in this plan
</sv-ask>

<sv-ask id="g2q4" round="2">
**Who can change a regular gift's terms.**
- * Staff and admins, as for setting one up; viewers never
- Admins only
</sv-ask>

<sv-ask id="g2q5" round="2">
**Expected vs actual on the regular-gift card.**
- * The last 12 periods: expected amount, what happened (collected, failed, missing, cancelled), and the scheduled change if any. The full history is in the report
- Nothing on the card: the report only
</sv-ask>

<sv-ask id="g2q6" round="2">
**A payment from a subscription we didn't create** on a known mandate (someone made a second subscription in the GoCardless dashboard).
- * Record it as a one-off gift on the mandate's contact (as the unified-gifts build does for one-offs), not expected, and list the unknown subscription for staff to adopt as a new regular gift or leave
- Adopt it as a new regular gift automatically, uncoded
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: changes from outside, when upgrades count, bulk, permissions, the card. Send when done.
</sv-ask>

<sv-prose id="b9">
## Round 3: confirm

Round 2 came back all as suggested. Its answers are folded into the design tree, the steps (4–6) and the tests.

One addition from round 2: a row's change code gets its own slice, `giving.regularGiftTermCode`, editable at any state. A change made in GoCardless can then be coded after it was sent, and the code shares no field with the staff or sync contracts. Every other field of a sent row stays fixed.

Nothing is left open. Approve to hand this to a builder once unified gifts has merged, or choose revise and say what to change.
</sv-prose>

<sv-ask id="g3fin" round="3" role="close">
Confirm the plan: design tree, contracts and tables, steps 1–7, tests.
</sv-ask>

</sv-page>
