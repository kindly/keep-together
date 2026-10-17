# 0005 — Auth: django-allauth in-app; hosted OIDC deferred

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: accepted (2026-07) · updated for 0011 (headless mode dropped with
the SPA — standard server-rendered allauth views instead)

## Context

Hosted providers were evaluated: WorkOS AuthKit (best SSO upsell, but US
data processing with no EU/UK residency option), Auth0 (documented UK
region, clunkier), Clerk (US, consumer-leaning). Users are charity *staff*
— tens of seats per instance — so free tiers and per-MAU pricing are
irrelevant; the axes are data residency, moving parts, and the self-host
story. With one-instance-per-client, in-app auth means each charity's
logins live in **their own UK database**: the strongest residency story,
zero external vendors, and identical behaviour for open-source
self-hosters.

## Decision

**django-allauth** with its standard server-rendered views: email-only
login (custom `User`, no username), no self-signup (adapter closes it;
staff are invited or seeded), our styled template overriding
`account/login.html` in `templates_django/`. MFA/passkeys and
Google/Microsoft social login are allauth modules to enable in a later
slice. Dev convenience is a seeded superuser (`just seed`) — **no
auth-bypass code path exists**.

Hosted OIDC/SAML (Auth0 UK preferred, or WorkOS if enterprise SSO becomes
the wedge) is the documented future path if a client's procurement demands
it — allauth's socialaccount/OIDC support makes that additive.

## Consequences

- Standard Django sessions + CSRF; htmx sends the token via a global
  `hx-headers` attribute on `<body>`.
- Password policy, rate-limiting and session security are allauth/Django
  configuration we own — review before first production client.
- Auth is fully testable locally and in CI with no external service.
