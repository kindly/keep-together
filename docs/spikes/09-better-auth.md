# Spike 9 — Better Auth on Convex (A0)

Date: 2026-10-17 · Status: **done** · Plan: `factory/plans/auth-roles.sv` (step 0, gates R4 and P1)

## Verdict: pass. Build R4 and P1 on Better Auth.

All four A0 conditions hold, end to end, in the production build of our
SPA against a live EU dev deployment. Better Auth also covers the R4
extras the plan asked about (migration, equal timing, uniform errors).
The pass comes with six conditions (below). Without them it would be
unsafe. Every condition is small, and the spike already wrote and tested
each one. The fallback (Convex Auth plus a hand-built emailed-code second
factor) would mean writing TOTP, OTP storage, attempt counting and
lockout ourselves, while Convex Auth itself is still beta. Here those
pieces exist and are tested upstream.

## What was run

- `@convex-dev/better-auth` **0.12.5** (latest, released 2026-06-27) and
  `better-auth` **1.6.33**. The component's peer range is `>=1.6.11 <1.7.0`,
  but npm `latest` is 1.7.10, so we pin to the 1.6 line. The rest of the
  stack is `convex` 1.47.0, Vite 8, React 19 and TanStack Router.
- Throwaway deployment `dev/a0-spike` (`harmless-reindeer-723`, eu-west-1).
  First main's HEAD (Convex Auth) was deployed and seeded with
  `platform/qcSeed:fixture`: two password users and two tenants. Then the
  spike code was pushed over it.
- Evidence is a 9-case Playwright run (`spike-a0/a0.spec.ts`) against
  `vite build` + `vite preview` on :3107, plus the existing vitest suite
  with its fixtures switched to Better Auth sessions. Curl and a
  timing script covered the HTTP-only questions.
- The spike code is not committed. The full diff is in
  `factory/out/builder-a0-better-auth-spike.patch` in the main checkout.

```
✓ 1 migrated Convex Auth user signs in with the old password; no 2FA yet → no staff access
✓ 2 enrol TOTP → session upgraded to password+totp → staff functions and tenant data open
✓ 3 password sign-in now demands a second factor; wrong TOTP refused, right one admitted
✓ 4 a TOTP user is refused an emailed code (they chose the app)
✓ 5 emailed-code-only enrolment and sign-in (user B)
✓ 6 magic link to a staff address: confirm page, supporter-only session, 1 h, single use
✓ 7 a magic-link session cannot touch second factors, even with the password
✓ 8 unverified migrated user: a magic link deletes the unproven password
✓ 9 unknown address gets the same reply
9 passed (37.0s)
```

## The four A0 questions

### 1. Better Auth runs in our Vite SPA with Convex: yes

This follows the component's React (Vite SPA) guide. Auth endpoints live
on the deployment's `.convex.site` origin under `/api/auth/*`. The
`crossDomain` plugin carries the session as a `Better-Auth-Cookie` header
that the client keeps in localStorage, so no third-party cookies are
needed. `convex` plugin issues a 15-minute RS256 JWT for Convex
(`customJwt`, JWKS at `/api/auth/convex/jwks`). `ConvexBetterAuthProvider`
replaces `ConvexAuthProvider` in `src/main.tsx`. The built SPA doesn't
care where it is served from: only `VITE_CONVEX_URL`,
`VITE_CONVEX_SITE_URL` and `SITE_URL` (the trusted origin) matter. Both
GitHub Pages and the tailnet need a `SITE_URL`/`trustedOrigins` entry.

Friction found:
- **Local install is required, not optional.** The component bundles a
  schema generated for better-auth 1.6.15. 1.6.33's two-factor plugin
  writes `failedVerificationCount` and `lockedUntil` (account lockout,
  NIST 5.2.2), and the bundled `twoFactor` table doesn't have them. We
  also need a `session.signInMethod` field (below), and the bundled
  schema "cannot be altered". So the component lives in
  `convex/betterAuth/` (schema, `createApi` adapter, one `sessions.get`
  query). On every better-auth upgrade we regenerate that schema
  ourselves (`npx auth generate`, or copy it as the spike did), with the
  two-phase rule.
- `ConvexBetterAuthProvider`'s `authClient` type rejects a client that has
  `twoFactorClient()` (its `useSession` type differs). Cast at the
  provider. It works at runtime.
- Convex's guidelines want typed `env`. `createAuthOptions` reads
  `SITE_URL`/`BETTER_AUTH_SECRET` through `env` from `_generated/server`,
  declared in `defineApp({ env })`.

### 2. Two Factor (TOTP and emailed code) works: yes, with our guard

- **TOTP:** `twoFactor.enable({ password })` returns an `otpauth://` URI
  (secret stored encrypted). Verifying one code confirms it. After that a
  password sign-in returns `{ twoFactorRedirect: true, twoFactorMethods }`.
  The interim session is deleted and a signed 10-minute `two_factor`
  cookie is set, and `verifyTotp` mints the real session. Cases 2 and 3.
- **Emailed code:** `sendOtp` / `verifyOtp` with our `sendOTP` callback.
  For an email-only person, enrolment is `enable` followed by confirming
  an emailed code instead of a TOTP code. The TOTP row stays unconfirmed,
  so their later sign-ins offer only `otp`. Case 5.
- Wrong codes are refused, and account lockout (10 failures, 15 minutes)
  is on by default and stored in the database.
- **"Required for every staff password account"** is not a Better Auth
  setting. `twoFactorEnabled` is opt-in per user. We enforce it in our own
  guard: a session signed in by password alone gets `twoFactorRequired`
  from every staff function, and its only use is to enrol. Case 1.
- **Admin/operator 2FA reset** is a component-adapter write (delete the
  `twoFactor` row, set `twoFactorEnabled: false`). The spike's
  `markEmailVerified` is the same kind of write.

Two holes in the defaults, both closed by our `kt-second-factor-guard`
plugin (`/two-factor/*` before-hook) and proven closed:
- **Emailed codes are server-wide.** Once `sendOTP` is configured, every
  2FA user can receive one, including people who chose an authenticator
  app. That makes "app" no stronger than "email". The guard refuses
  `send-otp` to a user whose TOTP is confirmed. Case 4.
- **A magic-link session could re-key TOTP.** `/two-factor/enable` asks
  for the password, not for how the current session signed in. Someone
  with the mailbox and the password (but not the authenticator) could
  enrol a new TOTP from a magic-link session, then sign in as staff. The
  spike proved this end to end before the fix. The guard now refuses
  every `/two-factor/*` call from a session that isn't password-family.
  Case 7.

### 3. Magic link with a confirm page works: yes

- `sendMagicLink` gets the raw token and builds **our** URL
  (`<SITE_URL>/spike/confirm?token=…`), not Better Auth's verify URL.
  Opening the link signs nobody in (asserted: Convex auth stays
  `anonymous`). The page's button calls `authClient.magicLink.verify({
  query: { token } })`, which returns JSON plus the session header.
  Link scanners can't burn the token.
- 15-minute expiry (`expiresIn: 900`), tokens stored hashed, single use
  (consumed atomically, so a second click fails). Case 6.
- The request answers `{ status: true }` for known and unknown addresses
  alike. The UI shows "If that address is on file, we've sent you an
  email." Case 9. Whether to actually send to an unknown address is
  decided inside `sendMagicLink`, which is P1's job.
- **Gotcha:** a bad, used or expired token answers **302 →
  `<convex.site>/?error=INVALID_TOKEN`**, even to the JSON call. The
  browser follows the redirect, CORS fails, and the client *throws*
  instead of returning `{ error }`. The confirm page has to catch and show
  "this link has expired or was already used".
- Supporter sessions last **1 hour**: the session hook sets `expiresAt`
  for magic-link sessions (asserted 55–61 minutes). Staff get 7 days.
  `disableSessionRefresh: true` is required, or Better Auth's refresh
  would extend a supporter session to the 7-day `expiresIn`. The cost is
  that staff sessions hard-expire 7 days after sign-in, which matches the
  plan.

### 4. The session records its sign-in method, and a guard refuses magic-link sessions on staff functions: yes

Better Auth has one user per email, so a donor link sent to a staff
member's address reaches the staff user. The plan anticipated this.
Separation is by session:

- `session.signInMethod` is an additional field (local schema plus
  `session.additionalFields`, `input: false`). It is set by
  `databaseHooks.session.create.before` from the creating endpoint's
  path, using `convex/lib/signInMethod.ts`:

  | Creating endpoint | Method |
  |---|---|
  | `/sign-in/email`, `/sign-up/email` | `password` (no second factor yet) |
  | `/two-factor/verify-{totp,otp,backup-code}`, no prior session (sign-in challenge) | `password+totp` / `+otp` / `+backupCode` |
  | the same, with a prior session (enrolment) | upgrades only a `password*` session; otherwise inherits |
  | `/magic-link/verify` | `magicLink` |
  | `/callback/:id` | `oauth:<id>` |
  | `/two-factor/disable` | `password` |
  | anything else | inherited from the session it replaces, else `unknown` (fails closed) |

  "Inherited" works because Better Auth re-issues sessions with
  `createSession(userId, …, oldSession)` and copies the old row's fields.
- `convex/lib/session.ts` `requireSession(ctx, 'staff' | 'supporter')`
  reads `identity.subject` (Better Auth user id) and `identity.sessionId`
  from the JWT. It then **re-reads the session row** through
  `components.betterAuth.sessions.get` on every call. Revocation and
  expiry therefore apply immediately, not after the JWT's 15 minutes.
  - Staff: `password+totp|otp|backupCode` or `oauth:google`.
  - Supporter: `magicLink` only.
  - It maps the Better Auth user to our `users` row by
    `users.by_authId`.
- `requireMember` (all `tenant*` constructors) now begins with
  `requireSession(ctx, 'staff')`. That one line is the whole change to
  `convex/lib/tenancy.ts`.
- Case 6 shows a magic link sent to staff user A's address gives a
  session where the staff probe answers `forbidden` and the supporter
  probe answers `ok:magicLink`, and `/t/<A's tenant>/contacts` says "No
  group called…". Case 7 shows that session can't upgrade itself through
  2FA enrolment.

## The other questions in the brief

**Sessions and the tenancy constructors coexist safely: yes.** The vitest
fixtures (`test/fixture.ts`) now register the local component and sign
each user in through a real component `session` row, with
`signInMethod: 'password+totp'`. **183 of 191 tests pass**, including every
two-tenant isolation test, now through `requireSession` →
`requireMember`. The 8 failures are all `qcSeed.test.ts`: `qcSeed` calls
Convex Auth's `createAccount`. Porting it to Better Auth is R4 work, and
the QC seed needs the same port. In the browser, a staff session reads
its own tenant's contacts and gets "No group called…" for the other
tenant (case 2). Cost: one component query per authenticated call, which
is reactive, so the subscription also tracks session revocation.

**Migration from Convex Auth users: yes, passwords carry over.** Convex
Auth's `Password` hashes with Lucia's `Scrypt`. Better Auth hashes with
`@better-auth/utils/password`. Both use scrypt N=16384, r=16, p=1,
dkLen=64, an NFKC-normalised password, a 16-byte hex salt used as a
string, and store `hexsalt:hexkey`. The spike's
`platform/spike:migrateConvexAuthUsers` copies each `authAccounts`
(provider `password`) `secret` into a Better Auth `credential` account,
creates the Better Auth `user`, and sets `users.authId`. The app `users`
`_id` stays the same, so memberships and revision actors are untouched.
It is idempotent. The migrated user signed in with their **old Convex
Auth password** (curl and case 1). For new users, a component trigger
(`user.onCreate`, same transaction) creates or adopts the `users` row by
email. Schema change: `users` gains optional `authId` plus `by_authId`,
a loosening only. Convex Auth's tables stay until a later tighten.

One decision for R4: **`emailVerified`**. Convex Auth never verified
emails here, so migrated users arrive unverified. Better Auth's magic
link, on an unverified user, calls `revokeUnprovenAccountAccess`, which
**deletes the password and all sessions** (case 8: user B lost their
password). That is right for an unproven address. For migrated staff it
means one donor link wipes their password. Recommendation: have staff
re-prove their address once (an invite-style email) before they keep a
password, or mark them verified at migration if the operator vouches. If
there are no production users when R4 lands, this doesn't come up.

**Equal-timing error codes: built in, with a small gap.**
`/sign-in/email` gives an unknown email, a user without a password, and
a wrong password the same `401 {"code":"INVALID_EMAIL_OR_PASSWORD"}`. The
unknown-email path runs `password.hash()` (a full scrypt) before
answering. That covers the dummy-hash fix R4 planned. Measured on the
live deployment, 15 calls each with rate limiting off: unknown email
**median 322 ms**, wrong password **median 284 ms**. The bodies were
identical. A ~40 ms gap remains, probably hash plus salt generation
against verify, plus the failed lookup. Small next to network jitter,
but measurable with enough samples. R4 can even it out with a
before-hook pad if we care. `EMAIL_NOT_VERIFIED` is only reachable with
the correct password. Magic-link requests answer the same for any
address. The `withAuthErrorCodes` wrapper is replaced by a client-side
map from Better Auth's `error.code` to our kinds. The codes leave the
server already stable, as JSON `{ code }`, not redacted messages.

## Conditions on the pass (all R4 or P1 work)

1. **Local install** (`convex/betterAuth/`), with the schema regenerated
   on each better-auth bump. Pin `better-auth` to 1.6.x until the
   component supports 1.7.
2. **`kt-second-factor-guard`**: no 2FA management from non-password
   sessions, and no emailed code for TOTP users. It must be a *plugin*
   listed after `crossDomain`. Plugin before-hooks see the original
   request: crossDomain's `Better-Auth-Cookie` → `cookie` rewrite only
   reaches the endpoint, and `ctx.getSignedCookie` / `getSessionFromCtx`
   parse cookies once at context creation. So the guard reads the raw
   values itself. This is safe because it only ever *refuses*, and the
   values only work if you already hold them, but it is the most fragile
   part of the integration. Pin it with tests.
3. **`signInMethod` on the session plus `requireSession`** in the
   constructors (fails closed on unknown paths).
4. **Rate limiting configured explicitly**: `rateLimit: { enabled: true,
   storage: 'database' }`. Better Auth enables it only when
   `NODE_ENV === 'production'` (not set on Convex), and its default
   store is per-isolate memory. Once enabled it worked: a 4th wrong
   password within 10 s got `429`. The keys are the real client address
   (IPv6 /64), not a shared Convex proxy address.
5. **Confirm page catches the verify redirect** (question 3).
6. **`disableSessionRefresh: true`** so supporter sessions stay 1 hour.

## Not proven here

- **Google sign-in.** No OAuth client was available. The redirect URI is
  `<convex.site>/api/auth/callback/google`, and `crossDomain` hands the
  session back through a one-time token, as documented. The
  `oauth:<id>` classification depends on `ctx.params.id` in the session
  hook, which is untested. R4 must test it before admitting
  `oauth:google` sessions. Invite-only OAuth goes in
  `databaseHooks.user.create.before` (return `false` without an
  invitation).
- Passkeys and the organization plugin aren't supported by the component.
  The plan doesn't use them.
- Real email delivery: mail went to a `spikeOutbox` table standing in for
  `comms.send` (E1/E2).

## Files (in the patch, not committed)

- `convex/betterAuth/{convex.config,schema,adapter,sessions,spikeReset}.ts`: local component
- `convex/auth.ts`: Better Auth options, session hook, guard plugin, user trigger
- `convex/auth.config.ts`, `convex/http.ts`, `convex/convex.config.ts`
- `convex/lib/signInMethod.ts`, `convex/lib/session.ts`, one line in `convex/lib/tenancy.ts`
- `convex/platform/spike.ts`: migration, outbox, probes; `convex/platform/tenants.ts` uses `requireSession`
- `convex/schema.ts`: `users.authId` + `by_authId`, `spikeOutbox`
- `src/lib/auth-client.ts`, `src/lib/spike-probes.tsx`, `src/routes/spike.{index,portal,confirm}.tsx`, `src/main.tsx`
- `test/fixture.ts` (+ three test files): fixtures sign in through Better Auth sessions
- `spike-a0/`: Playwright config, spec, `reset.sh`
