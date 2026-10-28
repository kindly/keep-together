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

</sv-page>
