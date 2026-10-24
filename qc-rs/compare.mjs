import fs from 'node:fs'
const [hist, ...runs] = process.argv.slice(2)
const med = (a) => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const H = fs
  .readFileSync(hist, 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse)
  .filter((l) => l.flow && !l.rttOver)
const conv = {}
for (const l of H) (conv[l.flow] ??= []).push(l)
const rs = {}
const extra = {}
for (const r of runs) {
  const d = `qc-results/runs/${r}`
  for (const f of fs.readdirSync(d)) {
    if (f.startsWith('pid-'))
      for (const l of fs
        .readFileSync(`${d}/${f}`, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse))
        (rs[l.flow] ??= []).push(...l.samplesMs)
    if (f === 'rust-extra.jsonl')
      for (const l of fs
        .readFileSync(`${d}/${f}`, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse))
        (extra[l.flow] ??= []).push(l.ms)
  }
}
console.log(
  '| flow | Convex median (last 5 runs: median of medians) | Convex p95 (last run) | Rust median | Rust p95 | Rust n |',
)
console.log('|---|---|---|---|---|---|')
for (const [k, v] of Object.entries(rs).sort()) {
  const c = conv[k]?.slice(-5)
  const p95 = (a) => {
    const s = [...a].sort((x, y) => x - y)
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
  }
  console.log(
    `| ${k} | ${c ? med(c.map((x) => x.p50Ms)).toFixed(1) : '–'} | ${c ? c.at(-1).p95Ms.toFixed(1) : '–'} | ${med(v).toFixed(1)} | ${p95(v).toFixed(1)} | ${v.length} |`,
  )
}
for (const [k, v] of Object.entries(extra))
  console.log(`extra ${k}: ${v.join(', ')} (median ${med(v)})`)
// round trips per flow (calls inside the window)
const calls = {}
for (const r of runs) {
  const f = `qc-results/runs/${r}/rust-calls.jsonl`
  if (!fs.existsSync(f)) continue
  for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse))
    (calls[l.flow] ??= []).push(...l.calls)
}
for (const [k, v] of Object.entries(calls).sort()) {
  const n = v.map((c) => c.length)
  const ex = v
    .at(-1)
    .map(
      (c) =>
        `${c.url
          .replace(/\/api\/t\/[^/]+/, '')
          .replace(/[0-9a-f]{32}/g, ':id')
          .slice(0, 48)} ${c.startMs}-${c.endMs}`,
    )
    .join(' ; ')
  console.log(`calls ${k}: n=${[...new Set(n)].join('/')} e.g. ${ex}`)
}
