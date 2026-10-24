import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { budgetFor } from './budgets'
import type { FlowKind, FlowName } from './budgets'

// Client-perceived latency (factory/plans/qc-suite.sv, "What latency
// means"). Timed inside the page: t0 is the event timestamp of the start
// of the *last* gesture the action makes (or navigation start for a page
// load), and t1 is `performance.now()` in the first animation frame where
// the `until` predicate holds.
//
// A gesture starts at a pointerdown or a keydown; the events that follow
// it (mousedown, beforeinput, input) only set t0 when no gesture did.
// Why the last gesture: the rule is "from the input event to the result
// on screen", and for a typed action that input is the keystroke that
// completes it. Playwright types one key per CDP round trip, so timing
// from the first key would charge Playwright's typing speed to the app.
// Why its start: a checkbox's `input` event comes after `click`, where
// React has already re-rendered and the query's request started, so
// timing from it would leave that out. `fill()` is a single insertText
// (no key events), so it times from its beforeinput. Playwright's own expect polling (100 ms+)
// is far too coarse for this.
//
// Samples are judged raw: every one must be under the flow's maxMs
// (qc/budgets.ts). The worker's HTTP round trip to the API (probeRtt) is
// recorded for context, and above RTT_CEILING_MS the run skips the
// latency asserts.
//
// Spikes (ADR 0018's base rule; migration-rust F3): a judged flow with any
// sample at or over budget is re-measured once, at once, with a full K
// samples. Only the second set is judged, and it fails if any sample in it
// is over too. The first set is kept as `firstSamplesMs` and shown in the
// table, history and trend. Record mode and runs over the RTT ceiling
// judge nothing, so they never re-measure. Functional asserts never retry.
//
// Every sample also carries what it asked the API (SampleDetail.calls):
// each `/api` request the watched page made in the window, with its
// server time from the response's `Server-Timing` header (`total`, `db`).
// A slow sample's calls say whose time it was: server time, or the round
// trips around it. The page's long tasks and the host's CPU cover the
// local side. Context only, bar the server rule (qc/server.ts): every call
// must take under 100 ms on the server.
//
// Tracing (human, 2026-10-23): Playwright tracing is off for the whole
// run (playwright.config.ts). It snapshots the DOM around every action,
// timed clicks included, so it charged the harness's own work to the app
// and more so the bigger the page (~230 ms on one Load more). A flow that
// fails its budget instead gets one more sample, untimed and unjudged,
// with tracing on (`tracePath`): the failure stays debuggable and no
// judged sample is ever traced.
//
// Held results: a sample must do the work it claims to measure. TanStack
// Query keeps what it fetched until something invalidates it, so a
// `before` that leaves the answer cached makes the action a local
// re-render. A flow whose result is meant to come from the server says
// `server: true`, and a sample in which the watched page made no `/api`
// request that answered before `until` held fails (HeldResultError).
// After every `before` the harness waits until the page has no request in
// flight (`settle`), so one `before` started doesn't land in the sample.

/** Timed samples per flow call; QC_REPEATS=1 is a fast functional run. */
export const REPEATS = Number(process.env.QC_REPEATS ?? 5)
/** QC_MODE=record measures and writes history but never asserts. */
export const RECORD = process.env.QC_MODE === 'record'
/**
 * Above this median RTT, raw timings measure the link, not the app: assert
 * runs skip the latency asserts, and every run flags the samples (the
 * banner, and `rttOver` in history).
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

/** One `/api` request the watched page made during a sample. */
export interface ApiCall {
  method: string
  /** Path and query, as requested (`/api/t/<slug>/contacts?…`). */
  url: string
  /** Offsets in ms from the input event (t0). */
  startMs: number
  /** Its response headers arrived (null: still in flight at the end). */
  endMs: number | null
  status: number | null
  /** `Server-Timing` `total` and `db`, in ms (null: no header). */
  serverMs: number | null
  dbMs: number | null
}

/** Where one sample's time went. Offsets are ms from the input event. */
export interface SampleDetail {
  /** Wall clock (epoch ms) of the input event. */
  at: number
  /** The `/api` requests the watched page (and the input page) made. */
  calls: Array<ApiCall>
  /** The first change event (SSE) the watched page got, or null. */
  eventMs: number | null
  /** The result was on screen: the sample. */
  endMs: number
  /** A call answered before the result was on screen (`server: true`). */
  answered: boolean
  /** Main-thread long tasks overlapping the sample, summed. */
  longTaskMs: number
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
  /** Context only: the worker's median HTTP round trip to the API. */
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
   * 'input' (default): t0 is the start of the last gesture the action
   * makes (a click's pointerdown, the final keydown, or fill's input).
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
   * The result comes from the server: the watched page must get an answer
   * to an `/api` request before `until` holds, or the flow fails with
   * HeldResultError (the client already held the answer, so the sample
   * timed a local re-render).
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

/**
 * `Server-Timing: platform;dur=1.2, db;dur=3.4, total;dur=5.0` → ms by
 * name. Exported for its test.
 */
export function parseServerTiming(header: string | null): {
  serverMs: number | null
  dbMs: number | null
} {
  const dur = (name: string) => {
    const m = new RegExp(`(?:^|,)\\s*${name}\\s*;[^,]*?dur=([\\d.]+)`).exec(
      header ?? '',
    )
    return m ? Number(m[1]) : null
  }
  return { serverMs: dur('total'), dbMs: dur('db') }
}

// A request as the tap keeps it: page clock, nothing parsed.
type RawCall = [
  start: number,
  end: number | null,
  method: string,
  url: string,
  status: number | null,
  timing: string | null,
]

interface QcWindow {
  __qcListening?: boolean
  __qcArmed?: boolean
  __qcT0?: number
  /** Every `/api` request since the tap went in (capped). */
  __qcCalls?: Array<RawCall>
  /** `/api` requests not yet answered. */
  __qcInflight?: number
  /** Times change events arrived (capped). */
  __qcEvents?: Array<number>
  __qcLong?: Array<[start: number, duration: number]>
  __qcVis?: Array<number>
  /** settle: consecutive frames with nothing in flight. */
  __qcQuiet?: number
}

// Capture-phase listeners record the timestamp of trusted input events
// after arming: each pointerdown or keydown starts a gesture and sets t0,
// the rest only fill it in when none did (see the top of this file).
// Event.timeStamp shares performance.now()'s time base, so t0 is when the
// browser saw the input, not when Playwright sent it.
//
// The first arm also taps `fetch` (the SPA looks it up on every call, so a
// tap that goes in late still sees every request after it) and
// `EventSource` (only one made after the tap: tapContext installs it from
// the page's first script, before the app's own). Inside the timed window
// the tap only pushes times and strings; readSample parses after t1.
function arm(now: boolean) {
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
          if (!w.__qcArmed || !e.isTrusted) return
          if (type === 'pointerdown' || type === 'keydown')
            w.__qcT0 = e.timeStamp
          else w.__qcT0 ??= e.timeStamp
        },
        { capture: true },
      )
    }
    const calls: Array<RawCall> = (w.__qcCalls = [])
    w.__qcInflight = 0
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const target = new URL(url, location.href)
      if (!target.pathname.startsWith('/api/')) return original(input, init)
      const entry: RawCall = [
        performance.now(),
        null,
        (
          init?.method ?? (input instanceof Request ? input.method : 'GET')
        ).toUpperCase(),
        target.pathname + target.search,
        null,
        null,
      ]
      calls.push(entry)
      // Between flows nothing arms, so cap what an idle page collects.
      if (calls.length > 500) calls.splice(0, 250)
      w.__qcInflight = (w.__qcInflight ?? 0) + 1
      const done = () => {
        entry[1] = performance.now()
        w.__qcInflight = (w.__qcInflight ?? 1) - 1
      }
      return original(input, init).then(
        (r) => {
          entry[4] = r.status
          entry[5] = r.headers.get('server-timing')
          done()
          return r
        },
        (err: unknown) => {
          done()
          throw err
        },
      )
    }
    const events: Array<number> = (w.__qcEvents = [])
    const Source = window.EventSource as typeof EventSource | undefined
    if (Source) {
      window.EventSource = class extends Source {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          this.addEventListener('message', (e) => {
            events.push(e.timeStamp)
            if (events.length > 500) events.splice(0, 250)
          })
        }
      }
    }
    const longs: Array<[number, number]> = (w.__qcLong = [])
    const vis: Array<number> = (w.__qcVis = [])
    document.addEventListener('visibilitychange', (e) => vis.push(e.timeStamp))
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longs.push([e.startTime, e.duration])
        if (longs.length > 500) longs.splice(0, 250)
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      // No long-task timing in this browser: longTaskMs reads 0.
    }
  }
  if (!now) return
  w.__qcT0 = undefined
  w.__qcArmed = true
}

/** Install the tap in every page of `context` from its first script. */
export async function tapContext(context: BrowserContext) {
  await context.addInitScript(arm, false)
}

function readT0() {
  const w = window as unknown as QcWindow
  w.__qcArmed = false
  return w.__qcT0 ?? null
}

// In the page, after the sample: the requests and events of [t0, t1] (both
// performance.now()), offsets from t0. Long tasks and visibility only for
// the watched side.
function readSample([t0, t1, watched]: [number, number, boolean]) {
  const w = window as unknown as QcWindow
  const rel = (t: number | null) =>
    t === null ? null : Math.round((t - t0) * 10) / 10
  // The action's requests start after its gesture did. Not from arming:
  // a request between arming and the action (a late event refetch from
  // `before`) would answer a sample whose result came from the cache.
  const calls = (w.__qcCalls ?? [])
    .filter(([start]) => start >= t0 - 1 && start <= t1)
    .map(([start, end, method, url, status, timing]) => ({
      method,
      url,
      startMs: rel(start)!,
      endMs: end === null || end > t1 ? null : rel(end),
      status,
      timing,
    }))
  const event = (w.__qcEvents ?? []).find((t) => t >= t0 && t <= t1)
  return {
    calls,
    eventMs: event === undefined ? null : rel(event),
    longTaskMs: watched
      ? Math.round(
          (w.__qcLong ?? [])
            .filter(([s, d]) => s + d >= t0 && s <= t1)
            .reduce(
              (sum, [s, d]) => sum + Math.min(s + d, t1) - Math.max(s, t0),
              0,
            ),
        )
      : 0,
    hidden:
      watched &&
      (document.visibilityState !== 'visible' ||
        (w.__qcVis ?? []).some((t) => t >= t0 && t <= t1)),
  }
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

// In the page, outside the timed window: true once no `/api` request has
// been in flight for three animation frames in a row, so a request an
// effect starts a frame after `before` returns still counts.
function settledFrames(): boolean {
  const w = window as unknown as QcWindow
  if ((w.__qcInflight ?? 0) > 0) {
    w.__qcQuiet = 0
    return false
  }
  w.__qcQuiet = (w.__qcQuiet ?? 0) + 1
  return w.__qcQuiet >= 3
}

/**
 * Wait until `page` has no `/api` request in flight, so nothing `before`
 * started lands in the sample. measureOnce runs it after every `before`.
 */
export async function settle(page: Page, timeoutMs = 15_000) {
  await page.evaluate(arm, false)
  await page.evaluate(() => {
    ;(window as unknown as QcWindow).__qcQuiet = 0
  })
  await page.waitForFunction(settledFrames, undefined, {
    polling: 'raf',
    timeout: timeoutMs,
  })
}

/**
 * In the page, for a `server: true` sample (measureOnce): remove every cached query no component observes, from the
 * app's TanStack QueryClient, found through React's fiber tree (the app
 * doesn't expose it, and QC mustn't need it to). Serialised: no closures.
 */
function dropInactiveQueries() {
  interface Client {
    removeQueries: (f: {
      predicate: (q: { getObserversCount: () => number }) => boolean
    }) => void
    getQueryCache: () => unknown
  }
  interface Fiber {
    memoizedProps?: { client?: Client } | null
    child: Fiber | null
    sibling: Fiber | null
  }
  const root = document.getElementById('app')
  const key =
    root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'))
  // No app on the page (a cold load's about:blank): nothing cached.
  if (!root || !key) return
  const stack: Array<Fiber> = [(root as unknown as Record<string, Fiber>)[key]]
  while (stack.length) {
    const f = stack.pop()!
    const client = f.memoizedProps?.client
    if (client && typeof client.getQueryCache === 'function') {
      client.removeQueries({ predicate: (q) => q.getObserversCount() === 0 })
      return
    }
    if (f.child) stack.push(f.child)
    if (f.sibling) stack.push(f.sibling)
  }
  throw new Error('dropInactiveQueries: no QueryClientProvider')
}

/** A `server: true` sample that drew a result the client already held. */
export class HeldResultError extends Error {}

async function measureOnce<TArg>(
  page: Page,
  name: FlowName,
  step: FlowStep<TArg>,
  timeoutMs: number,
): Promise<{ ms: number; detail: SampleDetail }> {
  await step.before?.()
  await settle(page)
  if (step.inputPage && step.inputPage !== page) await settle(step.inputPage)
  // A result meant to come from the server: drop what no component shows,
  // as Convex dropped an unsubscribed query, so the sample asks rather
  // than drawing TanStack's cache. After settle: a query a `before` left
  // has lost its observer only once the page's effects have run.
  if (step.server) await page.evaluate(dropInactiveQueries)
  const pred = `(${step.until.toString()})(${JSON.stringify(step.arg ?? null)})`
  if (await page.evaluate(pred)) {
    throw new Error(
      `flow ${name}: \`until\` already holds before the action; \`before\` must reach a state where it doesn't`,
    )
  }
  const start = step.start ?? 'input'
  const inputPage = step.inputPage ?? page
  await inputPage.evaluate(arm, true)
  if (inputPage !== page) await page.evaluate(arm, true)
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
  // A page load starts a new document: its clock starts at navigation.
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
  const read = (p: Page, o: number, watched: boolean) =>
    p.evaluate(readSample, [T0 - o, T1 - o, watched] as [
      number,
      number,
      boolean,
    ])
  const watched = await read(page, oOut, true)
  // Propagation: the input tab's save is part of the sample too.
  const input = inputPage === page ? null : await read(inputPage, oIn, false)
  const calls: Array<ApiCall> = [...(input?.calls ?? []), ...watched.calls]
    .map(({ timing, ...c }) => ({ ...c, ...parseServerTiming(timing) }))
    .sort((a, b) => a.startMs - b.startMs)
  // The watched page's own answer: what it showed came from the server.
  const answered = watched.calls.some((c) => c.endMs !== null)
  if (step.server && !answered) {
    throw new HeldResultError(
      `flow ${name}: \`until\` held ${round1(ms)} ms after the input with no /api answer on the watched page ` +
        `(${watched.calls.length} requests started): the client already held the answer, ` +
        `so the sample timed a local re-render. \`before\` must reach a state where the result isn't held ` +
        `(a distinct term, or a reload)`,
    )
  }
  return {
    ms,
    detail: {
      at: Math.round(T0),
      calls,
      eventMs: watched.eventMs,
      endMs: round1(ms),
      answered,
      longTaskMs: watched.longTaskMs,
      hidden: watched.hidden,
      hostCpu,
      load1: round1(loadavg()[0]),
    },
  }
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
    await measureOnce(ctx.page, name, step, timeoutMs)
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
  // The judged set's slowest sample, with where its time went.
  const slowest = record.detail.reduce((a, b) => (b.endMs > a.endMs ? b : a))
  const calls = slowest.calls
    .map(
      (c) =>
        `${c.method} ${c.url.replace(/\/api\/t\/[^/]+/, '')} ${c.startMs}→${c.endMs ?? '…'} ms` +
        (c.serverMs === null ? '' : ` (server ${c.serverMs})`),
    )
    .join('; ')
  throw new OverBudgetError(
    `flow ${record.flow} over budget twice: samples ${record.samplesMs.join(', ')} ms, ` +
      `re-measured after ${record.firstSamplesMs?.join(', ')} ms; ` +
      `every one must be under ${record.budgetMs} ms (RTT ${record.rttMs} ms)` +
      (calls ? `; slowest ${slowest.endMs} ms: ${calls}` : ''),
  )
}

/**
 * Median HTTP round trip from Node to the API: `GET /api/me` without a
 * session (answered 401 before any org file is opened), on one kept-alive
 * connection. The first request opens it and isn't counted.
 */
export async function probeRtt(api: string, samples = 10): Promise<number> {
  const times: Array<number> = []
  for (let i = 0; i <= samples; i++) {
    const t = performance.now()
    await (await fetch(`${api}/api/me`)).arrayBuffer()
    if (i > 0) times.push(performance.now() - t)
  }
  return round1(median(times))
}
