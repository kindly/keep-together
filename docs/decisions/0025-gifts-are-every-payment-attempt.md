# 0025: Gifts are every payment attempt

Status: accepted (2026-10-29). From the plan `factory/plans/gocardless.sv`,
rounds 2 and 3 (blocks b3 and b4), confirmed by the human 2026-10-29;
written by builder-ugt. Built after GoCardless D1+D2 (merge b0eb535).

Amends [ADR 0008](0008-payments-stripe-gocardless.md) (it gives the
"provider-agnostic status enum" it asked for its values) and
[ADR 0022](0022-source-codes.md) (decision 9's regular-gift allocations:
a provider gift keeps one allocation for now; the dated terms history is
`factory/plans/regular-gift-terms.sv`). Within
[ADR 0024](0024-rust-sqlite-per-org.md): one org-schema step, contracts
as there.

## Context

D2 recorded a GoCardless payment as a gift only once GoCardless said
`confirmed`, voided it on a chargeback, un-voided it when the chargeback
was cancelled, and recorded *another* gift when a retry was collected on
another day or a claimed gift's money came back. That kept `gifts` to
money received, but:

- a payment could be several gifts over its life, so "which gift is this
  payment" needed a reference lookup and special refusals
  (`direct_debit_recorded_again`, `direct_debit_returned`);
- a pending or failed payment existed only on the regular gift's card,
  never in the donor's giving history;
- a payment we couldn't tie to a regular gift (a one-off taken in
  GoCardless's dashboard, an account's older mandates) was dropped as
  `unknown_resource`.

CiviCRM and CARE keep one contribution row per attempt, with a status;
reports count the completed ones.

## Decision

1. **`gifts` is the unified table of every payment attempt.** Status is
   `pending | completed | failed | cancelled | refunded | charged_back |
   void`. `void` stays the staff's word for "entered by mistake"; the
   others are a provider's. Every gift has one origin: `provider` set
   (`gocardless`, later `stripe`) with `provider_payment_id`, or entered
   by hand (`provider` empty; later inside a paying-in batch).
   `regular_gift_id` names the regular gift a payment was collected for,
   empty for a one-off.
2. **One gift per provider payment, for its whole life.** The gift is
   made the first time we hear of the payment, with the payment's status,
   and follows it: GoCardless's status, amount and charge date (the date
   the money was collected, which decides the tax year) are copied onto
   the same gift by the same processing step that updates the provider
   row, in one transaction. `(provider, provider_payment_id)` is unique.
   Provider-sourced fields (method, amount, date, reference, status)
   can't be edited by staff. Staff may still void a provider gift (a
   mistake, such as a payment matched to the wrong donor); that void
   outlives later provider updates, and un-voiding it gives it the
   provider's status again.
3. **Provider tables stay the raw record** of what the provider said
   (`direct_debit_payments` now, `stripe_payments` later). A payment we
   can't tie to a donor is stored there with no gift (*unmatched*) and
   listed for staff, who match it to a contact; that makes its gift.
   Nothing is quietly dropped.
4. **Only `completed` is money received.** Income, reports, dashboards
   and Gift Aid read gifts through one shared filter
   (`giving::RECEIVED`, `status = 'completed'`); a schema test fails on a
   gifts read in server code that neither uses it nor says why it reads
   every status. Pending, failed, cancelled, refunded, charged-back and
   void gifts count for nothing and are never claimable.
5. **Gift Aid keeps the claim lock.** A claimed gift keeps the amount and
   date it was claimed on. If its payment later stops counting (charged
   back, failed late, cancelled), its status follows GoCardless and the
   next claim pays the tax back as an adjustment, as a void does. A
   claimed gift's status may come back to `completed` (a cancelled
   chargeback): before the adjustment is claimed, nothing is repaid;
   after, the tax stays repaid (re-claiming it is a follow-up).
6. **No cash table** (round 3). For a gift entered by hand, the staff
   entry *is* the source. The outside record for cash and cheques is the
   paying-in batch (slip number, bank date, total), its own table when
   banking reconciliation is built; it plays the provider table's role.
7. **A consistency check** (a named test, and `keep giving-consistency
   <slug>`, read-only) fails if a matched provider payment doesn't have
   exactly one gift with the same amount, date and status (a claimed
   gift's own amount and date; a staff void).

## Consequences

- Org schema step 18 rebuilds `gifts` (the status CHECK widens; provider
  columns) and `direct_debit_payments` (a payment's regular gift is
  optional; the mandate it was taken on; no `gift_voided`), backfilling
  one gift per existing payment. D2's superseded gifts (a retry
  re-recorded) keep `provider` but no `provider_payment_id`: void, out
  of the unique pair.
- `giving.gift` v2 carries the provider fields (create-only);
  `giving.directDebitPayment` v2 drops `giftVoided` and makes
  `regularGiftId` optional. Both upcast v1 unchanged.
- Lists show every gift, marked by status; totals filter on completed.
- Staff can take a one-off by charging an existing mandate once or by
  sending an Instant Bank Pay link; both become gifts only on
  GoCardless's word (its events).
- A nightly catch-up reads each connected account's GoCardless events
  since the last run and queues any the webhooks missed.
