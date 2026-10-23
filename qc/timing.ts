import {
  appendFileSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
} from 'node:fs'
import { loadavg } from 'node:os'
import path from 'node:path'
import { BaseConvexClient } from 'convex/browser'
import type { QueryToken } from 'convex/browser'
import { getFunctionName } from 'convex/server'
import type { BrowserContext, Page } from '@playwright/test'
import { api } from '../convex/_generated/api'
import { budgetFor } from './budgets'
import type { FlowKind, FlowName } from './budgets'
import { RETRY_CAP_PER_RUN, judgeSlowSample } from './judge'
import type { SampleJudgement } from './judge'
import type { LiveRun } from './live'
import { sampling } from './quiet'

// Client-perceived latency (factory/plans/qc-suite.sv, "What latency
// means"). Timed inside the page: t0 is the event timestamp of the *last*
// input event the action dispatches (or navigation start for a page
// load), and t1 is `performance.now()` in the first animation frame where
// the `until` predicate holds.
//
// Why the last: the rule is "from the input event to the result on
// screen", and for a typed action that input is the keystroke that
// completes it. Playwright types one key per CDP round trip, so timing
// from the first key would charge Playwright's typing speed to the app.
// For a click, the last event we listen for is mousedown, which arrives
// with pointerdown. `fill()` is a single insertText (one input event), so
// either way it times from that. Playwright's own expect polling (100 ms+)
// is far too coarse for this.
//
// Samples are judged raw: every one must be under the flow's maxMs
// (qc/budgets.ts). The worker's WebSocket RTT (probeRtt) is recorded for
// context, and above RTT_CEILING_MS the run skips the latency asserts.
//
// Spikes (human, 2026-10-18): Convex dev deployments occasionally stall,
// so a judged flow with any sample at or over budget is re-measured once,
// at once, with a full K samples. Only the second set is judged; the first
// is kept as `firstSamplesMs` and shown in the table, history and trend.
// Record mode and runs over the RTT ceiling judge nothing, so they never
// re-measure. Functional asserts never retry.
//
// Every sample also carries its legs (SampleDetail), for finding where a
// slow one spent its time: a tap on the page's WebSocket notes when the
// first message went out after the input, when the server committed and
// answered, and when the Transition carrying the result came back; the
// page's long tasks and the host's CPU cover the local side. Context only:
// nothing is judged on them.
//
// Tracing (human, 2026-10-23): Playwright tracing is off for the whole
// run (playwright.config.ts). It snapshots the DOM around every action,
// timed clicks included, so it charged the harness's own work to the app
// and more so the bigger the page (~230 ms on one Load more). A flow that
// fails its budget instead gets one more sample, untimed and unjudged,
// with tracing on (`tracePath`): the failure stays debuggable and no
// judged sample is ever traced.
//
// Held results (review of 9e64046): a sample must do the work it claims
// to measure. The Convex client keeps a removed query's last result until
// the server acknowledges the removal, so a `before` that clears a search
// and an action that types it again, faster than a round trip, draws the
// old answer with nothing from the server. After every `before` the
// harness therefore waits until the server has answered every query-set
// change the page sent (`settle`). A flow whose result is meant to come
// from the server says `server: true`, and a sample in which the watched
// page got no query result from the server fails (HeldResultError).
// What the app itself holds on purpose is a flow's own business:
// `released` waits out a route loader's 5 s prewarm, and a reload in
// `before` clears what the client keeps in memory (the contact page's
// keep-alive cache, the rows the list remembers per filter).

/** Timed samples per flow call; QC_REPEATS=1 is a fast functional run. */
export const REPEATS = Number(process.env.QC_REPEATS ?? 5)
/** QC_MODE=record measures and writes history but never asserts. */
export const RECORD = process.env.QC_MODE === 'record'
/**
 * QC_LEGS=0 leaves the WebSocket tap off: samples carry no legs. For an
 * A/B of the tap's own cost on the same commit.
 */
export const LEGS = process.env.QC_LEGS !== '0'
/**
 * Above this median RTT, raw timings measure the link, not the app: assert
 * runs skip the latency asserts, and every run flags the samples (the
 * banner, and `rttOver` in history) so step 9b can drop them.
 */
export const RTT_CEILING_MS = 150

if (!Number.isInteger(REPEATS) || REPEATS < 1) {
  throw new Error(`QC_REPEATS must be a positive integer, not ${REPEATS}`)
}

export function runId(): string {
  const id = process.env.QC_RUN_ID
  if (!id) throw new Error('QC_RUN_ID is unset (playwright.config.ts sets it)')
  return id
}

/** Per-run scratch: flow records (one file per worker process). */
export function runDir(id = runId()): string {
  return path.join('qc-results', 'runs', id)
}

/**
 * Where one sample's time went. Offsets are ms from the input event (t0);
 * null when the sample had no such message. `commitMs` is on the server's
 * clock (Convex timestamps), so it's only as good as the two clocks agree.
 */
export interface SampleDetail {
  /** Wall clock (epoch ms) of the input event. */
  at: number
  /** First Mutation, Action or ModifyQuerySet the page sent after t0. */
  sendMs: number | null
  sent: string | null
  /**
   * What that message runs: the Mutation's or Action's function, or the
   * queries a ModifyQuerySet adds (canonical `module:name`, as in
   * `convex logs`). Absent on history from before it was recorded.
   */
  fns?: Array<string>
  /**
   * The queries the watched page was subscribed to at the end of the
   * sample (canonical `module:name`): the re-runs it may have waited for.
   */
  subs?: Array<string>
  /** Characters (≈ bytes) of server frames the watched page got in the sample. */
  bytesIn?: number
  /** Mutations, actions and query changes the page sent in the sample. */
  requests?: number
  /** The mutation's commit timestamp, from its MutationResponse. */
  commitMs: number | null
  /** Its MutationResponse arrived. */
  responseMs: number | null
  /** The Transition that carries the commit (or, without one, the first after the send). */
  transitionMs: number | null
  /** The last server message before the result was on screen. */
  lastInMs: number | null
  /** The result was on screen: the sample. */
  endMs: number
  /**
   * The server sent the watched page a query result during the sample
   * (`answered`). Absent without the tap, and on history from before it.
   */
  answered?: boolean
  /** Main-thread long tasks overlapping the sample, summed. */
  longTaskMs: number
  /** WebSockets the page opened during the sample (a reconnect). */
  connects: number
  /** The page wasn't visible (rAF and timers throttled). */
  hidden: boolean
  /** Host CPU busy fraction over the sample (Linux /proc/stat), else null. */
  hostCpu: number | null
  /** The host's 1-minute load average. */
  load1: number
  /**
   * Waited this long, before arming, for another worker's bulk write to
   * release the instance (qc/quiet.ts). Outside the sample: context only.
   */
  quietWaitMs?: number
  /** At or over budget in the judged set: how it was judged (qc/judge.ts). */
  judge?: SampleJudgement
}

export interface FlowRecord {
  runId: string
  flow: FlowName
  /** Playwright parallelIndex of the worker. */
  worker: number
  /** The pool instance the worker uses (qc-1 …), when known. */
  instance?: string
  /** Title path of the test, or "worker setup" for fixture flows. */
  where: string
  kind: FlowKind
  /** Input event to result on screen, network included. The judged set. */
  samplesMs: Array<number>
  /** A spike: the first set, which had a sample at or over budget. */
  firstSamplesMs?: Array<number>
  /** One per sample, in order. */
  detail: Array<SampleDetail>
  firstDetail?: Array<SampleDetail>
  /** Context only: the worker's median WebSocket round trip. */
  rttMs: number
  /** rttMs over RTT_CEILING_MS: these samples measure a bad link. */
  rttOver: boolean
  /** The failing line: every sample must be under this. */
  budgetMs: number
  /** Tracked, never failed (qc/target.ts); absent for kinds without one. */
  targetMs?: number
  medianMs: number
  maxMs: number
  /** null: not judged (record mode, or RTT over the ceiling). */
  pass: boolean | null
  skipped?: 'record' | 'rtt'
  selfTest?: true
  /** Approved exception (qc/budgets.ts): judged, but never fails. */
  knownOver?: string
  /**
   * Failed: the Playwright trace of one extra, unjudged sample. On the
   * returned record only: the written one is final before it is taken.
   */
  trace?: string
  /** That extra sample threw (the trace shows how). */
  traceError?: string
}

export interface FlowStep<TArg = undefined> {
  /** Untimed, before every repeat (and the warm-up): reach the start state. */
  before?: () => Promise<void>
  /** The timed user action, e.g. a click or a keystroke. */
  action: () => Promise<void>
  /**
   * Runs in the page every animation frame until truthy. Serialised like
   * page.waitForFunction's argument: no closures over test variables,
   * pass data through `arg`.
   */
  until: (arg: TArg) => unknown
  arg?: TArg
  /**
   * 'input' (default): t0 is the last pointer/key/input event the action
   * dispatches (one click, the final keystroke, or fill's single input).
   * 'navigation': t0 is the new document's navigation start; the action
   * must resolve before render, e.g.
   * `page.goto(url, { waitUntil: 'commit' })`.
   */
  start?: 'input' | 'navigation'
  /**
   * The page the action's input lands on, when it isn't the page `until`
   * watches (propagation between two tabs). t0 is read there and both
   * clocks are put on one time base with `performance.timeOrigin`; the
   * pages share the machine's clock.
   */
  inputPage?: Page
  /**
   * The result comes from the server: every sample must get a query result
   * from it before \`until\` holds, or the flow fails with HeldResultError
   * (the client already held the answer, so the sample timed a local
   * re-render). Unchecked with the tap off (QC_LEGS=0).
   */
  server?: true
}

export interface FlowContext {
  page: Page
  rttMs: number
  worker: number
  instance?: string
  where: string
  repeats?: number
  /** One untimed iteration first, once per flow per worker (default true). */
  warmUp?: boolean
  /**
   * Where to write the trace of one extra, unjudged sample when the flow
   * fails its budget. Without it a failing flow records no trace.
   */
  tracePath?: string
}

export function median(xs: Array<number>): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Nearest-rank percentile, p in (0, 100]. */
export function percentile(xs: Array<number>, p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
}

const round1 = (x: number) => Math.round(x * 10) / 10

/** The plan's pass rule: every sample under the budget. */
export function judge(samplesMs: Array<number>, budgetMs: number) {
  const maxMs = Math.max(...samplesMs)
  return { medianMs: median(samplesMs), maxMs, pass: maxMs < budgetMs }
}

// What the tap keeps while a sample runs: the time and the frame itself,
// a reference to the string, nothing parsed. readLegs parses after t1.
type RawEntry = [t: number, dir: 'out' | 'in', data: string]

// A frame after parsing (in readLegs, outside the timed window).
export type WireEntry = [
  t: number,
  dir: 'out' | 'in' | 'open',
  type: string,
  requestId: number | null,
  tsMs: number | null,
  fns?: Array<string>,
  /** ModifyQuerySet: its newVersion. Transition: its endVersion.querySet. */
  querySet?: number | null,
  /** A Transition carrying a query result (QueryUpdated or QueryFailed). */
  result?: boolean,
]

interface QcWindow {
  __qcListening?: boolean
  __qcArmed?: boolean
  __qcT0?: number
  __qcWire?: Array<RawEntry>
  __qcLong?: Array<[start: number, duration: number]>
  __qcVis?: Array<number>
  /** Every frame the page sent, kept across samples until readLegs folds it into __qcSubs. */
  __qcOut?: Array<[t: number, data: string]>
  /** The page's live subscriptions: queryId → udfPath. */
  __qcSubs?: Record<string, string>
  /** The fold has seen a Connect: __qcSubs is the whole set. */
  __qcSubsKnown?: boolean
  /** Fold __qcOut's frames up to `t` into __qcSubs (arm installs it). */
  __qcFold?: (t: number) => void
  /** settle: consecutive frames with no query-set change unanswered. */
  __qcQuiet?: number
}

// Capture-phase listeners record the timestamp of each trusted input event
// after arming; the last one wins (see the top of this file).
// Event.timeStamp shares performance.now()'s time base, so t0 is when the
// browser saw the input, not when Playwright sent it.
//
// With `legs`, the first arm also taps the page's WebSockets through
// WebSocket.prototype.send, so a socket opened before the tap (the SPA's,
// on page load) is caught by its first send after it; the server messages
// before that belong to no sample. Inside the timed window the tap only
// pushes [time, direction, string] (no parsing, no regex); an incoming
// frame's time is its MessageEvent.timeStamp, set when the message was
// dispatched, so the SPA's own handler, which runs first, isn't counted
// in it. Each arm empties the buffer, so it holds one sample's frames.
//
// tapContext runs the same function as an init script with `now` false:
// it installs the tap before the app's own scripts, so the tap sees the
// socket's Connect and every subscription the page makes, not only those
// after the first sample. Without that the subscriptions are unknown.
function arm([legs, now]: [legs: boolean, now: boolean]) {
  const w = window as unknown as QcWindow
  if (!w.__qcListening) {
    w.__qcListening = true
    for (const type of [
      'pointerdown',
      'mousedown',
      'keydown',
      'beforeinput',
      'input',
    ]) {
      window.addEventListener(
        type,
        (e) => {
          if (w.__qcArmed && e.isTrusted) w.__qcT0 = e.timeStamp
        },
        { capture: true },
      )
    }
    if (legs) {
      w.__qcWire = []
      w.__qcOut = []
      w.__qcSubs = {}
      const longs: Array<[number, number]> = (w.__qcLong = [])
      const vis: Array<number> = (w.__qcVis = [])
      document.addEventListener('visibilitychange', (e) =>
        vis.push(e.timeStamp),
      )
      // Between flows nothing arms, so cap what an idle page collects.
      const note = (e: RawEntry) => {
        const wire = w.__qcWire!
        wire.push(e)
        if (wire.length > 500) wire.splice(0, 250)
      }
      const tapped = new WeakSet<WebSocket>()
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (!tapped.has(this)) {
          tapped.add(this)
          this.addEventListener('message', (ev: MessageEvent) => {
            if (typeof ev.data === 'string') note([ev.timeStamp, 'in', ev.data])
          })
        }
        if (typeof data === 'string') {
          const t = performance.now()
          note([t, 'out', data])
          w.__qcOut!.push([t, data])
        }
        return send.call(this, data)
      }
      // The page's subscriptions as of `t`: every frame it sent so far,
      // folded in order. A Connect starts the set again (the client
      // re-adds them). Outside the timed window only.
      w.__qcFold = (t: number) => {
        const subs = (w.__qcSubs ??= {})
        const out = w.__qcOut ?? []
        let done = 0
        try {
          for (const [at, data] of out) {
            if (at > t) break
            done++
            const type = /"type":"(\w+)"/.exec(data.slice(0, 200))?.[1]
            if (type === 'Connect') {
              for (const k of Object.keys(subs)) delete subs[k]
              w.__qcSubsKnown = true
            } else if (type === 'ModifyQuerySet') {
              const m = JSON.parse(data) as {
                modifications?: Array<{
                  type: string
                  queryId: number
                  udfPath?: string
                }>
              }
              for (const x of m.modifications ?? []) {
                if (x.type === 'Add' && x.udfPath) subs[x.queryId] = x.udfPath
                else if (x.type === 'Remove') delete subs[x.queryId]
              }
            }
          }
        } catch {
          // A frame that won't parse: unknown until the next Connect.
          for (const k of Object.keys(subs)) delete subs[k]
          w.__qcSubsKnown = false
        }
        out.splice(0, done)
      }
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            longs.push([e.startTime, e.duration])
          if (longs.length > 500) longs.splice(0, 250)
        }).observe({ type: 'longtask', buffered: true })
      } catch {
        // No long-task timing in this browser: longTaskMs reads 0.
      }
    }
  }
  if (!now) return
  if (w.__qcWire) w.__qcWire.length = 0
  w.__qcT0 = undefined
  w.__qcArmed = true
}

/** Install the tap in every page of `context` from its first script. */
export async function tapContext(context: BrowserContext) {
  if (LEGS)
    await context.addInitScript(arm, [true, false] as [boolean, boolean])
}

function readT0() {
  const w = window as unknown as QcWindow
  w.__qcArmed = false
  return w.__qcT0 ?? null
}

type Legs = Omit<SampleDetail, 'at' | 'endMs' | 'hostCpu' | 'load1'>

// In the page, after the sample: parse the frames of [t0, t1] (both
// performance.now()) and read its legs. `out` reads the input side (the
// page the action hit), `in` the side whose screen is watched; for one
// page they're the same. Null legs when the tap is off.
function readLegs([t0, t1, side]: [number, number, 'out' | 'in' | 'both']) {
  const w = window as unknown as QcWindow
  if (!w.__qcWire) return null
  // Convex timestamps: u64 nanoseconds, little-endian, base64.
  const tsMs = (b64: string | undefined) => {
    if (!b64) return null
    const b = atob(b64)
    let n = 0n
    for (let i = b.length - 1; i >= 0; i--)
      n = (n << 8n) | BigInt(b.charCodeAt(i))
    return Number(n / 1_000_000n)
  }
  const parse = ([t, d, data]: RawEntry): Array<WireEntry> => {
    const type = /"type":"(\w+)"/.exec(data.slice(0, 200))?.[1] ?? '?'
    if (d === 'out') {
      if (type === 'Mutation' || type === 'Action') {
        const m = JSON.parse(data) as { requestId?: number; udfPath?: string }
        return [
          [
            t,
            'out',
            type,
            m.requestId ?? null,
            null,
            m.udfPath ? [m.udfPath] : [],
          ],
        ]
      }
      if (type === 'ModifyQuerySet') {
        const m = JSON.parse(data) as {
          newVersion?: number
          modifications?: Array<{ type: string; udfPath?: string }>
        }
        const adds = (m.modifications ?? []).flatMap((x) =>
          x.type === 'Add' && x.udfPath ? [x.udfPath] : [],
        )
        return [[t, 'out', type, null, null, adds, m.newVersion ?? null]]
      }
      return type === 'Connect'
        ? [
            [t, 'open', type, null, null],
            [t, 'out', type, null, null],
          ]
        : [[t, 'out', type, null, null]]
    }
    if (type === 'Transition') {
      const m = JSON.parse(data) as {
        endVersion?: { ts?: string; querySet?: number }
        modifications?: Array<{ type: string }>
      }
      const result = (m.modifications ?? []).some(
        (x) => x.type === 'QueryUpdated' || x.type === 'QueryFailed',
      )
      return [
        [
          t,
          'in',
          type,
          null,
          tsMs(m.endVersion?.ts),
          undefined,
          m.endVersion?.querySet ?? null,
          result,
        ],
      ]
    }
    if (type === 'MutationResponse' || type === 'ActionResponse') {
      const m = JSON.parse(data) as { requestId?: number; ts?: string }
      return [[t, 'in', type, m.requestId ?? null, tsMs(m.ts)]]
    }
    return [[t, 'in', type, null, null]]
  }
  // A checkbox click's trusted `input` event fires inside the click, as the
  // mutation is sent: allow the send a millisecond before t0.
  // Context only: a frame that won't parse (a protocol change) costs the
  // sample its legs, never the flow.
  let wire: Array<WireEntry>
  try {
    wire = w.__qcWire.filter(([t]) => t >= t0 - 1 && t <= t1).flatMap(parse)
  } catch {
    return null
  }
  const rel = (t: number | null | undefined) =>
    t === null || t === undefined ? null : Math.round((t - t0) * 10) / 10
  const origin = performance.timeOrigin
  const legs: Partial<Legs> & {
    commitAt?: number | null
    addVersion?: number | null
  } = {}
  if (side !== 'in') {
    // The request the action makes, if any; else the query change.
    const first =
      wire.find(
        ([, d, type]) =>
          d === 'out' && (type === 'Mutation' || type === 'Action'),
      ) ?? wire.find(([, d, type]) => d === 'out' && type === 'ModifyQuerySet')
    legs.sendMs = rel(first?.[0])
    legs.sent = first?.[2] ?? null
    legs.fns = first?.[5] ?? []
    // The query-set version of the first change that adds a query.
    legs.addVersion =
      wire.find(
        ([, d, type, , , fns]) =>
          d === 'out' && type === 'ModifyQuerySet' && (fns?.length ?? 0) > 0,
      )?.[6] ?? null
    const resp =
      first && first[3] !== null
        ? wire.find(
            ([t, d, type, id]) =>
              d === 'in' &&
              t >= first[0] &&
              id === first[3] &&
              type.endsWith('Response'),
          )
        : undefined
    legs.responseMs = rel(resp?.[0])
    legs.commitAt = resp?.[4] ?? null
    legs.commitMs =
      resp?.[4] != null ? Math.round(resp[4] - (origin + t0)) : null
    legs.connects = wire.filter(([, d]) => d === 'open').length
  }
  if (side !== 'out') {
    const ins = wire.filter(([, d]) => d === 'in')
    legs.lastInMs = rel(ins.at(-1)?.[0])
    // What the server sent this page during the sample, in characters of
    // JSON (≈ bytes), and how many requests the page made.
    legs.bytesIn = w.__qcWire
      .filter(([t, d]) => d === 'in' && t >= t0 - 1 && t <= t1)
      .reduce((n, [, , data]) => n + data.length, 0)
    legs.requests = wire.filter(
      ([, d, type]) =>
        d === 'out' &&
        (type === 'Mutation' || type === 'Action' || type === 'ModifyQuerySet'),
    ).length
    // The page's subscriptions as of t1. Only a set folded from the
    // socket's Connect is the whole set.
    w.__qcFold?.(t1)
    if (w.__qcSubsKnown)
      legs.subs = [...new Set(Object.values(w.__qcSubs ?? {}))].sort()
    legs.longTaskMs = Math.round(
      (w.__qcLong ?? [])
        .filter(([s, d]) => s + d >= t0 && s <= t1)
        .reduce(
          (sum, [s, d]) => sum + Math.min(s + d, t1) - Math.max(s, t0),
          0,
        ),
    )
    // Hidden at any point in the sample: now, or a change during it.
    legs.hidden =
      document.visibilityState !== 'visible' ||
      (w.__qcVis ?? []).some((t) => t >= t0 && t <= t1)
  }
  const ins = wire
    .filter(([, d]) => d === 'in')
    .map(([t, d, type, id, ts, fns, querySet, result]): WireEntry => [
      rel(t)!,
      d,
      type,
      id,
      ts,
      fns,
      querySet,
      result,
    ])
  return { legs, ins }
}

// Host CPU (all cores) from /proc/stat: [busy, total] jiffies.
function cpuTicks(): [number, number] | null {
  try {
    const f = readFileSync('/proc/stat', 'utf8')
      .split('\n')[0]
      .trim()
      .split(/\s+/)
      .slice(1)
      .map(Number)
    const idle = f[3] + (f[4] ?? 0)
    const total = f.reduce((a, b) => a + b, 0)
    return [total - idle, total]
  } catch {
    return null
  }
}

// In the page, outside the timed window: true once the server has
// answered every query-set change the page sent since its socket's last
// Connect (each Transition carries the query-set version it brings the
// page to), for three animation frames in a row, so a React effect that
// unsubscribes a frame after `before` returns still counts.
function settledFrames(): boolean {
  const w = window as unknown as QcWindow
  let sent = -1
  let acked = -1
  for (const [, d, data] of w.__qcWire ?? []) {
    const type = /"type":"(\w+)"/.exec(data.slice(0, 200))?.[1]
    if (d === 'out' && type === 'Connect') {
      sent = -1
      acked = -1
    } else if (d === 'out' && type === 'ModifyQuerySet') {
      const v = /"newVersion":(\d+)/.exec(data)?.[1]
      if (v) sent = Math.max(sent, Number(v))
    } else if (d === 'in' && type === 'Transition') {
      const v = /"endVersion":\{[^}]*"querySet":(\d+)/.exec(
        data.slice(0, 600),
      )?.[1]
      if (v) acked = Math.max(acked, Number(v))
    }
  }
  if (acked < sent) {
    w.__qcQuiet = 0
    return false
  }
  w.__qcQuiet = (w.__qcQuiet ?? 0) + 1
  return w.__qcQuiet >= 3
}

/**
 * Wait until the server has answered every query-set change `page` sent,
 * so the Convex client holds results only for queries it is subscribed to
 * (see the top of the file). measureOnce runs it after every `before`.
 */
export async function settle(page: Page, timeoutMs = 15_000) {
  if (!LEGS) return
  await page.evaluate(() => {
    ;(window as unknown as QcWindow).__qcQuiet = 0
  })
  await page.waitForFunction(settledFrames, undefined, {
    polling: 'raf',
    timeout: timeoutMs,
  })
}

/**
 * Wait until `page` holds no subscription to any of `fns` (canonical
 * `module:name`), and the server has answered the removal: for a query
 * the app holds on purpose after its page is gone (a route loader's
 * prewarm), so a sample that needs it fetches it. Needs the tap from the
 * page's first script (the `context` fixture installs it).
 */
export async function released(
  page: Page,
  fns: Array<string>,
  timeoutMs = 15_000,
) {
  if (!LEGS) return
  await page.waitForFunction(
    (paths) => {
      const w = window as unknown as QcWindow
      if (!w.__qcFold) throw new Error('released: no WebSocket tap on the page')
      w.__qcFold(performance.now())
      if (!w.__qcSubsKnown) return false
      const held = new Set(Object.values(w.__qcSubs ?? {}))
      return paths.every((f) => !held.has(f))
    },
    fns,
    { polling: 100, timeout: timeoutMs },
  )
  await settle(page, timeoutMs)
}

/** A `server: true` sample that drew a result the client already held. */
export class HeldResultError extends Error {}

/**
 * Did the server send the watched page a query result for this sample?
 * After a mutation, a Transition that reaches its commit. Otherwise a
 * Transition carrying a query result, at or past the query-set version of
 * the first change the sample sent that adds a query (when the input and
 * watched pages are one socket and it sent one; a route preload on hover
 * sends its add just before t0). `ins` are the watched page's frames in
 * the sample.
 */
export function answered(
  ins: Array<WireEntry>,
  commitAt: number | null,
  addVersion: number | null,
): boolean {
  return ins.some(([, , type, , ts, , querySet, result]) => {
    if (type !== 'Transition') return false
    if (commitAt !== null) return ts !== null && ts >= commitAt
    return (
      result === true &&
      (addVersion === null || (querySet != null && querySet >= addVersion))
    )
  })
}

async function measureOnce<TArg>(
  page: Page,
  name: FlowName,
  step: FlowStep<TArg>,
  timeoutMs: number,
  instance?: string,
): Promise<{ ms: number; detail: SampleDetail }> {
  await step.before?.()
  await settle(page)
  if (step.inputPage && step.inputPage !== page) await settle(step.inputPage)
  const pred = `(${step.until.toString()})(${JSON.stringify(step.arg ?? null)})`
  if (await page.evaluate(pred)) {
    throw new Error(
      `flow ${name}: \`until\` already holds before the action; \`before\` must reach a state where it doesn't`,
    )
  }
  const start = step.start ?? 'input'
  const inputPage = step.inputPage ?? page
  // From the tap to the result, marked busy on the instance; a bulk write
  // holding it (qc/quiet.ts) is waited out first, before anything is armed.
  const timed = async () => {
    // The tap goes on both pages, so their sockets are caught before t0.
    await inputPage.evaluate(arm, [LEGS, true] as [boolean, boolean])
    if (inputPage !== page)
      await page.evaluate(arm, [LEGS, true] as [boolean, boolean])
    const cpu0 = cpuTicks()
    await step.action()
    // The predicate and the clock read happen in the same frame callback.
    const handle = await page.waitForFunction(
      `(() => (${pred}) ? performance.now() : false)()`,
      undefined,
      { polling: 'raf', timeout: timeoutMs },
    )
    const t1 = (await handle.jsonValue()) as number
    await handle.dispose()
    return { t1, cpu0, cpu1: cpuTicks() }
  }
  const {
    value: { t1, cpu0, cpu1 },
    waitedMs: quietWaitMs,
  } = instance
    ? await sampling(instance, timed)
    : { value: await timed(), waitedMs: 0 }
  const hostCpu =
    cpu0 && cpu1 && cpu1[1] > cpu0[1]
      ? Math.round(((cpu1[0] - cpu0[0]) / (cpu1[1] - cpu0[1])) * 100) / 100
      : null
  const t0 = start === 'navigation' ? 0 : await inputPage.evaluate(readT0)
  if (t0 === null) {
    throw new Error(
      `flow ${name}: the action dispatched no input event; a page load needs start: 'navigation'`,
    )
  }
  // Both ends on one time base (epoch ms), then each page reads its own
  // side of the window [T0, T1] on its own clock.
  const origin = (p: Page) => p.evaluate(() => performance.timeOrigin)
  const oIn = await origin(inputPage)
  const oOut = inputPage === page ? oIn : await origin(page)
  const T0 = oIn + t0
  const T1 = oOut + t1
  const ms = start === 'navigation' ? t1 : T1 - T0
  type Read = Awaited<ReturnType<typeof readLegs>>
  const read = (
    p: Page,
    o: number,
    side: 'out' | 'in' | 'both',
  ): Promise<Read> =>
    p.evaluate(readLegs, [T0 - o, T1 - o, side] as [
      number,
      number,
      typeof side,
    ])
  const [out, inn] =
    inputPage === page
      ? await read(page, oOut, 'both').then((r) => [r, r])
      : [await read(inputPage, oIn, 'out'), await read(page, oOut, 'in')]
  const { commitAt, addVersion, ...legs } = {
    ...out?.legs,
    ...inn?.legs,
    commitAt: out?.legs.commitAt,
    addVersion: inputPage === page ? out?.legs.addVersion : null,
  }
  const gotResult = inn
    ? answered(inn.ins, commitAt ?? null, addVersion ?? null)
    : undefined
  if (step.server && gotResult === false) {
    throw new HeldResultError(
      `flow ${name}: \`until\` held ${round1(ms)} ms after the input with no query result from the server ` +
        `(sent ${legs.sent ?? 'nothing'}, ${legs.bytesIn ?? 0} characters in): the client already held the answer, ` +
        `so the sample timed a local re-render. \`before\` must reach a state where the result isn't held ` +
        `(a distinct term, or \`released\` for a query the app holds on purpose)`,
    )
  }
  return {
    ms,
    detail: {
      at: Math.round(T0),
      sendMs: legs.sendMs ?? null,
      sent: legs.sent ?? null,
      ...(legs.fns && { fns: legs.fns }),
      ...(legs.subs && { subs: legs.subs }),
      ...(legs.bytesIn !== undefined && { bytesIn: legs.bytesIn }),
      ...(legs.requests !== undefined && { requests: legs.requests }),
      commitMs: legs.commitMs ?? null,
      responseMs: legs.responseMs ?? null,
      transitionMs: pickTransition(
        inn?.ins ?? [],
        legs.sendMs ?? null,
        commitAt ?? null,
      ),
      lastInMs: legs.lastInMs ?? null,
      endMs: round1(ms),
      ...(gotResult !== undefined && { answered: gotResult }),
      longTaskMs: legs.longTaskMs ?? 0,
      connects: legs.connects ?? 0,
      hidden: legs.hidden ?? false,
      hostCpu,
      load1: round1(loadavg()[0]),
      ...(quietWaitMs > 0 && { quietWaitMs }),
    },
  }
}

// The Transition that carries the result: the first whose end timestamp
// reaches the commit; without a commit, the first after the send. Offsets
// are already from t0.
function pickTransition(
  ins: Array<WireEntry>,
  sendMs: number | null,
  commitAt: number | null,
): number | null {
  const tr = ins.filter(([, , type]) => type === 'Transition')
  const hit =
    commitAt !== null
      ? tr.find(([, , , , ts]) => ts !== null && ts >= commitAt)
      : sendMs !== null
        ? tr.find(([t]) => t >= sendMs)
        : undefined
  return hit ? hit[0] : null
}

// Per worker process: the run's live files, opened on the first slow
// sample. Imported lazily: qc/live.ts imports back into this module.
let live: LiveRun | undefined
async function liveRun(): Promise<LiveRun> {
  if (!live) live = new (await import('./live')).LiveRun(runDir())
  return live
}

/**
 * Take one of the run's RETRY_CAP_PER_RUN retries. Workers are separate
 * processes, so each retry is a file created exclusively: the first to
 * create `retries/<i>` has it.
 */
export function takeRetry(dir = path.join(runDir(), 'retries')): boolean {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < RETRY_CAP_PER_RUN; i++) {
    try {
      closeSync(openSync(path.join(dir, String(i)), 'wx'))
      return true
    } catch {
      // Taken; try the next.
    }
  }
  return false
}

// Per worker process: flows that already had their untimed warm-up.
const warmed = new Set<FlowName>()

/**
 * Time a flow K times and judge it. Writes the record for the reporter and
 * returns it; never throws on a budget miss (assertFlow does that), so a
 * worker fixture can time a flow without failing every test in the worker.
 */
export async function runFlow<TArg>(
  ctx: FlowContext,
  name: FlowName,
  step: FlowStep<TArg>,
): Promise<FlowRecord> {
  const budget = budgetFor(name)
  const timeoutMs = Math.max(15_000, 10 * budget.maxMs)
  if ((ctx.warmUp ?? true) && !warmed.has(name)) {
    await measureOnce(ctx.page, name, step, timeoutMs, ctx.instance)
    warmed.add(name)
  }
  const measureSet = async () => {
    const set: Array<number> = []
    const detail: Array<SampleDetail> = []
    for (let i = 0; i < (ctx.repeats ?? REPEATS); i++) {
      const sample = await measureOnce(
        ctx.page,
        name,
        step,
        timeoutMs,
        ctx.instance,
      )
      set.push(round1(sample.ms))
      detail.push(sample.detail)
    }
    return { set, detail }
  }
  const rttOver = ctx.rttMs > RTT_CEILING_MS
  const skipped = RECORD
    ? ('record' as const)
    : rttOver
      ? ('rtt' as const)
      : undefined
  let { set: samplesMs, detail } = await measureSet()
  let firstSamplesMs: Array<number> | undefined
  let firstDetail: Array<SampleDetail> | undefined
  if (!skipped && !judge(samplesMs, budget.maxMs).pass) {
    firstSamplesMs = samplesMs
    firstDetail = detail
    ;({ set: samplesMs, detail } = await measureSet())
  }
  const judged = judge(samplesMs, budget.maxMs)
  const { medianMs, maxMs } = judged
  let pass = judged.pass
  // Over budget in the judged set: whose time was it? (qc/judge.ts)
  if (!skipped && !pass && !budget.selfTest && !budget.knownOver) {
    pass = true
    for (let i = 0; i < samplesMs.length && pass; i++) {
      if (samplesMs[i] < budget.maxMs) continue
      const j = await judgeSlowSample(
        { ms: samplesMs[i], detail: detail[i] },
        budget.maxMs,
        {
          blame: async (m) =>
            (await liveRun()).blame({
              ...m.detail,
              worker: ctx.worker,
              ...(ctx.instance && { instance: ctx.instance }),
            }),
          measure: async () => {
            const s = await measureOnce(
              ctx.page,
              name,
              step,
              timeoutMs,
              ctx.instance,
            )
            return { ms: round1(s.ms), detail: s.detail }
          },
          takeRetry: () => takeRetry(),
        },
      )
      detail[i] = { ...detail[i], judge: j }
      pass = j.pass
    }
  }
  const record: FlowRecord = {
    runId: runId(),
    flow: name,
    worker: ctx.worker,
    ...(ctx.instance && { instance: ctx.instance }),
    where: ctx.where,
    kind: budget.kind,
    samplesMs,
    ...(firstSamplesMs && { firstSamplesMs }),
    detail,
    ...(firstDetail && { firstDetail }),
    rttMs: ctx.rttMs,
    rttOver,
    budgetMs: budget.maxMs,
    ...(budget.targetMs !== undefined && { targetMs: budget.targetMs }),
    medianMs,
    maxMs,
    pass: skipped ? null : pass,
    ...(skipped && { skipped }),
    ...(budget.selfTest && { selfTest: true as const }),
    ...(budget.knownOver && { knownOver: budget.knownOver }),
  }
  // The verdict is written before anything else can go wrong.
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    path.join(dir, `pid-${process.pid}.jsonl`),
    JSON.stringify(record) + '\n',
  )
  // Failed: trace one more sample, outside the judged set. Under
  // `--trace on` the context is traced already and start() throws: that
  // trace covers it. The sample can fail (a timeout, a held result): the
  // trace still shows how, and the flow keeps its budget verdict.
  if (skipped || pass || budget.knownOver || !ctx.tracePath) return record
  const tracing = ctx.page.context().tracing
  const started = await tracing
    .start({ screenshots: true, snapshots: true, title: name })
    .then(() => true)
    .catch(() => false)
  if (!started) return record
  const tracePath = ctx.tracePath
  let traceError: string | undefined
  let saved = false
  try {
    await measureOnce(ctx.page, name, step, timeoutMs, ctx.instance)
  } catch (err) {
    traceError = String(err)
  } finally {
    saved = await tracing.stop({ path: tracePath }).then(
      () => true,
      (err: unknown) => {
        console.warn(`qc: flow ${name}: trace not saved: ${String(err)}`)
        return false
      },
    )
  }
  return {
    ...record,
    ...(saved && { trace: tracePath }),
    ...(traceError && { traceError }),
  }
}

export class OverBudgetError extends Error {}

export function assertFlow(record: FlowRecord) {
  if (record.pass !== false || record.knownOver) return
  const why = record.detail
    .flatMap((d, i) =>
      d.judge && !d.judge.pass
        ? [
            `sample ${record.samplesMs[i]} ms ${d.judge.rule} (${d.judge.attempts
              .map(
                (a) =>
                  `${a.ms} ms ${a.verdict ?? 'under'}${a.why ? `: ${a.why}` : ''}`,
              )
              .join(' → ')})`,
          ]
        : [],
    )
    .join('; ')
  throw new OverBudgetError(
    `flow ${record.flow} over budget twice: samples ${record.samplesMs.join(', ')} ms, ` +
      `re-measured after ${record.firstSamplesMs?.join(', ')} ms; ` +
      `every one must be under ${record.budgetMs} ms (RTT ${record.rttMs} ms)` +
      (why ? `; ${why}` : ''),
  )
}

/**
 * Median WebSocket round trip to a deployment: subscribe to
 * `platform/qcProbe:rtt` over the Convex sync protocol (the same socket
 * path the SPA uses) and wait for the transition that answers it. It
 * reads nothing, so Convex answers it from its query cache and the server
 * adds ~0 ms; its own name keeps it out of the app's server-timing rows
 * (spike 07 f: the socket reads ~27 ms where an HTTP query reads ~45 ms,
 * so an HTTP probe would overstate it).
 *
 * The low-level client, because ConvexClient.query() answers a repeat
 * from its local cache without touching the network.
 */
export async function probeRtt(url: string, samples = 10): Promise<number> {
  const probe = openProbe(url)
  const pause = () => new Promise((r) => setTimeout(r, 20))
  try {
    // Connects the socket and warms the server's cache.
    await probe.roundTrip()
    const times: Array<number> = []
    for (let i = 0; i < samples; i++) {
      // Lets the unsubscribe go out on its own, not batched with the next add.
      await pause()
      times.push(await probe.roundTrip())
    }
    if (median(times) < 1) {
      throw new Error(
        `RTT probe answered locally (${times.join(', ')} ms), not over the socket`,
      )
    }
    return round1(median(times))
  } finally {
    await probe.close()
  }
}

/**
 * The same probe every `everyMs` for the life of the worker, from Node
 * rather than the browser, so a slow sample can be set against the link at
 * that moment: if this slows too, the time went to the network or the
 * deployment, not to Chrome. `onSample` gets the wall clock, the ms, and
 * how late this process's last timer fired (`lagMs`): a busy event loop
 * here inflates the RTT too. The first round trip connects the socket and
 * isn't reported.
 */
export function startRttMonitor(
  url: string,
  everyMs: number,
  onSample: (at: number, ms: number, lagMs: number) => void,
): () => Promise<void> {
  const probe = openProbe(url)
  const state = { stopped: false }
  const loop = (async () => {
    await probe.roundTrip()
    let lagMs = 0
    while (!state.stopped) {
      const at = Date.now()
      const ms = await probe.roundTrip()
      // Context only: a sample that can't be written is lost, not an error.
      try {
        onSample(at, round1(ms), lagMs)
      } catch (err) {
        console.warn(`qc: RTT monitor sample not written: ${String(err)}`)
      }
      const t = performance.now()
      await new Promise((r) => setTimeout(r, everyMs))
      lagMs = round1(performance.now() - t - everyMs)
    }
  })().catch((err: unknown) => {
    console.warn(`qc: RTT monitor stopped: ${String(err)}`)
  })
  return async () => {
    state.stopped = true
    await probe.close()
    await Promise.race([loop, new Promise((r) => setTimeout(r, 1_000))])
  }
}

function openProbe(url: string) {
  let pending: { token: QueryToken; done: () => void } | null = null
  const client = new BaseConvexClient(url, (updated) => {
    if (pending && updated.includes(pending.token)) pending.done()
  })
  const roundTrip = () =>
    new Promise<number>((resolve) => {
      const t0 = performance.now()
      const sub = client.subscribe(
        getFunctionName(api.platform.qcProbe.rtt),
        {},
      )
      pending = {
        token: sub.queryToken,
        done: () => {
          pending = null
          sub.unsubscribe()
          resolve(performance.now() - t0)
        },
      }
    })
  return { roundTrip, close: () => client.close() }
}
