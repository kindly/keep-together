<sv-page label="plan: GoCardless" category="plans">

<sv-prose id="b1">
## Design tree

*Confirmed by the human in round 1 (2026-10-28), all as suggested: partner OAuth; staff send a hosted link (public sign-up page later); import existing GoCardless accounts on connect (D4). Ready for building after cutover.*

- **Each group connects its own GoCardless account** through GoCardless's partner OAuth ("Connect with GoCardless"). Money goes straight from donors to the group. We never hold funds, and a platform fee can be added later through the partner app.
  - We store each group's access token as an org secret (`platform::settings`, encrypted), plus the GoCardless organisation id in platform storage so webhooks can find the org.
  - Disconnecting revokes the token. Regular gifts already set up stay, marked "not connected".
- **Regular gift** (new, in `giving`): contact, amount (pence), monthly or yearly, day of month, status (`pending → active → cancelled/failed`), and the GoCardless mandate and subscription ids.
- **Signing a donor up:** staff open the contact, choose "Set up Direct Debit" and enter the amount and day. We create a GoCardless **Billing Request** and give staff its hosted link to copy or email. The donor completes the mandate on GoCardless's own page, which carries the Direct Debit Guarantee and their bank details. We never see the donor's bank details.
- **Payments become gifts only on GoCardless's word** (never optimistic): a webhook with a payment `confirmed` records a gift (`method = 'direct_debit'`, the payment id as reference). Gift Aid treats it like any gift. A `failed` payment shows on the regular gift and creates no gift. A `charged_back` payment voids its gift, with the reason.
- **Webhooks:** one platform endpoint with the signature checked against the partner webhook secret. Each event is routed to its org by GoCardless organisation id, stored by event id (so each is handled once), and handled by a job (`api::jobs`), one org file at a time.
- **Mandate cancelled or expired:** the regular gift ends, and the contact page shows it.
- **Groups that already use GoCardless** (round 1, q3): on connect, import existing customers, mandates and subscriptions as regular gifts. Each is matched to a contact by email, or listed for staff to match by hand.
- **Tests and dev:** a fake GoCardless (local mock server) for cargo tests and QC; the GoCardless **sandbox** for staging. No real money anywhere before prod.
</sv-prose>

<sv-prose id="b2">
## Steps

| Step | What |
|---|---|
| **D0** | **You:** a GoCardless sandbox account, and a partner app registered in the sandbox (OAuth client id and secret, webhook secret). I write a script that stores them on Fly without showing them. |
| **D1** | Connect and disconnect (OAuth); the webhook endpoint, signature check, event store and routing; the fake GoCardless. |
| **D2** | Regular gifts: schema, contracts, Billing Request and hosted link, subscription on mandate, payments → gifts, failure, chargeback and cancellation; routes with isolation tests; QC flows on the fake. |
| **D3** | The UI: settings "Connect GoCardless"; on the contact, "Set up Direct Debit", the regular-gift card and the payment history. |
| **D4** | Import of an existing GoCardless account (if q3 says yes). |

One builder for D1 and D2, a second for D3, and a reviewer after each. Stripe comes after, on the same pattern (Stripe Connect).
</sv-prose>

<sv-ask id="d1q1" round="1">
**How a group connects.** Partner OAuth is one click for them, and lets us add a platform fee later, but needs a GoCardless partner app (a sign-up step for you). Pasting an API token needs nothing from GoCardless, but is fiddly for a small group.
- * Partner OAuth
- Paste an API token
</sv-ask>

<sv-ask id="d1q2" round="1">
**Donor sign-up for now.**
- * Staff send a hosted link from the contact; a public sign-up page later
- A public sign-up page as well, now
</sv-ask>

<sv-ask id="d1q3" round="1">
**Groups already on GoCardless.**
- * Import their existing mandates and subscriptions on connect (D4)
- Not now: new sign-ups only
</sv-ask>

<sv-ask id="d1fin" round="1" role="close">
</sv-ask>

<sv-prose id="b3">
## Round 2: one gifts table, one-off payments, catch-up

*Raised by the human 2026-10-28 after D1+D2 merged (b0eb535). **Confirmed** round 2 (unified table yes; staff one-offs both ways; upgrades designed now on their own page, `factory/plans/regular-gift-terms.sv`) and round 3 (no cash table; a paying-in batch table with banking reconciliation). Builder: step 2a (unified gifts, record every payment, catch-up, one-off api).*

- **`gifts` becomes the unified table of every payment attempt**, CiviCRM-style: status `pending → completed`, or `failed`, `cancelled`, `refunded`, `charged_back`, plus `void` (a staff mistake); `provider` (`gocardless`, later `stripe`; empty for cash/cheque), `provider_payment_id`, and `regular_gift_id` (empty for a one-off). Gift Aid, income and reports read **only** `gifts`, and count only `completed`.
- **Provider tables stay** as the raw record of what the provider said: `direct_debit_payments` now, `stripe_payments` later. A provider row and its gift row are written by the same processing step in one transaction; provider-sourced fields on a gift can't be edited by staff.
- **Consistency:** a named test and a `keep` check fail if a provider payment doesn't have exactly one gift with matching amount, date and status.
- **Never optimistic:** one shared "money received" filter (`status = 'completed'`); a schema test fails on a gifts read that skips it; named tests prove pending, failed and charged-back gifts never count as income or as claimable.
- **One-off payments:** every GoCardless payment is recorded, including one-offs on a known mandate (a single gift, not a regular-gift instalment) and unmatched ones (listed for staff to match to a contact). Staff can take a one-off from a contact: charge the existing mandate once, or send an Instant Bank Pay link (same fee as Direct Debit; the group switches it on in GoCardless).
- **Nightly catch-up:** for each connected group, read GoCardless's events since the last run and queue any we haven't seen; report how many (non-zero means webhooks are being missed).
- **Order:** the gifts change first (schema step 18, ADR), then one-off payments and catch-up, then the D3 screens on top.
</sv-prose>

<sv-ask id="d2q1" round="2">
**Unified table.** Provider tables stay as the raw record; `gifts` holds every attempt with its status, and Gift Aid works off `gifts`.
- * Yes, as described
- Keep `gifts` to received money only (as now)
</sv-ask>

<sv-ask id="d2q2" round="2">
**Staff-started one-off payments.**
- * Both: charge the existing mandate once, and an Instant Bank Pay link
- Charge the existing mandate only
- Not now: just record one-offs made elsewhere
</sv-ask>

<sv-ask id="d2q3" round="2">
**Upgrades and splits on regular gifts** (ADR 0022 decision 9, source-codes g1q11, not yet designed). A regular gift keeps a dated history of its terms: amount plus a split by source code from an effective date. An upgrade adds a row (e.g. £10 Street + £2 Telephone from 1 Dec) and changes the GoCardless subscription amount; each payment's gift copies the split in force on its charge date. The same rows later generate expected payments (expected vs actual, from CARE).
- * Design it now, as part of this round (a design page with you first, then built after the unified table)
- Later: keep one code and a fixed amount for now
</sv-ask>

<sv-ask id="d2fin" round="2" role="close">
</sv-ask>

<sv-prose id="b4">
## Round 3: cash in its own table?

*Round 2 (2026-10-29): unified table yes; one-off payments both ways; upgrades designed now on their own page. Rider on d2q1: "Should cash be own table for consistency".*

**My view: no table for cash now, but yes when there's something to record about it.** A provider table holds what an outside system told us, which we have to mirror and check against (GoCardless's ids, statuses and reasons). For cash typed in by staff, the staff entry *is* the source, and it's already in `gifts` (who entered it, when, how). A `cash_gifts` table would only repeat the gift row, and keeping two copies in step would add risk for nothing.

The real cash-side record is the **paying-in batch**: the bag of cash and cheques banked together, with its paying-in slip number, bank date and total, which must match its gifts. That's its own table when banking reconciliation is built, and it plays the same role as a provider table: the outside record (the bank statement line) that gifts are checked against.

So every gift has one origin: `provider` set (GoCardless, Stripe) with its provider row, or entered by hand (later, in a paying-in batch).
</sv-prose>

<sv-ask id="d3q1" round="3">
**Cash.**
- * No cash table now; a paying-in batch table when banking reconciliation is built
- A cash table now, mirroring hand-entered gifts like the provider tables
</sv-ask>

<sv-ask id="d3fin" round="3" role="close">
</sv-ask>

</sv-page>
