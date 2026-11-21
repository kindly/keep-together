# 0028: Stripe Connect with direct charges; a donor's submission is the evidence; declarations made by the donor on screen

Status: accepted (2026-11-21). From the plan `factory/plans/stripe.sv`
(design tree b1, Stripe's facts b2, brief b3; rounds 1–3), confirmed by
the human 2026-11-13 and 2026-11-18, with the human's decisions of
2026-11-21 taken while it was built; written by builder s6.

Amends [ADR 0008](0008-payments-stripe-gocardless.md): it says how
"Stripe for cards" is done. Within
[ADR 0025](0025-gifts-are-every-payment-attempt.md) (a Stripe payment is
one gift for its whole life; `stripe_payments` is the table its decision
3 names) and [ADR 0024](0024-rust-sqlite-per-org.md). Uses
[ADR 0007](0007-domain-invariants.md)'s declaration chain and
[ADR 0015](0015-validation-tiers.md)'s tiers.

## Context

A small group wants to take one-off card gifts on a page of its own and
claim Gift Aid on them. keep-together mustn't hold anyone's money, and a
group must be able to leave with its Stripe account.

Stripe Checkout takes the card, but it can't take a Gift Aid
declaration: it has no optional tick box, three custom fields, and warns
against personal data in them. A billing address isn't always the
donor's home, and Stripe doesn't promise a full one.

Stripe's facts are in the plan (b2), read from its pages on 2026-11-13
and 2026-11-18. Nothing here has run against Stripe yet: what the first
sandbox run must confirm is listed in docs/ops.md "To verify on the
first real run".

## Decision

1. **Each group has its own Stripe account, connected through Stripe
   Connect, and donors pay it directly (direct charges).** The payment,
   the customer and the balance are on the group's account. The group
   has Stripe's full Dashboard, pays Stripe's fees itself, refunds from
   its Dashboard, and Stripe carries the loss risk (what "Standard"
   meant). The platform never holds funds and takes no fee.
2. **Stripe-hosted onboarding only.** "Connect Stripe" makes a new
   account for the group and sends its admin to Stripe's form. There is
   no OAuth, so an account a group already has can't be connected.
   Disconnecting forgets the routing on our side and calls nothing at
   Stripe; connecting again is the same account.
3. **No secret per group.** Every call is the platform's restricted key
   plus the group's account id. So which account is which group's, and
   every webhook event, live in `platform.db`; the org files hold only
   the group's own records.
4. **The account is made through Accounts v2 and read through v1.** v2
   is what Stripe recommends and may be the only create open to a new
   platform; `GET /v1/accounts/{id}` and v1 `account.updated` are what
   Stripe documents for following an account's onboarding. The choice
   is one constant (`api::stripe::client::ACCOUNTS_API`), with v1's
   create implemented beside it.
5. **One webhook endpoint for every group**, registered as a connected
   accounts endpoint: signature checked, each event stored once by id,
   routed by its account, run one organisation at a time. An event is
   good for ids only: what it names is read from Stripe as it is now,
   since Stripe promises no order. A daily catch-up reads the events
   webhooks missed.
   - Events for an account whose group has disconnected are **kept 30
     days, then deleted** (human, 2026-11-21): as long as Stripe keeps
     events, so nothing replayable is lost and the store is bounded.
6. **The donor's page is ours; Stripe's is only for the card.** Amount,
   name, email and, if ticked, the declaration and home address are
   taken on `/give/<group>` and stored before the donor reaches Stripe.
   Only the email, the amount, the group's name and the submission's id
   go to Stripe.
7. **A donor's submission is the evidence, and nothing else.** It is
   create-only: what the donor typed, the wording version the page
   showed, when. It makes no contact, gift or declaration. Those are
   made only when Stripe says the payment succeeded, in one transaction
   (never optimistic: the thank-you page writes nothing).
   - An unpaid submission's personal fields are cleared after 30 days;
     the row stays. A paid one's never are.
   - The server pins the declaration's scope (`futureAndPast4y`) and
     accepts only the wording version it currently shows, so a
     submission can't record agreement to words the donor didn't see.
8. **No idempotency key on creating the Checkout Session.** Stripe
   answers a key's first result again, failures included, and the
   session's expiry moves with each try, so a stable key would turn one
   failure into a permanent one. Instead a submission has one session:
   requests for a submission take turns, a repeat after a session exists
   is `409 duplicate`, and the page starts a new attempt. A create whose
   answer was lost leaves a session nobody has the address of; it
   expires unpaid.
9. **The donor is matched by email and last name.** Exactly one live
   contact has the email, and the last name is equal ignoring case,
   accents, spacing and punctuation: linked. No contact has the email: a
   new contact. Anything else waits in the staff queue with no gift. A
   different first name still links, and the gift is marked for staff
   (a couple sharing an address). The page's answer is the same in every
   case, so it never shows whether a donor is known.
10. **The declaration is made by the donor on screen**
    (`method = onScreenByDonor`), in the transaction that makes the
    gift, dated the day the donor sent the page, in the name they typed.
    Only `giftaid::make_donor_declaration` can record that method; every
    staff payload is refused it.
    - **A new declaration is always kept** (human, 2026-11-21), even
      when an older one already covers the gift: the donor made it, and
      the older one may be weaker or later cancelled.
    - A declaration Gift Aid's own rules refuse (the contact isn't a
      person) doesn't stop the gift: the match records why, for staff.
11. **"We claim Gift Aid" (`claimsGiftAid`, on by default) stops the
    offering and never the record.** Off, the donation page shows no
    declaration and the server refuses a ticked submission; the staff
    app stops offering new declarations and claims. What is on record
    stays visible, a claim that exists can be finished, and a
    declaration can be cancelled. The server's Gift Aid rules don't
    change.
12. **A payment that isn't a donation is set aside with a reason, never
    deleted.** Only a payment taken some other way on the group's
    account (`no_submission`) can be; it leaves the queue, makes no
    gift, and can be put back or matched after all. A payment that came
    through the page is always somebody's gift.
13. **Refunds and disputes follow the payment.** Refunded in full:
    `refunded`. In part: `completed` at what the group kept; a gift
    already in a Gift Aid claim keeps its claimed amount and is flagged.
    Disputed: `charged_back`, and `completed` again if the group wins.

## Consequences

- A group that already has a Stripe account gets a second one.
- Monthly giving and Bacs through Stripe, a platform fee, our own
  receipt, a marketing tick (it needs the consent log, rule 2), refunds
  from inside keep-together, and per-link source codes are not built.
- Moving a matched gift to another contact isn't built: a gift's donor
  can't change and a payment keeps its gift for life. It awaits a
  decision.
- A wrong match puts an enduring declaration on someone else's record.
  Matching on last name only was the human's choice (round 2); the
  first-name mark and the queue are the guard.
- Environments: `KEEP_STRIPE=off|fake|test|live`. The fake is a mock on
  the server for tests, dev and local QC; staging and keep-qc each have
  a Stripe sandbox; `live` only on prod, which is deferred.
- QC can't complete Stripe's onboarding form, so keep-qc holds one
  connected account onboarded by hand (`KEEP_QC_STRIPE_ACCOUNT`) that
  the run's group is given through `/api/qc/stripe/connect`.
