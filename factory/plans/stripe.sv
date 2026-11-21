<sv-page label="plan: Stripe" category="plans">

<sv-prose id="b1">
# Plan: Stripe — one-off gifts with Gift Aid

*Planner stp. Confirmed by the human over three rounds (2026-11-13 and 2026-11-18). Ready for building.*

## Design tree

**Settled (from the brief and what is already built)**

- **Each group connects its own Stripe account.** Money goes from donor to group; we never hold funds. The group is the merchant, pays Stripe's fees itself and bears its own refunds and disputes.
- **A Stripe payment is one gift for its whole life** (ADR 0025): `provider = 'stripe'`, `method = 'card'`, made the first time Stripe tells us of the payment and following its status. Only `completed` counts (`giving::RECEIVED`). Never optimistic: the donor's "thank you" screen writes nothing.
- **`stripe_payments` is the raw record** beside its gift, written in the same transaction (ADR 0025 decision 3 names the table). A payment we can't tie to a contact is stored with no gift and listed for staff, as `gocardless/unmatched` does.
- **Webhooks:** one platform endpoint, signature checked, each event stored once by id, routed to its org by Stripe account id, handled by a job one org file at a time. A daily catch-up reads the events webhooks missed (Stripe keeps 30 days).
- **Donor matching:** the submission keeps what the donor typed. It links to a contact only when exactly one live contact has the email and the name agrees. No email match makes a new contact. Anything else goes to the staff queue. The page never shows whether a donor is known.
- **Tests and environments:** a fake Stripe mounted on the server for cargo tests and QC (`KEEP_STRIPE=off|fake|test|live`, as `KEEP_GOCARDLESS`); a Stripe sandbox each for staging and keep-qc. Prod is deferred.

**Follows from Stripe's facts (below)**

- **The Gift Aid declaration is made on our page, before the donor reaches Stripe.** Stripe Checkout has no optional tick box, allows three custom fields, and warns against putting personal data in them. So every Stripe gift starts on a keep-together page that takes amount, name, email and (if ticked) the declaration and home address, then hands the donor to Stripe Checkout for the card. A staff-sent link is the same page with the donor filled in.
- **The home address is asked by us, not taken from the card.** A billing address isn't always the donor's home, and Stripe doesn't promise a full one. Required only when Gift Aid is ticked: house name or number and postcode at least (HMRC 3.6.2).
- **The declaration is a `giftaid.declaration` with `method = onScreenByDonor`**, which the code already names and refuses "until a donor-facing screen exists". It is made only when the payment completes, in the same transaction as the gift, dated the day the donor ticked it, with the wording version the page showed. Coverage and claims need no change.

**Confirmed in round 1** (2026-11-13, all as suggested)

- **Connecting:** Stripe-hosted onboarding only. "Connect Stripe" creates a new Stripe account for the group and sends the admin to Stripe's form. No OAuth, so an account the group already has can't be connected.
  - Disconnecting forgets the routing on our side; the account stays the group's. Events that arrive afterwards are kept and replayed if the same account reconnects, as GoCardless does.
- **Where donors give:** the public page `/give/<group>` in this plan (S4). The staff-sent link is later.
- **Scope:** one-off card gifts only. A sandbox spike on Stripe Bacs (charging a saved mandate on our own schedule, on a connected account) runs alongside; monthly is the next plan.
- **Declaration:** HMRC's enduring wording: this gift, future gifts and the past four years (`futureAndPast4y`).
- **Non-charities:** a "We claim Gift Aid" switch in Settings, on by default. Off, it hides Gift Aid on the donation page and across the staff app (S5). The server keeps its rules.
- **S0:** you don't have a Stripe platform account yet and will create it when the script is ready.

**Confirmed in round 2** (2026-11-18)

- **Amounts:** three buttons and "other amount". Defaults £10, £25, £50, minimum £2, maximum £1,000, and **each group can change them in Settings** (your rider: "that as default but should make it configurable per instance"; I've read "instance" as the group). Whatever a group sets, the server never accepts under £1 or over £1,000 (`giving::rules::ONE_OFF_MAX`).
- **Source code:** one per group, picked in Settings. The page link isn't shown, and the page answers "not taking donations", until it is set. Per-link codes later.
- **Name match: last name only** (your change from my stricter rule). The email matches exactly one live contact and the last name is equal ignoring case, accents, spacing and punctuation → linked. Otherwise the staff queue.
  - The declaration keeps the name the donor typed, whichever contact it lands on.
  - **Same last name, different first name** (round 3): still linked, and the gift is marked "first name differs: Jane" so staff can see it and move it if it's a different person (a couple sharing an email).
- **Unpaid submissions:** kept 30 days, then the personal fields are cleared and the row stays.
- **Refunds:** full refund → `refunded` (a claimed one is paid back by the next claim). Partial refund → the gift stays `completed` at the amount the group kept; one already in a claim keeps its claimed amount and is flagged for staff. Paying back the difference automatically is a follow-up. A dispute → `charged_back`, `completed` again if the group wins.
- **Afterwards:** Stripe's own receipt only. No marketing tick until the consent log exists.

**Confirmed by the human in round 3 (2026-11-18): the plan as this page reads. Ready for building; nothing is open.**
</sv-prose>

<sv-prose id="b2">
## What Stripe says now

Read from Stripe's own pages on 2026-11-13. "Unverified" means Stripe's pages didn't settle it and the builder checks it in the sandbox.

| Topic | Fact |
|---|---|
| Connect flavours | Standard, Express and Custom are labelled legacy. New platforms describe an account by properties instead. Ours: the group has the **full Stripe Dashboard**, **pays Stripe's fees itself**, and **Stripe carries the loss risk**, which is what "Standard" used to mean. |
| Onboarding | Stripe recommends **Stripe-hosted onboarding**: we create the account, the group fills in Stripe's own form. OAuth ("connect your existing Stripe account") still exists but "isn't recommended for new Connect platforms". It is the only way to connect an account the group already has. Unverified: whether a new platform can still switch OAuth on. |
| Charges | **Direct charges**: the payment, the customer and the balance live on the group's account. A platform fee (`application_fee_amount`) can be added to any charge later, with no Stripe charge for it. |
| Cost to us | None. With Stripe billing the groups directly there is no per-account or per-payout Connect fee. |
| Per-group secret | None. We call Stripe with our platform key plus the group's account id. GoCardless needed a sealed token per group; Stripe doesn't. |
| Webhooks | One "connected accounts" endpoint; each event names its account. Signature is HMAC-SHA256 over timestamp and raw body. Live retries run for three days. Order isn't guaranteed. |
| Checkout | `submit_type=donate`, an amount we pass in, expiry 30 minutes to 24 hours. No optional tick box, three custom fields, no personal data in them. |
| Refunds, disputes | The group refunds from its own Stripe Dashboard and we hear by webhook. Stripe keeps its fee on a refund. A card dispute costs the group £20. |
| UK prices | Cards 1.5% + 20p (premium 2.8% + 20p, EEA 2.5% + 20p). Bacs 1%, 20p to £4. Nonprofit discount: exists, unpublished, each group applies to Stripe. |
| Monthly by Bacs | Stripe Billing is 0.7% on top. Saving a mandate and charging it on our own schedule avoids Billing, but Stripe's pages contradict each other on whether Bacs allows it, and none show it on a connected account. Bacs needs Stripe's approval per account, and the donor's bank statement names Stripe unless the group pays £50 a month. |
| Test environments | **Sandboxes** replace test mode: up to five per account, isolated, each with its own keys and webhook endpoints. Test groups are created inside the platform's sandbox. |

**Accounts API v1 or v2.** Stripe recommends v2 for new work, but its v2 examples still send a preview version header. The first task of S1 is to check this in the sandbox: v2 if it runs on a released version, otherwise v1 with the same three properties. Either way the group gets the same account, so this isn't a question for you.
</sv-prose>

<sv-prose id="b3">
## Brief

### Goal

A donor gives a one-off card gift to a group through a keep-together page and Stripe Checkout. The gift appears in the group's records once Stripe says it was paid, linked to the right contact or queued for staff, and carries a donor-made Gift Aid declaration when the donor ticked one, so it flows into the existing claims. A group that isn't a charity can switch Gift Aid off.

**Out of scope:** monthly giving and Bacs through Stripe; a platform fee; importing an existing Stripe account's history; contact merge (ADR 0019, not built); refunding from inside keep-together (the group uses its Stripe Dashboard); embedding the form in the group's own website; anything on prod.

### Contracts and tables

**`platform.db`** (`api::stripe::SCHEMA`, as `api::gocardless::SCHEMA`): `stripe_accounts` (Stripe account id ↔ tenant, onboarding state, connected by and when), `stripe_events` (every webhook event by id, outcome, tries), `stripe_catchup` (cursor per account).

**Org file**, one new schema step (new tables only, so one step; `gifts` already has `provider` and `method = 'card'` and is not rebuilt):

| Contract | Slice | Counter |
|---|---|---|
| `giving.donationSubmission` | what the donor typed, create-only: amount (pence), first and last name, email, Gift Aid ticked, declaration scope and wording version, address line 1 and postcode, source code, when. Never edited: it is the evidence. | `version` |
| `giving.donationSubmissionOutcome` | where it stands: Checkout session id, `started → paid / expired`, the payment it became, personal data cleared on | `outcome_version` |
| `giving.stripePayment` | Stripe's raw record: payment id, amount, currency, status, paid on, refunded amount, dispute state, reason, the submission it came from | `version` |
| `giving.stripePaymentMatch` | whose it is: contact and gift, or unmatched with why (`ambiguous`, `name_differs`); the staff flags: a partial refund on a claimed gift, and the first name the donor typed when it differs from the contact's | `match_version` |
| `giving.donationPage` | the group's page settings, one row: the three amounts, minimum, maximum (all pence), the source code for page gifts | `version` |

Changed: `giftaid.declaration` accepts `onScreenByDonor` only through a new public function `giftaid::make_donor_declaration`, which staff payloads can't reach (the refusal in `rules.rs` stays for every other path). `platform::preferences` gains `claimsGiftAid` (default on, so nothing changes for existing groups). `giving.gift` is unchanged (v2 already carries the provider fields).

The command that turns a paid submission into records spans `contacts`, `giving` and `giftaid`, so it lives in `api::stripe::process`, one transaction under one command group `stripe.donation`: the payment row, the contact (found or created), the gift, the declaration, the match, the submission's outcome.

### Steps

| Step | What | Files | Runs |
|---|---|---|---|
| **S0** | **You:** a Stripe account for the platform with Connect switched on; two sandboxes (staging, keep-qc); in each, a restricted API key and a connected-accounts webhook endpoint pointing at that environment. I write `scripts/fly/stripe-secrets.sh staging\|qc\|prod`, which reads the key and the webhook secret from the terminal without echo and gives them to Fly on stdin, as `gocardless-secrets.sh` does. | `scripts/fly/`, `docs/ops.md` | first; the script can be written at once |
| **S1** | Connect and plumbing: `KEEP_STRIPE` modes, the client (version pinned, idempotency keys), create account and hosted onboarding link, connection status from `account.updated`, disconnect, the webhook endpoint with signature check, event store and routing, the fake Stripe. Routes `GET stripe`, `POST stripe/connect`, `POST stripe/disconnect`, `POST /api/stripe/webhook`. | `server/crates/api/src/stripe/{mod,client,connect,webhook,fake}.rs`, `api/tests/stripe_*.rs` | parallel with S2 |
| **S2** | Org schema step and its fixture; the five `giving` contracts; `make_donor_declaration`; the `claimsGiftAid` preference; the matching rule as a pure function. | `server/crates/giving/src/stripe.rs`, `giftaid/src/{rules,declarations}.rs`, `platform/src/preferences.rs`, `api/src/schema.rs`, `api/tests/schema.rs` | parallel with S1 |
| **S3** | Processing: paid session → payment, match, contact, gift, declaration; failed and expired; refund and dispute follow-on; the unmatched list and staff match; daily catch-up; `keep giving-consistency` covers Stripe. | `api/src/stripe/{process,catchup}.rs`, `api/src/routes/`, `cli` | after S1 and S2 |
| **S4** | The donor's page: its own Vite entry with none of the app's bundle (as `scan.html`), public routes `GET /api/give/{slug}` (group name, whether Gift Aid is offered) and `POST /api/give/{slug}/donations` (stores the submission, makes the Checkout session, answers its URL), the return page, rate limits per address and per group. | `give.html`, `src/give/`, `api/src/routes/give.rs`, `vite.config.ts` | after S2, parallel with S3 (on the fake) |
| **S5** | Staff screens: Settings "Connect Stripe" with the page's link to copy, and the page's amounts and source code; "Card payments to match"; a Stripe gift on the contact; the Gift Aid switch and what it hides. | `src/routes/`, `src/lib/data/`, `src/lib/domain/` | after S3, parallel with S4 |
| **S6** | QC flows on the fake; a nightly spec against the keep-qc sandbox (as `gocardless-sandbox-qc`); `server/README.md` "Stripe"; the ADR. | `qc/`, `scripts/qc-nightly/`, `docs/` | last |

A reviewer after each step. **ADR to propose** (the S6 builder writes it): "Stripe Connect with direct charges; a donor's submission is the evidence; declarations made by the donor on screen", amending 0008.

### Tests

- **Isolation, every route:** under two orgs, B never sees A's submissions, payments or queue; A's ids under B's slug are 404. The public routes too: a submission to A's page writes nothing in B's file, and an event for A's Stripe account never runs against B.
- **Webhook:** bad, missing or stale signature refused; a repeated event id is a no-op; events out of order end in the same state; an event for an unknown account is stored and not run.
- **Never optimistic:** a submission alone makes no gift; an unpaid or expired session makes none; only `paid` makes a `completed` gift; the schema test on gifts reads still passes.
- **One gift per payment:** paid, then refunded, then disputed, are one gift changing status; `(provider, provider_payment_id)` unique; `keep giving-consistency` passes and fails when a row is tampered with.
- **Matching:** one contact with that email and the same last name (case, accents, spacing and punctuation ignored) → linked, whatever the first name, and marked with the typed first name when it differs; no contact with that email → new contact; two contacts, a different last name, or a truncated lookup → unmatched; the public answer is byte-identical in every case.
- **Page settings:** an amount under the group's minimum or over its maximum is `422`; a group can't set a minimum under £1 or a maximum over £1,000; no source code set → the page takes no donations.
- **Refunds:** full → `refunded`; partial → `completed` at the kept amount; partial on a claimed gift → amount unchanged and flagged; dispute lost → `charged_back`, won → `completed`.
- **Retention:** an unpaid submission's personal fields are cleared after 30 days by a job; a paid one's never are.
- **Gift Aid:** ticked → an `onScreenByDonor` declaration dated the submission day, covering the gift, claimable in the preview; not ticked → none; `onScreenByDonor` in a staff payload still refused; with `claimsGiftAid` off the page offers no tick and the server refuses a ticked submission.
- **Money:** amounts are integer pence end to end; a non-GBP payment is logged and never recorded; no `REAL` column.
- **Erasure-safe:** clearing an unpaid submission's personal data leaves its row; nothing cascades from a contact.

### Domain rules

- **1** (declaration is a dated chain): the page adds a declaration to the chain; it never sets a flag. A second gift under an enduring declaration adds nothing.
- **2** (consent log): the page asks for no marketing consent in this plan, because the consent module isn't built. Round 2 decides whether to wait for it.
- **3** (anonymise, don't delete): submissions and payments keep their rows; only an unpaid submission's personal fields are cleared.
- **4** (the reclaim is a financial record): unchanged; Stripe gifts enter claims through the same lines and lock.
- **5** (suppression in `comms`): any receipt we send is transactional and goes through `comms`.
- **6** (no tenants in domain code): routing by Stripe account id and by page slug lives in `api` and `platform.db`; the `giving` contracts see one file.
- **7** (integer pence): Stripe's amounts are already minor units; stored as `INTEGER`.
</sv-prose>

<sv-prose id="b4">
## Round 1
</sv-prose>

<sv-ask id="s1q1" round="1">
**How a group connects.** Stripe's recommended way: the admin clicks "Connect Stripe", we create a Stripe account for the group, and Stripe's own form takes their details and bank account. They get a normal Stripe login and Dashboard and can leave us at any time. The catch is that a group that already has a Stripe account gets a second one. OAuth would let them connect the one they have, but Stripe steers new platforms away from it and may not let us switch it on.
- * Stripe-hosted onboarding only (a new account per group)
- Hosted onboarding now; add "connect an existing account" later if a group asks and Stripe allows it
- OAuth first, like GoCardless
</sv-ask>

<sv-ask id="s1q2" round="1">
**Where a donor gives first.** Gift Aid has to be asked on our own page (Stripe Checkout can't hold the declaration), so a donor-facing page is needed either way. The public version adds little on top: an address anyone can open (`/give/<group>`), rate limits, and the matching rule, which the brief already settled. The staff-sent version is the same page opened from a contact with the donor already known.
- * Public page in this plan (step S4); the staff-sent link later
- Both in this plan
- Staff-sent link first; public page as a later plan
</sv-ask>

<sv-ask id="s1q3" round="1">
**One-off only, or monthly too.** Monthly by Bacs through Stripe has three unknowns: whether we can charge a saved mandate on our own schedule (Stripe's pages disagree), whether it works on a connected account, and the approval each group needs from Stripe. Regular-gift terms (ADR 0026) already exist to schedule from, so it is a plan of its own once a sandbox spike answers those.
- * One-off card gifts only here; a sandbox spike on Stripe Bacs runs alongside, and monthly is the next plan
- One-off only; no spike yet
- Monthly in this plan too
</sv-ask>

<sv-ask id="s1q4" round="1">
**Which declaration the page offers.** HMRC's model wording comes in two forms: this donation only, or this donation plus future ones and the past four years. The staff forms default to the second. On a public page it claims the most, and a donor who gives again is already covered. Its risk is that a declaration linked to the wrong person covers that person's other gifts; the matching rule (one contact, same email, same name) is what guards against that.
- * This gift, future gifts and the past four years (HMRC's enduring wording)
- This gift only
- The donor picks between the two
</sv-ask>

<sv-ask id="s1q5" round="1">
**Groups that aren't charities.** The page must not offer Gift Aid for them, so a switch is needed now: Settings, "We claim Gift Aid", on by default. Off, the donation page shows no Gift Aid step. Hiding Gift Aid in the staff app as well (the tick on the gift form, declarations on the contact, the claims pages) is mostly conditionals in the screens; the server keeps its rules.
- * The switch in this plan, hiding Gift Aid on the page and across the staff app (S5)
- The switch for the donation page only; the staff app later
- Leave it out; a separate plan
</sv-ask>

<sv-ask id="s1q6" round="1">
**Step S0 is yours.** It needs a Stripe account that acts as the platform (keep-together's, not a group's), with Connect switched on and two sandboxes. Sandboxes need no business verification as far as Stripe's pages say; going live later will.
- * I don't have one yet; I'll create it when the script is ready
- I have a Stripe account to use for this
</sv-ask>

<sv-ask id="s1fin" round="1" role="close">
Round 1: how groups connect, where donors give, scope, the declaration, the Gift Aid switch, your Stripe account. Send when done.
</sv-ask>

<sv-prose id="b5">
## Round 2

The details of the page and of what happens after a payment. Each is small; together they are everything the builders would otherwise have to guess.
</sv-prose>

<sv-ask id="s2q1" round="2">
**Amounts on the page.** Three buttons and an "other amount" box. Stripe's 20p fixed fee takes 10% of a £2 gift, and the app already caps a staff-taken one-off at £1,000 ("ask for a bank transfer").
- * £10, £25, £50 and other; minimum £2, maximum £1,000; the same for every group for now
- The same defaults, but each group can set its own three amounts in Settings
- Other amount only, no buttons
</sv-ask>

<sv-ask id="s2q2" round="2">
**Source code for page gifts.** Every gift needs one. The admin picks the page's code in Settings, and the page link isn't shown until they have. A link that carries its own code (one per appeal or leaflet) can come later without changing anything stored.
- * One code per group, picked in Settings; per-link codes later
- Per-link codes now (`/give/<group>?code=…`), with the Settings code as the fallback
</sv-ask>

<sv-ask id="s2q3" round="2">
**When "the name agrees".** The email already matches exactly one contact. A wrong link puts a gift, and an enduring declaration, on someone else's record; a missed link only costs staff a click in the queue.
- * First and last name both equal, ignoring case, accents, spacing and punctuation; anything else goes to the queue
- Last name equal and first name equal or the same initial (Jo / Joanna)
- Last name only
</sv-ask>

<sv-ask id="s2q4" round="2">
**Submissions never paid for.** A donor who fills in the form and leaves at Stripe's card page has given us a name, an email and maybe an address, with no gift. The Checkout session lasts 30 minutes.
- * Keep 30 days (long enough to investigate a "I paid but it's not showing"), then clear the personal fields and keep the row
- Clear after 7 days
- Keep them: staff can see who nearly gave
</sv-ask>

<sv-ask id="s2q5" round="2">
**Refunds.** The group refunds from its Stripe Dashboard. A full refund makes the gift `refunded`: it stops counting, and a claimed one is paid back by the next claim, as a chargeback is today. A partial refund has no precedent here. A dispute follows GoCardless's chargeback: `charged_back`, and `completed` again if the group wins.
- * Partial refund: the gift stays `completed` at the amount the group kept. If it is already in a claim it keeps its claimed amount and is flagged for staff; paying back the difference automatically is a follow-up
- Partial refund: never change the gift; flag it for staff to sort out by hand
- Partial refund: treat as a full refund plus a note
</sv-ask>

<sv-ask id="s2q6" round="2" pick="many">
**What the donor gets afterwards.** Stripe can email its own receipt from the group's account, at no cost and with nothing for us to build. HMRC needs no written confirmation of a declaration made on screen. A marketing opt-in belongs in the consent log (rule 2), which isn't built.
- * Stripe's receipt only; our own thank-you email later
- * No marketing opt-in on the page until the consent log exists
- Our own thank-you email now, through `comms`, quoting the declaration
- A marketing tick now, kept on the submission and fed to the consent log when it exists
</sv-ask>

<sv-ask id="s2fin" round="2" role="close">
Round 2: the page's details and what follows a payment. Send when done.
</sv-ask>

<sv-prose id="b6">
## Round 3: confirmation

Round 2 is folded into the design tree and the brief above. One thing follows from matching on last name only that you should see before confirming: a couple who share an email address. Jane Smith gives and ticks Gift Aid; the only contact with that email is John Smith. The gift and Jane's enduring declaration go on John's record, and John's later gifts are then covered by a declaration Jane made. The declaration itself still says "Jane", as typed.
</sv-prose>

<sv-ask id="s3q1" round="3">
**Same last name, different first name.**
- * Link as you chose, and mark the gift "first name differs: Jane" so staff can see it and move it if it's a different person
- Link with no mark
- Send that case to the staff queue instead (last name only still applies when the first name is missing or an initial)
</sv-ask>

<sv-ask id="s3fin" round="3" role="close">
Final round. Approving confirms the plan as the page now reads (design tree, brief, steps S0 to S6) and hands it to the controller for building.
</sv-ask>

</sv-page>
