import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { STALL_MS } from './link.setup'
import { median } from './timing'
import type { SampleDetail } from './timing'

// Whose time a slow sample was (human, 2026-10-21: explain, don't judge).
// For every sample at or over budget the reporter splits the time into
// legs from what the run recorded: the sample's WebSocket legs
// (qc/timing.ts), the matching Convex call from `convex logs`
// (server-calls.jsonl), the worker's `platform/qcProbe:rtt` probe every
// 2 s (rtt-*.jsonl) and the first-hop ping (link.json). Then a verdict:
//
// - `link`: the first hop stalled during the sample (≥ STALL_MS, the
//   LINK banner's rule).
// - `ours`: page time (input → send, plus Transition → screen) at or over
//   PAGE_SLOW_MS, or our function at or over FN_SLOW_MS with the probe
//   normal.
// - `convex/network`: the probe was elevated at that moment (PROBE_SLOW),
//   or the function was matched and normal and the page normal, so the
//   excess is in the legs between them.
// - `unclear`: no legs, or the function couldn't be matched.
//
// The checks run in that order; the first that holds wins, except that
// a slow page is `ours` before an elevated probe is looked at, since the
// page's time doesn't depend on the server. Context only: a verdict
// never changes whether a sample or a flow passes.

/** Page time this slow is ours: input → send plus Transition → screen. */
export const PAGE_SLOW_MS = 40
/** Our function this slow is ours (half the server budget). */
export const FN_SLOW_MS = 50
/** A probe this far over the worker's run median is an elevated moment. */
export const PROBE_SLOW = { ratio: 1.5, plusMs: 20 } as const
/** Probes this close to the sample's window count as "at that moment". */
export const PROBE_NEAR_MS = 1_000
/**
 * Slack on the server clock when matching a call to a sample. A call's
 * log time is its completion, about 15 ms before its MutationResponse
 * reaches the page (measured on run tn9ttz4a: 12–25 ms).
 */
export const MATCH_SLACK_MS = 10

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
  linkMs: number | null
}

const r1 = (x: number) => Math.round(x * 10) / 10

/** The calls of `fns` that completed in [from, to] (epoch ms) on `instance`. */
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
        c.instance === instance &&
        c.fn === fn &&
        c.at >= from - MATCH_SLACK_MS &&
        c.at <= to + MATCH_SLACK_MS,
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
      : matchCalls(
          ctx.calls,
          s.instance,
          s.fns,
          s.at + s.sendMs,
          s.at + (s.responseMs ?? screenAt ?? end),
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

  const verdict = ((): [Verdict, string] => {
    if (linkMs !== null && linkMs >= STALL_MS)
      return ['link', `first hop at ${linkMs} ms (≥ ${STALL_MS})`]
    if (pageMs === null) return ['unclear', 'no legs (nothing sent)']
    if (pageMs >= PAGE_SLOW_MS)
      return ['ours', `page ${pageMs} ms (≥ ${PAGE_SLOW_MS})`]
    if (elevated)
      return [
        'convex/network',
        `probe ${Math.max(...probe.near)} ms against a run median of ${probe.medianMs}`,
      ]
    if (match.ms === null) return ['unclear', `function ${match.how}`]
    if (match.ms >= FN_SLOW_MS)
      return ['ours', `function ${match.ms} ms (≥ ${FN_SLOW_MS})`]
    return [
      'convex/network',
      `function ${match.ms} ms and page ${pageMs} ms normal`,
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
    linkMs,
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
  if (b.backMs !== null) parts.push(`back ${ms(b.backMs, b.approx)}`)
  if (b.transitionMs !== null) parts.push(`Transition ${ms(b.transitionMs)}`)
  if (b.overheadMs !== null)
    parts.push(`overhead beyond the probe ${ms(b.overheadMs)}`)
  parts.push(
    b.probeMs.length
      ? `probe ${b.probeMs.map((x) => Math.round(x)).join('/')} ms @ that moment (run median ${ms(b.probeMedianMs)})`
      : `probe: none within ${PROBE_NEAR_MS / 1000} s (run median ${ms(b.probeMedianMs)})`,
  )
  parts.push(b.linkMs === null ? 'link ?' : `link ${Math.round(b.linkMs)} ms`)
  return `${Math.round(endMs)} = ${parts.join(' · ')} → ${b.verdict} (${b.why})`
}

/** Server calls and probes from a run directory; empty when absent. */
export function readBlameContext(dir: string): BlameContext {
  const jsonl = <T>(file: string): Array<T> =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T)
  const callsFile = path.join(dir, 'server-calls.jsonl')
  return {
    calls: existsSync(callsFile) ? jsonl<ServerCall>(callsFile) : [],
    probes: existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.startsWith('rtt-') && f.endsWith('.jsonl'))
          .flatMap((f) => jsonl<Probe>(path.join(dir, f)))
      : [],
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
