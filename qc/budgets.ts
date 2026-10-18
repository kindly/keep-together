// Client-perceived budgets per flow (factory/plans/qc-suite.sv, Latency).
// Times are raw: from the input event to the result on screen, network
// included, with no round-trip allowance. A flow passes when **every**
// sample is under maxMs; there is no median.
//
// - repeatable: anything a user can do more than once per signed-in
//   session. Always 100 ms.
// - oncePerSession: sign-in and the first page load. Their own budgets,
//   recorded first: 1.5× the worst sample of three `QC_MODE=record` runs
//   (step 9b). The numbers below are provisional until then.
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
  'auth.signIn': { kind: 'oncePerSession', maxMs: 2000 },
  'groups.open': repeatable,
  'contacts.coldLoad': { kind: 'oncePerSession', maxMs: 1200 },
  'contacts.nav': repeatable,
  'contacts.search': repeatable,
  'contacts.showArchived': repeatable,
  'contacts.create': repeatable,
  'contact.save': repeatable,
  'contact.addEmail': {
    ...repeatable,
    knownOver:
      'sits at 90-95 ms, frame-bound; with planner-perf (human 2026-10-18)',
  },
  'contact.livePropagation': repeatable,
  'contact.archive': repeatable,
  'contact.restore': repeatable,
  'contact.note.add': repeatable,
  'contact.note.save': repeatable,
  'contact.note.pin': repeatable,
  'contact.note.archive': repeatable,
  'contact.tag.add': repeatable,
  'contact.tag.remove': repeatable,
  'tags.create': repeatable,
  'tags.rename': repeatable,
  'tags.archive': repeatable,
  'tags.filter': repeatable,
  'settings.nav': repeatable,
  'settings.identifierTypes.create': repeatable,
  'settings.identifierTypes.rename': repeatable,
  'settings.identifierTypes.archive': repeatable,
  // Provisional until step 9b records it.
  'contacts.bulkTag': { kind: 'bulk', maxMs: 1000 },

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
