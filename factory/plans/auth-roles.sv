<sv-page label="plan: logins & roles" category="archive">

<sv-prose id="b1">
## Design tree

*Confirmed by the human in round 3 (2026-10-17). All rounds were approved as recommended, plus the threads on platform admin, 2FA and email. Ready for building.*

- Logins and roles
  - **No in-app platform admin.** The operator creates tenants and invites the first admin from the CLI (`platform/tenants:create`, internal). Support access = the Convex dashboard (team with 2FA, in the DPA)
  - **Tenant roles: admin, staff, viewer**
    - **admin-only:** invite/remove/re-role users; tenant settings, payment and email connections; bulk export; erasure
    - **staff too:** merging contacts, sending bulk email
    - always at least one admin
    - **viewer reads everything staff can read** (contacts, giving, Gift Aid, reports): no writes, no exports
  - **Auth library: Better Auth**, gated by spike A0 (fallback: Convex Auth + our own emailed-code 2FA)
  - **Staff accounts: invite-only.** OAuth is accepted only if its verified email matches an invitation or an existing staff user
    - **sign-in: email + password with 2FA, or Google**
    - **2FA required for every staff password account**; each person chooses authenticator app or emailed code; admins can reset a member's 2FA
      - **sole admin loses 2FA → the operator resets it from the CLI** after confirming identity out of band; the reset is logged
    - **sessions: staff 7 days, with re-auth (password/2FA) for admin actions if the last sign-in is over 1 hour old; supporters 1 hour**
    - sign-in errors are ConvexError kinds, with equal timing and uniform replies (R4 note)
  - **Supporter logins: built now (P1)**; DD self-service follows the giving/GoCardless plan
    - **email link → confirm page, 15-minute expiry**
    - **a supporter sign-in only ever gives a supporter-scoped session** (separated by sign-in method; the spike must prove it)
    - **a supporter may edit address, phones, communication preferences and their sign-in email** (confirm new, notify old); **name is staff-only**
    - **edits apply directly** through the normal contracts (source `portal`); staff see them in history and in a "changed by supporters" dashboard list
  - **Email: AWS SES, London region**
    - **transactional isolated from marketing** (separate account/stream), plus per-tenant marketing auto-pause (SES Tenants)
    - **sender: platform domain**, group name as From name, group (or person) address as Reply-To; a group's own domain later
      - **a dedicated domain for the service**, with `mail.` (marketing) and `auth.` (transactional) subdomains; the name is to be chosen (build against a placeholder until then)
    - **the Mailchimp alternative is a separate comms plan**; see "Carried to the comms plan"
</sv-prose>

<sv-prose id="b2">
## Goal

Three kinds of people sign in, and today the code knows only one:

1. **The operator** (you) runs the service and creates tenants from the CLI only. Today `platform/tenants.create` lets any signed-in user make a group from `/`, and that stops. There is no in-app platform admin role.
2. **Tenant users** (staff and volunteers) work inside one group with a role. Tenant admins invite, remove and re-role them.
3. **Supporters** (donors) sign in without a password, by an emailed link. Each one is bound to one contact in one tenant, so they can give and manage their Direct Debit.

All three need email, and Convex has none built in. So this plan also picks the **email provider**, and per your note it must handle **bulk sending** too: the small Mailchimp alternative in comms will run on it.

**Out of scope:** the Direct Debit self-service screens (they need the giving/GoCardless mandate model); the newsletter builder, lists and segments (a comms plan); 2FA/passkeys; SSO.

### Where we are today (checked in code)

- `convex/auth.ts`: Convex Auth with `Password` only, open sign-up, no email verification and no reset (nothing can send email).
- `memberships.role` is `'owner' | 'staff'`, but **nothing reads it**. `requireMember` (`convex/lib/tenancy.ts`) only checks that a membership exists, so every member can do everything.
- `platform/tenants.create` is a public mutation: any authenticated user becomes `owner` of a new tenant.
- Convex Auth is **beta** ([labs.convex.dev/auth](https://labs.convex.dev/auth)), v0.0.96 installed.
</sv-prose>

<sv-prose id="b3">
## What Convex Auth can and can't do here (checked in current docs)

- **Magic links and OTP** both come from the `Email` provider ([email docs](https://labs.convex.dev/auth/config/email), [OTP docs](https://labs.convex.dev/auth/config/otps)). Its default token lifetime is 1 hour (`maxAge` in `providers/Email.js`); the OTP example uses 15 minutes and 8 digits. Verification checks that the email matches the one the token was sent to, and failed attempts are rate-limited automatically.
- **The docs warn that a magic link signs you in on click** (session fixation / phishing), and they recommend exactly the interstitial we discussed: put the token in the link, show a page with a button, and call `signIn` with `code` + `email` from it. That also defeats link scanners that would otherwise burn the token.
- **Account linking is the trap.** Email-based providers are "trusted": a magic-link sign-in **links to an existing user with the same verified email** ([advanced docs](https://labs.convex.dev/auth/advanced)). Unchanged, a donor link sent to a staff member's address would sign them in **as the staff user, without the password**. The fix is a custom `createOrUpdateUser` callback. "When you provide this callback, the library doesn't create or update users at all", so we decide the linking: a supporter sign-in only ever finds or creates a `kind: 'supporter'` user, and a password sign-in only a `kind: 'staff'` user.
- **One deployment, two kinds of account: yes, safely**, on three conditions:
  1. the custom `createOrUpdateUser` above;
  2. `users.kind`, with `requireMember` rejecting non-staff users;
  3. a separate supporter constructor that never reads `memberships`.

  Accounts are per provider (`authAccounts`), so the same email can be a staff user *and* a supporter user without colliding.
</sv-prose>

<sv-prose id="b3a">
## Auth library: Better Auth proposed (from the g1q6 thread)

Convex Auth (beta) has no second factor. Better Auth (`@convex-dev/better-auth` 0.12.5) lists **Two Factor, Magic Link and Email OTP** as supported in the Convex component ([supported plugins](https://labs.convex.dev/better-auth/supported-plugins)), has a Vite SPA guide, and keeps auth data in our own EU Convex deployment, so there is no new sub-processor. Hosted platforms were checked and set aside: WorkOS and Clerk (US data), Auth0 (EU/UK region, heaviest), Kinde (UK region, unofficial integration). There is no UK-headquartered option with a Convex integration.

**What changes if Better Auth is chosen:**
- Better Auth has one user per email. Staff/supporter separation moves from "two user documents" (the Convex Auth design in the block above) to **the session's sign-in method**: staff functions accept only password+2FA or Google sessions, and link/code sessions reach only supporter functions.
- `createOrUpdateUser` becomes Better Auth hooks plus account-linking config.
- builder-autherr's Password error wrapper is redone against Better Auth's error codes.
- Passkeys and Better Auth's organization plugin aren't in the component's supported list. Our own memberships/invitations stay either way.

**Spike A0 (one session, gates R4 and P1):** in a throwaway branch, prove all four or fail:
1. Better Auth runs in our Vite SPA with Convex;
2. Two Factor (TOTP + emailed code) works;
3. Magic Link with a confirm page works;
4. a session records its sign-in method, and a guard can refuse a magic-link session on a staff function.

Report to `docs/spikes/09-better-auth.md`. If it fails, we stay on Convex Auth and build an emailed-code second factor ourselves.
</sv-prose>

<sv-prose id="b4">
## Proposed shape

**Creating tenants (no platform admin role).** `platform/tenants.create` becomes an **internal** mutation run by the operator: `npx convex run platform/tenants:create '{"slug","name","adminEmail"}'`. It creates the tenant, seeds reference data, and creates an invitation for the first admin. No public function can create a tenant, and there is no platform role in the app. *Access to tenant data outside the app:* the Convex dashboard gives every Convex team member full access regardless of app roles. That is operator access, governed operationally: the team is named operators with 2FA, stated in the processor DPA.

**Tenant roles** (memberships): `admin`, `staff`, `viewer`.

| Can… | admin | staff | viewer |
|---|---|---|---|
| read contacts, giving, reports | ✓ | ✓ | ✓ |
| edit contacts, record gifts, tag, notes, merge | ✓ | ✓ | |
| send bulk email | ✓ | ✓ | |
| invite / remove / re-role users | ✓ | | |
| tenant settings, payment + email connections | ✓ | | |
| bulk export, erasure (anonymise) | ✓ | | |

The rule lives in the constructors, not in handlers (the same idea as rule 6). `tenantQuery` defaults to `viewer`, `tenantMutation` to `staff`, and admin-only functions declare `{ minRole: 'admin' }`. The membership is already loaded in `requireMember`, so this costs nothing extra. Invariant: **a tenant always has at least one admin** (the last admin can't be removed or demoted). The treasurer handover from the product brief is "invite new admin → they accept → old admin steps down".

**Staff accounts.** Invite-only: `createOrUpdateUser` refuses a password sign-up unless a pending invitation (or platform bootstrap) exists for that email. Password plus **email verification by code** (`Password({ verify })`) plus **password reset by code** (`Password({ reset })`): accepting an invitation proves you control the invited address. Removing a member takes effect on the next call, since membership is re-checked every time.

**Supporter logins.** A `supporter` provider (custom `Email`, link + confirm page, 15-minute token). `users.kind = 'supporter'`, and a platform table `supporterLinks {tenantId, userId, contactId, emailKey}` binds a supporter to a contact through the email row (as recorded on the contact-model page). A new `supporterQuery` / `supporterMutation` pair checks the link and hands the handler a **supporter db**: row rules that let it see only rows whose `contactId` is in the contact's identity set (ADR 0019), and nothing else. Self-signup, auto-match and the shared-address refusal are as recorded under "Carried to the portal plan" on the contact-model page.

**Email** (see the comparison below). One `comms.send(kind, …)` entry point. Everything goes through it, including Convex Auth's `sendVerificationRequest`, so suppression stays centralised (rule 5):
- **transactional** (sign-in links, invites, receipts, DD notices): ignores marketing consent, still refuses an address that is `onHold` (hard-bounced);
- **marketing**: requires consent for the purpose, skips `onHold`, adds unsubscribe headers.

Bounces set `onHold` on the email row. A spam complaint on a marketing email becomes a consent-withdrawal event for that purpose (source `complaint`) and never blocks transactional mail.
</sv-prose>

<sv-prose id="b5">
## Email provider comparison

Prices are USD list prices from each vendor's pricing page, read 2026-10-17: [SES](https://aws.amazon.com/ses/pricing/), [Resend](https://resend.com/pricing), [Postmark](https://postmarkapp.com/pricing), [Mailgun](https://www.mailgun.com/pricing/). Residency: [Resend regions](https://resend.com/docs/dashboard/domains/regions) (account data stays in the US), [SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html) (London region). Postmark has no EU region according to a [competitor's comparison](https://nuntly.com/blog/email-api-eu-data-residency); Postmark's own page doesn't say, so verify before quoting. The 170k scenario is 200 groups × ~400 contacts × 2 mailings a month, plus transactional mail. Source: `factory/out/auth-roles-email-providers.csv`.
</sv-prose>

<sv-csv id="t1" src="factory/out/auth-roles-email-providers.csv" freeze="1" height="22rem">
</sv-csv>

<sv-prose id="b6">
**My recommendation: AWS SES in London, with transactional and marketing in separate AWS accounts.**
- **It's the only option that is both UK-resident and cheap at newsletter volume.** That matters because bulk mail is now in scope: at 170k a month SES costs about $17, against $160–450 elsewhere, and margins here are pennies per group.
- **The cost is that we build more.** There's no Convex component, so we write our own sender action, a queue through the workpool, and the SNS webhook.
- **The real risk is account-wide reputation.** One group's bad newsletter could get the account paused, and sign-in links would stop with it. Hence the separate transactional account, plus a per-tenant auto-pause of marketing when that group's bounce or complaint rate climbs.

**Runner-up: Resend.** It's the fastest to ship (official component, Auth.js provider) but stores data in the US and prices marketing per contact. **Mailgun EU** is the managed choice if UK/EU residency must not mean DIY.

**Sender identity.** By default mail comes from a platform domain with the group's name as the From name, the group's own address as Reply-To, and DKIM/DMARC on our domain: zero setup for volunteers. A group's own verified domain is an optional later upgrade, and its DKIM records live in our provider account, so no per-tenant secret is needed. `tenantSettings` secrets are only for a group that brings its own provider, which is not planned.
</sv-prose>

<sv-prose id="b7">
## Contracts and tables

- Platform tables are not domain aggregates, so they get no contracts, only plain `platform/` mutations.
- `memberships` already carries `tenantId`. `invitations` does too, with tenantId-first indexes; it lives in `platform/`.

| Change | Phases |
|---|---|
| `memberships.role`: `'owner' \| 'staff'` → `'admin' \| 'staff' \| 'viewer'` | loosen (union of all four) → backfill owner→admin → tighten (drop owner) |
| new `invitations {tenantId, email, role, tokenHash, invitedBy, expiresAt, acceptedAt?}`, index `by_tenant_email`, `by_tokenHash` | new table |
| `users` (Convex Auth's table, overridden in schema): add `kind: 'staff' \| 'supporter'` | loosen (optional) → backfill `'staff'` → tighten |
| new `supporterLinks {tenantId, userId, contactId, emailKey}`, indexes `by_tenant_user`, `by_tenant_contact`, `by_tenant_emailKey` | new table |
| `revisions.source` gains `'portal'` | one-phase loosening |
</sv-prose>

<sv-prose id="b8">
## Steps (settled by round 1; R4/P1 are written for Better Auth if spike A0 passes)

*∥ = parallel in separate worktrees.*

0. **A0 Better Auth spike** (see above). Gates R4 and P1; if it passes, R4/P1 are written against Better Auth (hooks, session sign-in method) instead of Convex Auth's `createOrUpdateUser`. ∥ R1, R2, E1.
1. **R1 Roles schema, loosen + backfill + tighten.** `convex/schema.ts`, `convex/platform/migrations.ts`. **Depends on contact-model S2**, which installs `@convex-dev/migrations` (`convex/convex.config.ts`) and is not built yet. Run S2 first, or have R1 install the component itself and S2 reuse it, but not both in parallel. The loosen phase can ship before the component exists; the backfill and tighten phases can't. Then `requireMember` returns the role. ∥ R2, E1 (once the migrations component exists).
2. **R2 Operator-only tenant creation.** `platform/tenants.ts` (`create` → `internalMutation` taking `adminEmail`, creating an invitation; it needs `invitations` from R4, so until R4 lands it creates an owner/admin membership for an existing user), `src/routes/index.tsx` (remove the create-group form; signed-in users without memberships see "ask your group's admin for an invite"), `platform/devSeed.ts`.
3. **R3 Role-aware constructors.** `convex/lib/tenancy.ts`: `minRole` option, defaults viewer/staff, plus a test that **every** registered domain mutation rejects a viewer. After R1.
4. **E1 Email transport spike.** SES (or the chosen provider): send one transactional mail from a Convex action, and receive one bounce on an HTTP route. Answer whether the SES HTTPS API works from the default runtime (fetch + SigV4) or needs a Node action. Report to `docs/spikes/08-email.md`. ∥ R1, R2.
5. **E2 `comms.send` + suppression.** New `convex/comms/` (send entry point, transactional vs marketing, `onHold` check, workpool queue), bounce/complaint webhook in `convex/http.ts` → `onHold` / consent event. After E1.
6. **R4 Staff accounts: invitations, verify, reset, 2FA, sessions.** Session lifetime 7 days; admin-only functions require a sign-in within the last hour (step-up). An internal `platform/members:resetTwoFactor` for the operator (logged). `convex/auth.ts` (`Password({ verify, reset })`, custom `createOrUpdateUser`: invite-only, staff kind), `platform/memberships.ts` (invite, accept, remove, changeRole, last-admin invariant), schema `invitations` + `users.kind` loosen. After R2, R3, E2. **Also: sign-in failures are ConvexError kinds, and they reveal nothing.** Production redacts plain errors to "Server Error". `builder-autherr` (branch `fix/auth-error-messages`) already wraps Password's `authorize` to throw `ConvexError` kinds `invalidCredentials`, `accountExists` and `weakPassword`. **Build on that wrapper; don't replace it.** Add `inviteRequired` and `emailUnverified` in the same style. Two enumeration fixes from `factory/out/reviewer-ui-autherr.md`:
   - **Equal timing:** an unknown email must also run scrypt (verify against a fixed dummy hash), so it costs the same as a wrong password. Both return `invalidCredentials`.
   - **Uniform wording:** open sign-up goes away (invite-only), so the "Could not create an account with that email. If you already have one, sign in instead." message is retired. Invite acceptance knows the email from the token, so it can say "you already have an account, sign in to accept" without leaking anything. Password-reset requests and supporter sign-in always answer "if that address is on file, we've sent you an email".
   - **Tests:** each failure is a ConvexError with its kind. The unknown-email path calls the same verify function as a wrong password (assert the dummy hash is checked; wall-clock timing is not testable in convex-test). Reset and supporter requests return identical responses for known and unknown addresses.
   - **Follow-up from the manual-test instances: honour `AUTH_2FA_REQUIRED`.** It is already declared in `convex/convex.config.ts` (typed `env`) and set to `0` on `dev/demo` and `dev/preview` only (`scripts/test-instances.mjs`), whose seeded users (`platform/testSeed`) sign in with a password alone. When it is `"0"`, staff password sign-ins don't require 2FA enrolment or a second factor. Absent or any other value means 2FA is required, so production never depends on it being set. Test both values.
7. **R5 Members UI.** Members page, invite dialog, accept-invite route, reset-password route under `src/routes/`. After R4.
8. **P1 Supporter login.** `auth.ts` (`supporter` provider with confirm-page link), `supporterLinks`, `supporterQuery` / `supporterMutation` + supporter db rules in `lib/tenancy.ts` (or a new `lib/supporter.ts`), portal route skeleton (sign-in, confirm, "your details": address, phones, communication preferences, sign-in email change; name read-only), 1-hour supporter sessions, `source: 'portal'`, and a staff dashboard list "changed by supporters". After R4 (shares `createOrUpdateUser`) and the contact-model email lookup (S1/S2).
9. **P2 DD self-service.** *Not in this plan*: waits for giving/GoCardless.
</sv-prose>

<sv-prose id="b9">
## Tests

- **Two-tenant isolation.** An admin of A can't invite into, list members of, or re-role users in B. A supporter linked in A gets nothing from B even with B's contact ids. An invitation token for A can't be accepted into B.
- **Platform.** `tenants.create` is not callable from a client (internal only). It creates exactly one invitation for `adminEmail` and no membership for anyone else.
- **Roles.** A viewer is rejected by every domain mutation (meta-test over the registered functions) and by exports, but can read giving and Gift Aid. Staff are rejected by admin-only functions. The last admin can't be removed or demoted.
- **Account separation.** A supporter sign-in with a staff member's email creates a *separate* supporter user and grants no membership. A supporter session calling any `tenantQuery` → forbidden. A staff session calling a `supporterQuery` → forbidden.
- **Invites.** Sign-up without an invitation is refused. An expired or used token is refused. The invited email must match the verified email.
- **Supporter db.** Reads of another contact's rows → null. A supporter can change their address and phones but not their name. Edits land as revisions with source `portal`. A merged contact's history is visible through the identity set.
- **Email.** Transactional mail sends despite a marketing opt-out. Nothing sends to `onHold`. A bounce webhook sets `onHold`. A complaint on marketing writes a consent-withdrawal event and leaves transactional sending untouched.
</sv-prose>

<sv-prose id="b10">
## Domain rules and ADRs

- **Rule 2 (consent log):** a spam complaint is recorded as a consent event, not a flag.
- **Rule 3:** anonymising a contact also removes its `supporterLinks` and disables the supporter user.
- **Rule 5:** applies centrally; every mail, auth mail included, goes through `comms.send`.
- **Rule 6:** applies; role checks and supporter scoping live in constructors. Rules 1, 4, 7 are not touched.
- **ADR 0017 changes:** Convex Auth is replaced by **Better Auth** (if spike A0 passes). Staff are invite-only (password+2FA or Google); supporters sign in by email link; tenants are created only by the operator from the CLI.
- **ADR 0019 changes:** the "supporter login" live-class entity is concretely `supporterLinks`; merge re-points its `contactId`, and the email row it names is re-parented with its key, so the binding survives.
- **Proposed ADRs:** **0020** "Accounts: operator-created tenants, tenant roles, supporter logins" and **0021** "Email: provider, transactional/marketing separation, sender identity".
</sv-prose>

<sv-prose id="b10a">
## Carried to the comms plan (from the g1q9 thread)

Not built here; recorded so the comms (Mailchimp alternative) plan starts from it.

- **Mail "from a person":** platform sending with the sender's name and group in the From name (`Jane Smith (Ashby Village Hall) <ashby@mail.…>`) and Reply-To set to their own address. It keeps consent filtering, `onHold`, unsubscribe and the activity log, and stays DMARC-safe.
- **"Open in Gmail / Outlook" with BCC prefilled** for small personal messages. Addresses go only in BCC, filtered by consent and `onHold` before the link is built. Lists are split into batches of about 50–60 (URL length; personal Gmail daily caps), and each use is logged as an export (who, when, segment). The UI prompts for a PECR opt-out line. Bounces from this route never come back, so it isn't for newsletters.
- **Possible later:** sending through the user's own Gmail via the Gmail API (personal and tracked), which needs Google app verification for the send scope.
- **Optional "send via your Google account" connector for personal-scale mail.** Workspace limits are 2,000 messages/day, 3,000 external recipients/day, 100 per message over SMTP and 500 via the API; personal Gmail is about 500/day (unofficial). Prefer the Gmail API with OAuth over an SMTP app password (otherwise the secret is stored in `tenantSettings`). There's no bounce feedback or unsubscribe headers, and it risks the group's own mailbox, so it is never the newsletter engine.
- **SES Tenants** ($0.005/tenant/month + $0.005 per 1,000) for per-group reputation and auto-pause, if SES is chosen.
</sv-prose>

<sv-prose id="b11">
## Grill: round 1

My recommendation is pre-selected on each question; change anything, add riders, then send.
</sv-prose>

<sv-ask id="g1q3" round="1">
**Tenant roles.**
- * admin, staff, viewer (read-only, for trustees or an auditor)
- admin, staff
- admin only (every user can do everything)
</sv-ask>

<sv-ask id="g1q4" round="1" pick="many">
**Admin-only actions.** Ticked = admins only; unticked = staff can do it too.
- * invite / remove / re-role users
- * tenant settings, payment and email connections
- * bulk export
- * erasure (anonymise)
- merging contacts
- sending bulk email
</sv-ask>

<sv-ask id="g1q5" round="1">
**How staff get an account.**
- * invite-only: sign-up is refused unless that email has a pending invitation
- open sign-up; an account with no membership can't see anything
</sv-ask>

<sv-ask id="g1q6a" round="1">
**Auth library** (see the thread on staff sign-in). Convex Auth (today, beta) has no 2FA.
- * Better Auth (`@convex-dev/better-auth`): 2FA, Google, magic link and email OTP built in, data stays in our EU Convex deployment. A 1-session spike first; if it fails, fall back to Convex Auth
- Convex Auth, building our own 2FA (emailed code, later TOTP)
- WorkOS AuthKit for staff only (US data), our own auth for supporters
- Kinde (UK region, unofficial Convex integration)
</sv-ask>

<sv-ask id="g1q6" round="1" pick="many">
**How staff sign in.** Invite-only either way; an OAuth sign-in is accepted only if its verified email matches an invitation or an existing staff user.
- * email + password, with 2FA
- * Google
- Microsoft (after a spike: not in Convex's documented providers)
- passkeys (later; not in the Better Auth component's supported list)
</sv-ask>

<sv-ask id="g1q6b" round="1">
**2FA for password sign-ins.** OAuth (Google/Microsoft) needs none of ours: the provider does it.
- * required for every staff password account; each person chooses authenticator app or emailed code; admins can reset a member's 2FA
- required for admins only
- optional
</sv-ask>

<sv-ask id="g1q7" round="1">
**How supporters sign in.**
- * email link that opens a "Sign in" confirm page (beats link scanners and the phishing risk the docs warn about), 15-minute expiry
- a code typed into the page (works across devices; more friction)
- one email with both the link and a code
</sv-ask>

<sv-ask id="g1q8" round="1">
**A staff member who is also a supporter (same email).** With Better Auth they are one user, so the separation is by how the session was signed in.
- * a supporter sign-in (link/code) only ever gives a supporter-scoped session; staff functions accept only password+2FA or Google sessions (the spike must prove this)
- one combined session: a donor link also opens the staff side (skips password and 2FA)
</sv-ask>

<sv-ask id="g1q9" round="1">
**Email provider** (needs bulk sending too).
- * AWS SES, London region: UK data, ~$17/mo at 170k emails; we build the queue and webhooks
- Resend: fastest to build (official component), US data, marketing priced per contact
- Mailgun EU region: managed, EU data, ~$167/mo at 170k
- Postmark: best transactional reputation, US data, ~$225/mo at 170k
</sv-ask>

<sv-ask id="g1q10" round="1">
**Keeping sign-in links alive if a newsletter goes wrong.**
- * separate sending accounts (or streams) for transactional and marketing, plus per-tenant auto-pause of marketing on high bounce/complaint rates
- one account, with care
</sv-ask>

<sv-ask id="g1q11" round="1">
**Who mail comes from.**
- * the platform domain, with the group's name as From name and the group's address as Reply-To; a group's own domain is an optional later upgrade
- every group must verify its own domain before sending
- groups bring their own provider keys (stored in `tenantSettings`)
</sv-ask>

<sv-ask id="g1q12" round="1">
**The Mailchimp alternative.**
- * a separate comms plan (lists = consent purposes + segments, editor, scheduling, unsubscribe); this plan only makes sure the provider and `comms.send` can carry it
- part of this plan
</sv-ask>

<sv-ask id="g1q13" round="1">
**When supporter login gets built.**
- * now (P1: sign-in, confirm, "your details"), with DD self-service following the giving/GoCardless plan
- all of it after giving/GoCardless
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: roles, staff and supporter sign-in, email provider. Send when done.
</sv-ask>

<sv-prose id="b12">
## Grill: round 2

Details hanging off round 1.
</sv-prose>

<sv-ask id="g2q1" round="2">
**What a viewer can see.** Typically a trustee or an independent examiner.
- * everything staff can read (contacts, giving, Gift Aid, reports), but no exports and no writes
- contacts and reports, but not individual donation amounts
- reports only
</sv-ask>

<sv-ask id="g2q2" round="2">
**A sole admin loses their 2FA device / email access.**
- * the operator resets it from the CLI after confirming identity out of band (phone the group); the reset is logged in the member's history
- the group must always have two admins (enforced), so another admin resets it
</sv-ask>

<sv-ask id="g2q3" round="2" pick="many">
**What a supporter can change in "your details".** Ticked = editable by the supporter.
- * address (Gift Aid uses it; the change is dated in revisions)
- * phone numbers
- * communication preferences (consent events, source `portal`)
- * their sign-in email (confirm on new address, notify old, as agreed)
- name (affects Gift Aid matching; my lean is staff-only)
</sv-ask>

<sv-ask id="g2q4" round="2">
**Do supporter edits apply straight away?**
- * yes, through the normal contracts (source `portal`); staff see them in history and a "changed by supporter" list on the dashboard
- no, they queue for staff approval
</sv-ask>

<sv-ask id="g2q5" round="2">
**Session lifetimes.**
- * staff: 7 days, re-entering password/2FA for admin actions older than 1 hour; supporters: 1 hour
- staff: 1 day; supporters: 1 hour
- leave the library defaults
</sv-ask>

<sv-ask id="g2q6" round="2">
**The platform's sending domain** (mail goes from `<group>@mail.<domain>`). Use the rider if you have a name in mind.
- * a dedicated domain for the service (e.g. a `.org.uk`), with `mail.` and `auth.` subdomains for marketing vs transactional
- not decided yet; build against a placeholder
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: viewer scope, 2FA recovery, supporter self-service, sessions, sending domain. Send when done.
</sv-ask>

<sv-prose id="b13">
## Grill: round 3 (confirmation)

The frontier is empty: every branch above is settled. The one item left open is the actual domain name, which doesn't block building (placeholder). **Approve = the plan is confirmed for building**, starting with spike A0 (Better Auth) and E1 (SES) in parallel with R1–R2. Revise = tell me what's wrong.
</sv-prose>

<sv-ask id="g3fin" round="3" role="close">
Round 3: confirm the logins & roles plan (design tree, steps A0–P1, tests, ADR 0020/0021 proposals).
</sv-ask>

</sv-page>
