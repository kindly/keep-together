#!/usr/bin/env node
// Markdown tables from measure.mjs's raw.json: per case, server time
// (Server-Timing `total`: median / p95 / max), the `db` share, client
// time, and — with `--rtt <ms>` — the server median plus that round trip,
// the arithmetic stand-in for the network (the Convex runs' RTT to Dublin
// is ~30 ms).
//
//   node scripts/perf-search10k-rs/analyze.mjs <dir>/raw.json [--rtt 30]
import { readFileSync } from 'node:fs'

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const i = process.argv.indexOf('--rtt')
const addRtt = i === -1 ? null : Number(process.argv[i + 1])
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]
}
const f = (x) => (x === undefined ? '–' : x < 10 ? x.toFixed(2) : x.toFixed(1))

const groups = new Map()
for (const c of raw.calls) {
  const g = groups.get(c.group) ?? new Map()
  groups.set(c.group, g)
  const l = g.get(c.label) ?? []
  g.set(c.label, l)
  l.push(c)
}
console.log(
  `Local network share (client − server on GET /api/me, median of ${raw.rtts.length}): ${f(raw.rtt)} ms\n`,
)
for (const [group, cases] of groups) {
  console.log(`### ${group}\n`)
  const rttCol = addRtt === null ? '' : ` + ${addRtt} ms RTT |`
  console.log(
    `| case | n | server median | p95 | max | db median | client median |${rttCol} rows | hits read | truncated |`,
  )
  console.log(`|---|---|---|---|---|---|---|${addRtt === null ? '' : '---|'}---|---|---|`)
  for (const [label, cs] of cases) {
    const s = cs.map((c) => c.serverMs)
    const db = cs.map((c) => c.dbMs)
    const cl = cs.map((c) => c.clientMs)
    const rtt = addRtt === null ? '' : ` ${f(q(s, 0.5) + addRtt)} |`
    console.log(
      `| ${label} | ${s.length} | ${f(q(s, 0.5))} | ${f(q(s, 0.95))} | ${f(q(s, 1))} | ${f(q(db, 0.5))} | ${f(q(cl, 0.5))} |${rtt} ${cs[0].rows} | ${cs[0].checked ?? '–'} | ${cs[0].truncated ?? (cs[0].isDone === false ? 'more' : '')} |`,
    )
  }
  console.log()
}
console.log('isolation:', JSON.stringify(raw.iso))
