# Project Brief: Community CRM + Donations Platform

## What this is
A simple, cheap CRM for small UK community groups and hubs (village halls, community centres, grassroots charities, CICs) with **email and Direct Debit donations built in**. Target users are non-technical volunteers — often a rotating treasurer or secretary — currently running on spreadsheets + Mailchimp + a standalone GoCardless account.

## The gap
- Existing charity CRMs (Beacon ~£37/mo, Wild Apricot ~£40/mo, White Fuse £30–52/mo) are too expensive for groups with £5–10k/year income.
- Fundraising platforms (Localgiving, JustGiving) handle donations but not the CRM/email side.
- Nothing combines contacts + email + UK Direct Debit regular giving in one dead-simple, cheap tool.
- Direct Debit via GoCardless is the key differentiator — it's how small UK charities want regular giving, and cheap CRMs treat it as an afterthought.

## Business model (decided)
**Dual pricing, automatically billed at whichever is cheaper for the group:**
- Option A: percentage cut of donations processed (~10%)
- Option B: flat subscription (e.g. ~£10/mo or £120/yr)
- Reconcile quarterly or annually: charge percentage as you go, **cap total charges at the flat-fee equivalent**. Pitch: "10% of donations, capped at £X/year, ever."
- Platform absorbs payment processing fees on Direct Debit (GoCardless ~20p/transaction); only partially absorb card fees — the fixed ~20p Stripe portion makes small one-off card gifts loss-making, so DD regular giving is where margin lives and is the behaviour to encourage.
- Founder has local connections; **first cohort trials free in local area.**
- Grant funding is the realistic sustainability leg (National Lottery Community Fund, Power to Change's Community Tech fund — £40k/2yr grants for community-controlled tech; a CIC/co-op structure strengthens applications). Revenue alone won't cover a salary at small scale (~200 groups ≈ ~£22k/yr under this model).

## Market pricing reference points
- Localgiving: £150+VAT/yr membership, voluntary donor tips under £200, 5% over £200
- GlobalGiving: 10% retained
- CAF Donate: 4%
- White Fuse: £30+/mo + 1% commission on DD on top of GoCardless fee
- Free competitors exist (Wonderful.org, KindLink ~1.3% fees) — so the 10% must be justified by convenience/value, and messaging must emphasise the cap

## MVP scope (proposed)
1. **Contacts**: simple people database — name, email, dropdown fields an organisation defines (e.g. supporter type: member/donor/volunteer; these replaced tags, ADR 0023), notes, GDPR consent tracking. CSV import from spreadsheets.
2. **Donations**:
   - GoCardless integration for Direct Debit regular giving (core feature)
   - Stripe for one-off card donations
   - Hosted/embeddable donation page per organisation
   - Gift Aid declaration capture + HMRC-ready export (full Gift Aid filing can be phase 2)
3. **Email**: basic broadcast email to segments chosen by dropdown field (newsletters, appeals). Nothing fancy — no automation builders in v1.
4. **Billing engine**: track donations processed per org, compute percentage vs flat fee, auto-charge the cheaper amount, show the org a transparent running tally ("you've paid £43 of your £120 annual cap").
5. **Multi-tenant** from day one: each community group is an isolated org with 1–5 volunteer logins.

## Non-goals for v1
- Case management / beneficiary tracking
- Event ticketing
- Room bookings
- Website builder
- Automated Gift Aid submission to HMRC

## Constraints & considerations
- UK-specific: GDPR, Gift Aid, GoCardless, data hosted in UK/EU
- Users are non-technical volunteers — onboarding must be near-zero-training; treasurer handover between volunteers is a common event, so account/role transfer must be easy
- Keep infra costs minimal (revenue per org is tiny)
- Design for churn: groups fold and volunteers rotate; easy data export builds trust

## First build task suggestion
Start with the interactive pricing/break-even model (inputs: percentage, cap, number of groups, avg raised per group, payment fee assumptions; outputs: revenue, per-group cost, break-even point), then scaffold the multi-tenant app skeleton with GoCardless sandbox integration.
