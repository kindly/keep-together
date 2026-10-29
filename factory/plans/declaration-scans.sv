<sv-page label="plan: declaration scans" category="plans">

<sv-prose id="b1">
# Plan: scanned paper Gift Aid declarations (phone pairing)

*Planner: planner-scan · started 2026-10-29 · status: **grill round 1 open***

Staff working on a laptop scan paper Gift Aid declarations with their phone, without signing in on the phone.

## Design tree

**Agreed before this page (with the controller):**

- **Phone pairing.** The laptop shows a QR code holding a one-time link. The phone opens a bare camera page with no sign-in, photographs, crops and sends. Scans appear on the laptop live, where staff confirm them and match them to a declaration. The link dies when the laptop ends the sitting, after about 15 minutes idle, or at a hard cap of about 2 hours.
- **One pairing per sitting, multi-scan stacks.** Scans attach to the declaration open on the laptop, or go to the inbox for that stack.
- **Safety.** The token can only upload: the phone reads nothing but its own sitting's scans. The first device to open the link claims it with a cookie and others are refused. The pairing is tied to the laptop's staff session and ends on sign-out. It is stored hashed in `platform.db` with org, user, purpose and expiry. Uploads are drafts until staff accept them on the laptop, and the audit line reads "scanned by X via phone pairing". Size and page limits apply, images only, re-encoded on the server. The route sits outside the tenant prefix (`/api/scan/{token}`) and resolves to one org file. Signed-in staff can also open the camera page directly.
- **Storage.** A second SQLite file per org, under the same Litestream and hourly snapshots. Content-addressed by sha256 and immutable, referenced from the declaration (declarations are add-only). Erasure and org deletion cover it.
- **On the phone:** corner detection with draggable corners, perspective correction, greyscale or threshold, about 100 KB per page (revised by the research: g1q12).

**Facts from the code (2026-10-29), shaping the questions below:**

- `orgs/<id>.files.db` **can't** sit in `orgs/`. The boot migration takes every `orgs/*.db` for an org file (`store::migrate::org_files` filters on the `db` extension) and would refuse it on the stamp check. The snapshot job skips it (it wants `<32 hex>.db`). Litestream's `orgs/*.db` pattern would pick it up. → g1q1.
- **Declarations are create-only** (`giftaid.declaration`, `declaration_version`). A scan can't be a field on one. It needs its own slice or its own root. → g1q2.
- **Step-up is per deployment, not per org.** `KEEP_AUTH_POLICY=strict` (the default, and the only one prod allows) makes admin routes need a sign-in or step-up within `STEP_UP_MS` (1 h). There are no "strict-policy orgs". → g1q6.
- **Precedent for a route outside the tenant prefix that reaches one org:** `/api/gocardless/webhook` and `/callback` resolve an org through a `platform.db` row. The pairing does the same.
- **Bodies:** every body is read whole before routing (2 MB default, 30 s), and on `/api/t/*` the session is checked before the body is held. `/api/scan/{token}` checks the token hash **before** reading the body, with its own limit.
- **Erasure and org deletion aren't built yet** (no code anonymises a contact or removes an org). This plan says what they must do to scans. Building them is out of scope.
- **ADR 0024 says "moving an organisation means copying its file".** With a files db it becomes two files, and ADR 0024 needs an amendment (proposed below, not written by me).

**Facts from the research (2026-10-29).** HMRC is cited from [Chapter 3](https://www.gov.uk/government/publications/charities-detailed-guidance-notes/chapter-3-gift-aid).

- **3.7.2:** "a clear auditable record of declarations". Acceptable evidence includes "a scanned image that's an exact replica of a declaration". But "the transcribing of declarations … into a database will not satisfy the requirements". **The image is the record. The typed fields are not.** "Exact replica" argues for greyscale over a hard threshold that could lose a faint tick or signature. → g1q12.
- **3.29:** "The charity does not have to keep records on paper", given regular back-ups kept off the computer (Litestream plus the locked snapshot bucket do that). No sentence says "you may shred the paper after scanning". That follows from 3.7.2 plus 3.29, but it is our inference, so the UI shouldn't claim it.
- **3.30.1:** enduring declarations covering ongoing donations are kept "permanently". Once donations stop, the clock runs from the last donation. **3.30.2** (charitable companies): 6 years after the end of the accounting period. **3.30.3** (trusts): the later of 6 years after the tax year or 12 months after that year's claim. **3.30.4:** penalties for destroying required records. → g1q9, g1q10.
- **Camera:** `<input type="file" accept="image/*" capture="environment">` uses the native camera at full resolution with focus and flash. It works over plain HTTP (the tailnet dev URL) and in in-app browsers. `getUserMedia` needs HTTPS, is capped around 720p on iOS, and has no `takePhoto` on iOS. Listing `image/heic` in `accept` triggers a Safari 17 conversion bug, so use `image/*` only. `createImageBitmap(file)` applies the EXIF rotation. The iOS Camera app's QR banner opens the link in the default browser. → g1q11.
- **Corners and warp:** OpenCV.js is 7–11 MB (jscanify needs it), too heavy for a phone. **scanic** (MIT, Rust → WASM, < 100 KB gzipped) gives four corners and a warp. Hand-rolled (Sobel, largest quadrilateral, 3×3 homography with bilinear sampling) is about 5 KB. Since staff drag the corners anyway, detection only needs to be a first guess. → g1q11.
- **Format:** Safari can't encode WebP from canvas (it silently falls back to PNG). Greyscale JPEG at 150 dpi (1240×1754) and quality 0.65 is about 120–250 KB a page (estimated). A 1-bit PNG is about 50–120 KB.

*Rounds fold in here as they come back.*
</sv-prose>

<sv-prose id="b2">
## Goal

Staff can attach a photo of a paper Gift Aid declaration to the declaration they record, scanned with any phone without signing in on it. HMRC 3.7.2 accepts "a scanned image that's an exact replica of a declaration", and 3.29 says the records needn't be on paper. The scan becomes the stored evidence for a `paperForm` declaration, so a group can stop filing paper.

**Out of scope:** our own printable declaration form and AI read-out of handwriting (g1q8 decides whether either becomes a later plan); building contact erasure and org deletion (this plan only says what they must do to scans); scanning other documents (bank mandates, letters), unless g1q2 picks a generic module.
</sv-prose>

<sv-prose id="b3">
## Contracts and tables

*Draft, sharpened after round 1.*

| Where | What | Counter | Notes |
|---|---|---|---|
| `platform.db` (`api`, new platform schema step) | `scan_pairings`: `token_hash`, `tenant_id`, `user_id`, `session_id`, `purpose`, `created_at`, `last_used_at`, `expires_at`, `claimed_by` (device cookie hash), `ended_at` | n/a (platform, not a contract) | Like GoCardless's org lookup. Swept by a job. Ends when its session is revoked. |
| files db (`store`, new) | `blobs`: `sha256` PK, `bytes`, `content_type`, `size`, `created_at`. Stamped with the tenant id like an org file | n/a | Content-addressed and immutable. Only `store` opens it, and `api` calls it. Domain crates never touch it. |
| org file (`giftaid`, g1q2) | `declaration_scans` root: `id`, `pages[]` (child rows carrying ids: `sha256`, `page_no`, `width`, `height`, `bytes`), `status` (`draft`/`accepted`/`discarded`), `declaration_id?`, `via` (`phone`/`direct`), `pairing_id?`, `scanned_by`, `scanned_at` | `scan_version` | **`giftaid.scan`**: the upload creates a draft. Accepting or discarding is **`giftaid.scanReview`** (`review_version`), and linking to a declaration happens in the same command group as the declaration's create. |

Schema (one transactional step each): add `declaration_scans` plus an index on `(status, scanned_at)` and on `declaration_id`. It's a new table, so no loosen/backfill/tighten.
</sv-prose>

<sv-prose id="b4">
## Steps (draft)

1. **store: the files db.** `files/<tenant-id>.db` (g1q1), opened lazily beside the org handle in the same LRU slot, stamped, with its own tiny migration list. `put(bytes) -> sha256` and `get(sha256)`. Litestream dir entry, snapshot source, `restore.sh`, drill. *(store, api/backup.rs, server/litestream.yml, scripts/ops/)*
2. **giftaid: scans.** The `declaration_scans` schema, `giftaid.scan` and `giftaid.scanReview`, reads (the inbox, a declaration's scans), isolation tests. *(giftaid, api/schema.rs, api/tests/schema.rs)* Can run **in parallel with 1**.
3. **api: pairing + upload.** The `scan_pairings` platform schema; `POST /api/t/{slug}/scan-pairings` (start, staff or admin), `DELETE` (end); `GET /api/scan/{token}` (claim and set the cookie), `POST /api/scan/{token}/scans` (upload: token before body, size limit, decode and re-encode, blob then contract); the sweep job; ends on revoke-all. *(api/src/routes/scan.rs, auth hooks)* After 1 and 2.
4. **SPA: the laptop side.** QR dialog, live stack (SSE), side-by-side review with the declaration form, the inbox. *(src/routes, src/lib/data)* After 3.
5. **SPA: the phone page.** Camera, corners, warp, greyscale, upload, offline retry. A separate small entry so the phone never loads the app bundle (g2). Can run **in parallel with 4**, against step 3's API.
6. **QC + review.** Playwright flow with a fake camera (Chrome `--use-file-for-fake-video-capture`), budgets.
</sv-prose>

<sv-prose id="b5">
## Tests (draft)

- **Isolation:** org B never sees A's scans; A's scan ids under B's slug → 404; **a pairing token minted for A can't write to B** (its route has no slug to swap, so the test is that the row's tenant is the only file it opens), and a files-db sha from A asked for under B → 404, even when the same bytes exist in both (content addressing is per file, never global).
- Pairing: an expired, ended or revoked token → 410. A second device → 403. Upload before claim → refused. Sign-out ends the pairing. The token is stored hashed, never logged.
- Upload: a non-image, an oversize body (refused before it is read in full), too many pages, a decompression bomb → 422/413. Re-encode strips EXIF (location).
- Two-file order: blob written, contract fails → no draft. The orphan sweep removes the blob after N hours.
- Declarations stay create-only. A scan links in the same command group as the declaration's create (or through `scanReview` for an existing one).
- Rules: retention and erasure tests from g2.
- **Domain rules that apply:** 1 (dated chain: a scan is evidence for one declaration in the chain and never changes coverage), 3 (erasure anonymises, and the scan is a tax record: g2), 4 (indirectly: a claim's declarations show their evidence), 6 (the files db is one org's, stamped, and only `store` opens it). Rules 2, 5 and 7 don't apply.
</sv-prose>

<sv-ask id="g1q1" round="1">
**Where the files db lives.** `orgs/` is globbed as "every `*.db` here is an org file" by the boot migration (and as "every `*.db`" by Litestream). A second file there means teaching three listers to skip it, and the next lister to come along will forget.
- * `files/<tenant-id>.db`: its own directory, its own Litestream entry and snapshot source, same tenant-id stamp
- `orgs/<tenant-id>.files.db`, with the boot migration, snapshot job and restore taught to tell the two apart
</sv-ask>

<sv-ask id="g1q2" round="1">
**Who owns a scan.** Declarations are create-only, so a scan is its own root that points at a declaration (and can exist before one, in the inbox).
- * `giftaid` owns `declaration_scans`. Scans are Gift Aid evidence today, and a later "documents" module can take them over if bank mandates or letters come along
- a new generic `documents` crate now (any record can have attachments), with Gift Aid as the first user
</sv-ask>

<sv-ask id="g1q3" round="1">
**Multi-page forms.** Most declarations are one side of A4. Some (sponsorship sheets, two-sided forms) are more.
- * One scan holds 1 to N pages: the phone has "Add page" and "Send". The laptop can also merge two scans into one. Cap 6 pages
- Every photo is its own scan, and the laptop groups them
- Single page only for now
</sv-ask>

<sv-ask id="g1q4" round="1">
**What the inbox does with a scan nobody matched** (the sitting ended, or nobody had a declaration open).
- * It stays in an org-wide **"Scans to match"** list (every staff member sees it, not just the scanner) until someone matches it to a declaration or discards it. A discarded scan keeps its row (who discarded it and when), and its image is deleted after 30 days
- Same, but the inbox is per staff member
- Unmatched scans are deleted when the sitting ends
</sv-ask>

<sv-ask id="g1q5" round="1">
**Matching on the laptop.** When a scan arrives, what does the screen do?
- * Side by side: the scan on the left, the declaration form on the right (a new declaration for the contact open, or pick an existing declaration that has no scan). Accept saves both in one command group
- The scan only attaches to a declaration that already exists. Staff record the declaration first, then scan
</sv-ask>

<sv-ask id="g1q6" round="1">
**Starting a pairing under `strict`.** A pairing hands write access to another device, like an admin action. Step-up is per deployment (`strict` everywhere but the tailnet preview), and only admin routes need it today.
- * Starting a pairing needs a sign-in or step-up within the hour (under `strict`), for staff and admins alike. Viewers can't pair
- No step-up: any signed-in staff member can pair
</sv-ask>

<sv-ask id="g1q7" round="1" pick="many">
**Quotas per org.** At about 100 KB a page, 1,000 declarations is about 100 MB.
- * At most 400 KB a page (after re-encode), 6 pages a scan, 300 uploads per pairing
- * The files db is capped at 2 GB per org. Settings shows the usage, and new scans are refused past the cap, with a message to contact us
- No per-org cap for now
</sv-ask>

<sv-ask id="g1q8" round="1">
**Later options: the printable form and AI read-out.** A printable form would carry HMRC's model wording, boxes for the fields, and a QR code with the wording version and source code. An AI read-out would read the handwriting and pre-fill the form: off by default and needing a DPA with the provider.
- * Both out of this plan. The printable form gets a plan of its own next (the QR also makes matching easier). The AI read-out is parked until someone asks
- Printable form in this plan, AI read-out parked
- Both in scope
</sv-ask>

<sv-ask id="g1q9" round="1">
**Retention of an accepted scan.** HMRC: enduring declarations covering ongoing donations are kept permanently. Once donations stop, it's 6 years after the end of the accounting period (companies), or the later of 6 years after the tax year and 12 months after that year's claim (trusts). The legal form isn't in our data, and getting it wrong means destroying a required record (3.30.4).
- * Never deleted automatically. A report lists scans whose declaration has covered no gift for 7 years ("can be deleted"), and an admin deletes them from it, with an audit row kept
- Automatic deletion 7 years after the last covered gift, with an org setting to turn it off
- Keep forever, no deletion at all
</sv-ask>

<sv-ask id="g1q10" round="1">
**Erasure of a contact with a scanned declaration** (when erasure is built). The scan holds name, address and signature, but it is the tax record (3.7.2), so the anonymised contact still needs it while retention runs.
- * The scan stays, viewable only by admins, until g1q9's retention ends for it. Then the erasure deletes it. A scan of a declaration that covered no claimed gift is deleted on erasure
- The scan is deleted on erasure. The typed declaration stays (weaker evidence: 3.7.2 says transcriptions don't count)
</sv-ask>

<sv-ask id="g1q11" round="1">
**The phone page's tech.**
- * The native camera (`<input capture="environment">`: full resolution, focus and flash, works on plain HTTP). Then corners from **scanic** (WASM, < 100 KB), falling back to a ~5 KB hand-rolled detector if its WASM fights the Vite build. Then a canvas homography warp. A separate small entry point (`scan.html`), so the phone never loads the app bundle
- A live viewfinder (`getUserMedia`) with auto-capture when the page is steady: slicker, but HTTPS only and about 720p on iOS
- No corner detection: staff drag four corners by hand
</sv-ask>

<sv-ask id="g1q12" round="1">
**How a page is kept.** HMRC wants "an exact replica".
- * Greyscale JPEG at 150 dpi (about 120–250 KB a page), with a "high contrast" toggle for faint pencil that only changes the preview, never what's stored. The server re-encodes (strips EXIF, caps dimensions)
- 1-bit black-and-white PNG (about 50–120 KB): smaller and crisper, but can drop a faint tick or signature
- Colour JPEG
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
Round 1: where scans live, who owns them, pages, the inbox, matching, step-up, quotas, later options, retention, erasure, the phone page's tech, and image format. Send when done.
</sv-ask>

</sv-page>
