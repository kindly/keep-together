import type { Blame, Verdict } from './blame'

// Is a slow sample ours? (human, 2026-10-21; ADR 0018 amendment.) Inside a
// flow's judged set (after the usual re-measure), a sample at or over
// budget is blamed (qc/blame.ts) and then:
//
// - `ours` or `unclear` (unclear counts as ours): it fails, as today.
// - not ours (`link` or `convex/network`, which need positive evidence):
//   it is measured again, up to RETRIES_PER_SAMPLE more times. An attempt
//   under budget passes it. An attempt that is over and ours fails it.
// - still over and not ours after the last attempt: our share of that
//   attempt (page + our function + the critical path of the re-runs it
//   waited for) is judged against the budget less SHARE_MARGIN_MS.
//
// Retries are capped per run (RETRY_CAP_PER_RUN, across all workers);
// past the cap a sample is judged as today, over budget fails, and the
// rule says so. Self-test flows are always judged as today.

/** Our share must be under the budget less this. */
export const SHARE_MARGIN_MS = 50
/** Extra attempts for one slow sample that isn't ours. */
export const RETRIES_PER_SAMPLE = 2
/** Extra attempts for the whole run. */
export const RETRY_CAP_PER_RUN = 10

/** Why a slow sample passed or failed. */
export type Rule =
  | 'passed on retry'
  | 'passed on our share'
  | 'failed: ours'
  | 'failed: unclear'
  | 'failed: our share over'
  | 'failed: retry cap'

export interface Attempt {
  ms: number
  /** Null for an attempt under budget: nothing to blame. */
  verdict: Verdict | null
  why?: string
  ourShareMs?: number | null
  /** The log streams caught up before the verdict (qc/live.ts). */
  caughtUp?: boolean
  /** The blame, kept on the history line. */
  blame?: Blame
}

export interface SampleJudgement {
  pass: boolean
  rule: Rule
  /** attempts[0] is the sample itself; the rest are its retries. */
  attempts: Array<Attempt>
  /** budget − SHARE_MARGIN_MS, when our share was judged. */
  shareBudgetMs?: number
}

export interface Measured<TDetail> {
  ms: number
  detail: TDetail
}

export interface JudgeDeps<TDetail> {
  /** Blame a slow sample (waits for the run's live data). */
  blame: (m: Measured<TDetail>) => Promise<{ blame: Blame; caughtUp: boolean }>
  /** Measure the flow once more. */
  measure: () => Promise<Measured<TDetail>>
  /** Take one retry from the run's cap; false when it's spent. */
  takeRetry: () => boolean
}

const isOurs = (v: Verdict) => v === 'ours' || v === 'unclear'

/** Judge one sample at or over budget. */
export async function judgeSlowSample<TDetail>(
  first: Measured<TDetail>,
  budgetMs: number,
  deps: JudgeDeps<TDetail>,
): Promise<SampleJudgement> {
  const attempts: Array<Attempt> = []
  let cur = first
  for (;;) {
    const { blame, caughtUp } = await deps.blame(cur)
    attempts.push({
      ms: cur.ms,
      verdict: blame.verdict,
      why: blame.why,
      ourShareMs: blame.ourShareMs,
      caughtUp,
      blame,
    })
    if (isOurs(blame.verdict)) {
      return {
        pass: false,
        rule: blame.verdict === 'ours' ? 'failed: ours' : 'failed: unclear',
        attempts,
      }
    }
    if (attempts.length > RETRIES_PER_SAMPLE) {
      const shareBudgetMs = budgetMs - SHARE_MARGIN_MS
      const share = blame.ourShareMs
      const pass = share !== null && share < shareBudgetMs
      return {
        pass,
        rule: pass ? 'passed on our share' : 'failed: our share over',
        attempts,
        shareBudgetMs,
      }
    }
    if (!deps.takeRetry())
      return { pass: false, rule: 'failed: retry cap', attempts }
    cur = await deps.measure()
    if (cur.ms < budgetMs) {
      attempts.push({ ms: cur.ms, verdict: null })
      return { pass: true, rule: 'passed on retry', attempts }
    }
  }
}
