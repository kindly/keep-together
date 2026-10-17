# 0021 — Email: AWS SES London, transactional isolated from marketing

Status: **proposed** (2026-10-17) · from the logins & roles plan
(`factory/plans/auth-roles.sv`, confirmed in grill round 3). Transport
details are confirmed by spike E1 (`docs/spikes/08-email.md`).

## Context

Convex has no email of its own. We need mail for two jobs:

- **transactional:** sign-in links, invitations, verification and reset
  codes, receipts, Direct Debit notices;
- **bulk:** newsletters and appeals, because comms will grow into a small
  Mailchimp alternative.

Bounces and complaints must feed back automatically. A bounce sets the
email row's `onHold`, and suppression is centralised in comms (rule 5).

The margin is pennies per group, so cost at newsletter volume matters.

Options compared (list prices read 2026-10-17; scenario: 200 groups ×
~400 contacts × 2 mailings a month ≈ 170k emails):

| Provider | Data | ~170k/mo | Notes |
|---|---|---|---|
| **AWS SES, eu-west-2 London** | UK | **~$17** ($0.10 per 1,000) + ~$2 Tenants | no Convex component; we build the queue and webhooks |
| Resend | US (account data, logs) | $160 via API; $450 marketing per contact | official `@convex-dev/resend` component |
| Postmark | US | ~$225 | strong transactional reputation; broadcast streams |
| Mailgun EU | EU (Germany/Belgium) | ~$167 | managed EU option |
| Brevo | EU (France) | not verified | managed EU runner-up for transactional + marketing |

Sources:
- pricing pages: [SES](https://aws.amazon.com/ses/pricing/),
  [Resend](https://resend.com/pricing),
  [Postmark](https://postmarkapp.com/pricing),
  [Mailgun](https://www.mailgun.com/pricing/);
- regions: [SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html),
  [Resend regions](https://resend.com/docs/dashboard/domains/regions);
- the full table: `factory/out/auth-roles-email-providers.csv`.

The one UK-headquartered sending API found (Sendamatic) shuts down on
1 October 2026.

## Decision

**1. Use AWS SES in London (eu-west-2), on the à la carte option.**
- Pay per email: no plan fee, no per-contact pricing.
- Use **SES Tenants** ($0.005 per tenant per month + $0.005 per 1,000) to
  track reputation per group, and to auto-pause one group's marketing
  when its bounce or complaint rate climbs.

**2. Isolate transactional mail from marketing.** Sign-in links and
receipts must keep flowing even if a newsletter goes wrong. Transactional
mail uses a separate sending account (or configuration set, if E1 shows
Tenants plus configuration sets isolate enough) and its own subdomain.

**3. Use one entry point, `comms.send(kind, …)`.** Every message goes
through it, auth mail included: Convex Auth's or Better Auth's verification
sender calls it.
- **`transactional`** ignores marketing consent and still refuses an
  `onHold` (hard-bounced) address.
- **`marketing`** requires consent for the purpose, skips `onHold`, and
  adds List-Unsubscribe headers.
- **A bounce** sets `onHold` on the email row.
- **A spam complaint on marketing mail** becomes a consent-withdrawal
  event for that purpose (source `complaint`, rule 2). It never blocks
  transactional mail.

Bounce and complaint notifications arrive through SNS on an HTTP route in
`convex/http.ts`.

**4. Send from a platform domain by default.**
- **Domain:** a dedicated domain for the service (name to be chosen;
  builds use a placeholder), with `mail.` for marketing and `auth.` for
  transactional.
- **From:** the group's (or person's) name as From name, e.g.
  `Jane Smith (Ashby Village Hall) <ashby@mail.…>`, with Reply-To set to
  the group's or person's own address. That needs zero setup and stays
  DMARC-safe.
- **Custom domains, later:** a group's own verified domain is an optional
  upgrade. Its DKIM records live in our SES account, so no per-tenant
  secret is needed. `tenantSettings` holds a provider secret only if a
  group brings its own sender (e.g. a Google account connector, a later
  comms plan).

## Alternatives rejected

- **Resend:** the fastest to build, but data is stored in the US and
  marketing is priced per contact. It is the fallback if E1 shows SES too
  costly to integrate.
- **Postmark:** US data, and roughly 13× the cost at volume.
- **Mailgun EU / Brevo:** managed EU options, kept as runners-up if we
  decide not to own bounce handling and throttling.
- **A group's Gmail/Workspace as the newsletter engine:**
  - Workspace caps at 3,000 external recipients a day and 100 per
    message over SMTP;
  - bounces get no webhooks and there are no unsubscribe headers;
  - it risks the group's own mailbox.

  It survives only as an optional personal-scale sender in the comms plan.

## Consequences

- **We own the code:** a sender action (SES v2 API; E1 decides between
  default-runtime fetch + SigV4 and a Node action), a Workpool queue with
  throttling, the SNS webhook with signature verification, and per-tenant
  auto-pause.
- **No Convex email component.**
- **Deliverability setup:** SPF, DKIM and DMARC on the platform domain
  before launch. SES production access must be requested; new accounts
  start sandboxed.
- **DPA:** AWS (London) is listed as a sub-processor.
- **The comms plan inherits** the "Carried to the comms plan" notes on the
  plan page: personal From names, the Gmail/Outlook BCC helper, the
  optional Google-account connector, and SES Tenants.
