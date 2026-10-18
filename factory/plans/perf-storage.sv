<sv-page label="plan: performance & storage" category="plans">

<sv-prose id="b1">
# Performance & storage, starting from contact.addEmail

**The question behind this page:** why does adding an email take 90–95 ms, and what would get it reliably under 100? The other three questions (caching, notes as their own aggregate, the revisions table) each bear on it, and each also gets a plain answer of its own.

Layout: short answers → addEmail anatomy and levers → evidence for each question → proposed steps → grill rounds. Numbers marked *est.* are estimates from the schema and code, not measured.
</sv-prose>

<sv-prose id="b2">
## Design tree (confirmed 2026-10-18)

**Added 2026-10-18 after step 0 (factory/out/perf-storage-step0.md):** no payload split (payloads are 35% of revision bytes; split saves 0 ms). `history` cost grows with revision count (~0.11 ms/revision) and gates saves on long histories, so **step 1 also pages the history panel: newest 10 moments, "Load older" for the rest** (human). Restore still works on any revision.

- **addEmail:** levers A (shared-address lookup becomes its own query taking the addresses as args) + B (`groupName` stamped on revisions, so `history` is 2 levels) + C (`list` never kept alive). Keep `knownOver` until a few QC runs pass, then drop the mark. No optimistic "saved"; no change to the budget rule.
  - The stored contact view (thread on §1) stays in reserve: same ms as A, with a new invariant to maintain.
- **Caching:** keep the contact page's own queries (`get`, `history`, `forContact`, `members`, the new `sharedAddresses`) alive ~2 min / ~20 contacts; never `list`; remount per user; measure against addEmail, save and nav. No IndexedDB.
- **Revisions:**
  - Drop `by_tenant_group`; `restoreEntityTo` reads latest-≤-T and latest per contract from `by_tenant_entity_contract`.
  - Shape: one table, full payloads. Step 0 measures real sizes; a payload/envelope split only if payloads dominate (it would need an ADR 0013 amendment).
  - Retention, archiving, export: deferred. "How long do we keep old contact details in history" goes to the consent/GDPR plan; per-tenant export gets built with tenant moves.
  - Dedicated instances run on Starter or above; no engineering for the Free plan's cap.
- **Notes:** stay their own aggregate; their revisions stay out of the contact history (archive is the notes undo).
</sv-prose>

<sv-prose id="b3">
## Short answers

**addEmail (90–95 ms).** About 70–78 ms is fixed cost: network, the save, and the queries the save forces to re-run. The rest is waiting for the next screen frame. Two quirks of the timing decide which frame a sample lands on. "All changes saved" can only appear once every live query on the page has re-run, so the slowest query gates it. And `get` is the slowest because it looks up other contacts that share each email address (4 read levels). Code changes can save about 5–8 ms, which moves most samples onto the 79 ms frame. **No code change makes every sample reliably under 100 while the deployment has occasional 30–100 ms stalls.** Those stalls are what fail the runs now (109, 100). Optimistic rendering doesn't help here: the typed row is already on screen, and the wait is for "saved", which shouldn't be faked.

**1. Instant contact open.** Opening from the list is already fast: 15–33 ms when the row was hovered (the route prefetches), 45–50 ms without. Anything under ~100 ms reads as instant. The real gaps:
- Coming back to a contact after more than 5 s costs a full fetch, because Convex drops a query's result once nothing subscribes. Keeping recent contacts subscribed for a few minutes makes a revisit draw in about one frame, and the data stays live.
- A browser reload takes ~270 ms. Saving query results in the browser (IndexedDB) would cut that, but it leaves personal data on disk on shared charity PCs and makes leaks between users and tenants possible. Not recommended.
- Caching has a cost that bears on addEmail: every query kept alive that a save touches joins the "saved" wait.

**2. Why notes are their own aggregate.** A contract stores the full state of its slice in every revision. As a slice of the contact, every note add would save all of the contact's notes again: 200 notes × 20 KB = 4 MB, four times Convex's 1 MiB document limit. Even small notes make history grow quadratically. Being separate also means two people adding notes never conflict, a contact save never re-runs the notes query, and a note add never re-runs `get` or `history`. That last point keeps notes off addEmail's critical path. The costs: one more subscription per contact page (prefetched in parallel, so no extra wait), merge has to re-point each note, and notes don't appear in the contact's history list.

**3. Revisions table size.** *Est.* ~135k rows and ~70 MB of data for a typical 5,000-contact tenant over 5 years. A heavy tenant reaches ~375k rows and ~320 MB. Convex bills each index as another full copy of the table, and revisions has 3 indexes, so the billed figures are ~0.3 GB and ~1.3 GB. On the shared Pro deployment (50 GB included, then $0.20/GB a month) that is pennies per tenant. On a **free-plan dedicated instance (0.5 GB hard cap)** it is the thing that fills up. Splitting into one table per contract doesn't help: total bytes and index copies stay the same, and it makes history and restore harder. Cheaper levers: drop the index nothing uses (−25% billed), make restore read only what it needs, and later, if real sizes justify it, move payloads out of the indexed rows or archive old ones to file storage. Writing the revision costs the addEmail save under 1 ms, so the shape of revisions isn't what makes addEmail slow.
</sv-prose>

<sv-prose id="b4">
## contact.addEmail: where the 90–95 ms goes

The QC clock runs from the Save click to the first animation frame in which "All changes saved" shows (`paneSaved`, `qc/timing.ts`). That text flips when the `saveForm` promise resolves. Convex holds that promise back until the page's subscriptions have caught up with the write, so the page never shows "saved" next to stale data. The wait therefore includes re-running **every live query the save invalidated**.

| step | ms | source |
|---|---|---|
| click → WebSocket send | ~3 | builder-perf probe |
| network out + back (RTT) | ~28 | QC `rttMs` 25–28 |
| `saveForm` on the server | ~15 | server timings p50 15–18 |
| commit (writes, index updates, revision insert) | ~7 | probe |
| re-run of invalidated queries: **the slowest one** gates the transition | ~11–15 | probe; `get` p50 15.6 before the perf fixes |
| React render | ~2 | probe |
| **subtotal** | **~66–78** | |
| wait for the next frame (16.7 ms grid: 63 / 79 / 95 / 112) | 0–17 | |

**What re-runs after addEmail:**
- `contacts/queries:get` (`contactView`, `convex/contacts/queries.ts:220`): auth, then the contact, children and emails in parallel, then **one `contactsWithEmail` per email**, which is itself an index read followed by reading the other contacts' documents. That makes 4 sequential read levels at ~2.5 ms each. The shared-address warning is half of `get`'s depth.
- `contacts/queries:history`: auth, then 100 revisions, then group names: 3 levels. Invalidated because the save inserts a revision into its index range.
- `contacts/queries:list`, **only if it's still subscribed**: the route loader's prewarm holds it for 5 s, and a cache provider would hold it for minutes. It reads every visible contact's document, and every save patches the contact's root counter, so it re-runs every time (p50 15.3, p95 22.7). It's the heaviest query on the list.
- *Not* `notes.forContact`: it reads only `contactNotes`.

**Why addEmail is slower than `contact.save` (62–80):** the methods contract inserts a row (3 index writes plus a key-ownership read), and `get`'s re-run gains the shared-address levels. Each repeat in the flow adds one more email, but the lookups run in parallel, so the depth stays the same.

### Levers, with expected gain

| lever | expected gain | trade-off |
|---|---|---|
| **A. Move the shared-address lookup out of `get`** into its own query that takes the addresses as args. `get` drops from 4 levels to 2. | ~5 ms on `get`, but only realised if `history` stops being the new slowest (B) | The "also used by" warning for a just-added address arrives one round trip later (~40 ms). It's advisory (ADR 0015), so that's acceptable. |
| **B. Make `history` 2 levels**: store the group name on the revision at insert (it's immutable), so there's no second read. | ~2.5 ms, which lets A count | Schema change (loosen, backfill, tighten). Optional field. |
| A + B together | **~5 ms server, often 16 ms measured**: most samples move from the 95 frame to the 79 frame | Still over on a deployment stall |
| C. Don't keep `list` subscribed while on a contact page (no long-lived list cache) | removes up to ~8 ms and a fat tail when the 5 s prewarm overlaps a save | Going back to the list is a full fetch, ~45 ms, which is fine |
| D. Lighter revision rows (payload split, fewer indexes) | < 1 ms on the save; helps `history` re-run bytes on long histories | See question 3. Pays off for storage, not addEmail. |
| E. Smaller re-render (memoising form sections) | ~1 ms of the ~2 ms render | Not worth it on its own |
| F. Optimistic "saved" | ~60 ms | Shows "saved" before it is. **Not recommended**: the typed row is already on screen, so an optimistic row adds nothing, and an optimistic "saved" is a false claim. A distinct "Saving…" is honest and already exists. |
| G. QC rule for deployment stalls | — | The failing samples (100, 109) look like the deployment stalling, which builder-perf saw with a 22 ms server time inside a 160 ms response. Options: keep `knownOver`, re-measure spikes (already in place), or judge by p95 for this flow. **Raising or exempting needs your OK.** |

Untouchable: the 28 ms RTT (eu-west-1 is the nearest Convex region) and the ~7 ms commit. builder-perf already tried running the revision insert concurrently and saw no gain.
</sv-prose>

<sv-prose id="b5">
## 1 · Caching the contact load: evidence and options

**What happens today (convex 1.47, `node_modules/convex`):**
- The contact route's loader (`src/routes/t.$slug.contacts.$contactId.tsx`) calls `prewarmQuery` for `get`, `history`, `forContact` and `members` when navigation starts, or on hover (`defaultPreload: 'intent'`). `prewarmQuery` subscribes and drops the subscription after `DEFAULT_EXTEND_SUBSCRIPTION_FOR = 5_000` ms.
- `useQuery` unsubscribes on unmount. When a query's subscriber count reaches 0, `local_state.removeSubscriber` deletes it and its result, so there is **no client cache after that point**.
- QC (builder-perf runs): `contacts.nav` 15–33 ms with hover prefetch, 45–50 ms before it (and for anyone who doesn't hover). `contacts.coldLoad` (a full page load) 259–282 ms against a 1,200 ms budget.

| option | revisit / open gain | live correct? | risks and costs |
|---|---|---|---|
| **A. Keep recent queries subscribed.** `ConvexQueryCacheProvider` from convex-helpers 0.1.128 (already a dependency) with its own `useQuery`, defaults 5 min / 250 idle entries; or a small LRU of `watchQuery` handles for the last ~10 contacts. | revisit within the window: 45 ms → ~1 frame | yes: it's still a server subscription | Each kept query re-runs on every write it touches (function calls; Pro includes 25 M a month) and **joins every save's wait** (lever C above). So scope it to per-contact queries and never `list`. Memory: tens of KB per contact. On sign-out or user switch, remount the provider keyed by user id, although the server re-checks tenancy on re-run anyway. |
| B. Longer prewarm hold (`extendSubscriptionFor` 30–60 s) | revisit within the window | yes | Same costs as A, cruder; no LRU bound |
| C. Prefetch rows in the viewport | first open without hover: 45 → ~15 ms | yes | A screen of 50 rows × 4 queries = 200 subscriptions per list view, each re-running on writes. Not worth it. |
| D. Paint the heading from the list row, form after | heading instant; form unchanged | yes | Two-step paint; little real gain at 45 ms |
| E. Persist results in IndexedDB | reload: ~270 ms → first paint ~50–100 ms (*est.*), then live | **no** until the live answer arrives | Personal data at rest on shared volunteer PCs, and it survives anonymisation (rule 3). Must be keyed by deployment + user + tenant + bundle version. Clearing on sign-out isn't guaranteed (a closed tab, or a session revoked elsewhere). Stale data must stay read-only until live; writes are safe anyway, because `expected` counters turn a stale edit into the `stale` merge. Convex has no supported persistence, so we'd own it. |

**Recommendation:** A, scoped to the contact page's own queries (not `list`), with a short window (2 min, ~20 entries), measured against addEmail before and after. No IndexedDB.
</sv-prose>

<sv-prose id="b6">
## 2 · Why notes are their own aggregate

Decided in `factory/plans/contact-model.sv` round 1 (g1q4) and round 2 (g2q6/g2q7). The reasons, from the rules they rest on:

1. **Every contract stores the full state of its slice** (CLAUDE.md conventions; ADR 0013/0017). A `contacts.notes` slice would put every note in every revision. At the 200-note panel cap × 20 KB body cap (`NOTE_MAX_BYTES`, `convex/contacts/rules.ts:254`) that's 4 MB in one document, against Convex's **1 MiB document limit**, so the save fails outright. Short notes don't fix it: *n* notes added one at a time store ~*n*²/2 note copies in history. Fifty 500-byte notes add ~640 KB of revisions for that contact alone.
2. **Independent counters, so no false conflicts.** A slice has one counter. Two staff adding notes to the same contact at once means the second gets `stale` and has to merge. One root per note means concurrent notes never conflict (tested). Notes also split into `contacts.note` (body) and `contacts.noteFlags` (pin/archive), so a pin never makes a body edit stale.
3. **No write contention with form saves.** A notes slice would patch the contact root's counter, so a note add and a form save on the same contact would contend on one document (Convex OCC retries, which cost latency). Separate roots never touch each other.
4. **Smaller re-runs: the addEmail link.** Convex re-runs a query when a document it read changes. `forContact` reads only `contactNotes`, so a contact save doesn't re-run it, and a note add doesn't re-run `get` or `history`. As a slice, every save would re-read up to 200 notes (up to 4 MB) inside addEmail's wait.
5. **Unbounded growth stays paginated.** A table with indexes per section (`by_tenant_contact_archived_pinned`) can be capped and paged (200 live, archived list separate). Child rows inside a payload can't. The 20 KB cap is sized so 200 notes stay far under the 16 MiB per-function read limit.

**What it costs (honestly):**
- One more subscription per contact page (`forContact`, ~13 ms server). It's prefetched alongside `get`, so it adds no extra wait, but it is one more query to run on open.
- Merge (ADR 0019) classes notes as **live** references: the merge action re-points each note through its contract, one revision per note, paginated if large. Anonymisation must also walk the notes.
- Notes revisions live under `entity: 'contactNotes'`, so they **don't appear in the contact's history** and the contact's "restore to time T" doesn't restore notes. Today that's deliberate (archive is the undo); it's a gap if you want a unified timeline.
</sv-prose>

<sv-prose id="b7">
## 3 · The revisions table

**Today** (`convex/schema.ts:80`): one table for every tenant and contract. Each row is the full normalised slice as `payload: v.any()` plus an envelope (tenant, entity, entityId, contract, version, counter, actor, source, group, restoredFrom). It has three indexes:

| index | used by | note |
|---|---|---|
| `by_tenant_entity` | `history` (newest 100), `restoreEntityTo`, tests | needed: time order across contracts |
| `by_tenant_entity_contract` | **nothing** | `restoreEntityTo` *should* use it (below) |
| `by_tenant_group` | **nothing** | intended for "this restore = these revisions"; no caller yet |

**Row size, est.:** envelope ~300 B. Payloads: details ~250 B, methods ~120 B per email/phone, addresses ~250 B each, tags ~40 B per tag, archive and flags ~30 B, a note's body as written (≤ 20 KB). So most rows are ~0.5 KB, a typical note ~0.65 KB, and the worst note ~20.3 KB. (I couldn't sample real rows: the CLI export's WebSocket is blocked in my sandbox. Step 0 below measures them.)

**Growth, 5,000-contact tenant over 5 years (est.):**

| driver | typical | heavy |
|---|---|---|
| creates (~3 slices each) | 15k rows | 15k |
| form edits (1 / 3 per contact per year, ~1.5 slices) | 37.5k | 112k |
| bulk tagging (4 / 12 runs a year × 2,500 contacts) | 50k | 150k |
| notes (1 / 3 per contact per year, +30% edits and pins; avg body 300 B / 1.5 KB) | 32.5k | 97k |
| **rows** | **~135k** | **~375k** |
| **data** | **~70 MB** | **~320 MB** |
| **billed: table + 3 indexes, each priced as another full copy** | **~0.3 GB** | **~1.3 GB** |

Not counted yet: giving. If each contribution is a contract, 1,000 monthly Direct Debit donors add ~60k rows over 5 years. Note bodies: 100 saves of one 20 KB note = 2 MB. That's a lot for one note but harmless overall.

**Convex limits and prices** (docs.convex.dev/production/state/limits, today):
- Limits: 1 MiB per document; 16 MiB read, 32k documents scanned, 16 MiB written per function.
- Storage includes rows and indexes ("each index is priced as another copy of the table"). Free 0.5 GB hard cap; Starter 0.5 GB then $0.22/GB a month; Pro 50 GB then $0.20/GB a month.
- DB I/O: Free 1 GB a month hard cap; Pro 50 GB.
- File storage: $0.03/GB a month on Pro.

**Read patterns:**
- *History per contact:* 100 newest rows, about 50 KB. It runs on open and on every save while the page is open, so it's far from the 16 MiB limit. It reads full payloads only to show "who / when / which slices", which wastes bytes and lengthens addEmail's re-run on long histories.
- *Restore* (`restoreEntityTo`, `convex/lib/contracts.ts:319`) `.collect()`s **every revision of the entity**, payloads included, so each restore costs O(the contact's whole history). At ~0.5 KB per row the 16 MiB / 32k-document ceiling is ~32k revisions, years away. The fix is cheap: per contract, read "latest ≤ T" and "latest" from `by_tenant_entity_contract`, which is two indexed reads per contract.
- *Anonymisation* (rule 3) must scrub personal data inside revision payloads. History is immutable except for erasure. That needs a paginated walk per entity, which the existing index supports.

### Options

| option | storage | addEmail | verdict |
|---|---|---|---|
| Drop `by_tenant_group` (re-add when "undo a group" is built); move restore onto `by_tenant_entity_contract` | −25% billed | ~0 | **do it**: a cheap fix that also bounds restore |
| **Split payload from envelope**: `revisions` keeps the small indexed envelope; `revisionPayloads` holds the payload with one tenant-first index | small for typical rows (the envelope dominates a 0.5 KB row); −20–35% for note-heavy tenants: payloads stored ×2 instead of ×3 | `history` re-run reads ~40% fewer bytes, much more on note-heavy entities | **only if step 0 shows payloads dominate**. Needs a two-phase schema change and an amendment to ADR 0013. |
| One table per contract (your suggestion) | ±0: same bytes, and each table still needs its tenant-first indexes | 0 | **no.** History becomes N queries merged by time. Command groups and restore span tables. Every new contract is a schema change. The upcaster registry is keyed by contract name, so it gains nothing. Typing each table's payload would put history under schema pressure, which ADR 0013/0017's untyped payload exists to avoid. Convex's limits are per function, not per table, so no limit gets better either. |
| Diffs instead of full payloads | −50–80% on edits | 0 | **no.** Restore becomes replay from the first revision or from keyframes, against "contracts are full-state, so no replay". Upcasters would have to transform diffs, which they can't do without rebuilding state. Only note bodies would shrink meaningfully. |
| Retention or compaction | up to −80% | 0 | **later, as a GDPR decision, not a cost one.** Financial and Gift Aid records must be kept ≥ 6 years (rules 1 and 4). Old contact details kept forever in history is a *storage limitation* question in its own right. |
| Archive old payloads to file storage (per tenant per month, gzipped JSONL; envelope stays) | ~25–150× cheaper per archived GB | 0 | **later**, when a tenant passes ~5 GB or a free-plan dedicated instance nears its cap. Costs: restoring an archived revision needs an action; anonymisation must rewrite blobs; tenant moves must carry the files. |
| Per-tenant export (paginated action → JSONL in file storage) | — | — | **needed anyway** (portability, leaving, moving to a dedicated instance). Independent of the storage shape. |

### Shared deployment vs dedicated instances
- **Shared:** tenant-first indexes mean a big neighbour doesn't slow anyone's history query (limits are per function). Storage is pooled: Pro's 50 GB covers ~150 typical tenants' revisions, and a heavy tenant costs ~$0.26 a month in overage against a ~£10/month price point. Any compaction or archiving runs as a Workpool fan-out, one job per tenant. A per-tenant retention period, if ever wanted, lives in `tenantSettings`, never a code flag.
- **Dedicated on the Free plan:** 0.5 GB hard cap including indexes. Revisions are the largest grower, so a typical 5,000-contact charity fills it in roughly 5–8 years (all tables). A heavy one fills it in ~2. This is where the payload split and archiving earn their keep, or the instance goes on Starter.
- **Moving tenants between deployments:** revisions travel inside the snapshot import (shared lineage). Archived blobs would need copying alongside, which is one more reason to postpone archiving.
</sv-prose>

<sv-prose id="b8">
## Steps (as settled in round 1)

Each step is one builder session. Order: 0 → (1 ∥ 3) → 2 → 4.

0. **Measure first** (no committed code). On a QC pool instance:
   - real revision row sizes per contract (a scratch internal query that sums `JSON` byte sizes);
   - per-query re-run times inside an addEmail transition (WebSocket timeline probe, as builder-perf did) on main, to confirm `get` and `history` are the gate.
   Output: `factory/out/…-measure.md`.
1. **Lighter save re-run** (levers A + B). `convex/contacts/queries.ts`: a new `sharedAddresses({ addresses })` query; `contactView` drops the lookup; `warnings()` merges both. `src/components/contact-form.tsx` subscribes to it. Revision `groupName`: an optional field stamped by `executeContract` (`convex/lib/contracts.ts`), a backfill migration, then `history` reads it. Optional, so loosen and backfill only, no tighten. ∥ 3.
2. **Scoped keep-alive cache.** `src/main.tsx` / `src/routes/__root.tsx`: convex-helpers' `ConvexQueryCacheProvider` (`expiration: 120_000`, `maxIdleEntries: 20`), keyed on the signed-in user so it remounts on a user switch. Only the contact page's components (`src/routes/t.$slug.contacts.$contactId.tsx`, `contact-form`, `contact-history`, `contact-notes`) import the cached `useQuery`; the list keeps `convex/react`'s, so it is never held. QC addEmail, save and nav before and after; if a save gets slower, shorten the window. After 1.
3. **Revision indexes**. `restoreEntityTo` reads latest-≤-T and latest per contract from `by_tenant_entity_contract`; drop `by_tenant_group` (removing an index is a safe single deploy). `convex/lib/contracts.ts`, `convex/schema.ts`. ∥ 1.
4. **Drop addEmail's `knownOver`** in `qc/budgets.ts` once three consecutive QC runs after 1–2 pass. Raising or exempting a budget stays out of scope.

**Tests:**
- `sharedAddresses`: tenant B asking about an address used in tenant A sees nothing, and A's snapshot is unchanged. Also: a warning appears after save and vanishes after remove.
- `history` groups by stored name, and old rows fall back.
- Restore with many revisions per contract returns the same state as before (compare against the current implementation's results in the test).
- Cache: after sign-out and sign-in as tenant B's user, no A data is rendered from the cache (QC isolation spec).

**Domain rules that apply:**
- **6 (tenancy):** the new query uses the scoped constructor; the cache is keyed per user.
- **3 (anonymise):** any persisted or archived copy of revisions must be scrubbable, which is why IndexedDB and archiving are deferred.
- **1 and 4 (dated chain, reclaim as a financial record):** retention can never drop Gift Aid or financial revisions within 6 years.
- Rules 2, 5 and 7 aren't touched.
- **ADR:** an amendment to ADR 0013 only if the payload split is chosen later.
</sv-prose>

</sv-page>

<sv-ask id="g1q1" round="1">
**addEmail target.** Code alone gets ~5–8 ms (typical sample 79 instead of 95), but not immunity to deployment stalls. What do you want?
- * do levers A + B (and C via the caching answer), keep `knownOver` until a few QC runs show it passing, then drop the mark
- A + B, and judge addEmail by p95 instead of every sample
- A + B only if step 0 confirms `get` / `history` are the gate; otherwise leave it
- optimistic "saved" (not recommended: it claims a save that hasn't happened)
</sv-ask>

<sv-ask id="g1q2" round="1">
**Caching contact loads.**
- * keep the contact page's own queries alive for ~2 min / ~20 contacts (never `list`), measured against addEmail
- no caching now: 45 ms opens are fine
- keep everything alive (convex-helpers defaults: 5 min, 250 entries), `list` included
- also persist to IndexedDB for faster reloads
</sv-ask>

<sv-ask id="g1q3" round="1">
**Revision indexes and restore.**
- * drop the unused `by_tenant_group` (−25% billed storage), and make restore read per contract from `by_tenant_entity_contract` instead of collecting the whole history
- keep `by_tenant_group` for a future "undo this group"; fix restore only
- leave both as they are
</sv-ask>

<sv-ask id="g1q4" round="1">
**Revision shape.** Your suggestion was one table per contract.
- * keep one table with full payloads; measure real sizes (step 0), and split payload from envelope only if payloads turn out to dominate
- split payload from envelope now
- one table per contract
- store diffs
</sv-ask>

<sv-ask id="g1q5" round="1">
**Retention, archiving, export.**
- * defer all three; raise "how long do we keep old contact details in history" as a GDPR question in the consent/GDPR plan, and build per-tenant export with tenant moves
- decide a retention period now
- plan archiving to file storage now
</sv-ask>

<sv-ask id="g1q6" round="1">
**Notes and the contact's history.** Notes stay their own aggregate either way. Should their revisions show in the contact's history list?
- * no, keep them separate; archive is the notes undo
- yes, read-only entries in the contact timeline (one more query per contact page, outside the save path)
</sv-ask>

<sv-ask id="g1q7" round="1">
**Dedicated instances and the Free plan's 0.5 GB cap.**
- * assume dedicated instances run on Starter or above; no engineering for the free cap
- dedicated instances must fit the Free plan, which brings the payload split and archiving forward
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: what to do about addEmail, caching, revisions storage, and notes in history. Send when done, and comment on any block you want to discuss.
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
**Confirm the plan.** Design tree and steps above reflect round 1 (all as recommended), plus the stored-view idea kept in reserve. Approve to hand steps 0–4 to builders, or send "revise" with what's off.
</sv-ask>
