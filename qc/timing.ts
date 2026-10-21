import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import path from 'node:path'
import { BaseConvexClient } from 'convex/browser'
import type { QueryToken } from 'convex/browser'
import { getFunctionName } from 'convex/server'
import type { Page } from '@playwright/test'
import { api } from '../convex/_generated/api'
import { budgetFor } from './budgets'
import type { FlowKind, FlowName } from './budgets'

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
  /** Every sample must be under this. */
  budgetMs: number
  medianMs: number
  maxMs: number
  /** null: not judged (record mode, or RTT over the ceiling). */
  pass: boolean | null
  skipped?: 'record' | 'rtt'
  selfTest?: true
  /** Approved exception (qc/budgets.ts): judged, but never fails. */
  knownOver?: string
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
type WireEntry = [
  t: number,
  dir: 'out' | 'in' | 'open',
  type: string,
  requestId: number | null,
  tsMs: number | null,
]

interface QcWindow {
  __qcListening?: boolean
  __qcArmed?: boolean
  __qcT0?: number
  __qcWire?: Array<RawEntry>
  __qcLong?: Array<[start: number, duration: number]>
  __qcVis?: Array<number>
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
function arm(legs: boolean) {
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
        if (typeof data === 'string') note([performance.now(), 'out', data])
        return send.call(this, data)
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
  if (w.__qcWire) w.__qcWire.length = 0
  w.__qcT0 = undefined
  w.__qcArmed = true
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
      const id =
        type === 'Mutation' || type === 'Action'
          ? ((JSON.parse(data) as { requestId?: number }).requestId ?? null)
          : null
      return type === 'Connect'
        ? [
            [t, 'open', type, null, null],
            [t, 'out', type, null, null],
          ]
        : [[t, 'out', type, id, null]]
    }
    if (type === 'Transition') {
      const head = /"endVersion":\{[^}]*"ts":"([^"]+)"/.exec(data.slice(0, 600))
      const ts = head
        ? tsMs(head[1])
        : tsMs(
            (JSON.parse(data) as { endVersion?: { ts?: string } }).endVersion
              ?.ts,
          )
      return [[t, 'in', type, null, ts]]
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
  const legs: Partial<Legs> & { commitAt?: number | null } = {}
  if (side !== 'in') {
    // The request the action makes, if any; else the query change.
    const first =
      wire.find(
        ([, d, type]) =>
          d === 'out' && (type === 'Mutation' || type === 'Action'),
      ) ?? wire.find(([, d, type]) => d === 'out' && type === 'ModifyQuerySet')
    legs.sendMs = rel(first?.[0])
    legs.sent = first?.[2] ?? null
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
    .map(([t, d, type, id, ts]): WireEntry => [rel(t)!, d, type, id, ts])
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

async function measureOnce<TArg>(
  page: Page,
  name: FlowName,
  step: FlowStep<TArg>,
  timeoutMs: number,
): Promise<{ ms: number; detail: SampleDetail }> {
  await step.before?.()
  const pred = `(${step.until.toString()})(${JSON.stringify(step.arg ?? null)})`
  if (await page.evaluate(pred)) {
    throw new Error(
      `flow ${name}: \`until\` already holds before the action; \`before\` must reach a state where it doesn't`,
    )
  }
  const start = step.start ?? 'input'
  const inputPage = step.inputPage ?? page
  // The tap goes on both pages, so their sockets are caught before t0.
  await inputPage.evaluate(arm, LEGS)
  if (inputPage !== page) await page.evaluate(arm, LEGS)
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
  const cpu1 = cpuTicks()
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
  const { commitAt, ...legs } = {
    ...out?.legs,
    ...inn?.legs,
    commitAt: out?.legs.commitAt,
  }
  return {
    ms,
    detail: {
      at: Math.round(T0),
      sendMs: legs.sendMs ?? null,
      sent: legs.sent ?? null,
      commitMs: legs.commitMs ?? null,
      responseMs: legs.responseMs ?? null,
      transitionMs: pickTransition(
        inn?.ins ?? [],
        legs.sendMs ?? null,
        commitAt ?? null,
      ),
      lastInMs: legs.lastInMs ?? null,
      endMs: round1(ms),
      longTaskMs: legs.longTaskMs ?? 0,
      connects: legs.connects ?? 0,
      hidden: legs.hidden ?? false,
      hostCpu,
      load1: round1(loadavg()[0]),
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
    await measureOnce(ctx.page, name, step, timeoutMs)
    warmed.add(name)
  }
  const measureSet = async () => {
    const set: Array<number> = []
    const detail: Array<SampleDetail> = []
    for (let i = 0; i < (ctx.repeats ?? REPEATS); i++) {
      const sample = await measureOnce(ctx.page, name, step, timeoutMs)
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
  const { medianMs, maxMs, pass } = judge(samplesMs, budget.maxMs)
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
    medianMs,
    maxMs,
    pass: skipped ? null : pass,
    ...(skipped && { skipped }),
    ...(budget.selfTest && { selfTest: true as const }),
    ...(budget.knownOver && { knownOver: budget.knownOver }),
  }
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    path.join(dir, `pid-${process.pid}.jsonl`),
    JSON.stringify(record) + '\n',
  )
  return record
}

export class OverBudgetError extends Error {}

export function assertFlow(record: FlowRecord) {
  if (record.pass !== false || record.knownOver) return
  throw new OverBudgetError(
    `flow ${record.flow} over budget twice: samples ${record.samplesMs.join(', ')} ms, ` +
      `re-measured after ${record.firstSamplesMs?.join(', ')} ms; ` +
      `every one must be under ${record.budgetMs} ms (RTT ${record.rttMs} ms)`,
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
