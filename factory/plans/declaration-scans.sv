<sv-page label="plan: declaration scans" category="archive">

<sv-prose id="b1">
# Plan: scanned paper Gift Aid declarations (phone pairing)

*Planner: planner-scan · started 2026-10-29 · status: **grill complete, confirmed by the human 2026-10-29, ready to build***

Staff working on a laptop scan paper Gift Aid declarations with their phone, without signing in on the phone.

## Design tree

**Agreed before this page (with the controller):**

- **Phone pairing.** The laptop shows a QR code holding a one-time link. The phone opens a bare camera page with no sign-in, photographs, crops and sends. Scans appear on the laptop live, where staff confirm them and match them to a declaration. The link dies when the laptop ends the sitting, after about 15 minutes idle, or at a hard cap of about 2 hours.
- **One pairing per sitting, multi-scan stacks.** Scans attach to the declaration open on the laptop, or go to the inbox for that stack.
- **Safety.** The token can only upload: the phone reads nothing but its own sitting's scans. The first device to open the link claims it with a cookie and others are refused. The pairing is tied to the laptop's staff session and ends on sign-out. It is stored hashed in `platform.db` with org, user, purpose and expiry. Uploads are drafts until staff accept them on the laptop, and the audit line reads "scanned by X via phone pairing". Size and page limits apply, images only, re-encoded on the server. The route sits outside the tenant prefix (`/api/scan/{token}`) and resolves to one org file. Signed-in staff can also open the camera page directly.
- **Storage.** A second SQLite file per org, under the same Litestream and hourly snapshots. Content-addressed by sha256 and immutable, referenced from the declaration (declarations are add-only). Erasure and org deletion cover it.
- **On the phone:** corner detection with draggable corners, perspective correction, greyscale JPEG, 120–250 KB per page (g1q12).

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

**Round 1 (2026-10-29, approved; all as suggested, plus a rider on g1q7):**

- **Files db at `files/<tenant-id>.db`**, in its own directory with its own Litestream entry and snapshot source, stamped with the tenant id. *(g1q1)*
- **`giftaid` owns `declaration_scans`.** A generic `documents` module can take it over later. *(g1q2)*
- **One scan holds 1–6 pages:** "Add page" and "Send" on the phone, plus a merge on the laptop. *(g1q3)*
- **Unmatched scans go to an org-wide "Scans to match" list** until matched or discarded. A discarded scan keeps its row, and its image goes after 30 days. *(g1q4)*
- **Matching is side by side:** the scan beside the declaration form (new, or an existing declaration without a scan). Accept saves both in one command group. *(g1q5)*
- **Starting a pairing needs a sign-in or step-up within the hour** under `strict`, for staff and admins. Viewers can't pair. *(g1q6)*
- **Quotas:** at most 400 KB a page after re-encode, 6 pages a scan, 300 uploads per pairing. The files db is capped at 2 GB per org: Settings shows the usage, and new scans past the cap are refused with "contact us". *(g1q7)*
  - **Rider: "can the scanning page compress if too big?" Yes.** The phone steps down until the page fits: JPEG quality 0.65 → 0.55 → 0.45, then the long edge 1754 → 1500 → 1300 px (about 110 dpi, the floor). The server only refuses what is still over 400 KB, which the phone shouldn't send.
- **Printable form: its own plan, next. AI read-out: parked.** *(g1q8)*
- **Retention: never deleted automatically.** A "can be deleted" report lists scans whose declaration has covered no gift for 7 years, and an admin deletes from it with an audit row kept. *(g1q9)*
- **Erasure:** the scan stays, admin-only, until its retention ends. A scan whose declaration covered no claimed gift is deleted on erasure. *(g1q10)*
- **Phone page:** native camera input, scanic corners (hand-rolled fallback), canvas warp, its own small `scan.html` entry. *(g1q11)*
- **Greyscale JPEG at 150 dpi.** "High contrast" changes only the preview. The server re-encodes, strips EXIF and caps dimensions. *(g1q12)*

**Round 2 (2026-10-29, approved, all as suggested; this confirmed the plan):**

- **Visibility:** staff and admins see scans. Viewers see "✓ scan held" with the date. After erasure, admins only. *(g2q1)*
- **Files-db snapshots: daily** (when changed), then the daily and monthly tiers. Litestream covers the hours in between. *(g2q2)*
- **"Scan with phone" appears in three places:** the contact's Gift Aid panel, the record-gift page when the Gift Aid tick is on, and a stack sitting from the Gift Aid menu (everything goes to "Scans to match"). *(g2q3)*
</sv-prose>

<sv-prose id="b2">
## Goal

Staff can attach a photo of a paper Gift Aid declaration to the declaration they record, scanned with any phone without signing in on it. HMRC 3.7.2 accepts "a scanned image that's an exact replica of a declaration", and 3.29 says the records needn't be on paper. The scan becomes the stored evidence for a `paperForm` declaration. The UI never says the paper may be shredded (our inference, not HMRC's words).

**Out of scope:**
- The printable declaration form: the next plan (g1q8).
- AI read-out of handwriting: parked.
- Building contact erasure and org deletion. This plan only fixes what they must do to scans (g1q10), and a test pins it once they exist.
- Scanning other documents (bank mandates, letters).
- A live viewfinder (`getUserMedia`).
</sv-prose>

<sv-prose id="b3">
## Contracts and tables

| Where | What | Counter | Notes |
|---|---|---|---|
| `platform.db` (`api`'s platform schema, new step) | `scan_pairings`: `id`, `token_hash` (SHA-256 of a 256-bit token), `tenant_id`, `user_id`, `session_id`, `created_at`, `last_used_at`, `expires_at` (created + 2 h), `device_hash` (cookie, set on first open), `ended_at`, `uploads` | n/a (platform, not a contract) | Idle after 15 min of no `last_used_at`. Ends on sign-out, revoke-all (`auth` invariant 4) and `DELETE`. Swept daily. Like GoCardless's org lookup, the row's `tenant_id` is the only way to a file. |
| `files/<tenant-id>.db` (`store`, new) | `_files` stamp (tenant id), `blobs`: `sha256` PK, `bytes` BLOB, `content_type`, `size`, `created_at` | n/a | Content-addressed, immutable, per org (the same bytes in two orgs are two rows). Opened lazily, in the org's LRU slot. Only `store` opens it, and `api` calls `put` / `get` / `delete_unreferenced`. Domain crates never see it (rule 6). Its own append-only migration list. |
| org file: `declaration_scans` (`giftaid`) | root: `id`, `status` (`draft`/`accepted`/`discarded`), `via` (`phone`/`direct`), `pairing_id?`, `scanned_by`, `scanned_at`; child `pages[]` carrying ids: `sha256`, `page_no`, `width`, `height`, `size` | `scan_version` | **`giftaid.scan`**: the upload creates the draft, with pages reorderable or removable while it's a draft (and the merge from g1q3). Refused once it isn't a draft. |
| | `declaration_id?`, `reviewed_by`, `reviewed_at`, `discard_reason?` | `review_version` | **`giftaid.scanReview`**: accept (sets `declaration_id`; the declaration must be `paperForm`, the same contact's, and not void) or discard. In the same named command group as `giftaid.declaration`'s create when the declaration is new (g1q5). |
| | `image_deleted_at`, `deleted_by?` | `retention_version` | **`giftaid.scanRetention`**: records that the images went (the 30-day discard purge, the admin's "can be deleted" report, erasure). The `api` job deletes the blobs after this commits. The row stays forever (rule 3). |

**Reads:** the inbox ("Scans to match": drafts plus accepted-nothing, oldest first), a pairing's stack, a declaration's scans, the "can be deleted" report (accepted scans whose declaration covered no gift in 7 years: giving's `describe_gift` through giftaid's coverage), and files-db usage per org.

**Schema:** one org step adds `declaration_scans` and `declaration_scan_pages` with indexes on `(status, scanned_at)`, `declaration_id` and `pairing_id`. It's new tables only, so there's nothing to loosen, backfill or tighten. One platform step adds `scan_pairings`. Files db: its own step 1.

**Two files, no shared transaction:** upload = re-encode → `put` blob (idempotent by sha) → `giftaid.scan` commit. A blob with no page row is an orphan, and `delete_unreferenced` sweeps it after 24 h. Deletion is the other way round: contract first, blob after.

**ADR:** propose an amendment to ADR 0024 (each org has two files; moving or restoring an org means both; the files db is outside contracts and revisions because it's immutable). The controller or human writes it.
</sv-prose>

<sv-prose id="b4">
## Steps

| # | Step | Files | After |
|---|---|---|---|
| 1 | **store: the files db.** `files/<tenant-id>.db`, stamped and migrated, opened lazily in the org's LRU slot; `put`/`get`/`usage`/`delete_unreferenced`; the 2 GB cap check. Ops: a Litestream `dir: /data/files` entry, the snapshot job's new source (daily when changed, g2q2), `restore.sh` and the drill restore both files. | `server/crates/store`, `api/src/backup.rs`, `server/litestream.yml`, `scripts/ops/`, `docs/ops.md` | none |
| 2 | **giftaid: scans.** The schema step plus fixture, the three contracts, the reads, upcaster-ready versions, unit tests of the rules (accept only onto `paperForm`, same contact, not void; drafts only edited while draft). | `server/crates/giftaid`, `api/src/schema.rs`, `api/tests/schema.rs` | none (**parallel with 1**) |
| 3 | **api: pairing and upload.** The platform step; `POST/DELETE /api/t/{slug}/scan-pairings` (staff or admin, step-up under strict); `GET /api/scan/{token}` (claim, `HttpOnly; SameSite=Strict; Secure` device cookie, 410 when dead); `POST /api/scan/{token}/scans` and `…/scans/{id}/pages` (token and cookie checked before the body is read, 1 MB body limit, decode with the `image` crate under dimension and pixel limits, re-encode greyscale JPEG without EXIF, ≤ 400 KB, 300 uploads); direct `POST /api/t/{slug}/scans` for a signed-in phone; `GET /api/t/{slug}/scans/{id}/pages/{n}` (image, `Cache-Control: private`, admin-only once erased); jobs: pairing sweep, orphan blob sweep, 30-day discard purge; revoke-all ends pairings. Routes plus isolation tests. | `api/src/routes/scans.rs`, `api/src/lib.rs`, `api/src/jobs.rs`, `api/src/auth*` | 1, 2 |
| 4 | **SPA laptop side.** "Scan with phone" on the contact's Gift Aid panel and the record-gift page: a QR dialog (with the link to copy), the live stack via SSE (`declaration_scans` events), the side-by-side review with the declaration form, merge, "Scans to match", files usage in Settings, the "can be deleted" report (admin). | `src/routes/…`, `src/lib/data/`, `src/lib/domain/` | 3 |
| 5 | **Phone page.** `scan.html`, its own Vite entry (no React app bundle; size budget: < 150 KB gzipped plus scanic's WASM). Native camera input, `createImageBitmap`, scanic corners with draggable handles (hand-rolled fallback), homography warp to 1240×1754, greyscale, the stepped compression (g1q7 rider), "Add page"/"Send", retry on network loss, a "link ended" screen. | `scan.html`, `src/scan/` | 3's API (**parallel with 4**) |
| 6 | **QC and review.** A Playwright flow: two contexts (laptop + "phone" with a fixture photo via `setInputFiles`), pair → scan → accept, timing budget for the upload-to-laptop path; a reviewer on the security surface (token, cookie, body, decoder). | `qc/` | 4, 5 |

One builder for 1 + 2 (or two in parallel), one for 3, then two in parallel for 4 and 5. A security-focused review after 3.
</sv-prose>

<sv-prose id="b5">
## Tests

- **Isolation (every route):** B never sees A's scans or images. A's scan ids under B's slug → 404. A token minted for A reaches only A's file: the route has no slug to swap, so the test asserts the pairing row's tenant is the file opened, and that a forged or B-minted token cannot touch A. A sha from A asked for under B → 404 even when B holds the same bytes (per-org content addressing).
- **Pairing:** an expired, idle, ended or revoked token → 410. A second device (no cookie, or another one) → 403. Sign-out and revoke-all end it. Starting under strict without step-up → 403 `step_up`. A viewer → 403. The token is stored hashed and never logged (a log-capture test).
- **Upload:** an oversize body is refused before it is read in full. Also refused: a non-image, a too-many-pixels image or decompression bomb, a 7th page, the 301st upload, the org past 2 GB. The re-encoded output has no EXIF, is greyscale and is ≤ 400 KB.
- **Two files:** blob written and contract refused → no draft, and the orphan sweep removes the blob after 24 h but never a referenced one. Deletion commits the contract before the blob goes.
- **Rules:** accept only onto a `paperForm`, same-contact, non-void declaration. Declarations stay create-only, and accepting a scan writes no `declaration_version`. A scan never changes coverage (rule 1). Accept with a new declaration is one command group: both or neither.
- **Retention:** nothing deletes an accepted scan automatically. The report lists one only after 7 years without a covered gift. A discarded scan's images go at 30 days and its row stays.
- **Erasure (pinned for when it's built):** a scan covering a claimed gift stays and becomes admin-only. One that covered no claimed gift is deleted.
- **Backups:** the restore drill restores an org with its files db, and the snapshot job lists `files/`.
- **Domain rules that apply:** 1 (a scan is evidence for one declaration in the chain and never changes coverage), 3 (erasure anonymises, and the scan is the tax record), 4 (a claim's declarations can show their evidence), 6 (the files db is one org's, stamped, and only `store` opens it). Rules 2, 5 and 7 don't apply.
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

<sv-ask id="g2q1" round="2">
**Who can see a scan.** It shows a donor's name, home address and signature. Viewers can read declarations today.
- * Staff and admins see scans. Viewers see "✓ scan held" with the date. After erasure, admins only
- Everyone who can see the declaration sees the scan
</sv-ask>

<sv-ask id="g2q2" round="2">
**Snapshot cadence for the files db.** It can reach 2 GB, and the hourly job copies a changed file whole (`VACUUM INTO`, zstd, upload). Blobs are immutable, and Litestream already replicates every second.
- * Daily (at most once a UTC day, when it changed), then the usual daily and monthly tiers. Litestream covers the hours in between
- Hourly like an org file, when it changed
</sv-ask>

<sv-ask id="g2q3" round="2">
**Where "Scan with phone" appears.**
- * On the contact's Gift Aid panel (record a declaration from a paper form), on the record-gift page when the Gift Aid tick is on, and as a "sitting" from the Gift Aid menu for a stack (everything to "Scans to match")
- Only the stack sitting from the Gift Aid menu
</sv-ask>

<sv-ask id="g2fin" round="2" role="close">
Round 2, the last: scan visibility, files-db snapshots, where scanning starts. **Approving this round confirms the whole plan as written above**, with these answers folded in, ready to build. Choose "revise" if anything above needs another pass.
</sv-ask>

</sv-page>
