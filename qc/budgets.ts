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
}

const repeatable = { kind: 'repeatable', maxMs: 150, targetMs: 100 } as const
const infrequent = { kind: 'infrequent', maxMs: 200, targetMs: 150 } as const
const rare = { kind: 'rare', maxMs: 250, targetMs: 200 } as const

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
  // PROVISIONAL, for the human's OK: recorded 2026-10-29 in runs tnoqzxpr,
  // tnor0ywg, tnor1s78 with netem off and load about 8 (worst: open 63 ms,
  // sendPage 214 ms), 1.5× rounded up to 10 ms. scan.open: opening the
  // link, the phone page's first load (oncePerSession, as
  // contacts.coldLoad). scan.sendPage: Use page to "Sent", which flattens
  // and encodes the photo on the phone before the upload and the server's
  // re-encode, "Preparing the page…" shown meanwhile: bulk's class (its own
  // recorded budget, a progress state), though it is one page.
  'scan.open': { kind: 'oncePerSession', maxMs: 100 },
  'scan.sendPage': { kind: 'bulk', maxMs: 330 },
  // bulkTag's budget (recorded with auth.signIn above), for the flow that
  // replaced it (human, g1q14).
  'contacts.bulkSetField': { kind: 'bulk', maxMs: 500 },

  // qc/harness.spec.ts: proves the timing path can fail and pass.
  'harness.impossible': { kind: 'repeatable', maxMs: 1, selfTest: true },
  'harness.generous': { kind: 'repeatable', maxMs: 60_000, selfTest: true },
  // A spike forced into the first set: passes on the re-measure, or fails
  // when forced into both.
  'harness.spike': { kind: 'repeatable', maxMs: 1000, selfTest: true },
} satisfies Record<string, Budget>

export type FlowName = keyof typeof budgets

export function budgetFor(name: FlowName): Budget {
  return budgets[name]
}

/**
 * Routes behind `bulk` flows (`METHOD /path`, as qc/server.ts names them):
 * an action over many records at once. Exempt from the 100 ms server rule
 * like their flows (human, 2026-10-18), each with its own limit in ms,
 * recorded like the `bulk` flow budgets. None on the Rust backend yet:
 * B1's bulk set (`POST /t/:slug/contacts/bulk-set-field`) is held to the
 * ordinary 100 ms; its Convex limit was 370 ms (bulkTag's worst, 242.6 ms
 * over runs tn357fbu, tn35ew84, tn35t6tx, × 1.5, rounded up).
 * Convex's server exception (a list re-run reading a grown pinned page)
 * went with Convex's paged list.
 */
export const BULK_ROUTES: Record<string, number> = {}
