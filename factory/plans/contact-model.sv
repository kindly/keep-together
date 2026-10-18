<sv-page label="plan: contact model" category="archive">

<sv-prose id="b1">
## Design tree

**Complete 2026-10-18: all steps merged (S1–S7, S8 → ADR 0019), last commit fc1baf3.** Follow-ons have their own pages: external identifiers (building), logins & roles, supporter portal (later).

*Confirmed by the human in round 3 (2026-10-17); round 4 settled the merge ADR's open questions. All rounds were approved as recommended, plus the supporter-login thread on g2q2. Ready for building.*

- Contact model expansion: **yes, modest, mostly around the root**
  - **Email lookup: now.** `addressNormalized` + index; the list finds a contact by exact email
    - **normalised = trimmed + whole address lowercased**; the typed address is kept for display and sending
    - **same email on two contacts: allowed, with an advisory warning naming the other contact**
      - uniqueness lives on the *supporter login* (portal plan), not on contact emails
  - **Tags: now.** `tags` aggregate + `contacts.tags` slice
    - **tags only, no Civi groups.** Smart groups become saved segments in comms; a mailing-list opt-in is a consent purpose
    - **seeded: member, volunteer.** Donor becomes a computed segment once giving exists
    - **flat; names unique per tenant, case-insensitive; no colours**
    - **retire = archive (`isActive: false`)**: hidden from pickers, existing assignments kept, can be reactivated
    - **bulk add/remove from the list: in this plan** (one command group per batch, paginated action)
  - **Notes: now, own `contactNotes` aggregate**
    - **plain-text body + pinned flag**; author and time from revisions; any staff member can edit
    - **remove = archive** (hidden, restorable); anonymisation scrubs the text
  - **Merge: tombstone + `mergedInto`; ADR now, build later**
    - **planner drafts ADR 0019 into `factory/out/` straight after this grill**; the human accepts it into `docs/decisions/` (numbered 0019, not 0018 as asked in g2q8: 0018 is taken by the QC harness). **Accepted: `docs/decisions/0019-contact-merge-tombstone.md`**
      - **consent across a merge: the latest event wins** (per channel and purpose, over the identity set)
      - **a tombstone keeps its name**; search finds it and redirects to the survivor
  - **Multiple external identifiers: next, as its own plan** (details-contract version bump + upcaster, import)
  - **Supporter login (portal): its own plan, after giving + GoCardless exist**, starting from "Carried to the portal plan"
    - purpose: make a payment, manage a Direct Debit
    - login binds to the **email row**; auto-match only if exactly one live contact has the address, else staff choose; the binding sticks
    - unknown address → contact created **after the link is clicked**, name asked first, `source: 'portal'`
  - **Later:** salutation, households UI, custom fields, phone type, websites, org identifiers, donor summary (giving), postcode lookup, email typo warning
  - **Never:** contact subtypes, do_not_* flags on the contact, master_id / employer_id, gender/pronouns/language as core fields
  - **Acquisition source:** decide with giving (campaign of first gift); tags meanwhile
</sv-prose>

<sv-prose id="b2">
## Verdict

**Yes, but only a little, and mostly around the Contact rather than inside it.** The root and its child rows already match CiviCRM's core contact (three kinds, multi-value email/phone/address, dated typed relationships, deceased, external id). ADR 0014's deliberate drops (do_not_* flags, subtypes, master_id, employer_id, greetings) still look right after checking what the extension ecosystem bolts back on. What's missing is the stuff around the contact that every small group uses from day one, plus one decision that has to be made before giving, giftaid and consent start referencing contacts.

Top changes, in order:

1. **Email lookup.** Add a normalised email address with an index. CSV import, GoCardless/Stripe webhooks, Mailchimp sync and dedupe all match on email. Today the list searches `sortName` only.
2. **Tags.** A per-tenant `tags` aggregate plus a `contacts.tags` slice. The product brief's MVP names "tags (member/donor/volunteer)".
3. **Notes.** A `contactNotes` aggregate, one root per note. Also named in the MVP.
4. **Merge reference rule (decide now, build later).** The losing contact becomes a tombstone with `mergedInto`. Immutable logs keep the old id and resolve through it. Needs an ADR before the next modules land.
5. **Multiple external identifiers (next, not now).** Replace the single `externalIdentifier` before any real import data exists.

**Explicitly out of scope:** custom fields, salutations, households UI, membership/volunteering/Direct Debit/Gift Aid modules, and building dedupe and merge themselves. Everything except #4's decision is in the "later" rows below.
</sv-prose>

<sv-prose id="b3">
## Gap table

Every candidate checked against CiviCRM core and the extension directory. Install counts are "Active Installs" from [civicrm.org/extensions](https://civicrm.org/extensions?sort_by=field_extension_usage&sort_order=DESC), scraped 2026-10-17 (805 listed extensions). They are **global**: per-country extension stats are members-only on [stats.civicrm.org](https://stats.civicrm.org/), so UK share is not known. Core features (tags, groups, notes, custom fields, dedupe) are not in the directory and have no count. Source CSV: `factory/plans/contact-model-gaps.csv`.
</sv-prose>

<sv-csv id="t1" src="factory/plans/contact-model-gaps.csv" freeze="2" height="32rem">
</sv-csv>

<sv-prose id="b4">
### What the directory says, briefly

- **The most-installed extensions don't touch contact data.** Mosaico 4,796, CiviRules 4,185, Contact Layout Editor 3,788, Firewall 3,777, Stripe 3,325, Extended Reports 2,394. They cover email design, automation, UI layout, payments and reporting.
- **Contact-data extensions with real usage:** Contact Editor 1,143 (lets you change a contact's type), XCM 1,094 (matching on import/API), Mailchimp 809, GDPR 792, Identity Tracker 705 (several external ids per contact), Summary Fields 658, Relationship Block 583.
- **The UK stack is small in absolute numbers:** UK Gift Aid 453, Membership Extras 302, CiviVolunteer 235, GoCardless 157, Gift Aid online submission 136, UK Postcode Lookup 129, SmartDebit 45. None of them adds contact fields that we lack, except that Gift Aid needs an address snapshot on the declaration.
- **Groups versus tags** ([user guide](https://docs.civicrm.org/user/en/latest/organising-your-data/groups-and-tags/)). Groups are for sets you act on (mailing, ACL) and keep a dated Added/Removed/Pending history. Tags are descriptive and can be nested.
- **Merge** ([user guide](https://docs.civicrm.org/user/en/latest/common-workflows/deduping-and-merging/), [CRM-5758](https://issues.civicrm.org/jira/browse/CRM-5758), [CRM-18106](https://issues.civicrm.org/jira/browse/CRM-18106)). The loser is trashed (`is_deleted=1`) and a "Contact Deleted by Merge" activity is attached to it. Dedupe rules are weighted field matches against a threshold, one unsupervised and one supervised rule per contact type. "Not a duplicate" pairs go in an exceptions list.
- **Core contact page** ([user guide](https://docs.civicrm.org/user/en/latest/organising-your-data/contacts/)): location types, privacy flags, computed greetings, notes, and trash.
</sv-prose>

<sv-prose id="b5">
## Contracts and tables (the "now" items)

| Item | Table / field | Contract (slice) | Counter | Schema phases |
|---|---|---|---|---|
| Email lookup | `contactEmails.addressNormalized` + index `by_tenant_addressNormalized` | none new: derived in `contacts.methods` reconcile on insert (it derives from the identity field, so it is immutable per key) | `methodsVersion` (unchanged, no version bump: payload shape is the same) | loosen (optional + index) → backfill → tighten (required) |
| Tags: definitions | new `tags` {name, nameNormalized, isActive, saveVersion}, indexes `by_tenant`, `by_tenant_name` (uniqueness check in apply, like `externalIdentifier`) | `contacts.tag` (own aggregate, like `relationshipTypes`) | `saveVersion` | new table, no phases |
| Tags: assignment | new `contactTags` {contactId, key, tagId}, indexes `by_tenant_contact`, `by_tenant_key`, `by_tenant_tag`; `contacts.tagsVersion` | `contacts.tags` slice on Contact; `tagId` is the identity field | `tagsVersion` | `tagsVersion`: loosen (optional, creates write 0) → backfill 0 → tighten |
| Notes | new `contactNotes` {contactId, body, pinned, archived, saveVersion}, index `by_tenant_contact` | `contacts.note` (own aggregate). `contactId` is fixed at create. Author comes from the revision actor. | `saveVersion` | new table, no phases |
| Merge rule | none yet (ADR first) | future `contacts.merge` → `mergedInto` | future `mergeVersion` | later |

`executeContract` throws if the counter field is missing (`convex/lib/contracts.ts:139`), so the `contacts.tags` contract must not be callable on pre-backfill contacts. Ship the UI only after the tighten step. `@convex-dev/migrations` is **not installed yet** (no `convex/convex.config.ts`), so S2 installs it.
</sv-prose>

<sv-prose id="b6">
## Steps

*Settled by rounds 1–2. ∥ = can run in parallel (separate worktrees; expect trivial `schema.ts` merges).*

1. **S1 Email lookup, loosen.** Touches `convex/schema.ts`, `convex/contacts/rules.ts` (`normaliseEmail`), `convex/contacts/contracts.ts` (reconcile sets `addressNormalized` on insert), `convex/contacts/queries.ts` (`findByEmail` internal query; `list` also matches an exact email; `get` passes "also used by" contacts into warnings), `convex/contacts/warnings.ts` (shared-email advisory: `contactWarnings` takes the other contacts' names as input and stays pure), `convex/contacts/contacts.test.ts`. ∥ S6, S8.
2. **S2 Migrations component + email backfill.** Touches `convex/convex.config.ts`, `package.json`, `convex/contacts/migrations.ts`. Backfill `addressNormalized`, deploy, then tighten in `schema.ts`. Needs S1 deployed.
3. **S3 Tags backend, loosen.** Touches `schema.ts` (`tags`, `contactTags`, optional `tagsVersion`), `validators.ts`, `contracts.ts` (`tag`, `tags`, registry, `contactSlices`; the details create writes `tagsVersion: 0`), `rules.ts` (`prepareTags`: duplicate tagIds rejected; `prepareTag`: trims the name, computes `nameNormalized`), `mutations.ts` (`currentPayloads`, `saveForm`, `bulkTag` under one command group with a bounded batch), `queries.ts` (tag list, `get` includes tags, contacts-by-tag paginated), `seed.ts` (seed member + volunteer), `test/fixture.ts`, new `convex/contacts/tags.test.ts`. After S2 (reuses the migrations setup).
4. **S4 Tags backfill + tighten** (`tagsVersion` = 0 on existing contacts). After S3 is deployed.
5. **S5 Tags UI.** Touches `src/components/contact-form.tsx`, `src/lib/contact-form-state.ts`, a tag admin route under `src/routes/`, a tag filter on the list, and list multi-select → add/remove tag. After S4.
6. **S6 Notes backend.** Touches `schema.ts` (`contactNotes`), `validators.ts`, `contracts.ts` (`note` in the registry), new `convex/contacts/notes.ts` (save, setPinned/archive through the one contract, `forContact` with pinned first then newest), new `notes.test.ts`. ∥ S1, S8.
7. **S7 Notes UI.** A notes panel on the contact page. After S6. ∥ S5.
8. **S8 Merge ADR proposal.** The planner drafts ADR 0019 ("contact merge: tombstone and reference rule") into `factory/out/` right after this grill, for the human to accept. No code. ∥ everything.
</sv-prose>

<sv-prose id="b7">
## Tests

- **Two-tenant isolation (every step).** Tenant A and B each have a contact with `Ann@Example.com`: `findByEmail` in B returns only B's contact. A tag id from A assigned through B's mutation is rejected. A note created in B against A's contact id is rejected. `snapshot` of B is unchanged after any of A's operations.
- **Email.** The lookup is case- and whitespace-insensitive. `addressNormalized` survives kept-key reconciles. Remove + add of a changed address updates the index. The list finds a contact by exact email. Two contacts sharing an address both save, and each carries a warning naming the other. A contact in tenant B with the same address never appears in tenant A's warning.
- **Tags.** A tags save never stales details, methods or addresses (and vice versa). Duplicate tagIds are rejected. Tag names are unique per tenant case-insensitively (`Volunteer` vs `volunteer` rejected), but the same name in two tenants is fine. An inactive tag can't be newly added, but an existing assignment stays. Restore recreates removed tag rows with the same keys. `bulkTag` writes one command group. Contacts-by-tag paginates. The counter/contract meta-test passes with `tagsVersion`.
- **Notes.** Create, edit, and a stale edit conflicts. Changing `contactId` is rejected. Two notes on one contact saved concurrently don't conflict. Archive and pin work; archived notes are hidden from `forContact` and restorable.
</sv-prose>

<sv-prose id="b8">
## Domain rules check

- **1 Gift Aid chain.** Not touched now. The merge ADR (S8) must say that a survivor's eligibility unions its own declaration chain with those of contacts merged into it, never rewriting either.
- **2 Consent log.** Applies. Tags and segments are never consent: a mailing-list opt-in is a consent purpose, not a tag or group (g1q3).
- **3 Anonymise, don't delete.** Applies. Note bodies and tag assignments are personal data that anonymisation must scrub. Merge never deletes the loser.
- **4 Reclaim is a financial record.** Not touched.
- **5 Centralised suppression.** Applies to the merge ADR. Merged, anonymised and deceased contacts are suppressed in `comms`, not by callers.
- **6 No tenant in domain code.** Applies. Three new tables, all with `tenantId`-first indexes. Cross-tenant ids are refused by the scoped db.
- **7 Integer pence.** Not touched.
</sv-prose>

<sv-prose id="b9">
## Grill: round 1

The now/later/never call on each candidate, plus the open questions. My recommendation is pre-selected. Change anything, add a rider, then send.
</sv-prose>

<sv-ask id="g1q1" round="1">
**Email lookup (gap #1).** Add `addressNormalized` + index on `contactEmails`, and let the list search find a contact by exact email.
- * now
- later (with import)
- never
</sv-ask>

<sv-ask id="g1q2" round="1">
**Tags (gap #2).** A per-tenant `tags` aggregate plus a `contacts.tags` slice (child rows keyed by id, `tagId` immutable per row).
- * now
- later
- never
</sv-ask>

<sv-ask id="g1q3" round="1">
**Groups versus tags (gap #14).** CiviCRM has both. What do we do?
- * tags only; smart groups become saved segments in comms later; mailing-list opt-in is a consent purpose
- tags now, plus Civi-style static groups with dated subscription history later
- groups instead of tags
</sv-ask>

<sv-ask id="g1q4" round="1">
**Notes (gap #3).** Where do notes live?
- * now, as their own `contactNotes` aggregate (one root per note, so concurrent notes never conflict)
- later, as an activity type in comms
- now, as child rows in a `contacts.notes` slice (simpler, but two people adding notes conflict)
</sv-ask>

<sv-ask id="g1q5" round="1">
**Merge reference rule (gap #4).** How do other modules' references survive a merge?
- * tombstone: the loser keeps its row with `mergedInto`; immutable logs keep the old id and resolve through it; the merge action re-points mutable aggregates. ADR now, build later
- re-point everything to the survivor on merge (rewrites consent and declaration rows, which breaks their immutability)
- don't decide until we build dedupe
</sv-ask>

<sv-ask id="g1q6" round="1">
**Multiple external identifiers (gap #5).** Replace the single `externalIdentifier` with `{system, value}` child rows (Identity Tracker, 705 installs)?
- * next: right after the now items, before the first real import
- now
- later
- never: one id is enough
</sv-ask>

<sv-ask id="g1q7" round="1" pick="many">
**The "later" bucket.** Untick anything you want pulled into **now**. Ticked = stays later.
- * salutation / addressee (#6)
- * households UI (#7)
- * custom fields (#8)
- * phone type (#10)
- * websites / social (#11)
- * organisation identifiers (#12)
- * donor summary read model (#13, owned by giving)
- * postcode lookup (#19)
- * email typo warning (#20)
</sv-ask>

<sv-ask id="g1q8" round="1" pick="many">
**The "never" bucket.** Untick anything you'd keep open. Ticked = never.
- * contact subtypes (#15); a type change will be create + merge later
- * do_not_* / preferred-method flags on the contact (#16); derived from consent
- * shared address `master_id`, `employer_id` (#17)
- * gender / pronouns / preferred language as core fields (#18); custom fields cover them
</sv-ask>

<sv-ask id="g1q9" round="1">
**Seed tags.** The brief says "member / donor / volunteer". "Donor" can be computed from giving, so as a tag it goes stale. What gets seeded per tenant?
- * member, volunteer (donor becomes a computed segment once giving exists)
- member, donor, volunteer
- nothing; groups make their own
</sv-ask>

<sv-ask id="g1q10" round="1">
**Acquisition source (gap #9).** "Where did this supporter come from" (e.g. "Christmas fair 2025"). ADR 0014 dropped `source` because `revision.source` is only technical provenance.
- * leave it for now; decide with giving (the campaign of the first gift), and use tags meanwhile
- add a free-text `source` field to `contacts.details` now
- a dedicated "source" tag set
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: now/later/never for each candidate, plus how tags, notes and merge are shaped. Send when done.
</sv-ask>

<sv-prose id="b10">
## Grill: round 2

Details that hang off round 1. Same drill.
</sv-prose>

<sv-ask id="g2q1" round="2">
**Email normalisation.** What does `addressNormalized` hold? The address as typed stays untouched for display and sending.
- * trimmed + whole address lowercased (local parts are case-sensitive in theory, never in practice)
- trimmed + domain lowercased only
- also strip Gmail dots and +tags (matches more, risks false merges)
</sv-ask>

<sv-ask id="g2q2" round="2">
**Same email on two contacts in one tenant** (couples, a shared office address).
- * allowed, with an advisory warning naming the other contact (validation tier 2)
- blocked: one email, one contact per tenant
- allowed silently
</sv-ask>

<sv-ask id="g2q3" round="2">
**Tag shape.**
- * flat list; names unique per tenant, compared case-insensitively; no colours
- flat, plus a colour per tag for the chips
- nested tags / tag sets, as in CiviCRM
</sv-ask>

<sv-ask id="g2q4" round="2">
**Retiring a tag.**
- * archive only (`isActive: false`): hidden from pickers, existing assignments kept and still visible; can be reactivated
- archive, plus hard delete when no contact carries it
- delete removes it from every contact (one command group)
</sv-ask>

<sv-ask id="g2q5" round="2">
**Bulk tagging** ("tag these 200 contacts volunteer") from the contact list.
- * in this plan: select in the list → add/remove a tag. One command group per batch, paginated action for large selections
- later, with segments
</sv-ask>

<sv-ask id="g2q6" round="2">
**Note shape.**
- * body only (plain text) plus a pinned flag; author and time come from revisions; any staff member can edit
- body + subject
- body only; only the author can edit
</sv-ask>

<sv-ask id="g2q7" round="2">
**Removing a note.** Revisions keep the text either way until anonymisation scrubs it.
- * archive (hidden, restorable), consistent with "no generic soft delete": it's explicit domain state
- hard delete of the note document; history keeps the revisions
</sv-ask>

<sv-ask id="g2q8" round="2">
**Merge ADR (S8).**
- * I draft ADR 0018 into `factory/out/` straight after this grill; you accept and move it into `docs/decisions/`
- the controller assigns it to a separate planner
- wait until dedupe is planned
</sv-ask>

<sv-ask id="g2q9" round="2">
**Multiple external identifiers ("next").**
- * its own plan once this one is building; it changes the details contract (version bump + upcaster) and import
- add it to this plan as S9
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2: details of email lookup, tags, notes, and what happens next. Send when done.
</sv-ask>

<sv-prose id="b11">
## Carried to the portal plan (from the g2q2 thread)

Nothing below is built in this plan. It is recorded so the portal plan starts from it.

- **Purpose:** a supporter makes a payment or manages their Direct Debit (amount, pause, cancel, bank change). One-off gifts need no login (the donation page). A login pre-fills and attributes the gift.
- **Identity:** a supporter is never a staff `membership`; they get their own scoped constructor, limited to their contact's records. The login binds to an **email row**. It auto-matches only when exactly one live contact (not archived/merged/anonymised, email not on hold) has the address; otherwise staff choose. Once made, the binding sticks. Removing the address ends the login.
- **Self-signup:** an unknown address gets a "finish signing up" email. The contact is created only after the link is clicked, with a name asked first, under the new revision `source: 'portal'` (a one-phase loosening).
- **Tokens:** Convex Auth `Email` provider with a shorter expiry (15 min, not the default 1 h). Keep the same-email check at verification on. A confirm-button page (or a 6-digit code) defeats link scanners. The form gives the same reply for every address, with rate limits per address and IP.
- **DD safety:** bank changes go only through GoCardless's hosted Billing Request flow (we store mandate references, never bank details). Every portal DD change emails a notice to the contact. Changing the login email is confirmed on the new address and notified to the old one.
- **Depends on:** the giving module's mandate / recurring-contribution model and the GoCardless integration.
</sv-prose>

<sv-prose id="b12">
## Grill: round 3

One open branch, then the confirmation. Sending this round as **approved** confirms the whole plan, and I then hand it to the controller for building.
</sv-prose>

<sv-ask id="g3q1" round="3">
**Supporter login / portal placement.**
- * its own plan after giving + GoCardless exist, starting from "Carried to the portal plan" above
- its own plan now, in parallel with this one (it would have to guess the mandate model)
- fold it into the giving/GoCardless plan
</sv-ask>

<sv-ask id="g3fin" round="3" role="close">
Round 3: portal placement, and confirmation of the whole plan (design tree, now-steps S1–S8, tests). **Approve = confirmed for building**; revise = tell me what's wrong.
</sv-ask>

<sv-prose id="b13">
## Grill: round 4 (merge ADR)

Two questions left open by the [ADR 0019 draft: merge](/p/adr-0019-merge) (`factory/out/planner-model-adr-0019-merge.md`). Both only matter once merge is built, but they fix how consent and history are read, so better settled before the consent module exists.
</sv-prose>

<sv-ask id="g4q1" round="4">
**Combining consent across a merge.** The survivor's preferences are derived from the combined log of both records, per channel and purpose. Example: the duplicate granted email marketing in 2023, the original withdrew it in 2025.
- * latest event wins. Same person, so their most recent statement stands. The example → withdrawn. A genuine fresh grant made after an old withdrawal is honoured.
- most restrictive wins. Any withdrawal on either record stands until the person grants consent again after the merge. Safer, but it ignores a real later grant.
</sv-ask>

<sv-ask id="g4q2" round="4">
**Does a tombstone keep its name?**
- * keep it. History shows "merged from Ann Smyth", and a search for the old spelling or name lands on the survivor through the redirect. It's the same person's data, and erasure of the survivor anonymises its tombstones too.
- blank it at merge. Less duplicated personal data, but "merged from" shows only an id and old-spelling searches miss. Revisions still hold the name until erasure.
</sv-ask>

<sv-ask id="g4fin" round="4" role="close">
Round 4: the two open questions in ADR 0019. Approve = I fold the answers into the draft, which is then ready for you to accept.
</sv-ask>

</sv-page>
