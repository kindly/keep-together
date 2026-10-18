# 0021 — Email: AWS SES London, transactional isolated from marketing

Status: accepted (2026-10-18; proposed 2026-10-17) · from the logins & roles plan
(`factory/plans/auth-roles.sv`, confirmed in grill round 3). Transport
details are confirmed by spike E1 (`docs/spikes/08-email.md`). **Amended
2026-10-18 after the email provider plan (`factory/plans/email-provider.sv`)**:
see "Amendment" at the end. Text it supersedes is marked *[superseded]*.

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
*(Re-confirmed by the amendment after comparing Mailgun EU and Brevo. New
accounts now default to the "Essentials" plan, so we switch them to à la
carte.)*
- Pay per email: no plan fee, no per-contact pricing.
- Use **SES Tenants** ($0.005 per tenant per month + $0.005 per 1,000) to
  track reputation per group, and to auto-pause one group's marketing
  when its bounce or complaint rate climbs.

**2. Isolate transactional mail from marketing.** Sign-in links and
receipts must keep flowing even if a newsletter goes wrong. Transactional
mail uses a separate sending account ~~(or configuration set, if E1 shows
Tenants plus configuration sets isolate enough)~~ *[superseded: always a
separate account, `keep-mail-tx`; see Amendment]* and its own subdomain.

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

~~Bounce and complaint notifications arrive through SNS on an HTTP route in
`convex/http.ts`.~~ *[superseded: they arrive through an EventBridge API
destination; see Amendment]*

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
  throttling, ~~the SNS webhook with signature verification~~ *[superseded:
  an HTTP route checking an EventBridge API-key header]*, and per-tenant
  auto-pause *(moved to the comms plan with E3)*.
- **No Convex email component.**
- **Deliverability setup:** SPF, DKIM and DMARC on the platform domain
  before launch. SES production access must be requested; new accounts
  start sandboxed.
- **DPA:** AWS (London) is listed as a sub-processor.
- **The comms plan inherits** the "Carried to the comms plan" notes on the
  plan page: personal From names, the Gmail/Outlook BCC helper, the
  optional Google-account connector, and SES Tenants.

## Amendment (2026-10-18, email provider plan)

The human asked for Mailgun EU (and then Brevo) to be weighed against SES
before E1/E2 started. A comparison using vendor pages read on 2026-10-18
(notes with URLs in `factory/out/planner-email-{ses,mailgun,brevo-sms}-research.md`,
summarised on the plan page) re-confirmed **SES London**. At 170k emails a
month it costs about $17, against about $167 for Mailgun EU and about £197
for Brevo. Per-group isolation comes built in through SES Tenants. Message
data stays in the UK. Mailgun EU stays the fallback. Brevo was rejected:
its webhooks are unsigned, it blocks API calls from IPs it doesn't
recognise, and below Enterprise every group shares one account.

The plan settled the following. It adds to or replaces the Decision and
Consequences above:

- **Provider adapter.** `comms.send(kind, channel, …)` calls
  `convex/comms/transport/ses.ts` (`send`, `parseEvent`). That is the only
  code that names the provider, so switching provider means one new file
  plus DNS.
- **Three AWS accounts in one OU locked to London.** Accounts `keep-prod`,
  `keep-mail-tx` and `keep-dev` sit in the Organization's OU `keep`. An SCP
  denies every region except eu-west-2; global services such as IAM,
  Route 53 and billing are exempt. People sign in through IAM Identity
  Center (in eu-west-2). `scripts/aws/bootstrap.sh` creates all of this.
  - **`keep-mail-tx`** sends `auth.` mail only, through configuration set
    `keep-transactional`, which suppresses on bounces only. SES enforces its
    review and pause thresholds per account, so a marketing incident can
    never pause sign-in links or receipts. This replaces the
    "configuration set" alternative in Decision 2.
  - **`keep-prod`** holds the domain `keep-together.org.uk` (registered and
    hosted in Route 53) and sends `mail.` marketing through
    `keep-marketing`.
  - **`keep-dev`** stays in the SES sandbox for good and sends from
    `auth.dev.` / `mail.dev.keep-together.org.uk`. Its events go to one
    chosen dev deployment; other dev deployments can send but receive no
    events. A dev deployment can only ever reach addresses we have
    verified.
- **Restricted keys.** Convex holds long-lived IAM keys as platform env vars
  (the SES accounts are ours, not the groups', so `tenantSettings` doesn't
  apply).
  - Each account's **`keep-sender`** may call only `ses:SendEmail`, from its
    own subdomain, through `keep-*` configuration sets, on API v2, plus
    `GetAccount`.
  - **`keep-provisioner`** may only create SES tenants and associate them
    with our identities and configuration sets.
  - Mail goes one `SendEmail` per recipient through a throttled Workpool
    queue, never `SendBulkEmail`, so the From-address condition applies to
    every call.
- **Events through EventBridge, not SNS.** Each configuration set sends to
  EventBridge. An API destination POSTs the events to `/webhooks/ses` in
  `convex/http.ts` with an API-key header. AWS retries for 24 hours, and we
  don't have to parse X.509 certificates. The route is platform-level: it
  resolves the tenant from the message's `tenantId` tag and calls an
  `internalTenantMutation`.
- **Pricing:** à la carte at $0.10 per 1,000, with Virtual Deliverability
  Manager only if needed. Shared IPs for now; managed dedicated IPs once
  volume is steady.
- **Complaints are scoped per tenant.** Marketing uses SES Tenants
  suppression scope `TENANT`, so a complaint about one group's newsletter
  doesn't block other groups. Hard bounces stay global. Lists, consent and
  unsubscribe stay ours: we serve our own one-click List-Unsubscribe
  endpoint, and SES list management is not used.
- **`emailEvents` is an append-only log outside contracts.** It is
  tenant-scoped with tenantId-first indexes, written only by
  `comms.recordEvent`, and never edited, like `revisions`. Anonymising a
  contact blanks its address there. A contact's SES suppression entry is
  kept, because removing it would let mail go out again.
- **`onHold` is written through a system contract,
  `contacts.deliverability`.** Its slice is `onHold` on every email row and
  its counter is `deliverabilityVersion` on `contacts`. Only the system
  writes it, and every hold gets a revision. A hard bounce holds every row
  with that normalised address in the tagged tenant.
- **Scope of E2:** transactional mail and event ingestion only.
  `comms.send('marketing', …)` throws until the comms plan. Complaints are
  stored in `emailEvents` and become consent-withdrawal events once the
  consent log exists (rule 2).
- **E3 moves to the comms plan.** That covers provisioning SES tenants
  (`platform/tenants:create` schedules a `CreateTenant` with the
  provisioner key, plus a backfill for existing tenants) and polling
  tenant and account status. Tenants only matter for marketing.
- **SMS comes later.** `comms.send` takes a `channel` argument now (email
  only). The comms plan will choose the SMS provider; the consent log is
  already per channel.
