// Client-perceived budgets per flow (factory/plans/qc-suite.sv, Latency).
// Times are raw: from the input event to the result on screen, network
// included, with no round-trip allowance.
//
// Two tiers (human, 2026-10-23; ADR 0018 amendment):
//
// - **The failing line, `maxMs`.** A flow passes when **every** sample is
//   under it; there is no median. Only the line decides pass and fail.
// - **The target, `targetMs`: tracked, never failed.** A flow whose median
//   is at or over its target, or whose median rose by 16 ms or more against
//   its last 5 runs in history, is listed in the TARGET banner every run
//   and marked in the trend report (qc/target.ts).
//
// - repeatable: anything a user can do more than once per signed-in
//   session. Line 150 ms, target 100 ms.
// - oncePerSession: sign-in and the first page load. Their own budgets,
//   recorded first: 1.5× the worst sample of three `QC_MODE=record` runs,
//   rounded up to 10 ms (step 9b). No target.
// - infrequent: creating a record (a new contact). Done less often than the
//   edits that follow it (human, 2026-10-19): line 200 ms, target 150 ms;
//   every later edit of that record is repeatable.
// - rare: done seldom (restoring a contact from its history) (human,
//   2026-10-21): line 250 ms, target 200 ms.
// - bulk: an action over many records at once (setting a field on up to
//   100 contacts).
//   Exempt from the repeatable line, with a progress state in the UI; its
//   own budget is recorded like oncePerSession's (human, 2026-10-17). No
//   target.
//
// **Raising a budget, or exempting a flow, needs the human's explicit
// OK.** A flow over budget means fixing the code.
//
// Every flow here must be timed in each assert run, or the run fails
// (qc/reporter.ts). `pending: true` marks one whose spec isn't written yet
// (QC steps 6–8): untimed, it only warns. Drop the mark with the spec.
//
// A judged flow with any sample at or over its line is re-measured once
// (K fresh samples) and fails only if that set is over too
// (qc/timing.ts; ADR 0018's base rule, migration-rust F3).
//
// `knownOver` is an exception the human approved: the flow is still timed
// and recorded in full, but being over budget doesn't fail the run. Every
// run lists every knownOver flow in a banner, timed or not, so it can't be
// forgotten. Remove the mark with the fix. None is set today (the two
// there were lifted with the two-tier budgets, human 2026-10-23).
//
// `pendingPort: '<step>'` marks a flow of a module the Rust backend
// doesn't serve yet (migration-rust.sv; its tests are in qc/pending.ts).
// Untimed, it is listed in the run's banner instead of failing it. The
// step that ports the module drops the mark.

import { qcTarget } from './target.ts'
import type { QcTarget } from './target.ts'

export type FlowKind =
  'repeatable' | 'infrequent' | 'rare' | 'oncePerSession' | 'bulk'

export interface Budget {
  kind: FlowKind
  /** The failing line: every sample must be under this, in ms. */
  maxMs: number
  /** Tracked, never failed: a median at or over this is flagged, in ms. */
  targetMs?: number
  /** The harness's own self-test: never in history, never fails the run. */
  selfTest?: true
  /** No spec times it yet: missing from a run warns instead of failing. */
  pending?: true
  /** Its module isn't on the Rust backend yet: the step that ports it. */
  pendingPort?: string
  /** Approved exception, "<reason> (<who> <date>)": over budget never fails. */
  knownOver?: string
  /**
   * Timed only against the GoCardless fake: untimed in a run whose tests
   * skipped for another mode (`gocardlessNotFake`, staging's sandbox), it
   * is listed in the GOCARDLESS banner instead of failing the run.
   */
  fakeGoCardless?: true
}

const repeatable = { kind: 'repeatable', maxMs: 150, targetMs: 100 } as const
const infrequent = { kind: 'infrequent', maxMs: 200, targetMs: 150 } as const
const rare = { kind: 'rare', maxMs: 250, targetMs: 200 } as const
// An action over many records at once, or a page's photo work: 500 ms
// (human, 2026-11-01, for every bulk flow and every BULK_ROUTES route;
// keep-qc's page-upload flows have their own line, QC_FIXED).
const bulk = { kind: 'bulk', maxMs: 500 } as const
const fake = { fakeGoCardless: true } as const

export const budgets = {
  // Step 9b, recorded 2026-10-18 in runs tn357fbu, tn35ew84, tn35t6tx
  // (sha 1cd6e46): signIn worst 488 ms, coldLoad worst 272 ms, bulkTag (since
  // removed with tags) worst 329 ms; each budget is 1.5× that, rounded up to
  // 10 ms.
  // Raised 740 → 1000 by the human (2026-10-18): the recorded 1.5× set had no
  // slack under machine load; sign-in is once per session.
  'auth.signIn': { kind: 'oncePerSession', maxMs: 1000 },
  // `groups.open` (groups list on "/" → a group's contacts, layout mount
  // included) is retired: cash-gifts step 4 removed the groups list, so
  // its start point no longer exists. Its history stays under that name.
  // The nearest flow now, inside a mounted layout, is a new measurement:
  'home.toContacts': repeatable,
  'contacts.coldLoad': { kind: 'oncePerSession', maxMs: 410 },
  'contacts.nav': repeatable,
  'contacts.search': repeatable,
  'contacts.searchIdentifier': repeatable,
  'contacts.search.phone': repeatable,
  'contacts.search.postcode': repeatable,
  'contacts.search.emailPart': repeatable,
  'contacts.search.org': repeatable,
  'contacts.search.number': repeatable,
  'contacts.showArchived': repeatable,
  'contacts.create': infrequent,
  'contact.save': repeatable,
  'contact.addEmail': repeatable,
  'contact.livePropagation': repeatable,
  // A save against a change this tab hasn't seen: the 200 with the stale
  // slice, the merge and the retry sent at once (migration-rust F3 step 5),
  // from Save to "All changes saved".
  'contact.staleMerge': repeatable,
  // Back to a contact opened in the last 2 minutes: the keep-alive cache
  // (perf-storage step 2). Expected well under, at about one frame.
  'contact.revisit': repeatable,
  'contact.archive': repeatable,
  'contact.restore': rare,
  'contact.note.add': repeatable,
  'contact.note.save': repeatable,
  'contact.note.pin': repeatable,
  'contact.note.archive': repeatable,
  'contact.identifier.add': repeatable,
  'contact.identifier.remove': repeatable,
  'contact.hold.release': repeatable,
  'contact.acquisition.set': repeatable,
  'contacts.createWithCode': infrequent,
  'contacts.filter.sourceCategory': repeatable,
  'contacts.filter.sourceVersion': repeatable,
  'contacts.loadMore': repeatable,
  // Dropdown fields (plan step 6): the classes of the tag flows they
  // replaced (human, g1q14, 2026-10-21; the tag flows left in step 7).
  'fields.create': repeatable,
  'fields.option.add': repeatable,
  'fields.archive': repeatable,
  'fields.filter': repeatable,
  'contact.field.set': repeatable,
  'contact.field.clear': repeatable,
  'settings.staffFields.toggle': repeatable,
  // Both open the Fields tab, the first (A3 ported the layout around it).
  'settings.nav': repeatable,
  'settings.tab': repeatable,
  // Timed in the per-list switch test, which also opens the Fields tab.
  'settings.staffIdentifierTypes.toggle': repeatable,
  'settings.identifierTypes.create': repeatable,
  'settings.identifierTypes.rename': repeatable,
  'settings.identifierTypes.archive': repeatable,
  'settings.staffSourceCodes.toggle': repeatable,
  'settings.sourceCodes.open': repeatable,
  'settings.sourceCodes.addDetail': repeatable,
  'settings.sourceCodes.rename': repeatable,
  'settings.sourceCodes.archive': repeatable,
  // Cash gifts step 3: recording a gift creates a record (contacts.create's
  // class), from an existing contact or with a new one in the same save.
  'gift.record': infrequent,
  'gift.recordNewContact': infrequent,
  // Cash gifts step 5: the gift page and the contact page's panels.
  'gift.open': repeatable,
  'gift.save': repeatable,
  // Void and unvoid show the new status only once the server confirms it
  // (gifts are never optimistic, human 2026-10-23).
  'gift.void': repeatable,
  // Gift Aid claims G1: a claimed gift's new amount, refused by the server
  // and said why (the claim lock), the form left open.
  'gift.saveClaimed': repeatable,
  'gift.unvoid': repeatable,
  'contact.gifts.loadMore': repeatable,
  'contact.giftaid.cancel': repeatable,
  'contact.giftaid.void': repeatable,
  // Completing a declaration's name and address after it was saved: an
  // edit, shown only once the server confirms it.
  'contact.giftaid.details': repeatable,
  // Gift Aid claims G3: the Gift Aid page, a claim's preview (a new end
  // date; Refresh after fixing a gift left out), and each step of a claim,
  // shown only once the server confirms it (rule 4). Creating claims
  // creates records, as gift.record does: infrequent.
  'giftaid.open': repeatable,
  'giftaid.preview': repeatable,
  'giftaid.refresh': repeatable,
  'giftaid.create': infrequent,
  'giftaid.markReady': repeatable,
  'giftaid.markSubmitted': repeatable,
  'giftaid.markPaid': repeatable,
  'giftaid.reject': repeatable,
  // Settings › HMRC details: an edit of the group's details.
  'giftaid.hmrcSave': repeatable,
  // Declaration scans step 4: "Scans to match" from the Gift Aid menu;
  // "Scan with phone" (a new pairing: its QR code and link) and accepting
  // a scan onto a new paper declaration each create a record, as
  // gift.record does: infrequent.
  'scans.open': repeatable,
  'scans.pair': infrequent,
  'scans.accept': infrequent,
  // Declaration scans step 5, the phone's page (qc/flows/scan-phone.spec.ts).
  // Approved (human, 2026-10-30): recorded 2026-10-29 in runs tnoqzxpr,
  // tnor0ywg, tnor1s78 with netem off and load about 8 (worst: open 63 ms,
  // sendPage 214 ms), 1.5× rounded up to 10 ms. scan.open: opening the
  // link, the phone page's first load (oncePerSession, as
  // contacts.coldLoad). scan.sendPage: Use page to "Sent", which flattens
  // and encodes the photo on the phone before the upload and the server's
  // re-encode, "Preparing the page…" shown meanwhile: bulk's class (its own
  // recorded budget, a progress state), though it is one page.
  'scan.open': { kind: 'oncePerSession', maxMs: 100 },
  'scan.sendPage': bulk,
  // GoCardless D3 (qc/flows/gocardless-ui.spec.ts). Classes
  // approved (human, 2026-10-30), not recorded. Opening Settings ›
  // GoCardless and the unmatched list are reads: repeatable. Setting up a
  // Direct Debit, a one-off on the mandate, an Instant Bank Pay link,
  // cancelling and matching a payment each create or end a record:
  // infrequent. All but matching wait for GoCardless itself (the fake,
  // locally; the real one adds its own round trip), so the line may need
  // its own class once recorded.
  'gocardless.settings': { ...repeatable, ...fake },
  'gocardless.unmatched': { ...repeatable, ...fake },
  'gocardless.setUp': { ...infrequent, ...fake },
  'gocardless.oneOff': { ...infrequent, ...fake },
  'gocardless.instantPayment': { ...infrequent, ...fake },
  'gocardless.cancel': { ...infrequent, ...fake },
  'gocardless.match': { ...infrequent, ...fake },
  // Declaration scans step 6 (qc/flows/scans-e2e.spec.ts). Approved
  // (human, 2026-10-30): recorded 2026-10-29 in runs tnoxdojv,
  // tnoxdz0z, tnoxea0c with netem off and load under 2 (worst 182 ms),
  // 1.5× rounded up to 10 ms. scans.uploadToLaptop: Use page on the phone
  // to the page's thumbnail in the laptop's stack, so scan.sendPage's work,
  // then the SSE event, the laptop's refetch and the thumbnail's image.
  // Bulk's class, as scan.sendPage (its own recorded budget; the phone
  // shows "Preparing the page…").
  'scans.uploadToLaptop': bulk,
  // Regular-gift terms step 6 (qc/flows/regular-terms.spec.ts).
  // Classes approved (human, 2026-10-30), not recorded.
  // Scheduling a change (the plan's "repeatable (100 ms)"), changing its
  // code and withdrawing it are edits of the regular gift: repeatable.
  // Opening the expected vs actual report is a read: repeatable.
  // Adopting a subscription makes a regular gift: infrequent.
  'terms.change': { ...repeatable, ...fake },
  'terms.code': { ...repeatable, ...fake },
  'terms.withdraw': { ...repeatable, ...fake },
  'expected.report': { ...repeatable, ...fake },
  'gocardless.adopt': { ...infrequent, ...fake },
  // Bank transfers 6b (qc/flows/batches.spec.ts). PROVISIONAL: classes
  // proposed by builder-bkp for the human's OK, not recorded. Recording a
  // cheque into a batch makes a gift (gift.record's class); closing a
  // batch ends a record's open life, as cancelling a regular gift does:
  // infrequent.
  'gift.recordCheque': infrequent,
  'batch.close': infrequent,
  // Bank transfers 6b part 2 (qc/flows/reconcile.spec.ts). "Accept
  // ticked" applies several lines at once (30 a sample): bulk (human,
  // 2026-11-01; recorded worst 177 ms on 2026-10-31 in runs tnr2xmr6,
  // tnr33uj5, tnr39er1). Matching a line by hand makes or ends a record:
  // infrequent.
  'bank.acceptTicked': bulk,
  'bank.matchLine': infrequent,
  // Bank transfers 6b part 3 (qc/flows/standing-orders.spec.ts).
  // PROVISIONAL: proposed by builder-rgt for the human's OK, not
  // recorded. Recording a standing order makes a regular gift, as
  // setting up a Direct Debit or adopting a subscription does: infrequent.
  'standingOrder.record': infrequent,
  // bulkTag's budget (recorded with auth.signIn above), for the flow that
  // replaced it (human, g1q14).
  'contacts.bulkSetField': bulk,

  // qc/harness.spec.ts: proves the timing path can fail and pass.
  'harness.impossible': { kind: 'repeatable', maxMs: 1, selfTest: true },
  'harness.generous': { kind: 'repeatable', maxMs: 60_000, selfTest: true },
  // A spike forced into the first set: passes on the re-measure, or fails
  // when forced into both.
  'harness.spike': { kind: 'repeatable', maxMs: 1000, selfTest: true },
} satisfies Record<string, Budget>

export type FlowName = keyof typeof budgets

// ── Per-target budgets (human, g2q6, 2026-11-01) ────────────────────────
//
// The set above is the house's: the local pool (at the hosted RTT, under
// netem) and keep-staging from the house nightly, now retired. A target listed here
// has its own set instead, recorded where it runs: GitHub's runners sit
// far from London (plan gocardless-sandbox-qc.sv, g2q7), so the house's
// lines would time the Atlantic, not the app.
//
// - `flows`: each flow's budget on that target. A flow missing from it is
//   timed and recorded in full, but **not judged** (`unbudgeted`): the run
//   lists them in a NO BUDGETS banner and neither passes nor fails them.
//   The harness's self-tests keep their house budgets everywhere.
// - `rttCeilingMs`: the RTT ceiling on that target (qc/timing.ts's
//   RTT_CEILING_MS at the house); null until recorded, when the RTT is
//   only recorded.
//
// `qc` (keep-qc from Actions) was recorded by plan step A3: 3
// `mode=record` runs of .github/workflows/qc.yml, each flow's line 1.5×
// its worst sample, the ceiling from the same runs, shown to the human as
// a diff of this file, and approved (human, 2026-11-01); re-recorded the
// same way after keep-qc moved to iad (below). Raising one later
// needs the human's OK, as above. Bulk flows and routes that call an
// external service are 500 ms there too (human, 2026-11-01), except the
// phone's page upload on keep-qc (QC_FIXED, below); a route measured over
// it goes back to the human with its numbers.

export interface TargetBudgets {
  rttCeilingMs: number | null
  flows: Partial<Record<FlowName, Budget>>
}

// keep-qc's recorded set (plan step A3, the human's OK 2026-11-01;
// re-recorded after keep-qc moved to iad, 8a843bd). Recorded from a US
// Actions runner to keep-qc in Ashburn (iad): the 3 `mode=record` runs of
// qc.yml on main 8a843bd, GitHub runs 41373392160, 41374042465,
// 41374568076 (history runIds tnupv1n2, tnuq748k, tnuqhdqe). Each line is
// 1.5× the flow's worst sample over the 3 runs, rounded up to 10 ms; the
// comment gives each run's worst (— where a run didn't time it). No
// targets (targetMs): only the failing line was recorded.
//
// The runner's region still sets the link: GitHub put the 3 runs in
// westus, southcentralus and eastus2, at a median RTT to keep-qc of 82,
// 57 and 13 ms, and most flows take 1–4 round trips, so run 1 (westus)
// sets most worsts. RTT ceiling: 1.5× the worst worker RTT (87.5 ms).
// contact.note.archive has 2 runs only: its test failed in run 1 before
// the flow (a behaviour failure, not timing), so its line is set by
// analogy with contact.note.add/save/pin, its 3-round-trip siblings,
// whose westus worsts set them (human, 2026-11-02).
//
// RE-RECORD: replace QC_RECORDED (and QC_RTT_CEILING_MS) wholesale; the
// human's fixed lines (QC_FIXED) stay. Bulk flows are not recorded.
//
// Not here: flows timed only against the GoCardless fake (untimed on
// keep-qc, which runs the sandbox), so they stay unbudgeted there.
const QC_RTT_CEILING_MS = 140
const QC_RECORDED: Partial<Record<FlowName, Budget>> = {
  'auth.signIn': { kind: 'oncePerSession', maxMs: 550 }, // worst 364/254/227
  'home.toContacts': { kind: 'repeatable', maxMs: 50 }, // worst 32/32/32
  'contacts.coldLoad': { kind: 'oncePerSession', maxMs: 360 }, // worst 235/153/147
  'contacts.nav': { kind: 'repeatable', maxMs: 240 }, // worst 157/75/100
  'contacts.search': { kind: 'repeatable', maxMs: 150 }, // worst 94/78/24
  'contacts.searchIdentifier': { kind: 'repeatable', maxMs: 170 }, // worst 112/77/26
  'contacts.search.phone': { kind: 'repeatable', maxMs: 160 }, // worst 105/74/26
  'contacts.search.postcode': { kind: 'repeatable', maxMs: 170 }, // worst 108/76/26
  'contacts.search.emailPart': { kind: 'repeatable', maxMs: 170 }, // worst 108/78/26
  'contacts.search.org': { kind: 'repeatable', maxMs: 170 }, // worst 111/76/27
  'contacts.search.number': { kind: 'repeatable', maxMs: 20 }, // worst 10/4/4
  'contacts.showArchived': { kind: 'repeatable', maxMs: 150 }, // worst 99/70/35
  'contacts.create': { kind: 'infrequent', maxMs: 190 }, // worst 123/91/45
  'contact.save': { kind: 'repeatable', maxMs: 180 }, // worst 115/88/34
  'contact.addEmail': { kind: 'repeatable', maxMs: 150 }, // worst 98/76/32
  'contact.livePropagation': { kind: 'repeatable', maxMs: 310 }, // worst 201/149/80
  'contact.staleMerge': { kind: 'repeatable', maxMs: 170 }, // worst 112/66/47
  'contact.revisit': { kind: 'repeatable', maxMs: 80 }, // worst 19/13/48
  'contact.archive': { kind: 'repeatable', maxMs: 150 }, // worst 98/76/32
  'contact.restore': { kind: 'rare', maxMs: 180 }, // worst 117/79/32
  'contact.note.add': { kind: 'repeatable', maxMs: 420 }, // worst 275/198/63
  'contact.note.save': { kind: 'repeatable', maxMs: 390 }, // worst 260/199/68
  'contact.note.pin': { kind: 'repeatable', maxMs: 400 }, // worst 265/193/52
  'contact.note.archive': { kind: 'repeatable', maxMs: 420 }, // worst —/199/62; 2 runs only: by analogy with note.add/save/pin, no run-1 (westus) sample (human, 2026-11-02)
  'contact.identifier.add': { kind: 'repeatable', maxMs: 250 }, // worst 161/82/26
  'contact.identifier.remove': { kind: 'repeatable', maxMs: 150 }, // worst 99/82/51
  'contact.hold.release': { kind: 'repeatable', maxMs: 430 }, // worst 281/200/52
  'contact.acquisition.set': { kind: 'repeatable', maxMs: 230 }, // worst 101/149/53
  'contacts.createWithCode': { kind: 'infrequent', maxMs: 200 }, // worst 129/89/95
  'contacts.filter.sourceCategory': { kind: 'repeatable', maxMs: 170 }, // worst 110/78/36
  'contacts.filter.sourceVersion': { kind: 'repeatable', maxMs: 150 }, // worst 94/78/39
  'contacts.loadMore': { kind: 'repeatable', maxMs: 180 }, // worst 119/77/59
  'fields.create': { kind: 'repeatable', maxMs: 380 }, // worst 250/198/61
  'fields.option.add': { kind: 'repeatable', maxMs: 410 }, // worst 267/197/213
  'fields.archive': { kind: 'repeatable', maxMs: 400 }, // worst 265/200/50
  'fields.filter': { kind: 'repeatable', maxMs: 150 }, // worst 94/79/39
  'contact.field.set': { kind: 'repeatable', maxMs: 150 }, // worst 98/76/28
  'contact.field.clear': { kind: 'repeatable', maxMs: 220 }, // worst 145/75/36
  'settings.staffFields.toggle': { kind: 'repeatable', maxMs: 380 }, // worst 250/195/60
  'settings.nav': { kind: 'repeatable', maxMs: 40 }, // worst 21/13/26
  'settings.tab': { kind: 'repeatable', maxMs: 150 }, // worst 96/80/32
  'settings.staffIdentifierTypes.toggle': { kind: 'repeatable', maxMs: 450 }, // worst 298/296/49
  'settings.identifierTypes.create': { kind: 'repeatable', maxMs: 400 }, // worst 265/183/48
  'settings.identifierTypes.rename': { kind: 'repeatable', maxMs: 400 }, // worst 265/182/48
  'settings.identifierTypes.archive': { kind: 'repeatable', maxMs: 400 }, // worst 265/182/48
  'settings.staffSourceCodes.toggle': { kind: 'repeatable', maxMs: 400 }, // worst 265/213/49
  'settings.sourceCodes.open': { kind: 'repeatable', maxMs: 180 }, // worst 114/66/31
  'settings.sourceCodes.addDetail': { kind: 'repeatable', maxMs: 450 }, // worst 298/183/48
  'settings.sourceCodes.rename': { kind: 'repeatable', maxMs: 400 }, // worst 265/192/49
  'settings.sourceCodes.archive': { kind: 'repeatable', maxMs: 430 }, // worst 283/199/49
  'gift.record': { kind: 'infrequent', maxMs: 180 }, // worst 117/82/31
  'gift.recordNewContact': { kind: 'infrequent', maxMs: 180 }, // worst 115/81/32
  'gift.open': { kind: 'repeatable', maxMs: 440 }, // worst 290/82/47
  'gift.save': { kind: 'repeatable', maxMs: 150 }, // worst 98/66/31
  'gift.void': { kind: 'repeatable', maxMs: 150 }, // worst 100/66/34
  'gift.saveClaimed': { kind: 'repeatable', maxMs: 150 }, // worst 99/66/33
  'gift.unvoid': { kind: 'repeatable', maxMs: 180 }, // worst 115/66/38
  'contact.gifts.loadMore': { kind: 'repeatable', maxMs: 150 }, // worst 98/77/32
  'contact.giftaid.cancel': { kind: 'repeatable', maxMs: 400 }, // worst 266/200/76
  'contact.giftaid.void': { kind: 'repeatable', maxMs: 430 }, // worst 283/200/50
  'contact.giftaid.details': { kind: 'repeatable', maxMs: 400 }, // worst 266/199/48
  'giftaid.open': { kind: 'repeatable', maxMs: 180 }, // worst 115/96/48
  'giftaid.preview': { kind: 'repeatable', maxMs: 230 }, // worst 153/66/32
  'giftaid.refresh': { kind: 'repeatable', maxMs: 150 }, // worst 99/65/31
  'giftaid.create': { kind: 'infrequent', maxMs: 160 }, // worst 101/82/32
  'giftaid.markReady': { kind: 'repeatable', maxMs: 180 }, // worst 114/66/31
  'giftaid.markSubmitted': { kind: 'repeatable', maxMs: 180 }, // worst 115/74/31
  'giftaid.markPaid': { kind: 'repeatable', maxMs: 170 }, // worst 111/67/30
  'giftaid.reject': { kind: 'repeatable', maxMs: 180 }, // worst 115/66/32
  'giftaid.hmrcSave': { kind: 'repeatable', maxMs: 400 }, // worst 266/185/49
  'scans.open': { kind: 'repeatable', maxMs: 240 }, // worst 159/83/66
  'scans.pair': { kind: 'infrequent', maxMs: 190 }, // worst 124/87/32
  'scans.accept': { kind: 'infrequent', maxMs: 420 }, // worst 276/199/66
  'scan.open': { kind: 'oncePerSession', maxMs: 450 }, // worst 294/279/115
  'gift.recordCheque': { kind: 'infrequent', maxMs: 170 }, // worst 110/80/51
  'batch.close': { kind: 'infrequent', maxMs: 450 }, // worst 298/232/66
  'bank.matchLine': { kind: 'infrequent', maxMs: 420 }, // worst 279/182/48
  'standingOrder.record': { kind: 'infrequent', maxMs: 240 }, // worst 157/67/32
}

// The human's fixed lines on keep-qc (2026-11-01), never recorded and
// never raised to get green: bulk at the house's 500 ms, except the
// phone's page upload, whose two flows get a keep-qc-only 1,500 ms (worst
// 448/731/515 and 627/1179/799 ms in A3's runs from lhr; the house's
// line stays 500 ms). Comments: the iad re-record's worst per run.
const QC_FIXED: Partial<Record<FlowName, Budget>> = {
  'scan.sendPage': { kind: 'bulk', maxMs: 1500 }, // worst 298/282/363
  'scans.uploadToLaptop': { kind: 'bulk', maxMs: 1500 }, // worst 515/415/265
  'bank.acceptTicked': bulk, // worst 178/149/115
  'contacts.bulkSetField': bulk, // worst 98/82/30
}

export const targetBudgets: Partial<Record<QcTarget, TargetBudgets>> = {
  qc: {
    rttCeilingMs: QC_RTT_CEILING_MS,
    flows: { ...QC_RECORDED, ...QC_FIXED },
  },
}

/**
 * A flow's budget on `target` (default: this process's, QC_TARGET).
 * `unbudgeted`: the target has its own set and this flow isn't in it, so
 * the house budget comes back for its kind and timeout only, and the
 * flow must not be judged.
 */
export function budgetFor(
  name: FlowName,
  target: QcTarget = qcTarget(),
): Budget & { unbudgeted?: true } {
  const house: Budget = budgets[name]
  const own = targetBudgets[target]
  if (!own || house.selfTest) return house
  const b = own.flows[name]
  if (b) return b
  // No target of its own on the house's line either: nothing is judged.
  const rest: Budget = { ...house }
  delete rest.targetMs
  return { ...rest, unbudgeted: true }
}

/**
 * Routes behind `bulk` flows (`METHOD /path`, as qc/server.ts names them):
 * an action over many records at once. Exempt from the 100 ms server rule
 * like their flows (human, 2026-10-18), each with its own limit in ms,
 * held to the bulk line, 500 ms (human, 2026-11-01). Reconcile's "Accept
 * ticked" (`POST /t/:slug/bank/accept`, 30 lines a call): worst 155.1 ms
 * over runs tnr2xmr6, tnr33uj5, tnr39er1 (QC_NO_NETEM=1). B1's bulk set (`POST /t/:slug/contacts/bulk-set-field`) is held to the
 * ordinary 100 ms; its Convex limit was 370 ms (bulkTag's worst, 242.6 ms
 * over runs tn357fbu, tn35ew84, tn35t6tx, × 1.5, rounded up).
 * Convex's server exception (a list re-run reading a grown pinned page)
 * went with Convex's paged list.
 */
export const BULK_ROUTES: Record<string, number> = {
  'POST /t/:slug/bank/accept': bulk.maxMs,
  // The phone's page upload (scan.sendPage, a bulk flow: the photo, its
  // flattening and thumbnail). On keep-qc in A3's runs: 183, 383 and
  // 263 ms worst, over the 100 ms rule (human, 2026-11-01: bulk, 500 ms).
  'POST /scan/:token/scans': bulk.maxMs,
}
