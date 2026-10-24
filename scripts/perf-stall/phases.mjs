#!/usr/bin/env node
// Per background phase (bulk-set, retire, idle): write count, p50/p99/max
// of server `total`, and how many over 50/150 ms.
//   node scripts/perf-stall/phases.mjs <out>/raw.json
import { readFileSync } from 'node:fs'
const { samples, events } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const phaseAt = (t) => {
  const e = events.filter((x) => x.t <= t).at(-1)?.what ?? 'setup'
  if (/bulk-set start/.test(e)) return 'bulk-set'
  if (/retire start/.test(e)) return 'retire'
  return 'idle'
}
const by = {}
for (const s of samples) (by[phaseAt(s.start)] ??= []).push(s)
const pct = (v, p) => v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]
for (const [k, xs] of Object.entries(by)) {
  const v = xs.map((s) => s.total).sort((a, b) => a - b)
  const span = (Math.max(...xs.map((s) => s.start)) - Math.min(...xs.map((s) => s.start))) / 1000
  console.log(
    `${k.padEnd(9)} n=${v.length} p50=${pct(v, 50).toFixed(1)} p99=${pct(v, 99).toFixed(1)} max=${v.at(-1).toFixed(1)} >50=${v.filter((x) => x > 50).length} >150=${v.filter((x) => x > 150).length}`,
  )
}
for (const e of events) console.log(`  ${(e.t / 1000).toFixed(2)}s ${e.what}`)
