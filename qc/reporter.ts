import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import path from 'node:path'
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import {
  RECORD,
  RTT_CEILING_MS,
  median,
  percentile,
  runDir,
  runId,
} from './timing'
import type { FlowRecord, SampleDetail } from './timing'
import { budgets } from './budgets'
import { DRIFT_MS, DRIFT_RUNS, checkTarget, targetReason } from './target'
import type { TargetCheck } from './target'
import { parseHistory } from './trend'
import { coverageGaps, readRoutes } from './coverage'
import { LINK_FILE, STALL_MS, linkDuring } from './link.setup'
import type { LinkFile } from './link.setup'
import { formatServer, serverSummary } from './server'
import type { ServerSummary as RouteSummary } from './server'
import { isPorted } from '../src/lib/data/ported'
import type { Budget, FlowKind, FlowName } from './budgets'

// QC reporter: gathers every flow record the workers wrote for this run
// (qc-results/runs/<runId>/), appends one line per flow to
// qc-results/history.jsonl and prints the flow table.
//
// It also fails the run for what no single test can see:
// - a flow timed outside a test (the worker-setup sign-in) over budget;
//   flows inside tests already failed their test;
// - in a full assert run, a flow in qc/budgets.ts that nothing timed,
//   unless it's marked `pending`. A filtered run (spec files, --grep,
//   --last-failed …) only warns, since it skips flows on purpose;
// - in a full run (assert or record), a route in src/routeTree.gen.ts
//   that no test which ran was annotated with, or a route annotation
//   naming no route (qc/coverage.ts). A filtered run only warns.
//
//   Routes the Rust backend doesn't serve yet (src/lib/data/ported.ts)
//   are exempt, and listed with the pendingPort flows and tests instead;
// - a route over the server rule (qc/server.ts): every call under 100 ms
//   by its Server-Timing, bar one spike per route.
//
// Each sample's calls (qc/timing.ts) go on its history line, with the
// worst first-hop round trip during it (qc/link.setup.ts); a LINK banner
// lists the over-budget samples that overlapped a first-hop stall. Context
// only: they're judged like any other.
//
// A `knownOver` flow (an approved exception) never fails the run, but
// every run lists all of them in a banner with their samples. So does
// every spike: a flow that passed only on its re-measure (qc/timing.ts),
// or a route that passed with one slow call.
//
// A flow with a target (qc/budgets.ts) is checked against it and against
// its own history (qc/target.ts): over target or drifting up, it's listed
// in a TARGET banner and its history line carries `target`. Tracked only:
// pass and fail depend on the failing line alone.

const HISTORY = path.join('qc-results', 'history.jsonl')

export interface HistoryLine {
  runId: string
  at: string
  sha: string
  dirty: boolean
  mode: 'assert' | 'record'
  /** Where it ran: the local pool, or staging (the nightly). Absent before it. */
  env?: 'local' | 'staging'
  flow: FlowName
  kind: FlowKind
  n: number
  /** Raw: input event to result on screen, network included. Judged. */
  samplesMs: Array<number>
  /** Some call spiked and was re-measured; its judged set is in samplesMs. */
  remeasured?: true
  /** The first sets of the re-measured calls, each with a sample ≥ budget. */
  firstSamplesMs?: Array<number>
  /** Per sample, aligned with samplesMs: when, where and its legs (qc/timing.ts). */
  detail?: Array<SampleWhere>
  /** The same, aligned with firstSamplesMs. */
  firstDetail?: Array<SampleWhere>
  p50Ms: number
  p95Ms: number
  maxMs: number
  /** Samples at or over the budget. */
  overBudget: number
  /** Context only: median of the workers' RTTs. */
  rttMs: number
  /** Some samples came from a worker over the RTT ceiling: drop them. */
  rttOver: boolean
  /** The failing line: every sample must be under this. */
  budgetMs: number
  /** Tracked, never failed; absent for kinds without one, and before them. */
  targetMs?: number
  /** This run against the target and the flow's history (qc/target.ts). */
  target?: TargetCheck
  /** Every call of this flow passed; null when none was judged. */
  pass: boolean | null
  /** Approved exception: `pass` is still the real judgement. */
  knownOver?: string
  /** Convex-era lines only: how slow samples were judged, by rule. */
  judged?: Partial<Record<string, number>>
  /** Convex-era lines only: bytes in, requests and commit latency. */
  signals?: {
    bytesInP50: number | null
    requestsP50: number | null
    commitLatencyP50: number | null
  }
  /**
   * The run's server times by route (qc/server.ts), the same on every line
   * of a run; null when no sample made a call. Convex-era lines carry
   * their functions under the same names.
   */
  server: ServerSummary | null
}

export type SampleWhere = SampleDetail & {
  worker: number
  instance?: string
  /** Worst first-hop round trip during the sample; absent without a monitor. */
  linkMs?: number | null
}

function readLink(dir: string): LinkFile | null {
  const file = path.join(dir, LINK_FILE)
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as LinkFile)
    : null
}

/** The shape history keeps (and qc/trend.ts charts): one row per route. */
export interface ServerSummary {
  /** No route broke the server rule. */
  pass: boolean
  /** Routes that passed with one call over budget. */
  spikes?: Array<string>
  functions: Array<{
    /** `METHOD /path` (Convex-era lines: the function). */
    fn: string
    type: string
    asserted: boolean
    n: number
    p50Ms: number
    p95Ms: number
    maxMs: number
    /** Asserted, one call over budget, the rest under: passed. */
    spike?: true
  }>
}

/** Exported for qc/reporter.test.ts. */
export function historyServer(s: RouteSummary): ServerSummary | null {
  if (!s.routes.length && !s.untimed.length) return null
  return {
    pass: s.pass,
    spikes: s.spikes,
    functions: s.routes.map((r) => ({
      fn: r.route,
      type: 'route',
      asserted: r.asserted,
      n: r.n,
      p50Ms: r.p50Ms,
      p95Ms: r.p95Ms,
      maxMs: r.maxMs,
      ...(r.spike && { spike: true as const }),
    })),
  }
}

function git(args: Array<string>) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function readRecords(dir: string): Array<FlowRecord> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith('pid-') && f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FlowRecord),
    )
}

/** Exported for qc/reporter.test.ts. */
export function summarise(
  records: Array<FlowRecord>,
  base: Pick<
    HistoryLine,
    'runId' | 'at' | 'sha' | 'dirty' | 'mode' | 'env' | 'server'
  >,
  link: LinkFile | null,
  /** history.jsonl before this run, oldest first: the drift baseline. */
  past: Array<HistoryLine> = [],
): Array<HistoryLine> {
  const byFlow = new Map<FlowName, Array<FlowRecord>>()
  for (const r of records)
    byFlow.set(r.flow, [...(byFlow.get(r.flow) ?? []), r])
  return [...byFlow.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([flow, rs]) => {
      const samplesMs = rs.flatMap((r) => r.samplesMs)
      const budgetMs = rs[0].budgetMs
      const judged = rs.filter((r) => r.pass !== null)
      const firstSamplesMs = rs.flatMap((r) => r.firstSamplesMs ?? [])
      const where = (r: FlowRecord, d: Array<SampleDetail> | undefined) =>
        (d ?? []).map((x): SampleWhere => ({
          worker: r.worker,
          instance: r.instance,
          ...x,
          ...(link?.watched && {
            linkMs: linkDuring(link, x.at, x.at + x.endMs),
          }),
        }))
      const detail = rs.flatMap((r) => where(r, r.detail))
      const firstDetail = rs.flatMap((r) => where(r, r.firstDetail))
      const targetMs = rs[0].targetMs
      const p50Ms = median(samplesMs)
      const rttOver = rs.some((r) => r.rttOver)
      const target = checkTarget(
        { flow, kind: rs[0].kind, p50Ms, rttOver, runId: base.runId, targetMs },
        past,
      )
      return {
        ...base,
        flow,
        kind: rs[0].kind,
        n: samplesMs.length,
        samplesMs,
        ...(firstSamplesMs.length && {
          remeasured: true as const,
          firstSamplesMs,
        }),
        ...(detail.length && { detail }),
        ...(firstDetail.length && { firstDetail }),
        p50Ms,
        p95Ms: percentile(samplesMs, 95),
        maxMs: Math.max(...samplesMs),
        overBudget: samplesMs.filter((x) => x >= budgetMs).length,
        rttMs: median(rs.map((r) => r.rttMs)),
        rttOver,
        budgetMs,
        ...(targetMs !== undefined && { targetMs }),
        ...(target && { target }),
        pass: judged.length ? judged.every((r) => r.pass) : null,
        ...(rs[0].knownOver && { knownOver: rs[0].knownOver }),
      }
    })
}

function table(lines: Array<HistoryLine>, selfTest: Set<FlowName>): string {
  const head = [
    'flow',
    'kind',
    'n',
    'median',
    'p95',
    'max',
    'target',
    'budget',
    'headroom',
    'over',
    'RTT',
    '',
  ]
  const rows = lines.map((l) => [
    l.flow,
    {
      repeatable: 'repeat',
      infrequent: 'infreq',
      rare: 'rare',
      oncePerSession: 'once',
      bulk: 'bulk',
    }[l.kind],
    String(l.n),
    `${Math.round(l.p50Ms)}`,
    `${Math.round(l.p95Ms)}`,
    `${Math.round(l.maxMs)}`,
    l.targetMs === undefined ? '' : `<${l.targetMs}`,
    `<${l.budgetMs}`,
    `${Math.round(l.budgetMs - l.maxMs)}`,
    `${l.overBudget}`,
    `${Math.round(l.rttMs)}`,
    (selfTest.has(l.flow)
      ? 'self-test'
      : l.pass === null
        ? 'not judged'
        : l.pass
          ? l.knownOver
            ? 'ok (known over)'
            : 'ok'
          : l.knownOver
            ? 'KNOWN OVER'
            : 'OVER') +
      (l.target?.flagged ? ' · TARGET' : '') +
      (l.firstSamplesMs
        ? ` (re-measured: 1st max ${Math.round(Math.max(...l.firstSamplesMs))})`
        : ''),
  ])
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  )
  const fmt = (r: Array<string>) =>
    r
      .map((c, i) =>
        i <= 1 || i === r.length - 1
          ? c.padEnd(widths[i])
          : c.padStart(widths[i]),
      )
      .join('  ')
      .trimEnd()
  return [fmt(head), ...rows.map(fmt)].join('\n')
}

// Positional args select spec files; these flags select tests, or (--list,
// --shard) don't run them all here.
const FILTER_FLAGS = [
  '-g',
  '--grep',
  '--grep-invert',
  '--last-failed',
  '--only-changed',
  '--list',
  '--shard',
]

function isFiltered(argv: Array<string>): boolean {
  const args = argv.slice(argv.indexOf('test') + 1)
  return args.some(
    (a) => !a.startsWith('-') || FILTER_FLAGS.includes(a.split('=')[0]),
  )
}

/** Every knownOver flow in qc/budgets.ts, with this run's samples if any. */
function knownOverBanner(lines: Array<HistoryLine>): Array<string> {
  const known = (Object.entries(budgets) as Array<[FlowName, Budget]>).filter(
    ([, b]) => b.knownOver,
  )
  if (!known.length) return []
  return banner([
    `${known.length} flows are KNOWN OVER (approved exceptions, qc/budgets.ts): timed, never failing.`,
    ...known.map(([name, b]) => {
      const l = lines.find((x) => x.flow === name)
      const samples = l
        ? `${l.overBudget}/${l.n} over: ${l.samplesMs.join(', ')} ms, budget < ${l.budgetMs}`
        : 'not timed this run'
      return `${name}: KNOWN OVER, not failing: ${b.knownOver} · ${samples}`
    }),
  ])
}

/**
 * Every flow over its target or drifting up (qc/target.ts), on every run.
 * Tracked: never a failure. Exported for qc/reporter.test.ts.
 */
export function targetBanner(lines: Array<HistoryLine>): Array<string> {
  const withTarget = lines.filter((l) => l.target)
  const flagged = withTarget.filter((l) => l.target!.flagged)
  if (!flagged.length) {
    return withTarget.length
      ? [
          `target: all ${withTarget.length} flows with a target are under it, none up ${DRIFT_MS} ms or more on their last ${DRIFT_RUNS} runs`,
        ]
      : []
  }
  return banner([
    `${flagged.length} flow${flagged.length === 1 ? '' : 's'} over TARGET or drifting up (median ≥ target, or up ≥ ${DRIFT_MS} ms on the median of its last ${DRIFT_RUNS} runs): tracked, never failing.`,
    ...flagged.map(
      (l) =>
        `${l.flow}: TARGET: ${targetReason(l)} · target < ${l.targetMs}, line < ${l.budgetMs}, max ${Math.round(l.maxMs)}`,
    ),
  ])
}

/** Flows that spiked and were re-measured, and routes with one slow call. */
function spikeBanner(
  lines: Array<HistoryLine>,
  selfTest: Set<FlowName>,
  server: ServerSummary | null,
): Array<string> {
  const flows = lines.filter((l) => l.firstSamplesMs && !selfTest.has(l.flow))
  const fns = server?.spikes ?? []
  if (!flows.length && !fns.length) return []
  return banner([
    `${flows.length + fns.length} SPIKES: over budget once, judged on the re-measure (qc/README.md).`,
    ...flows.map(
      (l) =>
        `${l.flow}: 1st ${l.firstSamplesMs!.join(', ')} ms · re-measured ${l.samplesMs.join(', ')} ms · budget < ${l.budgetMs} · ${l.pass ? 'passed' : 'FAILED'}`,
    ),
    ...fns.map((f) => `server ${f}`),
  ])
}

/** Over-budget samples that overlapped a first-hop stall. */
function linkBanner(
  lines: Array<HistoryLine>,
  selfTest: Set<FlowName>,
  link: LinkFile | null,
): Array<string> {
  // No banner must never read as a clean link: say when it wasn't watched.
  if (!link?.watched) {
    return [
      `link: first hop not watched (${link?.why ?? `no ${LINK_FILE}`}); the absence of a LINK banner says nothing about the network`,
    ]
  }
  const hits = lines
    .filter((l) => !selfTest.has(l.flow))
    .flatMap((l) =>
      [...(l.firstDetail ?? []), ...(l.detail ?? [])]
        .filter((d) => d.endMs >= l.budgetMs && (d.linkMs ?? 0) >= STALL_MS)
        .map(
          (d) =>
            `${l.flow}: ${d.endMs} ms with the first hop at ${d.linkMs} ms (w${d.worker} ${d.instance ?? '?'}, ${new Date(d.at).toISOString().slice(11, 23)} UTC)`,
        ),
    )
  if (!hits.length) return []
  return banner([
    `LINK: ${hits.length} samples at or over budget overlapped a first-hop stall (ping ${link.gateway} ≥ ${STALL_MS} ms; usually 2–5 ms).`,
    'Judged as usual; the network between this machine and its router held them up.',
    ...hits,
  ])
}

/**
 * What the Rust backend doesn't serve yet (migration-rust.sv), on every
 * run: the pendingPort flows (qc/budgets.ts), the tests skipped for them
 * (qc/pending.ts) and the unported routes, by the step that ports them.
 * Exported for qc/reporter.test.ts.
 */
export function pendingBanner(
  skipped: Map<string, number>,
  routes: Array<string>,
): Array<string> {
  const flows = new Map<string, Array<string>>()
  for (const [name, b] of Object.entries(budgets) as Array<[string, Budget]>)
    if (b.pendingPort)
      flows.set(b.pendingPort, [...(flows.get(b.pendingPort) ?? []), name])
  const steps = [...new Set([...flows.keys(), ...skipped.keys()])].sort()
  const unported = routes.filter((r) => !isPorted(r))
  if (!steps.length && !unported.length) return []
  return banner([
    'pendingPort: not on the Rust backend yet, so not run and not failing (qc/pending.ts, src/lib/data/ported.ts):',
    ...steps.map(
      (step) =>
        `${step}: ${skipped.get(step) ?? 0} tests skipped · flows ${(flows.get(step) ?? []).join(', ') || 'none'}`,
    ),
    ...(unported.length
      ? [`routes being ported (exempt from coverage): ${unported.join(', ')}`]
      : []),
  ])
}

const banner = (lines: Array<string>) => {
  const bar = '!'.repeat(72)
  return [bar, ...lines.map((l) => `!! ${l}`), bar]
}

export default class QcReporter implements Reporter {
  private filtered = false
  private routes = new Set<string>()
  /** pendingPort tests skipped, by step. */
  private pending = new Map<string, number>()

  onBegin(config: FullConfig) {
    this.filtered = isFiltered(config.argv)
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const step = [...test.annotations, ...result.annotations].find(
      (a) => a.type === 'pendingPort',
    )?.description
    if (step && result.status === 'skipped')
      this.pending.set(step, (this.pending.get(step) ?? 0) + 1)
    // A skipped test proves nothing about its route.
    if (result.status === 'skipped') return
    for (const a of [...test.annotations, ...result.annotations]) {
      if (a.type === 'route' && a.description) this.routes.add(a.description)
    }
  }

  async onEnd(
    result: FullResult,
  ): Promise<{ status?: FullResult['status'] } | undefined> {
    const id = runId()
    const records = readRecords(runDir(id))
    const out = ['']
    const failures: Array<string> = []
    let summary: Array<HistoryLine> = []

    if (records.length) {
      const selfTest = new Set(
        records.filter((r) => r.selfTest).map((r) => r.flow),
      )
      const link = readLink(runDir(id))
      const server = serverSummary(records)
      const past = existsSync(HISTORY)
        ? parseHistory(readFileSync(HISTORY, 'utf8')).lines
        : []
      const lines = summarise(
        records,
        {
          runId: id,
          at: new Date().toISOString(),
          sha: git(['rev-parse', 'HEAD']),
          dirty: git(['status', '--porcelain']) !== '',
          mode: RECORD ? 'record' : 'assert',
          env: process.env.QC_TARGET === 'staging' ? 'staging' : 'local',
          server: historyServer(server),
        },
        link,
        past,
      )
      const rtts = [...new Set(records.map((r) => `w${r.worker} ${r.rttMs}`))]
      out.push(
        `qc ${id} · ${RECORD ? 'RECORD MODE (nothing asserted)' : 'asserting'} · raw ms, input to screen; every sample must be under budget (the failing line); target is tracked, never failing; headroom = budget − max · RTT by worker: ${rtts.sort().join(', ')}`,
      )
      if (records.some((r) => r.rttOver)) {
        out.push(
          ...banner([
            `RTT over ${RTT_CEILING_MS} ms on some workers: their samples measure the link, not the app.`,
            RECORD
              ? 'Their history lines carry rttOver: true; leave them out of any budget.'
              : 'Their latency asserts were SKIPPED; behaviour was still checked.',
            'Use a better link.',
          ]),
        )
      }
      summary = lines
      out.push(table(lines, selfTest))
      out.push(...targetBanner(lines))
      out.push(...spikeBanner(lines, selfTest, lines[0]?.server ?? null))
      out.push(...linkBanner(lines, selfTest, link))
      if (server.routes.length) out.push(formatServer(server))
      // Judged like the flows: record mode and a slow link assert nothing.
      if (RECORD || records.some((r) => r.rttOver))
        out.push(...server.failures.map((f) => `not judged: ${f}`))
      else failures.push(...server.failures)
      const real = lines.filter((l) => !selfTest.has(l.flow))
      mkdirSync(path.dirname(HISTORY), { recursive: true })
      appendFileSync(
        HISTORY,
        real.map((l) => JSON.stringify(l) + '\n').join(''),
      )
      out.push(`history: ${real.length} lines appended to ${HISTORY}`)

      // Flows timed in a worker fixture can't fail a test; judge them here.
      for (const r of records) {
        if (r.where === 'worker setup' && r.pass === false && !r.knownOver) {
          failures.push(
            `${r.flow} over budget twice in worker ${r.worker} setup: ${r.samplesMs.join(', ')} ms, re-measured after ${r.firstSamplesMs?.join(', ')} ms, budget < ${r.budgetMs}`,
          )
        }
      }
    } else {
      out.push(`qc ${id}: no flows timed`)
    }

    out.push(...knownOverBanner(summary))
    const routes = readRoutes()
    out.push(...pendingBanner(this.pending, routes))

    const timed = new Set(records.map((r) => r.flow))
    const untimed = (Object.entries(budgets) as Array<[FlowName, Budget]>)
      .filter(([name, b]) => !b.selfTest && !b.pendingPort && !timed.has(name))
      .map(([name, b]) => ({ name, pending: b.pending === true }))
    const pending = untimed.filter((u) => u.pending).map((u) => u.name)
    const missing = untimed.filter((u) => !u.pending).map((u) => u.name)
    if (pending.length) {
      out.push(`not timed yet (pending): ${pending.join(', ')}`)
    }
    if (missing.length) {
      const msg = `not timed: ${missing.join(', ')} (in qc/budgets.ts without \`pending\`)`
      if (RECORD || this.filtered) out.push(`warning: ${msg}`)
      else failures.push(msg)
    }

    // Routes being ported are listed in the pendingPort banner instead.
    const all = coverageGaps(routes, this.routes)
    const gaps = { ...all, uncovered: all.uncovered.filter(isPorted) }
    const gapMsgs = [
      ...(gaps.uncovered.length
        ? [
            `coverage: no test that ran covers ${gaps.uncovered.join(', ')} (add a flow with a route annotation, qc/README.md)`,
          ]
        : []),
      ...(gaps.unknown.length
        ? [
            `coverage: route annotations name no route in src/routeTree.gen.ts: ${gaps.unknown.join(', ')}`,
          ]
        : []),
    ]
    if (this.filtered) out.push(...gapMsgs.map((m) => `warning: ${m}`))
    else failures.push(...gapMsgs)

    if (failures.length) {
      out.push(
        ...banner([
          'QC RUN FAILED, whatever the test counts above say:',
          ...failures,
        ]),
      )
    }
    console.log(out.join('\n'))
    if (failures.length && result.status === 'passed') {
      return { status: 'failed' }
    }
  }
}
