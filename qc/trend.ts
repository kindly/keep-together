import { BULK_FUNCTIONS } from './budgets.ts'
import type { FlowKind } from './budgets.ts'
import type { HistoryLine } from './reporter'
import { DRIFT_MS, DRIFT_RUNS, targetReason } from './target.ts'

const KIND_TEXT: Record<FlowKind, string> = {
  repeatable: 'repeatable',
  infrequent: 'infrequent',
  rare: 'rare',
  oncePerSession: 'once per session',
  bulk: 'bulk',
}
const KIND_SHORT: Record<FlowKind, string> = {
  repeatable: 'repeat',
  infrequent: 'infreq',
  rare: 'rare',
  oncePerSession: 'once',
  bulk: 'bulk',
}

// QC trend report (factory/plans/qc-suite.sv step 10): shapes
// qc-results/history.jsonl into per-flow and per-server-function series
// over the last N runs, and renders them as one static HTML page with
// inline SVG: no scripts, no network. `scripts/qc-report.mjs` is the CLI.
//
// Everything here is pure; the CLI does the file reading and writing.

/** The server's 100 ms rule for every uncached call (qc/server-timings.ts). */
export const SERVER_BUDGET_MS = 100

export interface Run {
  runId: string
  at: string
  sha: string
  dirty: boolean
}

export interface FlowPoint {
  /** Of the judged samples; after a spike, the re-measure. */
  maxMs: number
  /** A spike: the max of the first set, which was re-measured. */
  firstMaxMs?: number
  p50Ms: number
  /** The failing line. */
  budgetMs: number
  /** Tracked, never failed; absent before targets and for kinds without one. */
  targetMs?: number
  /** Over target or drifting up that run (qc/target.ts). */
  target?: HistoryLine['target']
  n: number
  pass: boolean | null
  knownOver?: string
  rttOver: boolean
  /** Slow samples that passed only on our share (qc/judge.ts). */
  passedOnShare?: number
  /** How the judged set's slow samples were judged, by rule. */
  judged?: HistoryLine['judged']
  /** Hidden-ours signals: tracked, not judged. */
  signals?: HistoryLine['signals']
}

export interface FlowSeries {
  flow: string
  kind: HistoryLine['kind']
  /** One per run in the window; null where the run didn't time the flow. */
  points: Array<FlowPoint | null>
  /**
   * Passed on our share in most of the runs that timed it (at least two):
   * a flow that keeps leaning on "not ours" to pass.
   */
  leansOnShare: boolean
}

export interface ServerPoint {
  n: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  /** One call over budget, the others under: passed. */
  spike?: true
}

export interface ServerSeries {
  fn: string
  type: string
  /** Judged against SERVER_BUDGET_MS; the rest is reported only. */
  asserted: boolean
  points: Array<ServerPoint | null>
}

export interface LatestRow {
  flow: string
  kind: HistoryLine['kind']
  run: Run
  /** That run is the window's last; otherwise the flow went untimed since. */
  current: boolean
  maxMs: number
  p50Ms: number
  budgetMs: number
  targetMs?: number
  target?: HistoryLine['target']
  /** budget − max: negative is over. */
  headroomMs: number
  /** headroomMs / budgetMs, the sort key, so 2000 ms budgets compare fairly. */
  headroomRatio: number
  pass: boolean | null
  knownOver?: string
  rttOver: boolean
  firstMaxMs?: number
  passedOnShare?: number
  signals?: HistoryLine['signals']
  leansOnShare: boolean
}

export interface Trend {
  runs: Array<Run>
  flows: Array<FlowSeries>
  server: Array<ServerSeries>
  latest: Array<LatestRow>
  /** Lines in the file, and lines that didn't parse. */
  lines: number
  skipped: number
}

/** Parses history.jsonl, skipping (and counting) lines that aren't JSON. */
export function parseHistory(text: string): {
  lines: Array<HistoryLine>
  skipped: number
} {
  const lines: Array<HistoryLine> = []
  let skipped = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const l = JSON.parse(raw) as HistoryLine
      if (typeof l.runId === 'string' && typeof l.flow === 'string') {
        lines.push(l)
      } else skipped++
    } catch {
      skipped++
    }
  }
  return { lines, skipped }
}

export function shapeTrend(
  all: Array<HistoryLine>,
  opts: { lastRuns: number },
  skipped = 0,
): Trend {
  // A run's lines are appended together; order runs by their first `at`.
  const byRun = new Map<string, Array<HistoryLine>>()
  for (const l of all) byRun.set(l.runId, [...(byRun.get(l.runId) ?? []), l])
  const ordered = [...byRun.values()]
    .map((ls) => ({
      run: {
        runId: ls[0].runId,
        at: ls.map((l) => l.at).sort()[0],
        sha: ls[0].sha,
        dirty: ls[0].dirty,
      },
      lines: ls,
    }))
    .sort((a, b) => a.run.at.localeCompare(b.run.at))
  const window = ordered.slice(-Math.max(1, opts.lastRuns))
  const runs = window.map((w) => w.run)

  const flowNames = [
    ...new Set(window.flatMap((w) => w.lines.map((l) => l.flow))),
  ].sort()
  const flows: Array<FlowSeries> = flowNames.map((flow) => {
    const points = window.map((w) => {
      const l = w.lines.find((x) => x.flow === flow)
      return l ? flowPoint(l) : null
    })
    const last = [...window]
      .reverse()
      .flatMap((w) => w.lines)
      .find((l) => l.flow === flow)
    const timed = points.filter((p) => p !== null)
    const leaning = timed.filter((p) => (p.passedOnShare ?? 0) > 0).length
    return {
      flow,
      kind: last!.kind,
      points,
      leansOnShare: leaning >= 2 && leaning * 2 > timed.length,
    }
  })

  // The server summary is the same on every line of a run.
  const serverByRun = window.map(
    (w) => w.lines.find((l) => l.server)?.server ?? null,
  )
  const fnInfo = new Map<string, { type: string; asserted: boolean }>()
  for (const s of serverByRun)
    for (const f of s?.functions ?? [])
      fnInfo.set(f.fn, { type: f.type, asserted: f.asserted })
  const server: Array<ServerSeries> = [...fnInfo.entries()]
    .map(([fn, info]) => ({
      fn,
      ...info,
      points: serverByRun.map((s) => {
        const f = s?.functions.find((x) => x.fn === fn)
        return f
          ? {
              n: f.n,
              p50Ms: f.p50Ms,
              p95Ms: f.p95Ms,
              maxMs: f.maxMs,
              ...(f.spike && { spike: true as const }),
            }
          : null
      }),
    }))
    // Asserted first, then worst max in the window first.
    .sort(
      (a, b) =>
        Number(b.asserted) - Number(a.asserted) ||
        worst(b.points) - worst(a.points) ||
        a.fn.localeCompare(b.fn),
    )

  const lastRunId = runs.at(-1)?.runId
  const latest: Array<LatestRow> = flows
    .map((s) => {
      const i = lastIndex(s.points)
      const p = s.points[i]!
      const headroomMs = p.budgetMs - p.maxMs
      return {
        flow: s.flow,
        kind: s.kind,
        run: runs[i],
        current: runs[i].runId === lastRunId,
        maxMs: p.maxMs,
        p50Ms: p.p50Ms,
        budgetMs: p.budgetMs,
        ...(p.targetMs !== undefined && { targetMs: p.targetMs }),
        ...(p.target && { target: p.target }),
        headroomMs,
        headroomRatio: headroomMs / p.budgetMs,
        pass: p.pass,
        ...(p.knownOver && { knownOver: p.knownOver }),
        rttOver: p.rttOver,
        ...(p.firstMaxMs !== undefined && { firstMaxMs: p.firstMaxMs }),
        ...(p.passedOnShare && { passedOnShare: p.passedOnShare }),
        ...(p.signals && { signals: p.signals }),
        leansOnShare: s.leansOnShare,
      }
    })
    .sort(
      (a, b) =>
        a.headroomRatio - b.headroomRatio || a.flow.localeCompare(b.flow),
    )

  return { runs, flows, server, latest, lines: all.length, skipped }
}

function flowPoint(l: HistoryLine): FlowPoint {
  return {
    maxMs: l.maxMs,
    p50Ms: l.p50Ms,
    budgetMs: l.budgetMs,
    ...(l.targetMs !== undefined && { targetMs: l.targetMs }),
    ...(l.target && { target: l.target }),
    n: l.n,
    pass: l.pass,
    ...(l.knownOver && { knownOver: l.knownOver }),
    rttOver: l.rttOver,
    ...(l.firstSamplesMs && { firstMaxMs: Math.max(...l.firstSamplesMs) }),
    ...(l.judged?.['passed on our share'] && {
      passedOnShare: l.judged['passed on our share'],
    }),
    ...(l.judged && { judged: l.judged }),
    ...(l.signals && { signals: l.signals }),
  }
}

/** Index of the last non-null point (lib is ES2022: no findLastIndex). */
function lastIndex(points: Array<unknown>): number {
  for (let i = points.length - 1; i >= 0; i--) if (points[i] !== null) return i
  return -1
}

const worst = (points: Array<ServerPoint | null>) =>
  Math.max(0, ...points.map((p) => p?.maxMs ?? 0))

/** Why a flow point is marked: the first that applies. */
export function flowMark(
  p: Pick<
    FlowPoint,
    | 'maxMs'
    | 'budgetMs'
    | 'pass'
    | 'knownOver'
    | 'rttOver'
    | 'firstMaxMs'
    | 'passedOnShare'
  >,
): 'rtt' | 'known' | 'over' | 'share' | 'spike' | 'ok' {
  if (p.rttOver) return 'rtt'
  if (p.knownOver) return 'known'
  if (p.pass === false) return 'over'
  // Over budget and passed: on our share, or on a retry (maxMs keeps the
  // sample that was retried, so a retry reads as a re-measure).
  if (p.passedOnShare) return 'share'
  if (p.maxMs >= p.budgetMs) return p.pass === true ? 'spike' : 'over'
  if (p.firstMaxMs !== undefined) return 'spike'
  return 'ok'
}

// ---------------------------------------------------------------- render

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )

const ms = (x: number) => `${Math.round(x)}`
const shortSha = (r: Run) => `${r.sha.slice(0, 7)}${r.dirty ? '+dirty' : ''}`
const when = (r: Run) => r.at.slice(0, 16).replace('T', ' ')

const W = 340
const H = 120
const PAD = { l: 34, r: 8, t: 8, b: 18 }

interface Line {
  values: Array<number | null>
  cls: string
}

/** The y-axis top: the budget plus room, or the data if it's higher. */
export function yMax(values: Array<number>, budgetMs: number): number {
  const top = Math.max(budgetMs * 1.25, ...values.map((v) => v * 1.08))
  const step = top > 1000 ? 500 : top > 300 ? 100 : top > 120 ? 50 : 25
  return Math.ceil(top / step) * step
}

function chart(opts: {
  runs: Array<Run>
  lines: Array<Line>
  budgetMs: number
  budgetLabel: string
  /** Tracked, never failed: drawn dotted under the budget. */
  targetMs?: number
  /** Point marks on the first line, by run index. */
  marks: Array<{ cls: string; title: string } | null>
}): string {
  const all = opts.lines.flatMap((l) =>
    l.values.filter((v): v is number => v !== null),
  )
  const top = yMax(all, opts.budgetMs)
  const n = opts.runs.length
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1))
  const y = (v: number) => PAD.t + ih - (Math.min(v, top) / top) * ih
  const f = (v: number) => v.toFixed(1)

  const path = (values: Array<number | null>) => {
    let d = ''
    let pen = false
    values.forEach((v, i) => {
      if (v === null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${f(x(i))} ${f(y(v))}`
      pen = true
    })
    return d
  }

  const by = y(opts.budgetMs)
  const parts = [
    `<svg viewBox="0 0 ${W} ${H}" role="img" class="chart">`,
    `<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(y(0))}" y2="${f(y(0))}"/>`,
    `<text class="tick" x="${PAD.l - 4}" y="${f(y(0))}" dy="3">0</text>`,
    `<text class="tick" x="${PAD.l - 4}" y="${f(y(top))}" dy="7">${top}</text>`,
    `<line class="budget" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(by)}" y2="${f(by)}"/>`,
    `<text class="tick budget-label" x="${PAD.l - 4}" y="${f(by)}" dy="3">${esc(opts.budgetLabel)}</text>`,
  ]
  if (opts.targetMs !== undefined) {
    const ty = y(opts.targetMs)
    parts.push(
      `<line class="target" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(ty)}" y2="${f(ty)}"/>`,
      `<text class="tick target-label" x="${PAD.l - 4}" y="${f(ty)}" dy="3">${opts.targetMs}</text>`,
    )
  }
  for (const l of [...opts.lines].reverse()) {
    const d = path(l.values)
    if (d) parts.push(`<path class="${l.cls}" d="${d}"/>`)
  }
  const first = opts.lines[0].values
  first.forEach((v, i) => {
    const m = opts.marks[i]
    if (v === null || !m) return
    parts.push(
      `<circle class="pt ${m.cls}" cx="${f(x(i))}" cy="${f(y(v))}" r="${m.cls === 'ok' ? 2.5 : 4}"><title>${esc(m.title)}</title></circle>`,
    )
    if (v > top)
      parts.push(
        `<text class="clip" x="${f(x(i))}" y="${PAD.t}" dy="-1">▲</text>`,
      )
  })
  if (n > 0) {
    parts.push(
      `<text class="tick start" x="${PAD.l}" y="${H - 4}">${esc(when(opts.runs[0]))}</text>`,
    )
    if (n > 1)
      parts.push(
        `<text class="tick end" x="${W - PAD.r}" y="${H - 4}">${esc(when(opts.runs[n - 1]))}</text>`,
      )
  }
  parts.push('</svg>')
  return parts.join('')
}

const MARK_TEXT = {
  ok: 'ok',
  over: 'OVER',
  known: 'known over',
  spike: 're-measured',
  share: 'passed on our share',
  rtt: 'RTT over ceiling',
} as const

const signalText = (s: HistoryLine['signals']) =>
  s
    ? `signals: ${s.bytesInP50 === null ? '?' : ms(s.bytesInP50)} B in · ${s.requestsP50 ?? '?'} requests · commit ${s.commitLatencyP50 === null ? '?' : ms(s.commitLatencyP50)} ms beyond the probe (medians)`
    : null

function flowCard(s: FlowSeries, runs: Array<Run>): string {
  const lastP = s.points[lastIndex(s.points)]!
  const budgets = new Set(s.points.flatMap((p) => (p ? [p.budgetMs] : [])))
  const marks = s.points.map((p, i) => {
    if (!p) return null
    const m = flowMark(p)
    const r = runs[i]
    return {
      cls: m,
      title: [
        `${when(r)} · ${r.runId} · ${shortSha(r)}`,
        `max ${ms(p.maxMs)} · median ${ms(p.p50Ms)} · ${p.targetMs === undefined ? '' : `target < ${p.targetMs} · `}line < ${p.budgetMs} · n ${p.n}`,
        ...(p.target?.flagged ? [`TARGET: ${targetReason(p)}`] : []),
        ...(p.firstMaxMs !== undefined
          ? [`spike: 1st set max ${ms(p.firstMaxMs)}, re-measured`]
          : []),
        ...(p.judged
          ? [
              `judged: ${Object.entries(p.judged)
                .map(([rule, n]) => `${n} ${rule}`)
                .join(', ')}`,
            ]
          : []),
        ...(signalText(p.signals) ? [signalText(p.signals)!] : []),
        MARK_TEXT[m] + (p.knownOver ? `: ${p.knownOver}` : ''),
      ].join('\n'),
    }
  })
  const flags = [...new Set(s.points.flatMap((p) => (p ? [flowMark(p)] : [])))]
    .filter((m) => m !== 'ok')
    .map((m) => `<span class="tag ${m}">${MARK_TEXT[m]}</span>`)
    .concat(
      s.points.some((p) => p?.target?.flagged)
        ? [
            `<span class="tag target" title="median at or over target, or up ${DRIFT_MS} ms or more on its last ${DRIFT_RUNS} runs">TARGET</span>`,
          ]
        : [],
    )
    .concat(
      s.leansOnShare
        ? [
            '<span class="tag over" title="passed on our share in most of the runs that timed it">leans on our share</span>',
          ]
        : [],
    )
    .join(' ')
  return `<figure class="card">
<figcaption><b>${esc(s.flow)}</b> <span class="muted">${KIND_TEXT[s.kind]}</span> ${flags}
<span class="legend"><i class="sw max"></i>max <i class="sw p50"></i>median${lastP.targetMs === undefined ? '' : ` · target ${lastP.targetMs}, line ${lastP.budgetMs}`}${budgets.size > 1 ? ' · <b>budget changed</b>' : ''}</span></figcaption>
${chart({
  runs,
  lines: [
    { values: s.points.map((p) => p?.maxMs ?? null), cls: 'max' },
    { values: s.points.map((p) => p?.p50Ms ?? null), cls: 'p50' },
  ],
  budgetMs: lastP.budgetMs,
  budgetLabel: `<${lastP.budgetMs}`,
  ...(lastP.targetMs !== undefined && { targetMs: lastP.targetMs }),
  marks,
})}
</figure>`
}

function serverCard(s: ServerSeries, runs: Array<Run>): string {
  // A bulk function has its own limit (qc/budgets.ts), not the 100 ms rule.
  const budgetMs = BULK_FUNCTIONS[s.fn] ?? SERVER_BUDGET_MS
  const marks = s.points.map((p, i) => {
    if (!p) return null
    const r = runs[i]
    const over = s.asserted && p.maxMs >= budgetMs && !p.spike
    const spike = s.asserted && p.spike === true
    return {
      cls: over ? 'over' : spike ? 'spike' : s.asserted ? 'ok' : 'info',
      title: [
        `${when(r)} · ${r.runId} · ${shortSha(r)}`,
        `max ${ms(p.maxMs)} · p95 ${ms(p.p95Ms)} · median ${ms(p.p50Ms)} · n ${p.n}`,
        s.asserted
          ? over
            ? 'OVER'
            : spike
              ? 'spike: one call over, the rest under'
              : 'ok'
          : 'reported, not asserted',
      ].join('\n'),
    }
  })
  return `<figure class="card${s.asserted ? '' : ' reported'}">
<figcaption><b>${esc(s.fn)}</b> <span class="muted">${esc(s.type)}</span>
<span class="legend"><i class="sw max"></i>max <i class="sw p95"></i>p95</span></figcaption>
${chart({
  runs,
  lines: [
    { values: s.points.map((p) => p?.maxMs ?? null), cls: 'max' },
    { values: s.points.map((p) => p?.p95Ms ?? null), cls: 'p95' },
  ],
  budgetMs,
  budgetLabel: `${budgetMs}`,
  marks,
})}
</figure>`
}

function latestTable(t: Trend): string {
  const rows = t.latest.map((r) => {
    const m = flowMark(r)
    const status =
      m === 'known' && r.maxMs < r.budgetMs
        ? 'ok (known over)'
        : r.pass === null && m === 'ok'
          ? 'not judged'
          : m === 'spike'
            ? `ok (re-measured: 1st max ${ms(r.firstMaxMs!)})`
            : MARK_TEXT[m]
    const pct = Math.round(r.headroomRatio * 100)
    const bar = Math.max(0, Math.min(100, pct))
    return `<tr class="${m}">
<td><b>${esc(r.flow)}</b>${r.current ? '' : ` <span class="tag stale" title="not timed in the latest run">${esc(when(r.run))}</span>`}</td>
<td class="muted">${KIND_SHORT[r.kind]}</td>
<td class="num">${ms(r.p50Ms)}</td>
<td class="num">${ms(r.maxMs)}</td>
<td class="num">${r.targetMs === undefined ? '' : `&lt;${r.targetMs}`}</td>
<td class="num">&lt;${r.budgetMs}</td>
<td class="num"><b>${ms(r.headroomMs)}</b></td>
<td class="hr"><span class="bar" style="width:${bar}%"></span><span class="pct">${pct}%</span></td>
<td><span class="tag ${m}"${r.knownOver ? ` title="${esc(r.knownOver)}"` : ''}>${esc(status)}</span>${r.target?.flagged ? ` <span class="tag target" title="${esc(targetReason(r))}">TARGET</span>` : ''}${r.leansOnShare ? ' <span class="tag over">leans on our share</span>' : ''}</td>
<td class="num">${r.signals?.bytesInP50 == null ? '' : ms(r.signals.bytesInP50)}</td>
<td class="num">${r.signals?.requestsP50 ?? ''}</td>
<td class="num">${r.signals?.commitLatencyP50 == null ? '' : ms(r.signals.commitLatencyP50)}</td>
</tr>`
  })
  return `<table class="latest">
<thead><tr><th>flow</th><th>kind</th><th class="num">median</th><th class="num">max</th><th class="num" title="tracked, never failed">target</th><th class="num" title="the failing line: every sample under it">budget</th><th class="num">headroom ms</th><th>headroom</th><th>status</th><th class="num" title="median characters (≈ bytes) the page received per sample">bytes in</th><th class="num" title="median requests the page sent per sample">requests</th><th class="num" title="median send → commit, less the probe">commit ms</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`
}

export function renderTrend(t: Trend, generatedAt: string): string {
  const last = t.runs.at(-1)
  const asserted = t.server.filter((s) => s.asserted)
  const reported = t.server.filter((s) => !s.asserted)
  const body = !last
    ? '<p>No runs in the history yet. Run <code>pnpm qc</code> first.</p>'
    : `<p class="muted">${t.runs.length} run${t.runs.length === 1 ? '' : 's'} from ${esc(when(t.runs[0]))} to ${esc(when(last))} · latest ${esc(last.runId)} at ${esc(shortSha(last))} · ${t.lines} history lines${t.skipped ? `, <b>${t.skipped} unreadable lines skipped</b>` : ''} · times are raw ms, input to screen · hover a point for its run</p>

<h2>Latest run per flow</h2>
<p class="muted">Least headroom first (budget − max, as a share of the budget). Every sample must be under budget, the failing line. The target is tracked, never failed: <span class="tag target">TARGET</span> marks a median at or over it, or up ${DRIFT_MS} ms or more on the flow's last ${DRIFT_RUNS} runs.</p>
${latestTable(t)}

<h2>Flows over runs</h2>
<p class="muted"><span class="tag over">OVER</span> failed · <span class="tag known">known over</span> approved exception (qc/budgets.ts) · <span class="tag spike">re-measured</span> a spike over budget, passed on its one re-measure (the point is the re-measure; hover for the first) · <span class="tag share">passed on our share</span> a slow sample that wasn't ours (link or Convex, with evidence) passed with our share under budget − 50 ms (qc/README.md "Ours") · <span class="tag rtt">RTT over ceiling</span> samples measured the link; latency not asserted · <span class="tag target">TARGET</span> median at or over target, or drifting up (tracked, never failing) · dashed line: budget (the failing line) · dotted line: target</p>
<div class="grid">
${t.flows.map((s) => flowCard(s, t.runs)).join('\n')}
</div>

<h2>Server functions over runs</h2>
<p class="muted">Uncached executions from the Convex log stream. Asserted calls must each be under ${SERVER_BUDGET_MS} ms, bar one spike per function per run when its other calls are under (ringed point).</p>
<div class="grid">
${asserted.map((s) => serverCard(s, t.runs)).join('\n')}
</div>
${
  reported.length
    ? `<h3>Reported, not asserted</h3>
<p class="muted"><code>auth:*</code>, admin, HTTP and seed calls.</p>
<div class="grid">
${reported.map((s) => serverCard(s, t.runs)).join('\n')}
</div>`
    : ''
}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QC trend</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>QC trend</h1>
${body}
<footer class="muted">Generated ${esc(generatedAt)} by <code>pnpm qc:report</code> from <code>qc-results/history.jsonl</code>.</footer>
</main>
</body>
</html>
`
}

const CSS = `
:root {
  --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --card: #fff;
  --max: #2f5fb3; --p50: #9db4dc; --p95: #d08a2e; --budget: #c0392b;
  --ok: #2f5fb3; --over: #c0392b; --known: #b7791f; --rtt: #8a8a85; --info: #8a8a85;
  --over-bg: #fbe9e7; --known-bg: #fdf3e1; --rtt-bg: #eeeeec;
  --spike: #7b4bb3; --spike-bg: #f1eaf9;
  --target: #1f7a6d; --target-bg: #e3f3f0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --fg: #e8e7e3; --muted: #9a9993; --line: #33322f; --card: #1f1f1d;
    --max: #7aa2f7; --p50: #3d5585; --p95: #e0a458; --budget: #ef6f61;
    --ok: #7aa2f7; --over: #ef6f61; --known: #e0a458; --rtt: #8a8a85; --info: #8a8a85;
    --over-bg: #3a1f1c; --known-bg: #362a17; --rtt-bg: #2a2a28;
    --spike: #b48ef0; --spike-bg: #2c2238;
    --target: #5fc4b3; --target-bg: #17302c;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1440px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 32px 0 4px; font-size: 17px; }
h3 { margin: 24px 0 4px; font-size: 15px; }
.muted { color: var(--muted); }
code { font: 12.5px ui-monospace, monospace; }
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 12px;
  background: var(--rtt-bg); color: var(--muted); white-space: nowrap; }
.tag.over { background: var(--over-bg); color: var(--over); font-weight: 600; }
.tag.known { background: var(--known-bg); color: var(--known); }
.tag.rtt { background: var(--rtt-bg); color: var(--rtt); }
.tag.spike { background: var(--spike-bg); color: var(--spike); }
.tag.share { background: var(--spike-bg); color: var(--over); }
.tag.ok { color: var(--ok); background: transparent; }
.tag.target { background: var(--target-bg); color: var(--target); }
table.latest { border-collapse: collapse; width: 100%; max-width: 980px; margin-top: 8px;
  font-variant-numeric: tabular-nums; }
.latest th, .latest td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line);
  text-align: left; vertical-align: middle; }
.latest th { font-size: 12px; color: var(--muted); font-weight: 500; }
.latest .num { text-align: right; }
.latest tr.over td:first-child { box-shadow: inset 3px 0 var(--over); padding-left: 8px; }
.latest tr.known td:first-child { box-shadow: inset 3px 0 var(--known); padding-left: 8px; }
.latest tr.spike td:first-child { box-shadow: inset 3px 0 var(--spike); padding-left: 8px; }
.latest tr.share td:first-child { box-shadow: inset 3px 0 var(--over); padding-left: 8px; }
.latest td:first-child { padding-left: 8px; }
.hr { width: 160px; position: relative; }
.hr .bar { display: inline-block; height: 8px; border-radius: 2px; background: var(--max);
  vertical-align: middle; max-width: 110px; }

.hr .pct { margin-left: 6px; font-size: 12px; color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px;
  margin-top: 8px; }
.card { margin: 0; padding: 10px 10px 4px; background: var(--card); border: 1px solid var(--line);
  border-radius: 6px; }
.card.reported { opacity: .8; }
figcaption { font-size: 13px; }
.legend { display: block; font-size: 11.5px; color: var(--muted); }
.sw { display: inline-block; width: 12px; height: 3px; vertical-align: middle; margin: 0 2px 0 6px; }
.sw.max { background: var(--max); } .sw.p50 { background: var(--p50); } .sw.p95 { background: var(--p95); }
.chart { width: 100%; height: auto; display: block; overflow: visible; }
.chart path { fill: none; stroke-width: 1.8; stroke-linejoin: round; }
.chart path.max { stroke: var(--max); }
.chart path.p50 { stroke: var(--p50); }
.chart path.p95 { stroke: var(--p95); }
.chart .axis { stroke: var(--line); }
.chart .budget { stroke: var(--budget); stroke-dasharray: 4 3; stroke-width: 1.2; }
.chart .tick { font-size: 9.5px; fill: var(--muted); text-anchor: end; }
.chart .tick.start { text-anchor: start; } .chart .tick.end { text-anchor: end; }
.chart .budget-label { fill: var(--budget); }
.chart .target { stroke: var(--target); stroke-dasharray: 1 3; stroke-width: 1.2; }
.chart .target-label { fill: var(--target); }
.chart .clip { font-size: 8px; fill: var(--over); text-anchor: middle; }
.pt { stroke: var(--card); stroke-width: 1; }
.pt.ok { fill: var(--ok); }
.pt.over { fill: var(--over); }
.pt.known { fill: var(--known); }
.pt.spike { fill: var(--card); stroke: var(--spike); stroke-width: 2; }
.pt.share { fill: var(--card); stroke: var(--over); stroke-width: 2; }
.pt.rtt { fill: var(--card); stroke: var(--rtt); stroke-width: 1.5; stroke-dasharray: 2 1.5; }
.pt.info { fill: var(--info); }
footer { margin-top: 40px; font-size: 12px; }
`
