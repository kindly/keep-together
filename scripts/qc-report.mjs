#!/usr/bin/env node
// Render the QC timing history to a trend page (factory/plans/qc-suite.sv
// step 10).
//
//   node scripts/qc-report.mjs [--runs N] [--history <file>] [--out <file>]
//
// Reads qc-results/history.jsonl (qc/reporter.ts appends one line per flow
// per `pnpm qc` run) and writes qc-report/trend.html: one static,
// self-contained page with no scripts and no network. It covers the last N
// runs (default 30). The shaping and rendering live in qc/trend.ts, which
// Node loads directly (type stripping).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { parseHistory, renderTrend, shapeTrend } from '../qc/trend.ts'

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '30' },
    history: { type: 'string', default: 'qc-results/history.jsonl' },
    out: { type: 'string', default: 'qc-report/trend.html' },
  },
})
const lastRuns = Number(values.runs)
if (!Number.isInteger(lastRuns) || lastRuns < 1) {
  console.error(
    `qc:report: --runs must be a positive integer, got ${values.runs}`,
  )
  process.exit(2)
}
if (!existsSync(values.history)) {
  console.error(
    `qc:report: no history at ${values.history}; run \`pnpm qc\` first`,
  )
  process.exit(1)
}

const { lines, skipped } = parseHistory(readFileSync(values.history, 'utf8'))
const trend = shapeTrend(lines, { lastRuns }, skipped)
mkdirSync(path.dirname(values.out), { recursive: true })
writeFileSync(values.out, renderTrend(trend, new Date().toISOString()))

const tight = trend.latest
  .slice(0, 5)
  .map((r) => `${r.flow} ${Math.round(r.headroomMs)} ms`)
  .join(', ')
console.log(
  `qc:report: ${trend.runs.length} runs, ${trend.flows.length} flows, ${trend.server.length} server functions${skipped ? `, ${skipped} unreadable lines skipped` : ''}`,
)
if (tight) console.log(`least headroom: ${tight}`)
console.log(`wrote ${path.resolve(values.out)}`)
