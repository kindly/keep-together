// Client-perceived budgets per flow (factory/plans/qc-suite.sv, Latency).
// Times are raw: from the input event to the result on screen, network
// included, with no round-trip allowance. A flow passes when **every**
// sample is under maxMs; there is no median.
//
// - repeatable: anything a user can do more than once per signed-in
//   session. Always 100 ms.
// - oncePerSession: sign-in and the first page load. Their own budgets,
//   recorded first: 1.5× the worst sample of three `QC_MODE=record` runs,
//   rounded up to 10 ms (step 9b).
// - bulk: an action over many records at once (tagging up to 100 contacts).
//   Exempt from 100 ms, with a progress state in the UI; its own budget
//   is recorded like oncePerSession's (human, 2026-10-17).
//
// **Raising a budget, or exempting a flow, needs the human's explicit
// OK.** A flow over budget means fixing the code.
//
// Every flow here must be timed in each assert run, or the run fails
// (qc/reporter.ts). `pending: true` marks one whose spec isn't written yet
// (QC steps 6–8): untimed, it only warns. Drop the mark with the spec.
//
// A judged flow with any sample at or over budget is re-measured once (K
// fresh samples) and fails only if that set is over too (qc/timing.ts).
//
// `knownOver` is an exception the human approved: the flow is still timed
// and recorded in full, but being over budget doesn't fail the run. Every
// run lists every knownOver flow in a banner, timed or not, so it can't be
// forgotten. Remove the mark with the fix.

export type FlowKind = 'repeatable' | 'oncePerSession' | 'bulk'

export interface Budget {
  kind: FlowKind
  /** Every sample must be under this, in ms. */
  maxMs: number
  /** The harness's own self-test: never in history, never fails the run. */
  selfTest?: true
  /** No spec times it yet: missing from a run warns instead of failing. */
  pending?: true
  /** Approved exception, "<reason> (<who> <date>)": over budget never fails. */
  knownOver?: string
}

const repeatable = { kind: 'repeatable', maxMs: 100 } as const

export const budgets = {
  // Step 9b, recorded 2026-10-18 in runs tn357fbu, tn35ew84, tn35t6tx
  // (sha 1cd6e46): signIn worst 488 ms, coldLoad worst 272 ms, bulkTag
  // worst 329 ms; each budget is 1.5× that, rounded up to 10 ms.
  'auth.signIn': { kind: 'oncePerSession', maxMs: 740 },
  'groups.open': repeatable,
  'contacts.coldLoad': { kind: 'oncePerSession', maxMs: 410 },
  'contacts.nav': repeatable,
  'contacts.search': repeatable,
  'contacts.searchIdentifier': repeatable,
  'contacts.search.phone': repeatable,
  'contacts.search.postcode': repeatable,
  'contacts.search.emailPart': repeatable,
  'contacts.search.org': repeatable,
  'contacts.showArchived': repeatable,
  'contacts.create': repeatable,
  'contact.save': repeatable,
  'contact.addEmail': repeatable,
  'contact.livePropagation': repeatable,
  // Back to a contact opened in the last 2 minutes: the keep-alive cache
  // (perf-storage step 2). Expected well under, at about one frame.
  'contact.revisit': repeatable,
  'contact.archive': repeatable,
  'contact.restore': repeatable,
  'contact.note.add': repeatable,
  'contact.note.save': repeatable,
  'contact.note.pin': repeatable,
  'contact.note.archive': repeatable,
  'contact.tag.add': repeatable,
  'contact.tag.remove': repeatable,
  'contact.identifier.add': repeatable,
  'contact.identifier.remove': repeatable,
  'tags.create': repeatable,
  'tags.rename': repeatable,
  'tags.archive': repeatable,
  'tags.filter': repeatable,
  'settings.nav': repeatable,
  'settings.tab': repeatable,
  'settings.staffLists.toggle': repeatable,
  'settings.identifierTypes.create': repeatable,
  'settings.identifierTypes.rename': repeatable,
  'settings.identifierTypes.archive': repeatable,
  // Recorded with auth.signIn above.
  'contacts.bulkTag': { kind: 'bulk', maxMs: 500 },

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
 * Server functions behind `bulk` flows: an action over many records at once
 * (bulkTag runs one contract and one search-projection rebuild per contact,
 * about 700 extra reads at 100 contacts since search Q1). Exempt from the
 * 100 ms server rule like their flows (human, 2026-10-18): each has its own
 * limit in ms, recorded like the `bulk` flow budgets. bulkTag: worst 242.6 ms
 * over runs tn357fbu, tn35ew84, tn35t6tx (2026-10-18), × 1.5, rounded up.
 * qc/server-timings.ts asserts them against it instead of 100 ms.
 */
export const BULK_FUNCTIONS: Record<string, number> = {
  'contacts/mutations:bulkTag': 370,
}
