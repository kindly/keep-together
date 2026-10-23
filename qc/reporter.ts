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
import { SERVER_EXCEPTIONS, budgets } from './budgets'
import { coverageGaps, readRoutes } from './coverage'
import { BUDGET_MS, RESULTS_FILE, budgetMiss } from './server-timings'
import { LINK_FILE, STALL_MS, linkDuring } from './link.setup'
import type { LinkFile } from './link.setup'
import type { ServerTimingsFile } from './server-timings'
import {
  blame,
  commitLatency,
  countVerdicts,
  formatBlame,
  formatCounts,
  readBlameContext,
} from './blame'
import type { Blame, BlameContext } from './blame'
import type { Rule } from './judge'
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
// Each sample's legs (qc/timing.ts) go on its history line, with the worst
// first-hop round trip during it (qc/link.setup.ts); a LINK banner lists
// the over-budget samples that overlapped a first-hop stall. Context only:
// they're judged like any other.
//
// Every sample at or over budget also gets a breakdown and a verdict
// (qc/blame.ts: ours, link, convex/network, unclear) on its history line
// as `blame`, a BLAME list, and a count by verdict next to the failures.
// They explain; they never change a pass or a fail.
//
// A `knownOver` flow (an approved exception) never fails the run, but
// every run lists all of them in a banner with their samples. So does
// every spike: a flow that passed only on its re-measure (qc/timing.ts),
// or a server function that passed with one slow call.

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
  /** Every sample must be under this. */
  budgetMs: number
  /** Every call of this flow passed; null when none was judged. */
  pass: boolean | null
  /** Approved exception: `pass` is still the real judgement. */
  knownOver?: string
  /** How the judged set's slow samples were judged (qc/judge.ts), by rule. */
  judged?: Partial<Record<Rule, number>>
  /**
   * Hidden-ours signals over every sample (human, 2026-10-21): tracked,
   * not judged. Medians of bytes the page received, requests it made, and
   * commit latency (send → commit less the probe).
   */
  signals?: {
    bytesInP50: number | null
    requestsP50: number | null
    commitLatencyP50: number | null
  }
  /**
   * The run's Convex server execution times (qc/server-timings.ts), the
   * same on every line of a run; null when the collector wrote nothing.
   */
  server: ServerSummary | null
}

export type SampleWhere = SampleDetail & {
  worker: number
  instance?: string
  /** Worst first-hop round trip during the sample; absent without a monitor. */
  linkMs?: number | null
  /** At or over budget: whose time it was (qc/blame.ts). */
  blame?: Blame
}

function readLink(dir: string): LinkFile | null {
  const file = path.join(dir, LINK_FILE)
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as LinkFile)
    : null
}

export interface ServerSummary {
  /** No stream was lost and no asserted function broke the budget rule. */
  pass: boolean
  /** Asserted functions that passed with one call over budget. */
  spikes?: Array<string>
  /** Every approved server exception, with this run's excepted calls. */
  exceptions?: Array<string>
  /** How many calls the exceptions excepted this run. */
  exceptedCalls?: number
  /** Uncached executions only; `asserted` ones are judged. */
  functions: Array<{
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

function readServer(dir: string): ServerSummary | null {
  const file = path.join(dir, RESULTS_FILE)
  if (!existsSync(file)) return null
  const t = JSON.parse(readFileSync(file, 'utf8')) as ServerTimingsFile
  return {
    pass: t.errors.length === 0 && t.failures.length === 0,
    spikes: t.spikes,
    exceptions: t.exceptions,
    exceptedCalls: t.functions
      .filter((f) => f.exception !== undefined)
      .reduce((n, f) => n + f.n, 0),
    functions: t.functions
      .filter((f) => !f.cached)
      .map((f) => {
        const budget =
          f.budgetMs ?? BUDGET_MS[f.udfType as keyof typeof BUDGET_MS]
        const spike =
          f.asserted && f.max >= budget && budgetMiss(f, budget) === null
        return {
          fn: f.identifier,
          type: f.udfType,
          asserted: f.asserted,
          n: f.n,
          p50Ms: f.p50,
          p95Ms: f.p95,
          maxMs: f.max,
          ...(spike && { spike: true as const }),
        }
      }),
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
  base: Pick<HistoryLine, 'runId' | 'at' | 'sha' | 'dirty' | 'mode' | 'server'>,
  link: LinkFile | null,
  ctx: BlameContext,
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
        (d ?? []).map((x): SampleWhere => {
          const s: SampleWhere = {
            worker: r.worker,
            instance: r.instance,
            ...x,
            ...(link?.watched && {
              linkMs: linkDuring(link, x.at, x.at + x.endMs),
            }),
          }
          return x.endMs >= r.budgetMs ? { ...s, blame: blame(s, ctx) } : s
        })
      const detail = rs.flatMap((r) => where(r, r.detail))
      const firstDetail = rs.flatMap((r) => where(r, r.firstDetail))
      const rules: Partial<Record<Rule, number>> = {}
      for (const d of detail)
        if (d.judge) rules[d.judge.rule] = (rules[d.judge.rule] ?? 0) + 1
      const all = [...firstDetail, ...detail]
      const p50 = (xs: Array<number | null | undefined>) => {
        const ns = xs.filter((x): x is number => typeof x === 'number')
        return ns.length ? median(ns) : null
      }
      const signals = all.some((d) => d.bytesIn !== undefined)
        ? {
            bytesInP50: p50(all.map((d) => d.bytesIn)),
            requestsP50: p50(all.map((d) => d.requests)),
            commitLatencyP50: p50(all.map((d) => commitLatency(d, ctx.probes))),
          }
        : undefined
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
        p50Ms: median(samplesMs),
        p95Ms: percentile(samplesMs, 95),
        maxMs: Math.max(...samplesMs),
        overBudget: samplesMs.filter((x) => x >= budgetMs).length,
        rttMs: median(rs.map((r) => r.rttMs)),
        rttOver: rs.some((r) => r.rttOver),
        budgetMs,
        pass: judged.length ? judged.every((r) => r.pass) : null,
        ...(rs[0].knownOver && { knownOver: rs[0].knownOver }),
        ...(Object.keys(rules).length && { judged: rules }),
        ...(signals && { signals }),
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
      (l.firstSamplesMs
        ? ` (re-measured: 1st max ${Math.round(Math.max(...l.firstSamplesMs))})`
        : '') +
      (l.judged
        ? ` (${Object.entries(l.judged)
            .map(([rule, n]) => `${n} ${rule}`)
            .join(', ')})`
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
 * Every approved server exception (SERVER_EXCEPTIONS), on every run, with
 * the calls it excepted: like knownOver flows, so none is forgotten.
 */
export function serverExceptionBanner(
  server: Pick<ServerSummary, 'exceptions' | 'exceptedCalls'> | null,
): Array<string> {
  if (!SERVER_EXCEPTIONS.length) return []
  const lines =
    server?.exceptions ??
    SERVER_EXCEPTIONS.map(
      (x) => `${x.fn}: EXCEPTED, not asserted: ${x.reason} · no server data`,
    )
  const n = SERVER_EXCEPTIONS.length
  const calls = server?.exceptedCalls
  return banner([
    `${n} server exception${n === 1 ? '' : 's'} (approved, qc/budgets.ts SERVER_EXCEPTIONS)${calls === undefined ? '' : `, ${calls} call${calls === 1 ? '' : 's'} EXCEPTED this run`}: timed, never asserted.`,
    ...lines,
  ])
}

/** Flows that spiked and were re-measured, and server functions with one slow call. */
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

/** Every slow sample the judged sets judged on whose time it was (qc/judge.ts). */
function judgeList(
  lines: Array<HistoryLine>,
  selfTest: Set<FlowName>,
): Array<string> {
  const rows = lines
    .filter((l) => !selfTest.has(l.flow))
    .flatMap((l) =>
      (l.detail ?? []).flatMap((d) =>
        d.judge
          ? [
              `  ${l.flow} w${d.worker} ${d.instance ?? '?'}: ${d.judge.rule} · ` +
                d.judge.attempts
                  .map(
                    (a) =>
                      `${Math.round(a.ms)} ms ${a.verdict ?? 'under'}` +
                      (a.ourShareMs != null
                        ? ` (our share ${Math.round(a.ourShareMs)})`
                        : '') +
                      (a.caughtUp === false ? ' [logs behind]' : ''),
                  )
                  .join(' → ') +
                (d.judge.shareBudgetMs !== undefined
                  ? ` · our share must be < ${d.judge.shareBudgetMs}`
                  : ''),
            ]
          : [],
      ),
    )
  if (!rows.length) return []
  return [
    'JUDGED: slow samples in the judged sets, ours or not (qc/README.md "Ours"; unclear counts as ours):',
    ...rows,
  ]
}

/** Counts for the run: retried, passed on retry or our share, failed and why. */
function judgeSummary(
  lines: Array<HistoryLine>,
  selfTest: Set<FlowName>,
): Array<string> {
  const js = lines
    .filter((l) => !selfTest.has(l.flow))
    .flatMap((l) => (l.detail ?? []).flatMap((d) => (d.judge ? [d.judge] : [])))
  if (!js.length) return []
  const by: Partial<Record<Rule, number>> = {}
  for (const j of js) by[j.rule] = (by[j.rule] ?? 0) + 1
  const retried = js.filter((j) => j.attempts.length > 1).length
  const extra = js.reduce((n, j) => n + j.attempts.length - 1, 0)
  return [
    `ours: ${js.length} slow samples judged, ${retried} retried (${extra} extra attempts): ` +
      Object.entries(by)
        .map(([rule, n]) => `${rule} ${n}`)
        .join(', '),
  ]
}

/** Every slow sample's breakdown, by flow. */
function blameList(
  lines: Array<HistoryLine>,
  selfTest: Set<FlowName>,
): Array<string> {
  const rows = lines
    .filter((l) => !selfTest.has(l.flow))
    .flatMap((l) => {
      const slow = (set: string, d: Array<SampleWhere> | undefined) =>
        (d ?? [])
          .filter((x) => x.blame)
          .map(
            (x) =>
              `  ${set} w${x.worker} ${x.instance ?? '?'} ${new Date(x.at).toISOString().slice(11, 23)}: ${formatBlame(x.endMs, x.blame!)}`,
          )
      const all = [...slow('1st', l.firstDetail), ...slow('   ', l.detail)]
      return all.length ? [`${l.flow} (budget < ${l.budgetMs}):`, ...all] : []
    })
  if (!rows.length) return []
  return [
    'BLAME: samples at or over budget, split into legs (qc/README.md "Blame"; ≈ = server clock; context only, judged as usual):',
    ...rows,
  ]
}

/** Slow samples by verdict, and the verdicts of each failed flow's samples. */
function blameSummary(
  lines: Array<HistoryLine>,
  selfTest: Set<FlowName>,
): Array<string> {
  const real = lines.filter((l) => !selfTest.has(l.flow))
  const blames = (l: HistoryLine) =>
    [...(l.firstDetail ?? []), ...(l.detail ?? [])].flatMap((d) =>
      d.blame ? [d.blame] : [],
    )
  const all = real.flatMap(blames)
  if (!all.length) return []
  const failed = real.filter((l) => l.pass === false)
  return [
    `blame: ${all.length} samples at or over budget: ${formatCounts(countVerdicts(all))}`,
    ...failed.map(
      (l) =>
        `blame: ${l.flow} ${l.knownOver ? 'KNOWN OVER' : 'OVER'}: ${formatCounts(countVerdicts(blames(l)))}`,
    ),
  ]
}

const banner = (lines: Array<string>) => {
  const bar = '!'.repeat(72)
  return [bar, ...lines.map((l) => `!! ${l}`), bar]
}

export default class QcReporter implements Reporter {
  private filtered = false
  private routes = new Set<string>()

  onBegin(config: FullConfig) {
    this.filtered = isFiltered(config.argv)
  }

  onTestEnd(test: TestCase, result: TestResult) {
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
    let blameLines: Array<string> = []

    if (records.length) {
      const selfTest = new Set(
        records.filter((r) => r.selfTest).map((r) => r.flow),
      )
      const link = readLink(runDir(id))
      const blameCtx = readBlameContext(runDir(id))
      const lines = summarise(
        records,
        {
          runId: id,
          at: new Date().toISOString(),
          sha: git(['rev-parse', 'HEAD']),
          dirty: git(['status', '--porcelain']) !== '',
          mode: RECORD ? 'record' : 'assert',
          server: readServer(runDir(id)),
        },
        link,
        blameCtx,
      )
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
      out.push(...spikeBanner(lines, selfTest, lines[0]?.server ?? null))
      out.push(...linkBanner(lines, selfTest, link))
      out.push(...blameList(lines, selfTest))
      out.push(...judgeList(lines, selfTest))
      if (blameCtx.skipped) {
        out.push(
          `blame: ${blameCtx.skipped} unreadable lines or files in server-calls.jsonl / rtt-*.jsonl skipped`,
        )
      }
      blameLines = [
        ...blameSummary(lines, selfTest),
        ...judgeSummary(lines, selfTest),
      ]
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
    out.push(...serverExceptionBanner(readServer(runDir(id))))

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

    const gaps = coverageGaps(readRoutes(), this.routes)
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

    // Next to the failures, so a failed run says whose time it was.
    out.push(...blameLines)
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
