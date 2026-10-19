# UK Fundraising CRM — Project Brief & CiviCRM Reference

*A single consolidated handoff document. **Part A** captures the context and decisions from the discovery discussion; **Part B** is the full CiviCRM deep-dive to use as a design reference. Suitable as a project brief for a collaborator or as reference context for an agentic coding tool (see A8 for how to load it).*

*This is a synthesis for orientation, not legal or tax advice. Validate all HMRC and data-protection specifics against current GOV.UK / ICO guidance and live source code before building.*

---

# Part A — Project context and decisions

## A1. Goal

Build a **real, production UK fundraising CRM** for actual charities, on a modern web stack, licensed **AGPL-3.0** (matching CiviCRM), using **CiviCRM as the canonical reference** for how the domain is modelled.

Market context established during discovery:
- For genuinely open-source (not merely free-tier) fundraising CRM, the field is narrow. **CiviCRM is effectively the only purpose-built open-source option.**
- Most UK fundraising CRMs recommended in the sector (Beacon, Donorfy, White Fuse, Access/ThankQ) are **proprietary**. Several "free" ones (KindLink, Salesforce Power of Us) are **free-tier proprietary**, not open source.
- General-purpose open-source CRMs (SuiteCRM — notably British, EspoCRM, Odoo, Dolibarr) are adaptable but not fundraising-specific; they'd need the fundraising/compliance logic built from scratch.

Strategic steer: don't try to out-feature the incumbents on day one. Pick a **wedge** — e.g. donor management + Direct Debit + genuinely painless Gift Aid for small charities, plus frictionless migration off spreadsheets and legacy systems (lock-in fear is a real opening) — then expand.

## A2. The hard 80% is domain + compliance, not the stack

The framework choice matters far less than getting the domain right. The load-bearing, UK-specific pieces:
- **Gift Aid** — declarations, eligibility, and submitting claims to HMRC (see A3).
- **GDPR / Data Protection Act 2018** — provable consent, lawful-basis tracking, retention, right-to-erasure that preserves financial/audit records.
- **Direct Debit** — the backbone of UK regular giving, typically via **GoCardless** (Bacs), plus reconciliation of what actually cleared.
- **CRM fundamentals** — supporter deduplication, households/relationships, campaigns/appeals, trustee-friendly reporting on retention and income.

## A3. Gift Aid / HMRC reality

- HMRC **does** expose an API for submitting and amending Gift Aid claims via its **Charities Online** service — but it is **not** a modern REST API. It's **GovTalk XML over the Government Gateway / Transaction Engine**, with an **IRmark** signature on every message and a **polling** handshake for responses.
- Each vendor needs a **Vendor ID**, obtained through HMRC's **Charities Online Service Recognition Process**. There's a **test service** to validate against; once approved, the product is listed on GOV.UK's **recognised commercial software suppliers** page.
- **Alternative model:** since 2017, legislation allows third parties to create Gift Aid declarations on donors' behalf. **Donor-intermediary** services (e.g. Swiftaid) automate declaration capture and claiming — something to integrate rather than rebuild.
- **Key leverage:** the gnarliest engineering (the GovTalk/IRmark/polling submission) already exists as **AGPL code** in CiviCRM's Online Gift Aid Submission extension. Since AGPL is acceptable here, studying/porting it beats reimplementing from HMRC's spec cold. (Detail in Part B, §4.)

## A4. Data-protection & hosting posture

- In this product, the **charity is the data controller**, **you are their processor**, and any infrastructure provider is your **sub-processor**. You need a signed **DPA** with customers, **ICO registration**, **UK/EU data residency**, encryption in transit and at rest, and **audit logging** of who-changed-what.
- **Payments/PCI:** never store card data — use **Stripe** (cards) and **GoCardless** (Direct Debit) so you stay in the lightest PCI bracket (SAQ-A territory).
- **Cyber Essentials** certification is increasingly expected by charity buyers before purchase.
- GDPR does **not** require UK/EU-only storage; it regulates **transfers** outside the UK/EEA and requires a lawful mechanism (UK IDTA / UK addendum to SCCs) when data leaves.

## A5. Database platform evaluation — Convex

**Compliance posture (adequate, with two things to get right):**
- **SOC 2 Type II** compliant, audited annually; audit report and pen-test results available on request.
- States **GDPR compliance**; hosted on **AWS**; publishes a **Data Processing Addendum** (so it will sign as sub-processor).
- **Region selection** exists: currently **US East (N. Virginia)** and **EU West (Ireland)**, more planned. For UK donor data, choose **Ireland** (UK grants the EEA adequacy). **Gotcha:** a deployment's region **cannot be changed after creation** — set it correctly up front.
- **The one genuine nuance:** Convex is a **US-incorporated** company, so even with the Ireland region it could be compelled under the **US CLOUD Act** to disclose data stored on EU servers — a restricted-transfer risk under GDPR. Manage with the DPA + UK IDTA/SCCs + a transfer risk assessment. Acceptable for most fundraising charities; the most procurement-sensitive (e.g. those handling vulnerable beneficiaries) may prefer a UK/EU-incorporated provider.
- **Sovereignty escape hatch:** Convex is **open source and self-hostable** (Docker, with Postgres underneath), giving full control over data location — but the self-hosted backend is **single-node by default, has no Convex support plan**, and you own scaling, backups, and version migrations.

**Transactions (a strength — an earlier doubt was corrected):**
- Convex is **ACID-compliant with serializable isolation and optimistic concurrency control (OCC)**; every mutation is a transaction, **auto-retried on conflict**. Serializable is the **strongest** isolation level — stronger than Postgres's default (read committed). Good for contribution/mandate/claim integrity. (Convex Cloud runs on **PlanetScale MySQL** underneath.)
- **Real caveat — write contention, not weak transactions:** under serializable + OCC, conflicting writes can't run in parallel. A **hot document** (e.g. a single "campaign running total" every donation increments) becomes a contention point that conflicts and retries. Fix with well-known patterns: **sharded counters**, keeping mutations narrow. Also mind **per-transaction limits** (order of tens of thousands of documents) and **plan-based concurrency limits** for batch jobs like bulk Gift Aid claim generation.
- **Separate axis — relational integrity:** Convex is a document store, so **referential integrity (foreign keys, cascades) is enforced in your mutation code**, not guaranteed by the database. A modelling-discipline consideration, not a transaction-correctness one; not a dealbreaker.

**Net:** Convex Cloud in the Ireland region, with DPA + UK IDTA in place, is a defensible foundation for a small-to-mid charity CRM and lets you move fast. If "donor data never leaves UK/EU jurisdiction" is a go-to-market pillar, self-hosting on UK/EU infrastructure — or an EU-incorporated backend — is the stronger story at a meaningful ops cost.

## A6. Licensing stance

- Decision: **adopt AGPL-3.0** (same as CiviCRM and its Gift Aid/GDPR extensions).
- Implication (accepted): AGPL is strong copyleft **with a network clause** — offering a modified/derived work as a **SaaS** obliges you to provide the **corresponding source** to its users. This pushes toward an **open-core / paid-hosting-and-support** business model rather than proprietary SaaS, and it legitimately enables **reuse of the AGPL Gift Aid/GDPR extensions**.

## A7. Suggested stack (working default)

- **Data:** Postgres (strong relational/financial integrity) **or** Convex (per A5).
- **Backend:** a typed API layer — **NestJS/TypeScript** or **Django/FastAPI** (Django's admin/ORM is a head start for CRUD-heavy data).
- **Frontend:** **Next.js** or **SvelteKit**.
- **Payments:** **Stripe** (cards) + **GoCardless** (Direct Debit).
- **Decide early and hard-to-reverse:** **multi-tenancy** model — Postgres row-level security with a strong tenant boundary is a sane middle path; weigh against schema-per-tenant for isolation + GDPR erasure.

## A8. Handing this off to an agentic coding tool (e.g. Claude Code)

- Tools like Claude Code read `CLAUDE.md` files from the project at the start of every session as persistent context. Keep `CLAUDE.md` **lean (target under ~200 lines)** and high-signal — conventions, layout, "always do X" rules — because longer files reduce adherence.
- **Pattern:** keep **this full document in the repo** (e.g. `docs/uk-fundraising-crm-brief-and-civicrm-reference.md`) as a normal reference the tool opens on demand. Write a short root `CLAUDE.md` that captures only the **load-bearing rules** and **points to this doc**.
- Note: `@path` imports still load into context at launch, so importing this big doc doesn't save context — leave it as an on-demand reference, not an import. Use **path-scoped rules** later to load module-specific instructions only when relevant files are touched.
- **First session:** load both files, use plan mode, and ask the tool to propose the **schema and scaffold from this doc** before writing code.

**Non-negotiable domain rules to put in `CLAUDE.md`:**
1. Gift Aid declaration is a **dated chain, not a boolean** (eligibility = contribution date vs declaration windows).
2. Consent is an **immutable per-channel, per-purpose log**; current preferences are **derived** from it.
3. Erasure = **anonymise, don't delete** (preserve financial/tax history).
4. The Gift Aid reclaim is a **real financial record**, not a custom field.
5. Centralise **transactional-vs-marketing** suppression (transactional email always sends).
6. Licence: **AGPL-3.0**. Stack + multi-tenancy model as chosen.

---

# Part B — CiviCRM deep analysis (design reference)

*The framing throughout is "what to borrow, what to avoid" for a new build on a modern stack under the same AGPL-3.0 licence.*

## B1. What CiviCRM is, architecturally

CiviCRM is a PHP application on MySQL/MariaDB, released under **AGPL-3.0**. Historically it ran only embedded inside a PHP CMS (Drupal, WordPress, Joomla, Backdrop), inheriting that CMS's user/auth layer. As of version 6.0 it can also run **standalone** with no CMS, which removes a long-standing architectural constraint and makes it a cleaner reference for a headless/API-first design.

The pieces that matter as reference material:

- **APIv4** is the current stable API and the recommended interface for everything. It is entity/action/parameter shaped (e.g. `Contact.get`, `Contribution.create`), entities usually map to a table, and the same API powers the newer UIs internally. **APIv3** still exists but is maintenance-only — don't model anything on it.
- **Extensions** are the unit of modularity. Core "components" (below) are effectively first-party extensions that can be toggled on/off. The compliance features you care about (Gift Aid, GDPR) are *not* in core — they're community extensions.
- **Hooks** provide the extension points (pre/post entity ops, altering batches, etc.). The Gift Aid batching logic, for instance, uses a hook to filter ineligible contributions out of a batch before submission.
- **Search Kit** is an APIv4-powered search/display builder that can also define "smart groups" (saved dynamic segments). **FormBuilder/Afform** is the Angular-based form builder. These are the modern-era UI layers; older screens still use Smarty templates.
- **Custom fields** are stored EAV-style in `civicrm_value_*` tables (one table per custom field group). This is flexible but a well-known source of query complexity and performance cost at scale — see B7.

**Takeaway for your build:** the good structural ideas are the strict entity/API layer, the toggleable-component model, and hooks as extension points. The dated bits to avoid are Smarty, the APIv3 legacy surface, CMS coupling (now optional), and the EAV custom-data model as a default for anything you'll query or aggregate heavily.

## B2. The canonical fundraising data model

This is the part most worth internalising, because it's the distilled shape of a charity CRM after 20 years of iteration.

**Contacts** come in three types: **Individual**, **Household**, and **Organization**. Households and Organizations let you model "the gift came from the household / the company" without losing the individual relationships underneath.

**Relationships** are typed, directional, and dated (e.g. "Employee of", "Spouse of", "Member of household"), with start/end dates so history is preserved. This is how you avoid the classic mistake of flattening a supporter into a single row.

**Activities** are the universal interaction log — calls, emails, meetings, letters, and system events — attached to one or more contacts with a type, date, status, and subject. Almost everything a supporter does becomes an Activity, which is what makes timeline views and "no contact in N months" queries possible.

**Groups** (static or smart/dynamic) and **Tags** provide segmentation. Group *subscription* is dated and logged — important later for GDPR provenance.

**The money model** is worth copying carefully:
- A **Contribution** is a single financial transaction, linked to a contact, with a financial type, source, receive date, and status.
- **Line items** sit under contributions, so a single payment can split across funds/purposes.
- **Recurring contributions** are modelled separately and spawn individual contributions.
- **Pledges** (CiviPledge) model a promise to give over time, tracked against actual contributions.
- **Batches** group contributions for reconciliation and — critically — for Gift Aid claiming.
- **Payment processors** are pluggable; contribution pages capture gifts online.

**Takeaway:** keep Contribution / LineItem / RecurringContribution / Pledge / Batch as distinct entities from day one. The Batch abstraction in particular is load-bearing for Gift Aid.

## B3. Fundraising components (the reference feature set)

- **CiviContribute** — donations, recurring giving, pledges, receipts, reconciliation, contribution pages, payment-processor integration. This is the fundraising core.
- **CiviMember** — membership types, terms, statuses, automated renewals and reminders, self-service. Essential if you serve membership charities.
- **CiviEvent** — event calendar, registration flows, priced options, participant management.
- **CiviCampaign** — ties mailings, events, activities, and contributions to a campaign/appeal with goals; also runs surveys and petitions. This is your "appeal" abstraction for attributing income.
  *keep-together:* attribution is source codes (category → detail → version), not CiviCampaign's free hierarchy; gifts split across codes by pence allocations, and funds are a separate axis mapped on the code. See [ADR 0022](decisions/0022-source-codes.md).
- **CiviCase** — structured sequences of activities (case management), relevant if you ever cross into service-delivery charities.
- **CiviGrant / CiviPledge** — grant applications and pledges respectively.
- **CiviMail** — bulk email with segmentation, templates, tracking, and bounce handling; respects the communication-preference flags (see B5).
- **CiviReport** — templated reporting with filters; the Gift Aid HMRC report is delivered as a report template.

**Takeaway:** for an MVP wedge you likely need Contribute + Member + a light Campaign/appeal concept + mail/segmentation. Event, Case, and Grant can wait.

## B4. Gift Aid — deep dive

CiviCRM splits Gift Aid across **two AGPL-3.0 extensions**, and understanding the split tells you how to structure your own:

1. **UK Gift Aid** (core extension; originally Veda Consulting, `uk.co.compucorp.civicrm.giftaid`) — declarations, eligibility tracking, batching, the extra-amount calculation, and HMRC-format reporting.
2. **Online Gift Aid Submission** (`uk.co.vedaconsulting.module.giftaidonline`; MJW Consulting + Veda) — actually transmits claims to HMRC over the GovTalk protocol. It depends on the first extension.

### B4.1 The declaration model (the clever bit)

A Gift Aid declaration is **temporal**, not a boolean. Each contact has a chain of declaration records with:
- an "Eligible for Gift Aid" value (Yes / No, plus a "**Yes and past 4 years**" variant that back-dates eligibility),
- a **start_date** and an **end_date**.

The **current** declaration is the one with no end date. When a new declaration arrives, the system adjusts the chain rather than overwriting:
- A new positive declaration extends or opens an eligibility window (historically bounded ~3 years forward in the older logic; the past-4-years option opens backdated claims against contributions in the prior 4 years).
- A new negative declaration closes the current positive window (sets its end_date to "now") and records the negative period — even negative periods are retained, because they define spans where the contact was *not* eligible.

Declarations can be captured three ways: entered by admin on the contact record, submitted by the donor via an "Eligible for Gift Aid" field on a contribution/registration page (default profile provided), or updated over the phone. The **source** field records where it came from (form title, or admin).

**Why this matters:** eligibility of any given contribution is a function of *when it was received* versus *the declaration windows*. You cannot model Gift Aid as a flag on the contact. Copy the dated-declaration-chain design.

### B4.2 Eligibility, batching, and the extra amount

- A custom search finds contributions that are (a) unclaimed and (b) covered by a valid declaration for the relevant date.
- Eligible contributions are gathered into a **batch**. A hook lets you filter out contributions that shouldn't be included (e.g. multi-charity setups where each charity needs its own matching declaration).
- The extra 25% is calculated automatically. Note a modelling wart in CiviCRM: the extra amount has historically been stored as a *custom field* on a submission table rather than as a first-class contribution, so "how much did this donor give including Gift Aid" isn't a clean single query. **Avoid this** — model the reclaim as its own related financial record.

### B4.3 The HMRC report format

The report template produces exactly what HMRC expects:
- special characters stripped from first/last name,
- address reduced to "house name or number" + postcode (with `X` allowed as a postcode placeholder for non-UK addresses),
- amounts without currency symbols,
- filterable by batch and exportable to CSV.

The Gift Aid Small Donations Scheme (GASDS) and other income sit within the same HMRC Charities Online scope; plan for them as additional claim types rather than an afterthought.

### B4.4 Online submission (the painful, valuable part)

The submission extension implements HMRC's **GovTalk** message protocol: it builds the claim XML, applies the **IRmark** signature, sends it via the Government Gateway/Transaction Engine, then **polls** for the asynchronous response. Each submitting product needs a 4-digit **Vendor ID** obtained through HMRC's Charities Online service-recognition process (the extension ships with a consultant's Vendor ID by default, which you would replace with your own).

The claim lifecycle is a small **state machine** worth copying:
- contributions start **pending** in a batch,
- the batch is validated (submission is blocked until validation passes),
- on submission HMRC returns either "all eligible" or a list of **exceptions**,
- rejected contributions are set to **failed** and a **negative declaration** is recorded for that contact,
- the remaining pending contributions are promoted to **completed**,
- helper APIs exist to mark a batch manually submitted, mark it for resubmission, and generate the XML without transmitting (useful for testing).

**Takeaway for your build:** this GovTalk/IRmark/polling layer is the hardest UK-specific engineering in the whole product, and a working AGPL implementation already exists. Because you're adopting AGPL anyway, the pragmatic move is to read/port that extension's submission logic rather than reimplement it from HMRC's spec cold. Wrap it behind a clean modern service boundary. Keep the batch + pending/failed/completed state machine essentially as-is; it maps directly to how HMRC actually responds.

## B5. GDPR — deep dive

CiviCRM has two relevant efforts: the original **GDPR** extension (Veda Consulting, developed with data-protection consultant Paul Ticher) and the newer, more model-centric **GDPRX** toolkit. For a modern build, understand both but lean on GDPRX's approach.

### B5.1 The consent principles being modelled

The regulation's demand is: if you rely on consent, you must be able to prove **who** consented, **when**, **how**, **exactly what for**, and **through which channel** (post / email / phone / SMS). If you instead rely on **legitimate interests**, you must record any objection and be able to show the interest isn't outweighed by the individual's — and engagement decay weakens that basis over time. CiviCRM's docs are explicit that installing an extension does **not** make an organisation compliant; the software's job is to make consent provable and preferences honourable.

### B5.2 What the GDPR extension provides

- A **GDPR tab / summary** on the contact record showing: the date they last accepted the data policy, the date they last updated communication preferences, and their group subscriptions with subscription dates.
- A **combined communication-preferences page** (a standalone public page, deliberately separate from any incentive/competition) where a supporter can update personal fields, choose channels, and opt into/out of publicly listed groups — each group shown with its purpose, frequency, and format.
- Channel handling: opting out of the **email** channel maps to CiviCRM's "no bulk emails" flag, so **transactional** email (receipts, event confirmations) still sends — only mass communication stops. This transactional-vs-marketing split is essential and easy to get wrong.
- **Data policy** and **event/contribution T&Cs** upload, with forced acceptance recorded (the copy of what was agreed is retained).
- A **Data Protection Officer** record, and optional email notification to the DPO whenever a contact is forgotten.
- A custom search for **contacts with no activity** over a period — the operational tool for reviewing legitimate-interest retention.
- **Audit information recorded on export**, and permissions gating the GDPR settings, the dashboard, and the forget action.

### B5.3 Right to erasure: anonymise, don't delete

The standout design decision: the **"Forget Me"** button **anonymises** a contact (hides personal details, replaces with a configurable label like "Anon") but **retains financial and other history**. This reconciles the right to erasure with the legal obligation to keep Gift Aid/tax records — you cannot simply hard-delete a donor whose gifts you've claimed tax relief on. The action is irreversible and can notify the DPO.

**Takeaway:** design erasure as anonymisation-with-retained-financials from the start. A hard `DELETE` cascade is both a compliance trap (destroys required tax records) and an analytics trap (destroys historical totals).

### B5.4 GDPRX — the better reference for a new build

GDPRX is consent-record-centric. It stores discrete **consent records**, each with the channel/purpose plus optional **expiry date**, the **full T&C text** the person agreed to (with a dedup mechanism so identical T&C text isn't stored repeatedly), and a free-text note. Crucially it **does not act automatically** — it's a substrate you build retention/automation on top of (e.g. pairing with the SQL Tasks extension to tag contacts for deletion once no lawful basis remains). It can also derive the communication preferences as read-only from the consent records.

**Takeaway:** model **consent as an event-sourced log** (immutable records of granted/withdrawn consent, per purpose, per channel, with timestamp, source, method, and the exact wording shown), and **derive** current preferences from that log rather than storing a mutable preference flag as the source of truth. That gives you provability for free and makes "prove consent as at date X" a query rather than a reconstruction.

## B6. Communications, segmentation, reporting

- **Segmentation** is groups (static + smart) and tags, with smart groups defined via Search Kit / APIv4 criteria. Group membership changes are dated and logged — reuse that for consent provenance.
- **CiviMail** handles bulk sending, tracking, and bounce processing, and honours the no-bulk-email / channel flags so marketing suppression is centralised rather than per-send.
- **CiviReport** is template-based; note that the HMRC Gift Aid output is *a report*, which is elegant but couples claim generation to the reporting layer. In a modern build, treat claim generation as a first-class domain service, not a report export.

## B7. Honest architectural critique — what to carry across, what to leave

**Worth stealing:**
- The three-type Contact model (Individual/Household/Organization) with dated, typed relationships.
- Activities as a universal, queryable interaction log.
- Contribution / LineItem / Recurring / Pledge / **Batch** as distinct entities.
- The **temporal Gift Aid declaration chain** (never a boolean).
- The Gift Aid **batch + pending/failed/completed state machine** mirroring HMRC's response model.
- **Anonymise-don't-delete** erasure preserving financial history.
- **Consent as an immutable, per-purpose, per-channel log**, with current preferences derived from it (GDPRX's direction).
- Centralised **transactional-vs-marketing** suppression.

**Leave behind / improve:**
- **EAV custom-data tables** (`civicrm_value_*`) as the default extensibility mechanism — fine for sparse admin fields, painful for anything you query or aggregate. Prefer typed columns / JSONB with indexes for hot data; reserve dynamic fields for genuinely user-defined extras.
- Storing the **Gift Aid reclaim amount as a custom field** rather than a real financial record — model it as a related transaction so totals are queryable.
- Coupling **claim generation to the reporting layer** — make it a domain service.
- **Smarty / APIv3** legacy surfaces — irrelevant to a greenfield stack, but don't copy their patterns.
- CMS-coupled auth assumptions — you're building API-first, so design auth/tenancy natively.

**The one thing you cannot avoid re-implementing (or porting):** the HMRC GovTalk/IRmark submission and its polling handshake. It is genuinely the hardest UK-specific part, it hasn't modernised, and the AGPL extension is your best starting point.

## B8. Licensing note (AGPL-3.0) — read before you commit

CiviCRM and its Gift Aid / GDPR extensions are **AGPL-3.0**. AGPL is strong copyleft *with a network clause*: if you modify AGPL code and let users interact with it **over a network** (i.e. a SaaS), you must offer those users the **corresponding source** of your modified version. Practical consequences for a commercial SaaS:

- If you **port or derive from** the AGPL Gift Aid/GDPR extensions, your derivative is AGPL, and offering it as a hosted service triggers the source-provision obligation — competitors and the charities themselves can obtain and self-host your code.
- If you want the GovTalk submission logic without that obligation, you'd need a **clean-room reimplementation** from HMRC's public spec instead of porting the extension — much more work.
- Adopting the same licence is coherent and lets you legitimately reuse the extensions; go in eyes-open that AGPL pushes you toward "open core / paid hosting + support," not proprietary SaaS with a private codebase. Many charity-sector vendors run exactly this model.

Confirm specifics against `https://civicrm.org/licensing` and each extension's `info.xml` before relying on this.

## B9. Suggested reading order in the CiviCRM source/docs

1. APIv4 usage + the entity relationship diagram (the data model).
2. The UK Gift Aid extension docs: declaration model, then eligibility/batching, then HMRC report format.
3. The Online Gift Aid Submission extension: the GovTalk build, IRmark, and the submission state machine / helper APIs.
4. GDPRX docs (consent records, expiry, T&C dedup) then the original GDPR extension (forget-me, comms preferences, DPO, export audit).
5. Search Kit (for how they express dynamic segments via APIv4).

---

*End of document.*
