<sv-page label="plan: search" category="plans">

<sv-prose id="tree">
## Design tree

*Designed and built overnight by the controller on the human's instruction (2026-10-18: "design by you, build it without grilling, deploy, and make a post-hoc grill page with decisions made"). Every decision below is already in the build. Change any answer in the round at the bottom and send: the controller reworks it.*

- **Goal:** a staff member finds a contact from whatever they have in front of them (a name, part of an email, a phone number, a postcode, a street, an old reference, an organisation) in one search box, under the 100 ms rule.
- **Mechanism: a search projection.** New table `contactSearch {tenantId, contactId, text, archived, kind}`, one row per contact, with a Convex search index on `text` (filter fields `tenantId`, `archived`, `kind`).
  - It's *derived* data, not a domain aggregate: it's rebuilt from the contact's current state inside the same transaction as every contact contract that changes a searchable slice (a projection hook in `executeContract`), so it's never stale and needs no contract or revisions of its own.
  - Backfilled once for existing contacts (migrations component), then the list search switches to it.
- **What's searchable:** names (given, family, nickname, organisation name, sort name), every email address (also split at `@` and `.` so "gmail" or "smith" match), every phone (digits only, so "07700 900123", "07700900123" and "900123" match; it also indexes the last 6 digits), postcodes (with and without the space), address line 1 and town, external identifier values, and tag names.
- **Not searchable (for now):** note bodies (large, sensitive, and they'd bloat every save; a separate opt-in later), relationship names, history.
- **Matching:** Convex full-text search: whole words, last word as a prefix ("smi" finds Smith), all words must match. Text is lowercased and accent-folded ("Zoë" ↔ "zoe"). **No typo tolerance**: Convex has none, and faking it (n-grams) would blow the projection size and the 100 ms budget.
- **Ranking:** exact matches first, as today: an exact email, an exact identifier, then **new: an exact phone** (normalised), then the full-text results in Convex's relevance order.
- **Filters:** the existing archived toggle and tag filter, plus **new: kind** (individual / organisation / household) as a filter chip. Kind and archived go to the search index; tag is intersected after.
- **Limits:** up to 100 results with the existing `truncated` notice. The search runs within the 100 ms rule (a QC flow per search kind).
- **Deferred:** saved searches and smart groups (segments) → the comms plan, where mailing lists need them; notes search; search across tenants (never).
</sv-prose>

<sv-prose id="steps">
## Steps (built overnight)

1. **Q1: projection + backfill.** `contactSearch` table and search index (new table, an additive schema change), the pure `searchText(contact, children)` builder in `convex/contacts/search.ts` with unit tests, the projection hook run by every contact contract that touches a searchable slice, and a backfill migration. The list search is unchanged in Q1.
2. **Q2: switch the search.** `list` uses the projection plus the exact-phone match plus the kind filter; the UI gets the kind filter chip and a hint line ("Search by name, email, phone, postcode, street or reference"); QC flows `contacts.search.phone`, `.postcode`, `.emailPart`, `.org` (repeatable, under 100 ms) and two-tenant isolation for every new path. `search_name` stays until Q2 has rolled out everywhere, then a later commit drops it.

Rollout: Q1 merge → deploy everywhere → run the backfill → Q2 merge → deploy.
</sv-prose>

<sv-ask id="s1q1" round="1">
**What one search box finds.**
- * names, all emails (incl. parts), phones (digits, last 6), postcodes, address line 1 + town, identifier values, tag names
- names and emails only
- the above plus note bodies
</sv-ask>

<sv-ask id="s1q2" round="1">
**How it's stored.** Convex indexes one text field per search index.
- * a derived `contactSearch` row per contact, rebuilt in the same transaction as each contact save
- a `searchText` field on the contact document itself (bigger contact docs; every save rewrites it anyway)
- a scheduled background rebuild (cheaper saves, but search lags a moment behind edits)
</sv-ask>

<sv-ask id="s1q3" round="1">
**Typo tolerance.** Convex search has none.
- * none for now: prefix and whole-word only, accent-folded
- add trigram tokens (finds "smyth" for "smith"; the projection about 3× larger, slower saves)
</sv-ask>

<sv-ask id="s1q4" round="1">
**Exact matches ranked first.**
- * exact email, exact identifier, exact phone, then the full-text results
- full-text relevance only
</sv-ask>

<sv-ask id="s1q5" round="1">
**Filters next to the search box.**
- * archived (existing), tag (existing), plus kind: individual / organisation / household
- also "has email" / "has phone" / "has postcode"
- none beyond what exists
</sv-ask>

<sv-ask id="s1q6" round="1">
**Saved searches and smart groups.**
- * deferred to the comms plan (segments for mailing lists)
- build saved searches now
</sv-ask>

<sv-ask id="s1q7" round="1">
**Notes in search.**
- * not searched now; a separate opt-in later
- searched now, in the same projection
</sv-ask>

<sv-ask id="s1fin" round="1" role="close">
Decisions already built overnight. Send as-is to confirm, or change answers and the controller reworks.
</sv-ask>

</sv-page>
