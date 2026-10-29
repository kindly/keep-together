# 0026: Regular gift terms are a dated chain

Status: accepted (2026-10-29). From the plan
`factory/plans/regular-gift-terms.sv` (design tree b1, contracts b4,
steps b5, tests b6; rounds 1–3), confirmed by the human 2026-10-29;
written by builder-rgt. Built after unified gifts
([ADR 0025](0025-gifts-are-every-payment-attempt.md)).

Amends [ADR 0022](0022-source-codes.md) (decision 9: a regular gift's
split across codes is now dated, and each payment copies the split in
force on its date) and ADR 0025 (a provider gift's split is no longer one
allocation to the regular gift's code). Within
[ADR 0024](0024-rust-sqlite-per-org.md): one org-schema step, contracts
as there. Research: `factory/out/planner-rgt-research.md`.

## Context

A regular gift held one amount, schedule and source code, fixed once set
up: changing the amount meant cancelling it and setting up another, which
lost the donor's history and the code that recruited them. Fundraisers
need to credit an upgrade to the campaign that won it (£10 a month from
`Street-Wesser-001`, raised to £12 by a phone call: £2 a month to the
telephone code from then on) and to see, month by month, what each
regular gift should have brought in against what came.

GoCardless can amend only a subscription's amount, at most 10 times, and
has no effective date: a change applies to payments it creates after the
change, a few working days before each charge. A new frequency or day
means a new subscription on the same mandate.

NPSP and Nonprofit Cloud keep effective-dated schedule rows with a
derived change type; Blackbaud CRM stores expected instalments as rows.
Nobody splits one recurring gift across several sources as we do.

## Decision

1. **The terms are a dated chain.** `regular_gift_terms` holds one row
   per change: amount, frequency, day (and month), and a split by source
   code in pence (`regular_gift_term_allocations`, child rows with ids,
   `position` the layer order, oldest money first) that sums to the
   amount, in force from `effective_from`, the scheduled date of the first
   payment it governs. Nothing is overwritten: a change adds a row. Set-up
   writes the first row (one code for the whole amount). What was in
   force on a date is a lookup (`term_in_force`), never a stored flag.
2. **Upgrades and downgrades move layers, never divide.** An upgrade is a
   new total: the difference goes to the code that won it as a new last
   layer (merged into the last layer if it is that code). A downgrade
   comes off the newest money first. A collected amount that differs from
   the terms is absorbed by the newest layer the same way. Staff may edit
   the whole split instead. The change type (upgrade, downgrade, schedule,
   reallocation) is derived by comparing a row with the one before it:
   annual value, then schedule, then split.
3. **Each change records the code that won it** (`change_code_id`):
   required on an upgrade, optional otherwise, editable at any time in its
   own slice so a change made elsewhere can be coded later.
4. **Four slices, no shared field.** `giving.regularGift` v2 is the
   set-up (donor, client key; `setup_version`). `giving.regularGiftTerms`
   is one row's terms, split, note and withdrawal (`terms_version`): staff
   edit or withdraw a row only while it is scheduled; once sent it is
   history (`term_sent`), restores included. `giving.regularGiftTermSync`
   is the system's: `state` (`scheduled → sent → applied`), the GoCardless
   subscription it runs under, when it was sent and `applies_from`, the
   payment it really starts on if it missed its intended one
   (`sync_version`). `giving.regularGiftTermCode` is the change code
   (`code_version`). The chain reads `applies_from` when set, else
   `effective_from`.
5. **Changes reach GoCardless when due.** A job (`regular-terms-sync`,
   hourly and after each save) sends each scheduled row a fortnight before
   it takes effect: an amount is amended in place (`PUT`); a frequency or
   day change, or an amount change past GoCardless's 10, makes a new
   subscription on the same mandate starting on the effective date
   (idempotency key `keep-sub-{term id}`) and cancels the old one. If the
   payment it was meant for already exists at the old amount, the row
   moves to the next payment (`applies_from`) and staff see the new date.
   GoCardless sends the donor the advance notice. A donor is never left
   with two live subscriptions or one we don't know of: a row is `sent`
   only once the old subscription is cancelled (a failed cancel is
   retried), a gift ended mid-send has the new one cancelled, a gift's
   later changes wait for an earlier one still in flight, and cancelling
   a regular gift that shares its mandate (one adopted) cancels only its
   own subscription. A change GoCardless refuses for good goes back to
   staff to edit or withdraw. A change starts on one of the new terms'
   payment dates, still to come.
6. **Each payment copies the split in force on its scheduled date**
   (`scheduled_on`: the charge date GoCardless first gave it, kept through
   retries), with the newest layer absorbing any difference in the amount
   collected. After that the gift's split is the gift's own (ADR 0022
   decision 9).
7. **The expected side is derived, never stored.** For any period the
   chain gives the amount and split each regular gift should bring in;
   gifts are matched to periods by `scheduled_on`. A failed payment stays
   expected (arrears); cancellation ends what is expected from then on.
   Upgrade value is reported annualised, with the monthly figure beside
   it, by change code, from the first payment collected at the new
   amount; one that never collected is "not realised".
8. **Changes made outside.** An amount changed in GoCardless's dashboard
   (`subscriptions.amended` we didn't send) is recorded as a row from the
   next payment, uncoded, noted "changed in GoCardless", the difference
   on the newest layer, and the regular gift is flagged "change not coded"
   until staff code it. A payment from a subscription we didn't create, on
   a known mandate, is a one-off gift, and the subscription is listed for
   staff to adopt as a new regular gift.

## Consequences

- Org schema step 19 rebuilds `regular_gifts` without its old term
  columns (`amount`, `frequency`, `day_of_month`, `month`,
  `source_code_id`; `terms_version` becomes `setup_version`) and backfills
  one applied terms row per regular gift from them (`effective_from`: its
  first payment's charge date, else the set-up date). The plan's later
  "tighten" step (drop the columns once nothing reads them) is folded in:
  a migration runs with the code that reads the new shape, and a rollback
  restores the pre-migration copy, so there is no window where old code
  reads the new file.
- `gifts.scheduled_on` and `direct_debit_payments.scheduled_on` are
  backfilled from the charge date (the best known for old payments);
  `direct_debit_payments.subscription_id` keeps the subscription a payment
  came from.
- `giving.regularGift` v2 upcasts v1 by dropping the terms (they are row
  1 now), so restoring an old revision never touches the chain.
  `giving.gift` v3 (`origin.scheduledOn`) and `giving.directDebitPayment`
  v3 (`scheduledOn`, `subscriptionId`) upcast unchanged.
- A subscription's own `cancelled` event ends its regular gift only if it
  is the regular gift's current subscription; payments from a replaced
  subscription are still its instalments.
- Erasure anonymises the contact and keeps every terms row (rule 3).
  Gift Aid is untouched: it reads completed gifts and their own
  allocations.
- Pausing, bulk uplifts, agency imports, expected one-offs and pledges
  come later; pause would be a row type in the same chain.
