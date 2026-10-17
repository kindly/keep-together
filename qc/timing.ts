import { appendFileSync, mkdirSync } from 'node:fs'
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

/** Timed samples per flow call; QC_REPEATS=1 is a fast functional run. */
export const REPEATS = Number(process.env.QC_REPEATS ?? 5)
/** QC_MODE=record measures and writes history but never asserts. */
export const RECORD = process.env.QC_MODE === 'record'
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

export interface FlowRecord {
  runId: string
  flow: FlowName
  /** Playwright parallelIndex of the worker. */
  worker: number
  /** Title path of the test, or "worker setup" for fixture flows. */
  where: string
  kind: FlowKind
  /** Input event to result on screen, network included. */
  samplesMs: Array<number>
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
}

export interface FlowContext {
  page: Page
  rttMs: number
  worker: number
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

interface QcWindow {
  __qcListening?: boolean
  __qcArmed?: boolean
  __qcT0?: number
}

// Capture-phase listeners record the timestamp of each trusted input event
// after arming; the last one wins (see the top of this file).
// Event.timeStamp shares performance.now()'s time base, so t0 is when the
// browser saw the input, not when Playwright sent it.
function arm() {
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
  }
  w.__qcT0 = undefined
  w.__qcArmed = true
}

function readT0() {
  const w = window as unknown as QcWindow
  w.__qcArmed = false
  return w.__qcT0 ?? null
}

async function measureOnce<TArg>(
  page: Page,
  name: FlowName,
  step: FlowStep<TArg>,
  timeoutMs: number,
): Promise<number> {
  await step.before?.()
  const pred = `(${step.until.toString()})(${JSON.stringify(step.arg ?? null)})`
  if (await page.evaluate(pred)) {
    throw new Error(
      `flow ${name}: \`until\` already holds before the action; \`before\` must reach a state where it doesn't`,
    )
  }
  const start = step.start ?? 'input'
  if (start === 'input') await page.evaluate(arm)
  await step.action()
  // The predicate and the clock read happen in the same frame callback.
  const handle = await page.waitForFunction(
    `(() => (${pred}) ? performance.now() : false)()`,
    undefined,
    { polling: 'raf', timeout: timeoutMs },
  )
  const t1 = (await handle.jsonValue()) as number
  await handle.dispose()
  if (start === 'navigation') return t1
  const t0 = await page.evaluate(readT0)
  if (t0 === null) {
    throw new Error(
      `flow ${name}: the action dispatched no input event; a page load needs start: 'navigation'`,
    )
  }
  return t1 - t0
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
  const samplesMs: Array<number> = []
  for (let i = 0; i < (ctx.repeats ?? REPEATS); i++) {
    samplesMs.push(round1(await measureOnce(ctx.page, name, step, timeoutMs)))
  }
  const { medianMs, maxMs, pass } = judge(samplesMs, budget.maxMs)
  const rttOver = ctx.rttMs > RTT_CEILING_MS
  const skipped = RECORD
    ? ('record' as const)
    : rttOver
      ? ('rtt' as const)
      : undefined
  const record: FlowRecord = {
    runId: runId(),
    flow: name,
    worker: ctx.worker,
    where: ctx.where,
    kind: budget.kind,
    samplesMs,
    rttMs: ctx.rttMs,
    rttOver,
    budgetMs: budget.maxMs,
    medianMs,
    maxMs,
    pass: skipped ? null : pass,
    ...(skipped && { skipped }),
    ...(budget.selfTest && { selfTest: true as const }),
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
  if (record.pass !== false) return
  throw new OverBudgetError(
    `flow ${record.flow} over budget: samples ${record.samplesMs.join(', ')} ms, ` +
      `every one must be under ${record.budgetMs} ms (RTT ${record.rttMs} ms)`,
  )
}

/**
 * Median WebSocket round trip to a deployment: subscribe to a signed-out
 * `platform/tenants:mine` over the Convex sync protocol (the same socket
 * path the SPA uses) and wait for the transition that answers it. Signed
 * out it returns [] from Convex's query cache, so the server adds ~0 ms
 * (spike 07 f: the socket reads ~27 ms where an HTTP query reads ~45 ms,
 * so an HTTP probe would overstate it).
 *
 * The low-level client, because ConvexClient.query() answers a repeat
 * from its local cache without touching the network.
 */
export async function probeRtt(url: string, samples = 10): Promise<number> {
  let pending: { token: QueryToken; done: () => void } | null = null
  const client = new BaseConvexClient(url, (updated) => {
    if (pending && updated.includes(pending.token)) pending.done()
  })
  const roundTrip = () =>
    new Promise<void>((resolve) => {
      const sub = client.subscribe(
        getFunctionName(api.platform.tenants.mine),
        {},
      )
      pending = {
        token: sub.queryToken,
        done: () => {
          pending = null
          sub.unsubscribe()
          resolve()
        },
      }
    })
  const pause = () => new Promise((r) => setTimeout(r, 20))
  try {
    // Connects the socket and warms the server's cache.
    await roundTrip()
    const times: Array<number> = []
    for (let i = 0; i < samples; i++) {
      // Lets the unsubscribe go out on its own, not batched with the next add.
      await pause()
      const t0 = performance.now()
      await roundTrip()
      times.push(performance.now() - t0)
    }
    if (median(times) < 1) {
      throw new Error(
        `RTT probe answered locally (${times.join(', ')} ms), not over the socket`,
      )
    }
    return round1(median(times))
  } finally {
    await client.close()
  }
}
