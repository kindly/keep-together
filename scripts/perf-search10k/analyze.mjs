#!/usr/bin/env node
// Markdown tables from measure.mjs's raw.json: per case, server time
// (median / p95 / max), client time minus the median no-op round trip,
// documents read, rows and search hits checked.
//
//   node scripts/perf-search10k/analyze.mjs <dir>/raw.json
import { readFileSync } from 'node:fs'

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]
}
const med = (xs) => q(xs, 0.5)
const f = (x) => (x === undefined ? '–' : x.toFixed(1))

const groups = new Map()
for (const c of raw.calls) {
  const g = groups.get(c.group) ?? new Map()
  groups.set(c.group, g)
  const l = g.get(c.label) ?? []
  g.set(c.label, l)
  l.push(c)
}
console.log(
  `RTT (cached no-op, median of ${raw.rtts.length}): ${raw.rtt.toFixed(1)} ms\n`,
)
for (const [group, cases] of groups) {
  console.log(`### ${group}\n`)
  console.log(
    '| case | n | server median | p95 | max | client−RTT median | docs read | rows | hits checked | flags |',
  )
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const [label, cs] of cases) {
    const s = cs.map((c) => c.serverMs).filter((x) => x !== undefined)
    const cl = cs.map((c) => c.clientMs - raw.rtt)
    const docs = cs.map((c) => c.readDocs).filter((x) => x !== undefined)
    const flags = []
    if (cs.some((c) => c.cached)) flags.push('CACHED')
    if (s.length && q(s, 1) >= 100) flags.push('**≥100 ms**')
    else if (s.length && q(s, 1) >= 70) flags.push('near 100')
    if (cs[0].truncated) flags.push('truncated')
    console.log(
      `| ${label} | ${s.length} | ${f(med(s))} | ${f(q(s, 0.95))} | ${f(q(s, 1))} | ${f(med(cl))} | ${docs.length ? med(docs) : '–'} | ${cs[0].rows} | ${cs[0].checked ?? '–'} | ${flags.join(' ')} |`,
    )
  }
  console.log()
}
console.log('isolation:', JSON.stringify(raw.iso))
