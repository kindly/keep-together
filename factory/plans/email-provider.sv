<sv-page label="plan: email provider" category="archive">

<sv-prose id="b1">
# Email provider: Mailgun EU, Brevo or AWS SES London

*Planner `planner-email`, 2026-10-18. ADR 0021 chose SES London. This page re-opens that choice: Mailgun EU (the controller's ask), plus Brevo and SMS (your ask). Every fact below was read from vendor pages today; the full notes with URLs are in `factory/out/planner-email-{ses,mailgun,brevo-sms}-research.md`.*

**Decided (rounds 1–2): SES London in three accounts (`keep-prod` marketing, `keep-mail-tx` transactional, `keep-dev` sandbox), with the transport behind a small adapter so Mailgun EU stays a drop-in fallback.**

- **Cost.** At 170k emails a month SES is about **$17** (à la carte) and Mailgun about **$167**. Brevo is about **£197**. Mailgun's floor is **$35/month**, because two sending subdomains (`auth.`, `mail.`) already need the Foundation plan.
- **Isolating each group comes built in.** SES Tenants gives every group its own reputation metrics, auto-pause and complaint suppression list for about $1/month for 200 groups. Mailgun has the same only through subaccounts, which are contract plans. Brevo has it only on Enterprise. On both of them, all groups would share one reputation.
- **Residency.** On SES, message data stays in London, and the UK addendum (IDTA) applies automatically. Mailgun keeps message data in Germany and Belgium. Its API keys, domain names and account data are replicated globally, and US staff run support. That is still legal under UK GDPR, but it is a weaker story to tell a charity.
- **Mailgun's real advantage is less plumbing.** Webhooks are signed with HMAC, batch sends take 1,000 recipients, and there are no AWS accounts or IAM to run. Most of that gap closes on SES: EventBridge can POST events straight to our HTTP route with an API-key header, so we skip SNS certificate checks.
- **Brevo is out.** Its webhooks are not signed, it blocks API calls from IPs it hasn't seen once 30 days have passed (Convex's outbound IPs are not ours to control), it won't let us set standard headers, and it puts every group in one account below Enterprise.
- **SMS.** It is not part of E1/E2. `comms.send` should take a channel so SMS fits later. The consent log is already per channel.
</sv-prose>

<sv-prose id="b2">
## Design tree

- **Settled before this page (ADR 0020/0021, not reopened):** one entry point `comms.send(kind, …)`, with transactional mail isolated from marketing. Mail goes from a platform sending domain by default (`auth.` / `mail.`), with the group's name as the From name and the group's address as Reply-To; groups' own domains come later. ~~A bounce sets the email's `onHold`.~~ *[superseded 2026-10-19: see "Amendment (2026-10-19)" in the design tree]* A hard bounce suppresses the address in comms. A marketing complaint becomes a consent-withdrawal event (rule 2) and never blocks transactional mail (rule 5).
- **Domain rules that apply:** 2 (consent log is the truth, so complaints and unsubscribes become events), 5 (centralised suppression, transactional never blocked by marketing), 6 (tenancy is structural, so per-group isolation can't be a filter someone remembers), and 3 ~~(anonymising a contact must also scrub provider-side copies: suppression lists, logs)~~ *[superseded 2026-10-19]* (anonymising a contact blanks its address in logs such as `emailEvents`, but keeps suppressions, ours and SES's, because they are what stops the mail).
- **AWS layout (settled in chat, 2026-10-18; applies if SES stays):**
  - **Platform domain** `keep-together.org.uk`, registered in Route 53 and hosted there, so every DNS record is scripted.
  - **Accounts:** the existing account is the Organization's management account. IAM Identity Center is already enabled in **eu-west-2**, with an AdministratorAccess permission set, so root is no longer used.
    - Member accounts `keep-prod` (SES out of the sandbox, the domain, EventBridge) and `keep-dev` (SES left **in the sandbox for good**: dev and rehearsal can only reach addresses we verified) sit in a `keep` organisational unit.
    - An SCP on that unit denies everything outside eu-west-2, except global services such as IAM, Route 53 and Route 53 Domains, starting from AWS's region-deny example.
  - **Keys:** Convex holds a long-lived IAM key, stored as a platform env var (not in `tenantSettings`). `keep-sender` may call `ses:SendEmail` only, from `auth.` and `mail.` only, through `keep-*` configuration sets, API v2 only, plus `GetAccount`. `keep-provisioner` may only create and associate SES tenants. Humans sign in through Identity Center, never with long-lived keys.
  - **Scripted:** everything after Identity Center goes in a committed `scripts/aws-ses-setup.sh`: accounts, domain, SES identities, DNS, configuration sets, EventBridge API destination, IAM users and keys.
- **Round 1 (settled, all as recommended):**
  - **Provider: AWS SES London.** ADR 0021 stands, so there is no amendment to draft.
  - **Transport adapter:** `comms/transport/ses.ts` (`send`, `parseEvent`) is the only code that names the provider. Mailgun EU stays a fallback that would be one new file.
  - **Lists and unsubscribe are ours.** The consent log is the source of truth, and we serve our own one-click List-Unsubscribe endpoint. SES suppresses only hard bounces, plus complaints scoped per group.
  - **SMS later**, in the comms plan. `comms.send(kind, channel, …)` takes the channel now, email only. The provider is chosen then.
- **Round 2 (settled, all as recommended):**
  - **Events:** a configuration set sends to EventBridge, whose API destination POSTs to `convex/http.ts` with an API-key header. No SNS.
  - **Transactional isolation:** a third account, **`keep-mail-tx`**, sends `auth.` mail only, so a marketing incident can never pause sign-in links. `bootstrap.sh` now creates it.
  - **Complaints are scoped per group** (SES Tenants suppression scope `TENANT`). Hard bounces stay global.
  - **Pricing:** à la carte ($0.10 per 1,000). Virtual Deliverability Manager only if needed. Shared IPs; managed dedicated IPs later.
  - **Bulk:** one `SendEmail` per recipient through a throttled Workpool queue, so the From-address IAM condition applies to every call.
  - **SES tenants** are created by Convex in `platform/tenants:create` with the `keep-provisioner` key.
- **Round 3 (settled, all as recommended; the plan is confirmed for building):**
  - E2 covers transactional mail and event ingestion only. Marketing, consent events from complaints, and SES tenant provisioning go to the comms plan.
  - `emailEvents` is an append-only log outside contracts. Anonymising a contact blanks its address there.
  - ~~`onHold` is written through a new system contract, `contacts.deliverability` (counter `deliverabilityVersion`).~~ *[superseded 2026-10-19: see "Amendment (2026-10-19)" in the design tree]*
  - `keep-dev` sends from `auth.dev.` / `mail.dev.` in the sandbox, with events going to one chosen dev deployment.
- **Amendment (2026-10-19, after the E2a review; decided by the human):** a hold on the email row was lost whenever the row was re-created (a restore, remove + re-add, the same address under a new key) and never covered another contact using the address. So:
  - **Suppression is per address, in comms** (rule 5): table `emailSuppressions`, one row per (tenant, normalised address), never deleted, written only through the contract `comms.suppression` (counter `saveVersion`), so every change has a revision: who, when, why (reason, provider event ref, an admin's note).
  - **Only a hard bounce suppresses** (reason `bounce`). A complaint never blocks transactional mail; E2 keeps it in `emailEvents`, and the comms plan turns it into a consent event.
  - **Writers:** `comms/suppressions:suppress` (internal, role-null callers only: the SES webhook's ingest); a public function must never call or schedule it. An **admin-only `release`** (with a note) lifts it and schedules `releaseAtProvider`, which removes the address from SES's account-level suppression list (E2b implements it). Because that SES list is account-wide while our rows are per tenant, after a release any tenant without its own row can send to the address again; a dead address costs each such tenant one bounce before it holds there. Accepted rather than writing across tenants.
  - **The contact email row has no `onHold`.** The contact page reads the flag at query time from `comms/suppressions:held` (addresses as args, off a save's critical path); `comms.send` checks `isSuppressed`.
  - **Erasure keeps suppression rows**, ours and SES's: they hold only the address and why, and removing them would let mail go out again.
  - Built as E2a-1 (table, contract, functions; `onHold` loosened and backfilled into suppressions) and E2a-2 (`onHold` removed). `contacts.deliverability` and `deliverabilityVersion` are not built.
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
- **E1:** write `scripts/aws-ses-setup.sh` (see the AWS layout in the design tree) and run it against `keep-dev`. Send with `aws4fetch` from a default-runtime action. Deliver events through an EventBridge API destination with an API-key header to `convex/http.ts` (SNS only if that fails). Create one SES tenant and prove its complaint suppression scope. Poll `GetAccount` for an account-level pause. Decide whether transactional mail gets its own AWS account or a configuration set with BOUNCE-only suppression.
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

<sv-ask id="g2q1" round="2">
**How bounce and complaint events reach Convex.**
- * EventBridge API destination: POSTs SES events to an HTTP route in `convex/http.ts` with an API-key header (stored in Secrets Manager, compared in constant time on our side). Retries for 24h, about $0.20 per million events, no certificate parsing.
- SNS HTTPS subscription: we verify SNS's RSA-SHA256 signature ourselves, which means fetching and parsing an X.509 certificate in the default runtime, plus a confirm-subscription handshake.
</sv-ask>

<sv-ask id="g2q2" round="2">
**Keeping transactional mail separate from marketing.** SES enforces bounce and complaint thresholds **per account** (review at 5% bounces or 0.1% complaints, possible pause at 10% or 0.5%), and a pause stops sign-in links too. SES Tenants pauses one bad group first, but every group's traffic still counts toward the account.
- * a third account, `keep-mail-tx`, for `auth.` mail only: a marketing incident can never stop sign-in links or receipts. Costs nothing fixed, but needs one more production-access request and one more sender key.
- one account (`keep-prod`) with two configuration sets: transactional suppresses bounces only and has no tenant; marketing goes through Tenants. Simpler, but an account-level pause hits both.
</sv-ask>

<sv-ask id="g2q3" round="2">
**Complaint scope for marketing.** A newsletter complaint should block whom?
- * that group only: SES Tenants suppression scope `TENANT`, and the complaint also becomes a consent-withdrawal event for that group's purpose. Hard bounces stay global (the address is dead for everyone).
- every group on the platform (account-wide suppression list)
</sv-ask>

<sv-ask id="g2q4" round="2">
**SES pricing plan.** New accounts start on "Essentials".
- * switch to à la carte ($0.10 per 1,000) and add Virtual Deliverability Manager only if we need its dashboards
- stay on Essentials ($0.16 per 1,000, VDM included)
</sv-ask>

<sv-ask id="g2q5" round="2">
**Sending IPs.**
- * shared SES IPs for now. Managed dedicated IPs ($15/month plus $0.08 per 1,000, warm-up handled by AWS) only once volume is steady at tens of thousands a month
- managed dedicated IPs from launch
</sv-ask>

<sv-ask id="g2q6" round="2">
**How a newsletter is sent.**
- * one `SendEmail` per recipient, through a Workpool queue throttled under the account's send rate. Each message carries its own List-Unsubscribe link and tenant name, and the IAM rule pinning the From address applies to every call.
- `SendBulkEmail` with an SES template, 50 recipients per call. Fewer calls, but the IAM From-address condition doesn't apply, and templates live in SES rather than with us.
</sv-ask>

<sv-ask id="g2q7" round="2">
**Who creates a group's SES tenant.**
- * Convex, inside the operator's `platform/tenants:create`, using the `keep-provisioner` key (it can only create tenants and attach them to our identities and configuration sets)
- the operator runs a separate script after creating the group, so no provisioning key lives in Convex
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: SES specifics. After this I'll write the E1/E2 steps and tests in full and ask for a final confirmation. Send when done.
</sv-ask>

<sv-prose id="b5">
## Brief

**Goal.** Give keep a working email transport. One entry point, `comms.send(kind, channel, …)`, sends transactional mail (sign-in codes, invitations, receipts) through SES London from `auth.keep-together.org.uk`. Bounces and complaints flow back automatically: a hard bounce ~~puts that address `onHold` for its group~~ *[superseded 2026-10-19]* suppresses that address for its group (`emailSuppressions`), and every provider event is kept. Marketing mail has to be able to run on the same transport later without redesign.

**Out of scope:** sending marketing (it needs the consent log and lists, which come in the comms plan), the newsletter editor, segments, the unsubscribe page, SMS, groups' own domains, the Gmail BCC helper, the Google connector, managed dedicated IPs.

**Domain rules that apply**
- **2.** A complaint becomes a consent-withdrawal event once the consent log exists. Until then the complaint is kept in `emailEvents`, so nothing is lost.
- **3.** Anonymising a contact must also blank its rows in `emailEvents`. Its SES suppression entry stays, and so does its `emailSuppressions` row (2026-10-19), because each holds only an address and removing it would let mail go out again.
- **5.** Transactional mail ignores marketing consent and only refuses ~~`onHold`~~ suppressed addresses (`emailSuppressions`, 2026-10-19). Transactional and marketing mail go through different accounts and configuration sets.
- **6.** The SES event route is platform-level, because the SES accounts are ours rather than the groups'. It resolves the tenant from the message's `tenantId` tag (set by `comms.send`) and then calls an `internalTenantMutation`, so domain code never sees a tenant.
- **7.** No money is involved.

### What's already done
- **E0, by you:** `scripts/aws/bootstrap.sh` (OU `keep` plus the London-only SCP; accounts `keep-prod`, `keep-mail-tx`, `keep-dev`; Identity Center access; `keep-together.org.uk` registered in `keep-prod`). Re-run it once to create `keep-mail-tx`.

### Steps
1. **E1, SES spike and setup script, one session.** ∥ R1, R2.
   - **`scripts/aws/ses-setup.sh`**, idempotent, printing each command like `bootstrap.sh` does:
     - **`keep-mail-tx`:** identity `auth.keep-together.org.uk` (Easy DKIM, MAIL FROM `bounce.auth.…`), configuration set `keep-transactional` (suppression on bounces only), IAM user `keep-sender` (`ses:SendEmail` only from `*@auth.…`, plus `GetAccount`), production-access request (TRANSACTIONAL).
     - **`keep-prod`:** identity `mail.keep-together.org.uk`, configuration set `keep-marketing`, `keep-sender` (only from `*@mail.…`) and `keep-provisioner`, production-access request (MARKETING), and a switch to à la carte.
     - **All accounts:** DMARC `p=none` with reports on the apex. Every DNS record is written to the `keep-prod` zone. An EventBridge rule plus API destination to the Convex site URL `/webhooks/ses` with an API-key connection.
     - **`keep-dev`:** the same setup with `dev.` subdomains, left in the sandbox (round 3, question 4).
   - **Convex side:**
     - a default-runtime action sends one mail with `aws4fetch`, which proves `crypto.subtle` SigV4 works there;
     - `/webhooks/ses` receives SES's simulator bounce and complaint (`bounce@` and `complaint@simulator.amazonses.com`; these work in the sandbox);
     - a poll of `GetAccount` reads the account status.
   - **Report** in `docs/spikes/08-email.md`: what worked, the event payloads (saved as test fixtures), and the per-second send rate each account gets.
   - **Files:** `scripts/aws/ses-setup.sh`, `convex/comms/spike.ts` (deleted after the spike), `convex/http.ts`, `docs/spikes/08-email.md`.
2. **E2a, the ~~`onHold`~~ suppression write path.** ∥ E1. *[superseded 2026-10-19: see "Amendment (2026-10-19)" in the design tree]*
   - ~~A new contract `contacts.deliverability`. Its slice is `onHold` on every email row; its counter is `deliverabilityVersion` on `contacts`. Only the system writes it (internal function, no `expected`, read-modify-write inside the mutation), and it records a revision with source `comms`.~~ As built: `emailSuppressions` + contract `comms.suppression`, internal `suppress`, admin `release` (+ `releaseAtProvider` stub), query `held`.
   - **Schema in two phases:** ~~add `deliverabilityVersion` as optional, deploy, backfill it to 0 (migrations component), then tighten.~~ E2a-1 loosens `contactEmails.onHold` and backfills any stored hold into a suppression; E2a-2 removes the field.
   - **Files:** `convex/contacts/contracts.ts`, `convex/contacts/mutations.ts` (internal), `convex/schema.ts`, `convex/contacts/migrations.ts`.
3. **E2b, `comms.send` and event ingestion.** After E1 and E2a.
   - New `convex/comms/`:
     - `transport/ses.ts`: plain TypeScript, `send` and `parseEvent`, the only file that names SES;
     - `send.ts`: `comms.send(kind, channel, …)`. Transactional mail checks ~~`onHold`~~ `isSuppressed` and goes on the Workpool queue; `kind: 'marketing'` throws `notImplemented` until the comms plan;
     - `events.ts`: `recordEvent` (`internalTenantMutation`). A hard bounce ~~runs `contacts.deliverability` for every row in that tenant with the same `addressNormalized`~~ runs `suppressAddress` for its address in that tenant (2026-10-19); a complaint suppresses nothing; every event appends to `emailEvents`.
   - Install the Workpool component (`convex/convex.config.ts`), throttled under the account's send rate.
   - App env vars for the sender keys and the events API key. These are platform secrets, not `tenantSettings`. Update the comment in `http.ts` to say so.
   - **Schema:** `emailEvents` is a new table, so no loosen/tighten is needed.
4. **E3, provisioning SES tenants.** Moves to the comms plan as its first step, because tenants only matter for marketing. `platform/tenants:create` schedules an action (`keep-provisioner`) that calls `CreateTenant` and associates `mail.` and `keep-marketing`. A backfill covers existing tenants. A cron per tenant polls tenant status and `GetAccount`.
5. **Wiring auth mail:** R4/P1 (in the logins & roles plan) call `comms.send('transactional', 'email', …)` for codes and invitations. That plan already sequences R4 after E2.

### Tests
- **`transport/ses.ts`:** a request signed at a fixed clock and keys matches a known SigV4 signature. `parseEvent` maps the E1 fixtures (bounce Permanent/Transient, complaint, delivery, suppressed) to our event kinds.
- **`/webhooks/ses`:** a missing or wrong key returns 401 and writes nothing. A valid hard bounce ~~sets `onHold` on matching rows~~ suppresses the address **in the tagged tenant only**: the same address in a second tenant stays untouched. A soft bounce is logged but sets no hold. An unknown tenant tag returns 200, is logged and writes nothing.
- **`comms.send`:** transactional mail to a ~~`onHold`~~ suppressed address is refused, and mail to a contact with no marketing consent still sends. `marketing` throws. The transport is stubbed and receives the `tenantId` tag and the transactional configuration set.
- ~~**`contacts.deliverability`:** writes a revision and bumps `deliverabilityVersion`. A later `methods` save keeps `onHold` (existing test).~~ *[superseded 2026-10-19: `comms/suppressions.test.ts` covers the suppression, its survival across contact edits and restores, and admin release]*
- **Every fixture has two tenants.** Spike only, not in CI: a live sandbox run where the simulator bounce arrives at the route end to end.

### ADR 0021 needs updating (yours or the controller's to write; I don't edit ADRs)
- Isolation is decided: a separate `keep-mail-tx` account.
- Events go through EventBridge API destinations, not SNS.
- Pricing is à la carte.
- Complaints are scoped per tenant.
- The account layout is three accounts in an OU locked to eu-west-2.
- Bootstrap and setup scripts live in `scripts/aws/`.
- SMS comes later through the channel argument.
</sv-prose>

<sv-ask id="g3q1" round="3">
**E2 scope.** Marketing needs the consent log, which doesn't exist yet (no `convex/consent/`).
- * E2 is transactional plus event ingestion. `marketing` throws until the comms plan. Complaints are stored and turned into consent events there.
- E2 also builds a minimal consent log, so complaints become consent events straight away
</sv-ask>

<sv-ask id="g3q2" round="3">
**Where provider events live.** An append-only `emailEvents` table (tenantId, kind, addressNormalized, messageId, at, raw subtype): written only by `comms.recordEvent`, never edited, with tenantId-first indexes. Like `revisions`, it is a log rather than an entity, so it sits outside contracts.
- * yes: an append-only log outside contracts, with anonymisation blanking its address
- no: only apply the effects (`onHold`), and keep no event history
</sv-ask>

<sv-ask id="g3q3" round="3">
**How `onHold` gets written.** It's a system-owned field on `contactEmails`, and today only tests patch it.
- * a new system contract `contacts.deliverability` (slice: `onHold` on every email row; counter `deliverabilityVersion`), so every hold has a revision and history shows "bounced on …"
- comms patches `onHold` directly, as a carve-out like the derived projections (no revision)
</sv-ask>

<sv-ask id="g3q4" round="3">
**Dev sending.** `keep-dev` stays in the SES sandbox.
- * its own subdomains `auth.dev.` / `mail.dev.keep-together.org.uk`. Its EventBridge destination points at one chosen dev deployment, and other dev deployments send but get no events.
- dev deployments don't send at all (the transport is a stub logging to the console). Only the spike and production use SES.
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
Round 3: the last structural questions. **Approve with these answers = the plan is confirmed for building**: E1 and E2a can start in parallel. Revise = tell me what's wrong.
</sv-ask>
