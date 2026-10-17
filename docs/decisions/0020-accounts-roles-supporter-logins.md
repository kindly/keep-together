# 0020 — Accounts: operator-created tenants, tenant roles, supporter logins

Status: **proposed** (2026-10-17) · from the logins & roles plan
(`factory/plans/auth-roles.sv`, confirmed in grill round 3). **Amends
[0017](0017-convex-react-shared-tenancy.md)** on authentication. The
auth-library part (decision 4) is conditional on spike A0
(`docs/spikes/09-better-auth.md`).

## Context

Today (`convex/auth.ts`, `convex/lib/tenancy.ts`, `convex/platform/tenants.ts`):

- Convex Auth with `Password` only: open sign-up, no email verification,
  no reset.
- `memberships.role` is `'owner' | 'staff'`, but nothing reads it.
  `requireMember` only checks that a membership exists, so every member
  can do everything.
- `platform/tenants.create` is a public mutation, so any signed-in user
  can create a tenant and become its owner.

Three kinds of people need to sign in:

- **the operator**, who runs the service;
- **tenant users** (staff and volunteers);
- **supporters** (donors), who give and manage their Direct Debit.

Convex Auth (beta, [labs.convex.dev/auth](https://labs.convex.dev/auth))
has no second factor. Its email providers are "trusted" for account
linking, so unchanged, a supporter magic link sent to a staff member's
address would sign them in as the staff user without the password
([advanced docs](https://labs.convex.dev/auth/advanced)).

Hosted platforms were checked and set aside:
- WorkOS and Clerk store data in the US.
- Auth0 has an EU/UK region but is the heaviest option.
- Kinde has a UK region, but its Convex integration is unofficial.
- There is no UK-headquartered option with a Convex integration.

## Decision

**1. No in-app platform admin.** `platform/tenants.create` becomes an
**internal** mutation the operator runs from the CLI
(`npx convex run platform/tenants:create '{"slug","name","adminEmail"}'`).
It creates the tenant, seeds reference data, and invites the first admin.
No public function can create a tenant.

Access to tenant data outside the app is operator access through the
Convex dashboard. That is governed operationally, not in code: the Convex
team is named operators with 2FA, and the processor DPA says so.

**2. Tenant roles: `admin`, `staff`, `viewer`.**

| Role | Can |
|---|---|
| `viewer` | read everything staff can read (contacts, giving, Gift Aid, reports); no writes, no exports |
| `staff` | everything a viewer can, plus all domain writes, including merging contacts and sending bulk email |
| `admin` | everything staff can, plus invite/remove/re-role users, tenant settings and payment/email connections, bulk export, and erasure |

The rule is structural, like rule 6:
- `tenantQuery` defaults to `minRole: 'viewer'` and `tenantMutation` to
  `minRole: 'staff'`; admin-only functions declare `minRole: 'admin'`.
- A tenant always has at least one admin.
- Schema: `owner` → `admin` (loosen → backfill → tighten).

**3. Staff accounts are invite-only.**
- A sign-up, or a first OAuth sign-in, is accepted only if its verified
  email matches a pending invitation or an existing staff user.
- Staff sign in with **email + password with required 2FA** (each person
  chooses an authenticator app or an emailed code), or with **Google**.
  Microsoft is possible after a spike.
- Admins can reset a member's 2FA. If a sole admin loses theirs, the
  operator resets it from the CLI after confirming identity out of band,
  and the reset is logged.
- Sessions last 7 days, but admin-only functions require a sign-in within
  the last hour.
- Sign-in failures are `ConvexError` kinds. Production redacts plain
  errors to "Server Error".
- No enumeration: an unknown email costs the same as a wrong password
  (dummy hash check), and reset and supporter requests answer identically
  for known and unknown addresses.

**4. Auth library: Better Auth if spike A0 passes; else Convex Auth.**

*If A0 passes:* [Better Auth](https://labs.convex.dev/better-auth)
(`@convex-dev/better-auth`) replaces Convex Auth. Its Convex component
supports Two Factor, Magic Link and Email OTP, and auth data stays in our
own EU Convex deployment, so there is no new sub-processor. Better Auth
keys users by email, so a staff member who is also a supporter is one
user. Staff and supporter are therefore separated by **the session's
sign-in method**:
- staff functions accept only password+2FA or Google sessions;
- magic-link / OTP sessions reach only supporter functions.

A0 must prove four things or it fails:
1. Better Auth runs in our Vite SPA;
2. Two Factor (TOTP + emailed code) works;
3. Magic Link with a confirm page works;
4. a session records its sign-in method, and a guard refuses a magic-link
   session on a staff function.

*Else:* Convex Auth stays, with:
- a custom `createOrUpdateUser` that never links across account kinds;
- `users.kind: 'staff' | 'supporter'`, with `requireMember` rejecting
  non-staff users;
- `Password({ verify, reset })` by emailed code;
- our own emailed-code second factor;
- a custom `Email` provider for supporters.

The staff/supporter separation holds either way. The mechanism differs.

**5. Supporter logins** (the "supporter login" live-class entity of
[0019](0019-contact-merge-tombstone.md)):
- **Sign-in:** an email link that opens a "Sign in" confirm page. That
  defeats link scanners and the session-fixation risk the docs warn about.
  The link expires after 15 minutes; supporter sessions last 1 hour.
- **Binding:** `supporterLinks {tenantId, userId, contactId, emailKey}`
  binds a supporter to a contact through the **email row**.
  - It auto-matches only when exactly one live contact (not archived,
    merged or anonymised, email not on hold) has the address. Otherwise
    staff choose.
  - The binding sticks once made, and removing the address ends it.
  - Merge re-points `contactId`. The email row is re-parented with its
    key, so the binding survives.
- **Self-signup:** an unknown address creates a contact only after the
  link is clicked, with the name asked first.
- **Access:** `supporterQuery` / `supporterMutation` check the link and
  give the handler a supporter db that sees only rows whose `contactId`
  is in the contact's identity set (0019). They never read `memberships`.
- **Edits:** a supporter may edit address, phones, communication
  preferences, and their sign-in email (confirmed on the new address,
  notified to the old). The name is staff-only. Edits apply directly
  through the normal contracts with `revisions.source: 'portal'`, and
  staff see a "changed by supporters" list.
- **Direct Debit:** self-service waits for the giving/GoCardless mandate
  model. Bank changes go only through GoCardless's hosted flow, and every
  portal DD change emails a notice.

## Consequences

- **0017 is amended:**
  - "Email + password to start" becomes invite-only staff with 2FA or
    Google, plus email-link supporters;
  - the auth library may change (decision 4);
  - `convex/auth.ts` is no longer the only place auth is configured (it
    gains hooks or a custom `createOrUpdateUser`).
- **Schema:**
  - `memberships.role` (two-phase);
  - new `invitations` and `supporterLinks`;
  - `revisions.source` gains `'portal'` (one-phase);
  - under the Convex Auth fallback, `users.kind` (two-phase).
- **ESLint and the tenancy tests** extend to the role defaults: a
  meta-test asserts that every domain mutation rejects a viewer.
- **Anonymisation** removes a contact's `supporterLinks` and disables the
  supporter user (rule 3).
- **Email** for invites, verification, reset and supporter links goes
  through `comms.send` as transactional mail (ADR 0021).
- **Builder-autherr's ConvexError wrapper** around Convex Auth's
  `Password` is kept under the fallback, and redone against Better Auth's
  errors if A0 passes.
