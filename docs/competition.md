# Competitive landscape

Research date: 2026-07-12. Method: multi-angle web research with per-claim
adversarial verification (22 of 25 claims confirmed 3-0, 3 refuted). Facts —
especially prices — are time-sensitive; re-verify before quoting externally.

## Scope being compared against

1. Donor/membership database
2. Donation tracking + one-off payments + regular giving (GoCardless DD)
3. Gift Aid (HMRC claims) on those donations
4. Email campaigns to donors with campaign-code tracking
5. Mail merge for postal letters
6. Donate link / embeddable donation forms for the charity's own site
7. Email design/creation tool

## Headline

**No competitor is simultaneously open source, self-hostable, UK-first, and
integrated across this scope.** Every full Gift Aid + GoCardless pipeline
found (Beacon, Donorfy, Donorbox Pro) is closed SaaS. The only open-source
competitor (CiviCRM) delivers the UK features via a self-assembled extension
stack that typically needs a developer or consultant. The exploitable angle is
**integration, out-of-box UK compliance, and modern UX at zero licence cost**
— not features nobody has.

## Open source

### CiviCRM — the only significant open-source competitor

- AGPL, self-hostable, free. Covers scope items 1, 2, 4 in core (contacts,
  contributions, memberships, email marketing) plus events/case management
  beyond our scope. (Note: Standalone CiviCRM exists — it is *not* strictly
  CMS-embedded; a claim to the contrary was refuted 0-3.)
- **UK capability is all add-ons, not core:**
  - Gift Aid declarations: community extension `gift-aid-extension-uk`
    (~386 installs)
  - Direct HMRC Charities Online submission: a *second* extension,
    `ukgiftaidsubmission`
  - GoCardless DD: third-party Artful Robot extension (~163 installs;
    maintained — migrated to Billing Requests API Nov 2025)
  - The civicrm.org homepage mentions none of Gift Aid, Direct Debit,
    GoCardless, or HMRC.
- Key weakness (Charity Digital 2026): "setup and administration is quite
  technical... you will need to hire a developer... or a specialist
  consultant." CiviCRM Spark (~$9.50–14.50/mo hosted, ≤2,000 contacts) is the
  developer-free entry point but explicitly limited.
- Verifiers' emphasis: CiviCRM's gap is **packaging/out-of-box UX, not
  capability** — the extension stack does deliver Gift Aid incl. HMRC
  submission and GoCardless DD.

No newer open-source charity CRM with UK Gift Aid ambitions surfaced
(open question — see below).

## Closed SaaS, UK-first

### Beacon — closest single competitor to the integrated pipeline

- UK charity-specific. Starter £33.50/mo annual-billed (£37 monthly),
  500–2,000 contacts; pricing is modular so real cost can exceed the base.
- Supporters set up GoCardless DDs from the charity's own site via embeddable
  no-code forms; incoming DD payments are auto-checked for Gift Aid
  eligibility and added to a rolling claim for **one-click submission direct
  to HMRC** (no Charities Online login). GASDS support, auto-created
  declarations during DD setup, GDPR consent features, UK support.
- Verified coverage: scope items 1, 2, 3, 6.

### Donorfy — the other near-full-scope UK player

- Owned by The Access Group. Free "Essentials" tier ≤250 contacts; paid from
  ~£39–40+VAT/mo.
- GOV.UK-listed Charities Online supplier: direct HMRC submission, overnight
  auto-compiled claims, optional monthly auto-submit, GASDS-compatible.
- Native GoCardless recurring DD via web widgets (but widgets are
  **Professional-plan-gated**), plus Stripe/PayPal.
- Mail merge is an **export-then-merge-in-Word** workflow, not in-app letter
  generation. Bulk email is via Mailchimp integration, not built in.
- Verified coverage: 1, 2, 3, 5 (partial), 6.

### GoodCRM — budget UK option (medium confidence)

- ~£25–28+VAT/mo Personal plan (possible £199 setup fee), 1 user, up to
  100,000 constituents, no commission (charity connects its own
  Stripe/GoCardless). Exact price not fully verifiable on their JS-rendered
  pricing page.

## Closed SaaS, international

### Donorbox

- Embeddable donation forms with point-of-donation Gift Aid declaration
  capture (scope 3 + 6). Automated batch HMRC submission
  (daily/weekly/monthly/quarterly using the charity's own Government Gateway
  credentials) exists but is **gated behind Pro/Premium tiers** and only
  covers donations processed through Donorbox. Cheaper-plan charities claim
  manually.

### Little Green Light, Bloomerang, Zeffy, Givebutter

- Produced **no surviving verified claims** — their UK Gift Aid/GoCardless
  posture is *unassessed, not absent*. Working hypothesis: US-centric, weak
  or no Gift Aid; needs a follow-up pass before dismissing.

## Structural facts

- **GoCardless itself has zero Gift Aid capability** (official support doc:
  "not available directly through GoCardless"). Every CRM integrating it —
  Beacon, Donorfy, ChurchSuite — implements Gift Aid at the CRM layer. This
  validates ngo-go owning the declaration chain and reclaim records.

## Where the gaps are for ngo-go

1. **Open + integrated**: nobody offers Gift Aid chain + GoCardless regular
   giving + embeddable forms as *integrated core features* in an open-source,
   self-hostable package. CiviCRM has the parts; assembly requires expertise.
2. **Tier-gating as a wedge**: features competitors paywall (Donorfy's
   GoCardless widgets, Donorbox's automated HMRC filing) can be free core
   features here.
3. **Modern UX**: CiviCRM's complexity is its documented #1 pain point for
   small charities — exactly the differentiator already stated in CLAUDE.md.
4. **Zero licence cost vs £300–500/yr**: Beacon/Donorfy/GoodCRM all land in
   the ~£300–500+/yr range once real usage exceeds free tiers.

## Thinly-evidenced areas (don't over-claim)

- Scope 5 (postal mail merge) and 7 (email builder): only Donorfy's mail
  merge was verified (and it's export-to-Word). No competitor's email-builder
  quality was assessed (CiviMail exists; editor quality unverified).
- Scope 4 (campaign-code tracking) was not directly verified for any
  competitor.
- Charity Digital's 2026 roundup contains at least one factual error (its
  Donorfy free-tier figures were refuted 0-3) — treat its numbers cautiously.

## Open questions for a follow-up pass

1. Do Beacon/Donorfy/CiviCRM have genuine visual email builders and
   campaign-code attribution, and how good are they?
2. Are Little Green Light, Bloomerang, Zeffy, Givebutter credibly UK-capable,
   or dismissible as US-only?
3. Any post-2020 open-source charity CRM projects with UK ambitions that
   simply lack marketing visibility?
4. Real TCO of self-assembled CiviCRM (hosting + extensions + consultant) vs
   Beacon/Donorfy subscriptions — the economic case ngo-go must beat.

## Key sources

- https://civicrm.org/ · https://civicrm.org/extensions/gift-aid-extension-uk
  · https://docs.civicrm.org/ukgiftaidsubmission ·
  https://civicrm.org/extensions/gocardless
- https://www.beaconcrm.org/integration/gocardless ·
  https://guide.beaconcrm.org/en/articles/5720187-gift-aid ·
  https://www.beaconcrm.org/pricing
- https://www.theaccessgroup.com/en-gb/crm/sectors/not-for-profit/income-gift-aid-management/
  · https://support.donorfy.com/hc/en-us/articles/204583292 ·
  https://www.gov.uk/government/publications/charities-online-commercial-software-suppliers
- https://donorbox.org/nonprofit-blog/automated-gift-aid-submission
- https://support.gocardless.com/hc/en-gb/articles/360000895485-Gift-Aid
- https://charitydigital.org.uk/topics/the-best-crm-systems-for-2026-7626 ·
  https://www.plinth.org.uk/complete-guide/crm-small-charities
