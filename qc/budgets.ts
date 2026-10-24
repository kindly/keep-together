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
/** A repeatable flow a wave step still has to port (qc/pending.ts). */
const port = (step: string) => ({ ...repeatable, pendingPort: step })

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
  'contact.acquisition.set': port('A2'),
  'contacts.createWithCode': { ...infrequent, pendingPort: 'A2' },
  'contacts.filter.sourceCategory': port('A2'),
  'contacts.filter.sourceVersion': port('A2'),
  'contacts.loadMore': repeatable,
  // Dropdown fields (plan step 6): the classes of the tag flows they
  // replaced (human, g1q14, 2026-10-21; the tag flows left in step 7).
  'fields.create': port('B1'),
  'fields.option.add': port('B1'),
  'fields.archive': port('B1'),
  'fields.filter': repeatable,
  'contact.field.set': repeatable,
  'contact.field.clear': repeatable,
  'settings.staffFields.toggle': port('B1'),
  'settings.nav': port('A3'),
  'settings.tab': port('A3'),
  'settings.staffIdentifierTypes.toggle': port('A3'),
  'settings.identifierTypes.create': port('A3'),
  'settings.identifierTypes.rename': port('A3'),
  'settings.identifierTypes.archive': port('A3'),
  'settings.staffSourceCodes.toggle': port('A2'),
  'settings.sourceCodes.open': port('A2'),
  'settings.sourceCodes.addDetail': port('A2'),
  'settings.sourceCodes.rename': port('A2'),
  'settings.sourceCodes.archive': port('A2'),
  // Cash gifts step 3: recording a gift creates a record (contacts.create's
  // class), from an existing contact or with a new one in the same save.
  'gift.record': { ...infrequent, pendingPort: 'B2' },
  'gift.recordNewContact': { ...infrequent, pendingPort: 'B2' },
  // Cash gifts step 5: the gift page and the contact page's panels.
  'gift.open': port('B2'),
  'gift.save': port('B2'),
  // Void and unvoid show the new status only once the server confirms it
  // (gifts are never optimistic, human 2026-10-23).
  'gift.void': port('B2'),
  'gift.unvoid': port('B2'),
  'contact.gifts.loadMore': port('B2'),
  'contact.giftaid.cancel': port('B2'),
  'contact.giftaid.void': port('B2'),
  // bulkTag's budget (recorded with auth.signIn above), for the flow that
  // replaced it (human, g1q14).
  'contacts.bulkSetField': { kind: 'bulk', maxMs: 500, pendingPort: 'B1' },

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
 * B1 ports bulkSetField, whose Convex limit was 370 ms (bulkTag's worst,
 * 242.6 ms over runs tn357fbu, tn35ew84, tn35t6tx, × 1.5, rounded up).
 * Convex's server exception (a list re-run reading a grown pinned page)
 * went with Convex's paged list.
 */
export const BULK_ROUTES: Record<string, number> = {}
