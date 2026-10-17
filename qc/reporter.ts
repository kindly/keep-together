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
} from '@playwright/test/reporter'
import {
  RECORD,
  RTT_CEILING_MS,
  median,
  percentile,
  runDir,
  runId,
} from './timing'
import type { FlowRecord } from './timing'
import { budgets } from './budgets'
import { RESULTS_FILE } from './server-timings'
import type { ServerTimingsFile } from './server-timings'
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
//   --last-failed …) only warns, since it skips flows on purpose.
//
// A `knownOver` flow (an approved exception) never fails the run, but
// every run lists all of them in a banner with their samples.

const HISTORY = path.join('qc-results', 'history.jsonl')

export interface HistoryLine {
  runId: string
  at: string
  sha: string
  dirty: boolean
  mode: 'assert' | 'record'
  flow: FlowName
  kind: FlowKind
  n: number
  /** Raw: input event to result on screen, network included. */
  samplesMs: Array<number>
  p50Ms: number
  p95Ms: number
  maxMs: number
  /** Samples at or over the budget. */
  overBudget: number
  /** Context only: median of the workers' RTTs. */
  rttMs: number
  /** Some samples came from a worker over the RTT ceiling: drop them. */
  rttOver: boolean
  /** Every sample must be under this. */
  budgetMs: number
  /** Every call of this flow passed; null when none was judged. */
  pass: boolean | null
  /** Approved exception: `pass` is still the real judgement. */
  knownOver?: string
  /**
   * The run's Convex server execution times (qc/server-timings.ts), the
   * same on every line of a run; null when the collector wrote nothing.
   */
  server: ServerSummary | null
}

export interface ServerSummary {
  /** No stream was lost and no asserted call reached the budget. */
  pass: boolean
  /** Uncached executions only; `asserted` ones are judged. */
  functions: Array<{
    fn: string
    type: string
    asserted: boolean
    n: number
    p50Ms: number
    p95Ms: number
    maxMs: number
  }>
}

function readServer(dir: string): ServerSummary | null {
  const file = path.join(dir, RESULTS_FILE)
  if (!existsSync(file)) return null
  const t = JSON.parse(readFileSync(file, 'utf8')) as ServerTimingsFile
  return {
    pass: t.errors.length === 0 && t.failures.length === 0,
    functions: t.functions
      .filter((f) => !f.cached)
      .map((f) => ({
        fn: f.identifier,
        type: f.udfType,
        asserted: f.asserted,
        n: f.n,
        p50Ms: f.p50,
        p95Ms: f.p95,
        maxMs: f.max,
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
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FlowRecord),
    )
}

function summarise(
  records: Array<FlowRecord>,
  base: Pick<HistoryLine, 'runId' | 'at' | 'sha' | 'dirty' | 'mode' | 'server'>,
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
      return {
        ...base,
        flow,
        kind: rs[0].kind,
        n: samplesMs.length,
        samplesMs,
        p50Ms: median(samplesMs),
        p95Ms: percentile(samplesMs, 95),
        maxMs: Math.max(...samplesMs),
        overBudget: samplesMs.filter((x) => x >= budgetMs).length,
        rttMs: median(rs.map((r) => r.rttMs)),
        rttOver: rs.some((r) => r.rttOver),
        budgetMs,
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
    'budget',
    'headroom',
    'over',
    'RTT',
    '',
  ]
  const rows = lines.map((l) => [
    l.flow,
    l.kind === 'repeatable' ? 'repeat' : 'once',
    String(l.n),
    `${Math.round(l.p50Ms)}`,
    `${Math.round(l.p95Ms)}`,
    `${Math.round(l.maxMs)}`,
    `<${l.budgetMs}`,
    `${Math.round(l.budgetMs - l.maxMs)}`,
    `${l.overBudget}`,
    `${Math.round(l.rttMs)}`,
    selfTest.has(l.flow)
      ? 'self-test'
      : l.pass === null
        ? 'not judged'
        : l.pass
          ? l.knownOver
            ? 'ok (known over)'
            : 'ok'
          : l.knownOver
            ? 'KNOWN OVER'
            : 'OVER',
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

// Positional args select spec files; these flags select tests.
const FILTER_FLAGS = [
  '-g',
  '--grep',
  '--grep-invert',
  '--last-failed',
  '--only-changed',
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

const banner = (lines: Array<string>) => {
  const bar = '!'.repeat(72)
  return [bar, ...lines.map((l) => `!! ${l}`), bar]
}

export default class QcReporter implements Reporter {
  private filtered = false

  onBegin(config: FullConfig) {
    this.filtered = isFiltered(config.argv)
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
      const lines = summarise(records, {
        runId: id,
        at: new Date().toISOString(),
        sha: git(['rev-parse', 'HEAD']),
        dirty: git(['status', '--porcelain']) !== '',
        mode: RECORD ? 'record' : 'assert',
        server: readServer(runDir(id)),
      })
      const rtts = [...new Set(records.map((r) => `w${r.worker} ${r.rttMs}`))]
      out.push(
        `qc ${id} · ${RECORD ? 'RECORD MODE (nothing asserted)' : 'asserting'} · raw ms, input to screen; every sample must be under budget; headroom = budget − max · RTT by worker: ${rtts.sort().join(', ')}`,
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
            `${r.flow} over budget in worker ${r.worker} setup: ${r.samplesMs.join(', ')} ms, budget < ${r.budgetMs}`,
          )
        }
      }
    } else {
      out.push(`qc ${id}: no flows timed`)
    }

    out.push(...knownOverBanner(summary))

    const timed = new Set(records.map((r) => r.flow))
    const untimed = (Object.entries(budgets) as Array<[FlowName, Budget]>)
      .filter(([name, b]) => !b.selfTest && !timed.has(name))
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
