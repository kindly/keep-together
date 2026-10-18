<sv-page label="plan: email provider" category="plans">

<sv-prose id="b1">
# Email provider: Mailgun EU, Brevo or AWS SES London

*Planner `planner-email`, 2026-10-18. ADR 0021 chose SES London. This page re-opens that choice: Mailgun EU (the controller's ask), plus Brevo and SMS (your ask). Every fact below was read from vendor pages today; the full notes with URLs are in `factory/out/planner-email-{ses,mailgun,brevo-sms}-research.md`.*

**Recommendation: keep SES London, and put the transport behind a small adapter so Mailgun EU stays a drop-in fallback.**

- **Cost.** At 170k emails a month SES is about **$17** (à la carte) and Mailgun about **$167**. Brevo is about **£197**. Mailgun's floor is **$35/month**, because two sending subdomains (`auth.`, `mail.`) already need the Foundation plan.
- **Isolating each group comes built in.** SES Tenants gives every group its own reputation metrics, auto-pause and complaint suppression list for about $1/month for 200 groups. Mailgun has the same only through subaccounts, which are contract plans. Brevo has it only on Enterprise. On both of them, all groups would share one reputation.
- **Residency.** On SES, message data stays in London, and the UK addendum (IDTA) applies automatically. Mailgun keeps message data in Germany and Belgium. Its API keys, domain names and account data are replicated globally, and US staff run support. That is still legal under UK GDPR, but it is a weaker story to tell a charity.
- **Mailgun's real advantage is less plumbing.** Webhooks are signed with HMAC, batch sends take 1,000 recipients, and there are no AWS accounts or IAM to run. Most of that gap closes on SES: EventBridge can POST events straight to our HTTP route with an API-key header, so we skip SNS certificate checks.
- **Brevo is out.** Its webhooks are not signed, it blocks API calls from IPs it hasn't seen once 30 days have passed (Convex's outbound IPs are not ours to control), it won't let us set standard headers, and it puts every group in one account below Enterprise.
- **SMS.** It is not part of E1/E2. `comms.send` should take a channel so SMS fits later. The consent log is already per channel.
</sv-prose>

<sv-prose id="b2">
## Design tree

- **Settled before this page (ADR 0020/0021, not reopened):** one entry point `comms.send(kind, …)`, with transactional mail isolated from marketing. Mail goes from a platform sending domain by default (`auth.` / `mail.`), with the group's name as the From name and the group's address as Reply-To; groups' own domains come later. A bounce sets the email's `onHold`. A marketing complaint becomes a consent-withdrawal event (rule 2) and never blocks transactional mail (rule 5).
- **Domain rules that apply:** 2 (consent log is the truth, so complaints and unsubscribes become events), 5 (centralised suppression, transactional never blocked by marketing), 6 (tenancy is structural, so per-group isolation can't be a filter someone remembers), and 3 (anonymising a contact must also scrub provider-side copies: suppression lists, logs).
- **AWS layout (settled in chat, 2026-10-18; applies if SES stays):**
  - **Platform domain** `keep-together.org.uk`, registered in Route 53 and hosted there, so every DNS record is scripted.
  - **Accounts:** the existing account is the Organization's management account. IAM Identity Center is already enabled in **eu-west-2**, with an AdministratorAccess permission set, so root is no longer used.
    - Member accounts `kt-prod` (SES out of the sandbox, the domain, EventBridge) and `kt-dev` (SES left **in the sandbox for good**: dev and rehearsal can only reach addresses we verified) sit in a `keep-together` organisational unit.
    - An SCP on that unit denies everything outside eu-west-2, except global services such as IAM, Route 53 and Route 53 Domains, starting from AWS's region-deny example.
  - **Keys:** Convex holds a long-lived IAM key, stored as a platform env var (not in `tenantSettings`). `kt-sender` may call `ses:SendEmail` only, from `auth.` and `mail.` only, through `kt-*` configuration sets, API v2 only, plus `GetAccount`. `kt-provisioner` may only create and associate SES tenants. Humans sign in through Identity Center, never with long-lived keys.
  - **Scripted:** everything after Identity Center goes in a committed `scripts/aws-ses-setup.sh`: accounts, domain, SES identities, DNS, configuration sets, EventBridge API destination, IAM users and keys.
- **Round 1 (open):** provider · adapter · whose lists · SMS.
- **Round 2 (after the provider is settled):** event route · complaint scope · pricing plan · how transactional mail is isolated.
</sv-prose>

<sv-prose id="b3">
## Comparison

| | **AWS SES, London** | **Mailgun EU** | **Brevo** |
|---|---|---|---|
| **Where data lives** | eu-west-2. Suppression list, identities and templates stay in region. AWS lists SES among the services where moving data between regions is "essential", and no page says how long message content is kept. | Germany and Belgium (Google Cloud): messages, logs, suppressions and lists. **Replicated globally:** account, billing, API keys, domain names. Support and ops staff are in the US. | France, Germany and Belgium (OVH, Google Cloud). Some sub-processors in the US and India (including AI vendors). |
| **DPA** | AWS service terms. The UK addendum (IDTA) applies automatically. | Sinch DPA v8 (Oct 2025): SCCs plus the UK Addendum. No data-residency promise. | In the terms of service. SCCs and DPF. I found no UK addendum. |
| **2k / 20k / 170k per month** | $0.20 / $2 / **$17** à la carte ($0.10 per 1k). New accounts default to "Essentials" at $0.16 per 1k (VDM included) and can switch. | **$35** / $35 / **≈$167** (Foundation for 2k and 20k, Scale for 170k). Basic ($15) allows only 1 domain. 250k and above is quote-only. | Free (300 a day) / £24–47 / **£197** (Standard). Credit packs that never expire. 20% off for non-profits. |
| **Per-group isolation** | **SES Tenants**: $0.005 per tenant per month plus $0.005 per 1k. Per-tenant reputation, auto-pause and suppression scope. 10k tenants by default. | Per-domain suppressions and stats. Subaccounts are contract plans only. No auto-pause. | Enterprise sub-accounts only (custom price). |
| **IPs** | Shared by default. Managed dedicated IP: $15/month plus $0.08 per 1k, warms up automatically. | Shared by default. Dedicated IP $59/month. | Shared. Dedicated IP £194/year, Professional plan and up. |
| **Bounce/complaint feedback** | Configuration set → **EventBridge API destination** (Basic or API-key header to our route, retried for 24h) or SNS (RSA signature with an X.509 certificate). An account-level pause sends **no event**, so we would poll `GetAccount`. | Account- or domain-level webhooks, **HMAC-SHA256** over timestamp+token, retried for about 8h. | **Unsigned.** Bearer token, basic auth or IP allowlist. Can batch 500 events per POST. |
| **Suppression vs rule 5** | One list per account: by default a marketing complaint **blocks transactional mail too**. Fixed by suppression scoped per configuration set or per tenant. | Per domain: an `*` unsubscribe on a domain blocks *all* mail from it. Separate subdomains fix that. On a shared `mail.` domain, an opt-out from one group blocks every group. | Per channel. A marketing unsubscribe does not block transactional mail. |
| **Bulk** | `SendBulkEmail`: 50 recipients per call, templated. List management: 1 contact list and 20 topics per account (no good for multi-tenant). | Batch: 1,000 recipients per call with `recipient-variables`. Mailing lists. Adds one-click List-Unsubscribe automatically. Scheduled delivery. | Batch: 1,000 versions per call. Adds its own List-Unsubscribe header; we can't set standard headers. |
| **From a Convex action** | SigV4 via `aws4fetch` (2.5 kB, uses fetch and SubtleCrypto). `crypto.subtle` already runs in our default runtime (`convex/giftaid/irmark.ts`). E1 confirms. | `fetch` with FormData and Basic auth. Domain-scoped sending keys. | `fetch` with an `api-key` header. **Blocks API calls from unknown IPs after 30 days** unless that setting is turned off. Management API limited to 100 requests/hour. |
| **Domain verification** | `CreateEmailIdentity` returns the Easy DKIM tokens (2048-bit). Custom MAIL FROM is MX+SPF. Fully scriptable. 10k identities. | `POST /v4/domains` returns the records. Automatic Sender Security uses 2 CNAMEs and rotates keys every 120 days. Fully scriptable. | `POST /v3/senders/domains` returns the records. Scriptable. |
| **Setup friction** | AWS account, region, IAM keys, then a production-access request (first reply within 96h). The sandbox allows 200 a day to verified addresses only. | Signup with a card. Without one, only 5 authorised recipients. Business verification may be required, with no stated SLA. | Account must be approved before sending. Brevo can suspend an account after campaign sampling. |
| **Lock-in** | Low if lists, consent and templates are ours | Low, same | Medium: it wants to own lists and campaigns |
| **Reliability, 2026** | (not checked) | Two EU sending outages (27 Aug ~38 min, 4 Sep ~17 min) and several EU delays | (not checked) |

**SMS (UK, one segment):** Brevo ≈£0.036 · Textlocal charity rate 2.8p (third-party source) · AWS End User Messaging $0.05 (London; events go through SNS or CloudWatch; sender ID registration) · Twilio $0.056 (HMAC-signed webhooks) · FireText 5p (UK data centres). Every UK provider requires sender ID registration. Marketing SMS needs an opt-out in every message, and the charity soft opt-in (in force since 5 Feb 2026) can't be used on contact details collected before that date.
</sv-prose>

</sv-page>

<sv-prose id="b4">
## What E1 and E2 look like under each answer

**Either way**
- **Lists, consent and unsubscribe stay ours.** The consent log is the source of truth (rule 2). We serve our own one-click `List-Unsubscribe` endpoint (RFC 8058), and the provider is only a pipe. Provider-side suppression is for hard bounces only (they are about the address, not the group). Complaints are scoped per group.
- **`comms.send(kind, channel, …)`** calls a `transport` adapter (`send`, `parseEvent`). The adapter is the only code that names a provider, so switching provider is one new file plus DNS.

**If SES stays (ADR 0021 as written)**
- **E1:** write `scripts/aws-ses-setup.sh` (see the AWS layout in the design tree) and run it against `kt-dev`. Send with `aws4fetch` from a default-runtime action. Deliver events through an EventBridge API destination with an API-key header to `convex/http.ts` (SNS only if that fails). Create one SES tenant and prove its complaint suppression scope. Poll `GetAccount` for an account-level pause. Decide whether transactional mail gets its own AWS account or a configuration set with BOUNCE-only suppression.
- **E2:** as planned, plus a cron (one job per tenant) that syncs tenant status into `tenantSettings`.

**If Mailgun EU wins**
- **E1:** create an EU account on Foundation ($35). Add the domains `auth.<platform>` and `mail.<platform>` via `POST /v4/domains` with Automatic Sender Security. Send with `fetch` plus FormData. Verify an HMAC-signed `permanent_fail`/`complained` webhook on an HTTP route, with a replay check on the token. Prove an unsubscribe on `mail.` doesn't block `auth.`.
- **E2:** per-group isolation is ours to build. Either give each group its own `<slug>.mail.<platform>` subdomain (≤1,000 domains on Foundation, records created by our script), or use tag-scoped suppressions. Auto-pause is our own cron over webhook rates. The SES Tenants note in "Carried to the comms plan" is dropped. Batch sends use `recipient-variables` (1,000 per call) instead of a Workpool fan-out of single sends.
- **ADR 0021** gets an amendment (draft into `factory/out/`), not a new ADR.
</sv-prose>

<sv-ask id="g1q1" round="1">
**Provider.** Which one runs `comms.send`'s email transport?
- * AWS SES London: UK data, ~$17/month at 170k, per-group isolation via Tenants; we build the event plumbing (ADR 0021 stands)
- Mailgun EU: EU data (keys and account replicated globally), $35–167/month, simpler signed webhooks and batch sending; per-group isolation is ours to build
- Brevo: EU data, unsigned webhooks, IP lock-out risk, one shared account below Enterprise
</sv-ask>

<sv-ask id="g1q2" round="1">
**Provider adapter.** Keep the provider behind a `transport` interface so a switch costs one file?
- * yes: `comms/transport/<provider>.ts` with `send` and `parseEvent`; only it names the provider
- no: call the provider directly from `comms.send`; YAGNI
</sv-ask>

<sv-ask id="g1q3" round="1">
**Lists and unsubscribe.** Whose are they?
- * ours: the consent log is the truth, we serve our own one-click List-Unsubscribe endpoint, the provider only suppresses hard bounces (plus complaints scoped per group)
- the provider's list and unsubscribe features, synced back to the consent log by webhook
</sv-ask>

<sv-ask id="g1q4" round="1">
**SMS.** Where does it come in?
- * later, in the comms plan: E2's `comms.send` takes a `channel` argument now (email only), so SMS slots in; the provider is chosen then
- now: add an SMS transport to E1/E2 (sign-in codes and DD notices by text)
- not planned
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: provider, adapter, lists, SMS. The provider-specific details (event route, complaint scope, SES pricing plan, transactional isolation) come in round 2 once the provider is settled. Send when done.
</sv-ask>
