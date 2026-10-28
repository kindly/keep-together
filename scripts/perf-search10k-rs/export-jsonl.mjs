#!/usr/bin/env node
// The perf generator's people (./data.mjs) as JSONL,
// one contact a line, for the Rust seed (server/crates/seed). The same shape
// and seeds as the Convex measurement: tenant A = people(10000, 1), tenant
// B = 63 contacts (people(63, 2): the Convex run's 60 seeded + 3 fixture).
//
//   node scripts/perf-search10k-rs/export-jsonl.mjs <out dir>
//     → <out dir>/a.jsonl, <out dir>/b.jsonl
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { people } from './data.mjs'

const out = process.argv[2]
if (!out) throw new Error('usage: export-jsonl.mjs <out dir>')
mkdirSync(out, { recursive: true })
for (const [name, count, seed] of [
  ['a', 10000, 1],
  ['b', 63, 2],
]) {
  const lines = people(count, seed).map((p) => JSON.stringify(p))
  writeFileSync(path.join(out, `${name}.jsonl`), `${lines.join('\n')}\n`)
  console.log(`${name}.jsonl: ${lines.length} contacts`)
}
