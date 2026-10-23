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
// - infrequent: creating a record (a new contact). Done less often than the
//   edits that follow it, so 150 ms; every later edit of that record is
//   repeatable, 100 ms (human, 2026-10-19).
// - rare: done seldom enough that 200 ms is fine (restoring a contact from
//   its history) (human, 2026-10-21).
// - bulk: an action over many records at once (setting a field on up to
//   100 contacts).
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
// A sample over budget in that set is then judged on whose time it was
// (qc/judge.ts, human 2026-10-21): ours or unclear fails; not ours (link
// or Convex, with evidence) is retried up to twice, then passes only if
// our share of it is under maxMs − 50. The numbers here are unchanged.
//
// `knownOver` is an exception the human approved: the flow is still timed
// and recorded in full, but being over budget doesn't fail the run. Every
// run lists every knownOver flow in a banner, timed or not, so it can't be
// forgotten. Remove the mark with the fix.

export type FlowKind =
  'repeatable' | 'infrequent' | 'rare' | 'oncePerSession' | 'bulk'

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
const infrequent = { kind: 'infrequent', maxMs: 150 } as const
const rare = { kind: 'rare', maxMs: 200 } as const

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
  'contact.addEmail': {
    ...repeatable,
    knownOver:
      'save floor ~95 ms; mutation network leg drifted (58–75 ms), 104–111 ms some runs (human 2026-10-18)',
  },
  'contact.livePropagation': repeatable,
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
  'settings.nav': repeatable,
  'settings.tab': repeatable,
  'settings.staffIdentifierTypes.toggle': repeatable,
  'settings.identifierTypes.create': repeatable,
  'settings.identifierTypes.rename': repeatable,
  'settings.identifierTypes.archive': repeatable,
  'settings.staffSourceCodes.toggle': repeatable,
  'settings.sourceCodes.open': repeatable,
  'settings.sourceCodes.addDetail': repeatable,
  'settings.sourceCodes.rename': repeatable,
  'settings.sourceCodes.archive': repeatable,
  // Cash gifts step 5: the gift page and the contact page's panels.
  'gift.open': repeatable,
  'gift.save': repeatable,
  'gift.void': repeatable,
  'gift.unvoid': repeatable,
  'contact.gifts.loadMore': repeatable,
  'contact.giftaid.cancel': repeatable,
  'contact.giftaid.void': repeatable,
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
 * Server functions behind `bulk` flows: an action over many records at once
 * (bulkSetField runs one contract and one search-projection rebuild per
 * contact). Exempt from the 100 ms server rule like their flows (human,
 * 2026-10-18): each has its own limit in ms, recorded like the `bulk` flow
 * budgets. bulkSetField takes the limit of bulkTag, the function it
 * replaced (human, dropdown fields g1q14, 2026-10-21): bulkTag's worst was
 * 242.6 ms over runs tn357fbu, tn35ew84, tn35t6tx (2026-10-18), × 1.5,
 * rounded up.
 * qc/server-timings.ts asserts them against it instead of 100 ms.
 */
export const BULK_FUNCTIONS: Record<string, number> = {
  'contacts/mutations:bulkSetField': 370,
}

/**
 * Approved exceptions to the server rule, by the call itself, not the
 * function: a call of `fn` whose own log has a line containing `logLine`
 * is timed and recorded, listed in a banner on every run, and exempt
 * from the 100 ms rule. Every other call of `fn` is judged as usual. The
 * human's OK is needed for each, as for `knownOver`.
 *
 * Excepted is not unbounded: each excepted call must still be under its
 * exception's `ceilingMs`. One at or over it fails the run, with no spike
 * allowance (qc/server-timings.ts checkBudgets).
 *
 * - The contacts list reading a pinned page whose range a bulk write grew
 *   (contacts.loadMore's insert into page 0): the backend reads the whole
 *   range, ~0.5–0.7 ms a row, before `list` answers it with no rows to
 *   split (convex/contacts/queries.ts GROWN_PAGE_LOG).
 */
export const SERVER_EXCEPTIONS: Array<{
  fn: string
  logLine: string
  reason: string
  /** Every excepted call must be under this, in ms. */
  ceilingMs: number
}> = [
  {
    fn: 'contacts/queries:list',
    logLine: 'contacts list: grown page read in full',
    reason:
      'list re-run after a bulk write into an open page: ~150 ms reading the grown range (human 2026-10-23)',
    // Ceiling (human, 2026-10-23).
    ceilingMs: 250,
  },
]
