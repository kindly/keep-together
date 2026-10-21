import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { BULK_FUNCTIONS } from './budgets'
import { STALL_MS } from './link.setup'
import { median } from './timing'
import type { SampleDetail } from './timing'

// Whose time a slow sample was. For every sample at or over budget the
// time is split into legs from what the run recorded: the sample's
// WebSocket legs (qc/timing.ts), the matching Convex call and the page's
// re-run queries from `convex logs` (server-calls.jsonl, or the live file
// in a worker), the worker's `platform/qcProbe:rtt` probe every 2 s
// (rtt-*.jsonl) and the first-hop ping (link.json). Then a verdict:
//
// - `ours`: page time (input → send, plus Transition → screen) at or over
//   PAGE_SLOW_MS, or our function or the re-runs' critical path at or
//   over FN_SLOW_MS, whatever else was slow.
// - `link`: ours known and normal, and the first hop stalled (≥ STALL_MS,
//   the LINK banner's rule).
// - `convex/network`: ours known and normal, and the probe was elevated
//   at that moment (PROBE_SLOW) or Convex was slow on other instances
//   too (a spell: SPELL).
// - `unclear`: no legs, the function unmatched, a save's re-runs unknown,
//   or ours normal with no evidence elsewhere. Unclear counts as ours.
//
// Ours evidence comes first (human, 2026-10-21): a stall elsewhere
// doesn't make our page or our functions slower. qc/README.md "Blame" has
// the order and the numbers. The reporter's verdict is context; the
// worker's live one judges (qc/judge.ts).

/** Page time this slow is ours: input → send plus Transition → screen. */
export const PAGE_SLOW_MS = 40
/** Our function this slow is ours (half the server budget). */
export const FN_SLOW_MS = 50
/** A probe this far over the worker's run median is an elevated moment. */
export const PROBE_SLOW = { ratio: 1.5, plusMs: 20 } as const
/**
 * A Convex-wide slow spell: calls at or over the server budget
 * (`callMs`) of at least `fns` different functions, on at least
 * `instances` other pool instances, within `windowMs` of the sample. The
 * probe runs every 2 s and misses most of them; a spell slows our own
 * function too. Seeds, bulk functions and `auth:*` (password hashing) are
 * slow by design: left out. So are the sample's own functions, and one
 * function alone is no spell: a regression of our code is slow on every
 * instance at once, and that is `ours`.
 */
export const SPELL = {
  callMs: 100,
  windowMs: 500,
  instances: 2,
  fns: 2,
} as const
/** Probes this close to the sample's window count as "at that moment". */
export const PROBE_NEAR_MS = 1_000
/**
 * Slack when matching a call to a sample. Without a commit (a query
 * change, an action) the window is send → screen message on the page's
 * clock, widened by this. A call's log time is its completion, about
 * 15 ms before its MutationResponse reaches the page (run tn9ttz4a:
 * 12–25 ms).
 */
export const MATCH_SLACK_MS = 10
/**
 * A mutation is matched on the server clock alone: its log time lands
 * after the commit timestamp the page saw, 5–91 ms (median ~9) over five
 * runs, so no clock skew can move it out of the window or another
 * worker's call into it.
 */
export const COMMIT_MATCH = { beforeMs: 10, afterMs: 100 } as const

export type Verdict = 'ours' | 'link' | 'convex/network' | 'unclear'
export const VERDICTS: Array<Verdict> = [
  'ours',
  'link',
  'convex/network',
  'unclear',
]

/** One line of server-calls.jsonl (qc/server-timings.ts). */
export interface ServerCall {
  instance: string
  /** Completion time on the server's clock (epoch ms). */
  at: number
  fn: string
  type: string
  ms: number
  cached?: true
}

/** One line of rtt-*.jsonl (qc/fixtures.ts). */
export interface Probe {
  at: number
  ms: number
  lagMs: number
  worker: number
  instance: string
}

export interface BlameContext {
  calls: Array<ServerCall>
  probes: Array<Probe>
  /** Lines that didn't parse (a worker killed mid-write), skipped. */
  skipped?: number
}

/** A slow sample: its legs, and where it ran. */
export type BlameSample = SampleDetail & {
  worker: number
  instance?: string
  linkMs?: number | null
}

export interface Blame {
  verdict: Verdict
  /** Which rule gave the verdict, in words. */
  why: string
  /** Input → send, plus Transition (or the last message) → screen. */
  pageMs: number | null
  /** Send → commit, less our function. Server clock: approximate. */
  toConvexMs: number | null
  /** The matched call's execution time. */
  fnMs: number | null
  /** The functions it matched, or why it couldn't. */
  fnMatch: string
  /** Commit → response. Server clock: approximate. */
  backMs: number | null
  /** Response → the Transition carrying the result. */
  transitionMs: number | null
  /** Send → screen message less our function, when there's no commit to split it. */
  convexNetworkMs: number | null
  /** Send → screen message, less our function and the probe: what a no-op wouldn't take. */
  overheadMs: number | null
  /** Legs that rest on the server's clock (commitMs). */
  approx: boolean
  longTaskMs: number
  /** The worker's probes nearest the sample. */
  probeMs: Array<number>
  /** The worker's run median probe. */
  probeMedianMs: number | null
  /** Other instances slow near the sample, when that's a spell (SPELL). */
  slowElsewhere: Array<string>
  linkMs: number | null
  /**
   * The page's queries that re-ran after the commit and completed before
   * the Transition carrying it: what the sample waited for besides our
   * mutation. Null without a commit, a Transition or the page's
   * subscriptions (history before `subs`).
   */
  reruns: Array<{ fn: string; ms: number }> | null
  /**
   * Their critical path (human, 2026-10-21): the union of their
   * intervals. Re-runs side by side count once (≈ the slowest); ones after
   * another add up; a chain of overlaps counts all it covers.
   */
  rerunCriticalMs: number | null
  rerunMaxMs: number | null
  /** The union of their [start, end] intervals (≥ max; = max when they overlap). */
  rerunUnionMs: number | null
  rerunSumMs: number | null
  /**
   * Page + our function + the re-runs' critical path: the time that is
   * ours whoever else was slow. Null when the function is unmatched.
   */
  ourShareMs: number | null
  /** Send → commit, less the probe: how long Convex took to commit. Server clock. */
  commitLatencyMs: number | null
  bytesIn: number | null
  requests: number | null
}

const r1 = (x: number) => Math.round(x * 10) / 10

/** The calls of `fns` that completed in [from, to] (epoch ms, slack included) on `instance`. */
function matchCalls(
  calls: Array<ServerCall>,
  instance: string | undefined,
  fns: Array<string> | undefined,
  from: number,
  to: number,
): { ms: number | null; how: string } {
  if (!instance) return { ms: null, how: 'unmatched: no instance' }
  if (!fns) return { ms: null, how: 'unmatched: sample has no function name' }
  if (!fns.length) return { ms: null, how: 'unmatched: sent no function' }
  const times: Array<number> = []
  for (const fn of new Set(fns)) {
    const hits = calls.filter(
      (c) =>
        c.instance === instance && c.fn === fn && c.at >= from && c.at <= to,
    )
    // Two workers share an instance: two candidates is a guess, so don't.
    if (hits.length !== 1) {
      return {
        ms: null,
        how: `unmatched: ${hits.length} ${fn} calls in the window`,
      }
    }
    times.push(hits[0].ms)
  }
  // Queries a ModifyQuerySet adds run side by side: the slowest decides.
  return { ms: Math.max(...times), how: [...new Set(fns)].join(', ') }
}

/**
 * The page's subscribed queries that re-ran after the commit and completed
 * by the Transition (± slack); null when that can't be told.
 */
function rerunCalls(
  calls: Array<ServerCall>,
  s: BlameSample,
): Array<ServerCall> | null {
  if (!s.instance || !s.subs || s.commitMs === null || s.transitionMs === null)
    return null
  const subs = new Set(s.subs)
  const own = new Set(s.fns ?? [])
  const commit = s.at + s.commitMs
  return calls
    .filter(
      (c) =>
        c.instance === s.instance &&
        c.type === 'Query' &&
        subs.has(c.fn) &&
        !own.has(c.fn) &&
        c.at - c.ms >= commit - COMMIT_MATCH.beforeMs &&
        c.at <= s.at + s.transitionMs! + MATCH_SLACK_MS,
    )
    .sort((a, b) => a.at - b.at)
}

/** Total length of the calls' [start, end] intervals, overlaps counted once. */
function unionMs(calls: Array<ServerCall>): number {
  const spans = calls
    .map((c): [number, number] => [c.at - c.ms, c.at])
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let cur: [number, number] | null = null
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0]
      cur = [a, b]
    } else cur[1] = Math.max(cur[1], b)
  }
  return cur ? total + cur[1] - cur[0] : total
}

/** The worker's probes whose round trip is within PROBE_NEAR_MS of [from, to]. */
function probesNear(
  probes: Array<Probe>,
  s: BlameSample,
  from: number,
  to: number,
): { near: Array<number>; medianMs: number | null } {
  const mine = probes.filter(
    (p) => p.worker === s.worker && (!s.instance || p.instance === s.instance),
  )
  const near = mine
    .filter(
      (p) => p.at <= to + PROBE_NEAR_MS && p.at + p.ms >= from - PROBE_NEAR_MS,
    )
    .map((p) => p.ms)
  return {
    near,
    medianMs: mine.length ? median(mine.map((p) => p.ms)) : null,
  }
}

/**
 * Other instances where Convex was slow within SPELL.windowMs of [from,
 * to], when that's a spell (SPELL); else none.
 */
function slowElsewhere(
  calls: Array<ServerCall>,
  s: BlameSample,
  from: number,
  to: number,
): Array<string> {
  const where = new Set<string>()
  const fns = new Set<string>()
  const own = new Set(s.fns ?? [])
  for (const c of calls) {
    if (
      c.instance !== s.instance &&
      !c.cached &&
      !own.has(c.fn) &&
      c.ms >= SPELL.callMs &&
      !(c.fn in BULK_FUNCTIONS) &&
      !c.fn.startsWith('platform/qcSeed:') &&
      !c.fn.startsWith('auth:') &&
      c.at >= from - SPELL.windowMs &&
      c.at <= to + SPELL.windowMs
    ) {
      where.add(c.instance)
      fns.add(c.fn)
    }
  }
  return where.size >= SPELL.instances && fns.size >= SPELL.fns
    ? [...where].sort()
    : []
}

/**
 * Send → commit, less the worker's probe at that moment (or its run
 * median): how long Convex took to commit beyond a no-op round trip.
 * Server clock. Null without a commit or any probe.
 */
export function commitLatency(
  s: BlameSample,
  probes: Array<Probe>,
): number | null {
  if (s.commitMs === null || s.sendMs === null) return null
  const p = probesNear(probes, s, s.at, s.at + s.endMs)
  const ref = p.near.length ? Math.max(...p.near) : p.medianMs
  return ref === null ? null : r1(s.commitMs - s.sendMs - ref)
}

export function probeElevated(ms: number, medianMs: number): boolean {
  return ms >= medianMs * PROBE_SLOW.ratio && ms >= medianMs + PROBE_SLOW.plusMs
}

/** Split one slow sample into legs and give it a verdict. */
export function blame(s: BlameSample, ctx: BlameContext): Blame {
  const end = s.endMs
  const screenAt = s.transitionMs ?? s.lastInMs
  const pageMs =
    s.sendMs === null
      ? null
      : r1(s.sendMs + (screenAt === null ? 0 : end - screenAt))
  // The server's answer: whichever reached the page first, the response
  // or the Transition, closes the request's round trip.
  const answerAt =
    s.responseMs !== null && s.transitionMs !== null
      ? Math.min(s.responseMs, s.transitionMs)
      : (s.responseMs ?? screenAt)
  const match =
    s.sendMs === null || answerAt === null
      ? { ms: null, how: 'unmatched: no request in the sample' }
      : s.commitMs !== null
        ? matchCalls(
            ctx.calls,
            s.instance,
            s.fns,
            s.at + s.commitMs - COMMIT_MATCH.beforeMs,
            s.at + s.commitMs + COMMIT_MATCH.afterMs,
          )
        : matchCalls(
            ctx.calls,
            s.instance,
            s.fns,
            s.at + s.sendMs - MATCH_SLACK_MS,
            s.at + (s.responseMs ?? screenAt ?? end) + MATCH_SLACK_MS,
          )
  const fn = match.ms ?? 0
  const split =
    s.sendMs !== null && s.commitMs !== null && s.responseMs !== null
  const toConvexMs = split ? r1(s.commitMs! - s.sendMs! - fn) : null
  const backMs = split ? r1(answerAt! - s.commitMs!) : null
  const transitionMs =
    s.responseMs !== null && s.transitionMs !== null
      ? r1(Math.max(0, s.transitionMs - s.responseMs))
      : null
  const convexNetworkMs =
    !split && s.sendMs !== null && answerAt !== null
      ? r1(answerAt - s.sendMs - fn)
      : null
  const linkMs = s.linkMs ?? null
  const probe = probesNear(ctx.probes, s, s.at, s.at + end)
  const probeRef =
    probe.near.length > 0 ? Math.max(...probe.near) : probe.medianMs
  const serverLeg =
    s.sendMs !== null && screenAt !== null ? screenAt - s.sendMs : null
  const overheadMs =
    serverLeg !== null && match.ms !== null && probeRef !== null
      ? r1(serverLeg - match.ms - probeRef)
      : null
  const elevated =
    probe.medianMs !== null &&
    probe.near.some((ms) => probeElevated(ms, probe.medianMs!))
  const elsewhere = slowElsewhere(ctx.calls, s, s.at, s.at + end)
  const rr = rerunCalls(ctx.calls, s)
  // The time the server spent on our re-runs: the union of their
  // intervals, never less than what they covered.
  const rerunCriticalMs = rr ? r1(unionMs(rr)) : null
  // A save whose re-runs can't be told has no share: it would understate.
  const ourShareMs =
    pageMs === null ||
    match.ms === null ||
    (s.commitMs !== null && rerunCriticalMs === null)
      ? null
      : r1(pageMs + match.ms + (rerunCriticalMs ?? 0))
  const commitLatencyMs = commitLatency(s, ctx.probes)

  // Ours evidence first (human, 2026-10-21): a link stall, a slow probe
  // or a spell doesn't make our page, function or re-runs slower, so any
  // of those slow is ours whatever else was slow. Not ours only when every
  // part of ours is known and normal.
  const verdict = ((): [Verdict, string] => {
    if (pageMs === null) return ['unclear', 'no legs (nothing sent)']
    if (pageMs >= PAGE_SLOW_MS)
      return ['ours', `page ${pageMs} ms (≥ ${PAGE_SLOW_MS})`]
    if (match.ms !== null && match.ms >= FN_SLOW_MS)
      return ['ours', `function ${match.ms} ms (≥ ${FN_SLOW_MS})`]
    if (rerunCriticalMs !== null && rerunCriticalMs >= FN_SLOW_MS)
      return ['ours', `re-runs ${rerunCriticalMs} ms (≥ ${FN_SLOW_MS})`]
    if (match.ms === null) return ['unclear', `function ${match.how}`]
    if (s.commitMs !== null && rerunCriticalMs === null)
      return ['unclear', 're-runs unknown (no subscriptions recorded)']
    if (linkMs !== null && linkMs >= STALL_MS)
      return ['link', `first hop at ${linkMs} ms (≥ ${STALL_MS})`]
    if (elevated)
      return [
        'convex/network',
        `probe ${Math.max(...probe.near)} ms against a run median of ${probe.medianMs}`,
      ]
    if (elsewhere.length)
      return [
        'convex/network',
        `Convex slow on ${elsewhere.join(', ')} at that moment too`,
      ]
    // Ours normal, the excess in the legs between: no evidence against
    // us (human, 2026-10-21). Unclear counts as ours.
    return [
      'unclear',
      `function ${match.ms} ms and page ${pageMs} ms normal, no evidence elsewhere`,
    ]
  })()

  return {
    verdict: verdict[0],
    why: verdict[1],
    pageMs,
    toConvexMs,
    fnMs: match.ms,
    fnMatch: match.how,
    backMs,
    transitionMs,
    convexNetworkMs,
    overheadMs,
    approx: split,
    longTaskMs: s.longTaskMs,
    probeMs: probe.near,
    probeMedianMs: probe.medianMs,
    slowElsewhere: elsewhere,
    linkMs,
    reruns: rr?.map((c) => ({ fn: c.fn, ms: c.ms })) ?? null,
    rerunCriticalMs,
    rerunMaxMs: rr ? Math.max(0, ...rr.map((c) => c.ms)) : null,
    rerunUnionMs: rr ? r1(unionMs(rr)) : null,
    rerunSumMs: rr ? r1(rr.reduce((n, c) => n + c.ms, 0)) : null,
    ourShareMs,
    commitLatencyMs,
    bytesIn: s.bytesIn ?? null,
    requests: s.requests ?? null,
  }
}

const ms = (x: number | null, approx = false) =>
  x === null ? '?' : `${approx ? '≈' : ''}${Math.round(x)}`

/**
 * `136 = page 9 · to Convex ≈41 · our function 18 · back ≈47 · Transition
 * 21 · probe 88 ms @ that moment (run median 31) · link 3 ms → convex/network`
 */
export function formatBlame(endMs: number, b: Blame): string {
  const parts = [`page ${ms(b.pageMs)}`]
  if (b.longTaskMs) parts.push(`long tasks ${Math.round(b.longTaskMs)}`)
  if (b.toConvexMs !== null)
    parts.push(`to Convex ${ms(b.toConvexMs, b.approx)}`)
  else if (b.convexNetworkMs !== null)
    parts.push(`Convex + network ${ms(b.convexNetworkMs)}`)
  parts.push(
    b.fnMs === null
      ? `our function ${b.fnMatch}`
      : `our function ${ms(b.fnMs)} (${b.fnMatch})`,
  )
  if (b.reruns?.length)
    parts.push(
      `re-runs ${b.reruns.map((r) => `${r.fn.split(':')[1]} ${Math.round(r.ms)}`).join(', ')} (critical ${ms(b.rerunCriticalMs)})`,
    )
  if (b.backMs !== null) parts.push(`back ${ms(b.backMs, b.approx)}`)
  if (b.transitionMs !== null) parts.push(`Transition ${ms(b.transitionMs)}`)
  if (b.overheadMs !== null)
    parts.push(`overhead beyond the probe ${ms(b.overheadMs)}`)
  parts.push(
    b.probeMs.length
      ? `probe ${b.probeMs.map((x) => Math.round(x)).join('/')} ms @ that moment (run median ${ms(b.probeMedianMs)})`
      : `probe: none within ${PROBE_NEAR_MS / 1000} s (run median ${ms(b.probeMedianMs)})`,
  )
  if (b.slowElsewhere.length)
    parts.push(`Convex slow on ${b.slowElsewhere.join(', ')} too`)
  parts.push(b.linkMs === null ? 'link ?' : `link ${Math.round(b.linkMs)} ms`)
  if (b.ourShareMs !== null) parts.push(`our share ${ms(b.ourShareMs)}`)
  return `${Math.round(endMs)} = ${parts.join(' · ')} → ${b.verdict} (${b.why})`
}

/**
 * Server calls and probes from a run directory; empty when absent. Never
 * throws: it runs in the reporter's onEnd, so a torn line (a worker killed
 * mid-append) or an unreadable file is skipped and counted, and blame
 * degrades to `unclear` rather than losing the run's table and gates.
 */
export function readBlameContext(dir: string): BlameContext {
  let skipped = 0
  const jsonl = <T>(file: string): Array<T> => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      skipped++
      return []
    }
    return text
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T]
        } catch {
          skipped++
          return []
        }
      })
  }
  const callsFile = path.join(dir, 'server-calls.jsonl')
  let rtts: Array<string> = []
  try {
    rtts = existsSync(dir)
      ? readdirSync(dir).filter(
          (f) => f.startsWith('rtt-') && f.endsWith('.jsonl'),
        )
      : []
  } catch {
    skipped++
  }
  return {
    calls: existsSync(callsFile) ? jsonl<ServerCall>(callsFile) : [],
    probes: rtts.flatMap((f) => jsonl<Probe>(path.join(dir, f))),
    skipped,
  }
}

export type VerdictCounts = Partial<Record<Verdict, number>>

export function countVerdicts(bs: Array<{ verdict: Verdict }>): VerdictCounts {
  const out: VerdictCounts = {}
  for (const b of bs) out[b.verdict] = (out[b.verdict] ?? 0) + 1
  return out
}

export const formatCounts = (c: VerdictCounts) =>
  VERDICTS.filter((v) => c[v])
    .map((v) => `${v} ${c[v]}`)
    .join(', ') || 'none'
