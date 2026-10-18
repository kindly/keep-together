import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { BULK_FUNCTIONS } from './budgets'

// Server-time collector (factory/plans/qc-suite.sv step 5, spike 07 item a).
//
// One `convex logs --success --jsonl` stream per pool instance runs for the
// whole Playwright run. Every Completion event carries the function's
// identifier, udfType, executionTime (seconds), cachedResult and caller.
// stop() aggregates p50/p95/max per function; checkBudgets() asserts
// that every call of our own queries and mutations took < 100 ms (a max,
// not a percentile: the human's rule, 2026-10-17), except for one spike:
// a function may have a single call at or over budget if it has other
// calls in the run and all of those are under (human, 2026-10-18; dev
// deployments occasionally stall). That is the server form of the
// flows' one re-measure: the function's other calls are its re-measure.
// The spike is still listed (spikes()) so it stays visible.
//
// Bulk functions (BULK_FUNCTIONS in ./budgets, exempt from 100 ms like their
// `bulk` flows) are asserted against their own limit instead.
//
// Not asserted: cached queries (~0 ms, served without running), `auth:*`
// (Convex Auth hashes passwords in JS: auth:store is ~150 ms p95),
// component functions, actions, and calls with an admin identity (the
// CLI's seed and warm-up, and the mutations they run), which aren't what a
// signed-in user waits on. All of them still appear in the table.
//
// Liveness: `convex logs` retries a failed poll forever and exits only on
// a 403, so a dead stream looks exactly like an idle instance. Each stream
// therefore has to prove itself twice, with a ping (an anonymous
// `platform/tenants:mine` over the HTTP API) that must show up in it: once
// before the specs start, and once in stop(), after they finish. The end
// ping also flushes the stream, since its events arrive in order. A
// stream that misses either ping fails the run. With every stream proven
// live, zero events from an instance means no spec used it (a smoke-only
// run), not a lost stream. Ping events are left out of the stats.
//
// Deploy keys come from each instance's env file in the main checkout
// (scripts/qc-instances.mjs writes and verifies them) and are never printed.

export const BUDGET_MS = { Query: 100, Mutation: 100 } as const

const root = fileURLToPath(new URL('..', import.meta.url))
const convexBin = path.join(root, 'node_modules/.bin/convex')
// Never a pool member, whatever an env file says (as in qc-instances.mjs).
const DENIED = new Set(['zany-bird-247'])
const PING = 'platform/tenants:mine'
const PING_INTERVAL_MS = 1_000
// How long a stream may take to show a ping, at start and at stop.
const PING_TIMEOUT_MS = 30_000

export interface Instance {
  name: string
  deployment: string
  url: string
  envFile: string
}

export interface LogEvent {
  kind: string
  udfType: string
  identifier: string
  componentPath: string | null
  executionTime: number
  cachedResult: boolean | null
  caller: string
  identityType: string
  timestamp: number
}

export interface FunctionStats {
  /** `Query (cached)` and so on is folded into `cached`, not the name. */
  identifier: string
  udfType: string
  cached: boolean
  /** Asserted against `budgetMs`. */
  asserted: boolean
  /** BUDGET_MS for its type, or its BULK_FUNCTIONS limit; null if not asserted. */
  budgetMs: number | null
  n: number
  p50: number
  p95: number
  max: number
  /** The second-slowest call; null when n = 1. */
  second: number | null
}

export interface ServerTimings {
  startedAt: string
  stoppedAt: string
  instances: Array<string>
  /** Completion events per instance, pings excluded. */
  eventsByInstance: Record<string, number>
  events: number
  functions: Array<FunctionStats>
  /** Streams that died or went deaf; their instance's numbers are partial. */
  errors: Array<string>
}

// ── stream ──────────────────────────────────────────────────────────────

function readKey(inst: Instance): string {
  const line = readFileSync(inst.envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('CONVEX_DEPLOY_KEY='))
  const key = line?.slice('CONVEX_DEPLOY_KEY='.length).trim() ?? ''
  const deployment = key.match(/^dev:([a-z0-9-]+)\|/)?.[1]
  if (!deployment || deployment !== inst.deployment) {
    throw new Error(
      `${inst.envFile}: CONVEX_DEPLOY_KEY is not a dev key for ${inst.deployment}`,
    )
  }
  if (DENIED.has(deployment)) {
    throw new Error(`${inst.envFile}: ${deployment} is never a QC instance`)
  }
  return key
}

/** Our own liveness pings: never part of the stats. */
export const isPing = (ev: LogEvent) =>
  ev.caller === 'HttpApi' && ev.identifier === PING

async function ping(inst: Instance) {
  try {
    await fetch(`${inst.url}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: PING, args: {}, format: 'json' }),
      signal: AbortSignal.timeout(PING_INTERVAL_MS * 5),
    })
  } catch {
    // The stream decides: a lost ping is just retried.
  }
}

interface Stream {
  inst: Instance
  child: ChildProcess
  stderr: string
  exited: string | null
  /** Ping events seen on this stream (any timestamp: replay counts too). */
  pings: number
  events: number
}

export interface Collector {
  stop: () => Promise<ServerTimings>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startServerTimings(
  instances: Array<Instance>,
): Promise<Collector> {
  // Every key is checked before anything is spawned.
  const keys = instances.map(readKey)

  // Event timestamps are server-side seconds. `--history` replays the
  // deployment's buffer on the first poll, so nothing between spawn and
  // that poll is lost; the timestamp filter drops the older entries.
  const startedAt = Date.now()
  const events: Array<LogEvent> = []
  let stopping = false
  let interrupted: string | null = null

  const streams: Array<Stream> = instances.map((inst, i) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CONVEX_DEPLOY_KEY: keys[i],
    }
    delete env.CONVEX_DEPLOYMENT
    delete env.CONVEX_SELF_HOSTED_URL
    delete env.CONVEX_SELF_HOSTED_ADMIN_KEY
    const child = spawn(
      convexBin,
      ['logs', '--success', '--jsonl', '--history'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const stream: Stream = {
      inst,
      child,
      stderr: '',
      exited: null,
      pings: 0,
      events: 0,
    }
    let buf = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        let ev: LogEvent
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.kind !== 'Completion') continue
        if (isPing(ev)) {
          stream.pings++
          continue
        }
        if (ev.timestamp * 1000 < startedAt) continue
        events.push(ev)
        stream.events++
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      // Keep only the tail, for the error message.
      stream.stderr = (stream.stderr + chunk).slice(-2_000)
    })
    child.on('error', (err) => {
      stream.stderr += `\n${err.message}`
      stream.exited ??= 'spawn error'
    })
    child.on('close', (code, signal) => {
      stream.exited ??= signal ?? `code ${code}`
      if (signal === 'SIGINT' || code === 130) interrupted ??= 'SIGINT'
      if (!stopping && !interrupted) {
        console.error(
          `qc: convex logs for ${inst.name} exited early (${stream.exited})`,
        )
      }
    })
    return stream
  })

  // Safety net for when the teardown never runs (a crash, a later
  // globalSetup throwing, `kill <pid>`): no stream outlives the runner.
  const killAll = () => {
    for (const s of streams) if (s.exited === null) s.child.kill('SIGTERM')
  }
  const onSignal = (sig: NodeJS.Signals) => {
    interrupted ??= sig
    killAll()
    // Playwright handles SIGINT itself; where nobody else listens, keep
    // the default behaviour of dying from the signal.
    if (process.listenerCount(sig) === 1) {
      removeSafetyNet()
      process.kill(process.pid, sig)
    }
  }
  const removeSafetyNet = () => {
    process.off('exit', killAll)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  process.on('exit', killAll)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  // Ping each instance until its stream shows a ping (or any ping replayed
  // from the buffer: either way its first poll got through).
  const awaitPing = async (s: Stream): Promise<string | null> => {
    const seen = s.pings
    const deadline = Date.now() + PING_TIMEOUT_MS
    while (s.pings === seen) {
      if (s.exited !== null)
        return `${s.inst.name}: convex logs exited (${s.exited}): ${redact(lastLines(s.stderr))}`
      if (Date.now() > deadline) {
        return `${s.inst.name}: log stream showed no ping within ${PING_TIMEOUT_MS / 1000} s${lastLines(s.stderr) ? `: ${redact(lastLines(s.stderr))}` : ''}`
      }
      await ping(s.inst)
      await sleep(PING_INTERVAL_MS)
    }
    return null
  }
  const awaitAll = async () =>
    (await Promise.all(streams.map(awaitPing))).filter(
      (e): e is string => e !== null,
    )

  const startErrors = await awaitAll()
  if (startErrors.length) {
    stopping = true
    killAll()
    removeSafetyNet()
    throw new Error(
      `server timings: streams not live:\n  ${startErrors.join('\n  ')}`,
    )
  }

  return {
    async stop() {
      const errors = interrupted
        ? [`interrupted (${interrupted})`]
        : await awaitAll()
      stopping = true
      killAll()
      removeSafetyNet()
      return {
        startedAt: new Date(startedAt).toISOString(),
        stoppedAt: new Date().toISOString(),
        instances: instances.map((i) => `${i.name}=${i.deployment}`),
        eventsByInstance: Object.fromEntries(
          streams.map((s) => [s.inst.name, s.events]),
        ),
        events: events.length,
        functions: aggregate(events),
        errors,
      }
    },
  }
}

// The stderr tail, minus the CLI's banner (`▌ …`, `Watching logs …`).
const lastLines = (s: string) =>
  s
    .trim()
    .split('\n')
    .filter((l) => !/^\s*(▌|Watching logs)/.test(l))
    .slice(-3)
    .join(' | ')
const redact = (s: string) => s.replace(/dev:[a-z0-9-]+\|\S+/g, '<key>')

// ── aggregate ───────────────────────────────────────────────────────────

// Our own modules: a file under convex/, not Convex Auth's `auth:*`.
const ownModule = new Map<string, boolean>()
function isOwn(identifier: string): boolean {
  const mod = identifier.split(':')[0]
  if (mod === 'auth' || !identifier.includes(':')) return false
  let own = ownModule.get(mod)
  if (own === undefined) {
    own = ['.ts', '.js'].some((ext) =>
      existsSync(path.join(root, 'convex', mod + ext)),
    )
    ownModule.set(mod, own)
  }
  return own
}

function percentile(sorted: Array<number>, p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

const round = (ms: number) => Math.round(ms * 10) / 10

export function aggregate(events: Array<LogEvent>): Array<FunctionStats> {
  const groups = new Map<string, { ev: LogEvent; ms: Array<number> }>()
  for (const ev of events) {
    const cached = ev.cachedResult === true
    const admin = ev.identityType === 'instance_admin'
    const key = `${ev.udfType}|${ev.identifier}|${cached}|${admin}`
    const g = groups.get(key) ?? { ev, ms: [] }
    g.ms.push(ev.executionTime * 1000)
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(({ ev, ms }) => {
      ms.sort((a, b) => a - b)
      const cached = ev.cachedResult === true
      const asserted =
        !cached &&
        ev.componentPath === null &&
        ev.identityType !== 'instance_admin' &&
        ev.udfType in BUDGET_MS &&
        isOwn(ev.identifier)
      return {
        identifier:
          ev.identityType === 'instance_admin'
            ? `${ev.identifier} [admin]`
            : ev.identifier,
        udfType: ev.udfType,
        cached,
        asserted,
        budgetMs: asserted
          ? (BULK_FUNCTIONS[ev.identifier] ??
            BUDGET_MS[ev.udfType as keyof typeof BUDGET_MS])
          : null,
        n: ms.length,
        p50: round(percentile(ms, 0.5)),
        p95: round(percentile(ms, 0.95)),
        max: round(ms[ms.length - 1]),
        second: ms.length > 1 ? round(ms[ms.length - 2]) : null,
      }
    })
    .sort(
      (a, b) =>
        a.identifier.localeCompare(b.identifier) ||
        a.udfType.localeCompare(b.udfType) ||
        Number(a.cached) - Number(b.cached),
    )
}

// ── report ──────────────────────────────────────────────────────────────

/**
 * The pass rule, kept in one place so it can be swapped: every uncached
 * call must take < `budget` ms, bar one spike when the function's other
 * calls (at least one) are all under. Null when `f` passes, otherwise why
 * not.
 */
export function budgetMiss(f: FunctionStats, budget: number): string | null {
  if (f.max < budget) return null
  if (f.second === null)
    return `its only call took ${f.max} ms ≥ ${budget} ms (n=1, nothing to re-measure)`
  if (f.second >= budget)
    return `two calls ≥ ${budget} ms: ${f.max} and ${f.second} ms (n=${f.n})`
  return null
}

/** Asserted functions that passed with one spike, for the banner. */
export function spikes(t: Pick<ServerTimings, 'functions'>): Array<string> {
  return t.functions
    .filter(
      (f) =>
        f.asserted &&
        f.max >= f.budgetMs! &&
        budgetMiss(f, f.budgetMs!) === null,
    )
    .map(
      (f) =>
        `${f.udfType} ${f.identifier}: one call ${f.max} ms, the other ${f.n - 1} under (next slowest ${f.second} ms)`,
    )
}

/** One message per asserted function over its budget. */
export function checkBudgets(
  t: Pick<ServerTimings, 'functions'>,
): Array<string> {
  return t.functions
    .filter((f) => f.asserted)
    .flatMap((f) => {
      const miss = budgetMiss(f, f.budgetMs!)
      return miss ? [`${f.udfType} ${f.identifier}: ${miss}`] : []
    })
}

export function formatTable(t: ServerTimings): string {
  const rows = t.functions.map((f) => {
    const budget = f.budgetMs === null ? '—' : `<${f.budgetMs}`
    return [
      String(f.n).padStart(5),
      f.p50.toFixed(1).padStart(7),
      f.p95.toFixed(1).padStart(7),
      f.max.toFixed(1).padStart(7),
      budget.padStart(6),
      `  ${f.udfType.padEnd(11)}${f.identifier}${f.cached ? ' (cached)' : ''}`,
    ].join('')
  })
  return [
    `Convex server execution (${t.events} events: ${Object.entries(
      t.eventsByInstance,
    )
      .map(([name, n]) => `${name} ${n}`)
      .join(', ')})`,
    '    n   p50ms   p95ms   maxms   max  type       function',
    ...rows,
  ].join('\n')
}

/** What writeResults leaves in the run directory, for qc/reporter.ts. */
export const RESULTS_FILE = 'server-timings.json'

export type ServerTimingsFile = ServerTimings & {
  budgetMs: typeof BUDGET_MS
  failures: Array<string>
  /** Functions that passed with one call over budget. */
  spikes: Array<string>
}

/** Writes server-timings.{json,txt} into `dir` (the run's runDir()). */
export function writeResults(t: ServerTimings, dir: string) {
  mkdirSync(dir, { recursive: true })
  const file: ServerTimingsFile = {
    ...t,
    budgetMs: BUDGET_MS,
    failures: checkBudgets(t),
    spikes: spikes(t),
  }
  writeFileSync(
    path.join(dir, RESULTS_FILE),
    JSON.stringify(file, null, 2) + '\n',
  )
  writeFileSync(path.join(dir, 'server-timings.txt'), formatTable(t) + '\n')
}
