#!/usr/bin/env node
// The occasional ~200 ms write stall (factory/out/brief-stall.md): a
// write-heavy loop against one org (creates + saves) while field retires
// run in the background, recording every write's Server-Timing, then the
// tail and what was running when it happened. Load the machine yourself
// (e.g. a parallel `cargo build --release` in another worktree).
//
//   KEEP_DATA_DIR=<dir> KEEP_DEV_AUTH=1 KEEP_QC_SEED=1 KEEP_PORT=8800 \
//     KEEP_SNAPSHOT_BUCKET=file://<dir>/bucket server/target/release/api &
//   node scripts/perf-stall/bench.mjs --url http://127.0.0.1:8800 \
//     --out <dir> [--seconds 120] [--workers 4] [--contacts 10000] \
//     [--retire-every 20] [--think 0] [--slug stall]
//
// --think <ms>: each writer pauses between writes (a realistic rate).
//
// The snapshot job runs once, 60 s after the api boots: start the bench
// right after the api so its run falls inside the loop.
import { mkdirSync, writeFileSync } from 'node:fs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const url = arg('url', 'http://127.0.0.1:8800')
const slug = arg('slug', 'stall')
const seconds = Number(arg('seconds', 120))
const workers = Number(arg('workers', 4))
const contacts = Number(arg('contacts', 10000))
const retireEvery = Number(arg('retire-every', 20))
const think = Number(arg('think', 0))
const out = arg('out')
if (!out) throw new Error('--out <dir> is required')
mkdirSync(out, { recursive: true })

const t0 = performance.now()
const now = () => performance.now() - t0

function serverTiming(header) {
  const t = {}
  for (const part of (header ?? '').split(',')) {
    const m = part.trim().match(/^(\w+);dur=([\d.]+)$/)
    if (m) t[m[1]] = Number(m[2])
  }
  return t
}

let cookie = ''
async function call(method, path, body) {
  const start = now()
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const ms = now() - start
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, start, ms, timing: serverTiming(res.headers.get('server-timing')), json, res }
}
async function must(method, path, body) {
  const r = await call(method, path, body)
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`)
  return r
}

// ── setup ───────────────────────────────────────────────────────────────
const email = `${slug}@example.com`
const login = await call('POST', '/api/dev/login', { email })
if (login.status !== 200) throw new Error(`login: ${login.status}`)
cookie = login.res.headers.get('set-cookie').split(';')[0]
const t = `/api/t/${slug}`
const made = await call('POST', '/api/dev/tenants', { slug, name: 'Stall bench' })
if (made.status >= 300 && made.status !== 409) {
  throw new Error(`tenant: ${made.status} ${JSON.stringify(made.json)}`)
}

const ids = []
for (let cursor = null; ; ) {
  const qs = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })
  const page = (await must('GET', `${t}/contacts?${qs}`)).json
  ids.push(...page.rows.map((r) => r.id))
  if (page.isDone) break
  cursor = page.nextCursor
}
if (ids.length < contacts) {
  let left = contacts - ids.length
  while (left > 0) {
    const count = Math.min(left, 10000)
    await must('POST', '/api/dev/qc-crowd', { slug, lastName: `Crowd${Date.now()}`, count })
    left -= count
  }
  ids.length = 0
  for (let cursor = null; ; ) {
    const qs = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })
    const page = (await must('GET', `${t}/contacts?${qs}`)).json
    ids.push(...page.rows.map((r) => r.id))
    if (page.isDone) break
    cursor = page.nextCursor
  }
}
console.error(`org ${slug}: ${ids.length} contacts`)

// ── background: field retires ───────────────────────────────────────────
const events = []
const mark = (what) => events.push({ t: now(), what })

/** A field with one option set on every contact, then retired: the
 * retire job rewrites every contact in batches of 500 (one transaction
 * each, back to back). */
async function retireCycle(n) {
  const f = await must('POST', `${t}/fields`, {
    label: `Stall ${n} ${Date.now()}`,
    appliesTo: ['individual', 'organization', 'household'],
    isActive: true,
  })
  const fieldId = f.json.id
  const o = await must('POST', `${t}/fields/options`, {
    fieldId,
    label: 'yes',
    position: 0,
    isActive: true,
  })
  mark(`bulk-set start ${n}`)
  for (let i = 0; i < ids.length; i += 1000) {
    await must('POST', `${t}/contacts/bulk-set-field`, {
      contactIds: ids.slice(i, i + 1000),
      fieldId,
      optionId: o.json.id,
    })
  }
  mark(`bulk-set end ${n}`)
  mark(`retire start ${n}`)
  await must('POST', `${t}/fields/${fieldId}/retire`)
  // The retire runs after the response: wait for it to finish.
  for (;;) {
    const list = (await must('GET', `${t}/fields`)).json
    const all = Array.isArray(list) ? list : (list.fields ?? [])
    if (!all.some((x) => x.id === fieldId)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  mark(`retire end ${n}`)
}

// ── the loop ────────────────────────────────────────────────────────────
const samples = []
const deadline = now() + seconds * 1000
let stop = false

async function writer(w) {
  const mine = []
  let i = 0
  while (!stop && now() < deadline) {
    if (think && i) await new Promise((r) => setTimeout(r, think))
    i++
    if (i % 2 === 1 || mine.length === 0) {
      const r = await call('POST', `${t}/contacts`, {
        kind: 'individual',
        title: '',
        firstName: `W${w}`,
        lastName: `Loop${i}`,
        nickname: '',
        name: '',
        isDeceased: false,
      })
      samples.push({ op: 'create', w, start: r.start, ms: r.ms, status: r.status, ...r.timing })
      if (r.status === 200) mine.push({ id: r.json.id, counter: 0 })
    } else {
      const c = mine[i % mine.length]
      const r = await call('POST', `${t}/contacts/${c.id}/save`, {
        details: {
          expected: c.counter,
          kind: 'individual',
          title: '',
          firstName: `W${w}`,
          lastName: `Saved${i}`,
          nickname: '',
          name: '',
          isDeceased: false,
        },
      })
      samples.push({ op: 'save', w, start: r.start, ms: r.ms, status: r.status, ...r.timing })
      if (r.status === 200) c.counter = r.json.counters.details
    }
  }
}

const background = (async () => {
  for (let n = 1; !stop && now() < deadline; n++) {
    await retireCycle(n)
    const wait = deadline - now()
    if (wait <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(retireEvery * 1000, wait)))
  }
})()

mark('loop start')
await Promise.all(Array.from({ length: workers }, (_, w) => writer(w)))
stop = true
mark('loop end')
await background

// ── report ──────────────────────────────────────────────────────────────
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN
}
const summary = {}
for (const op of ['create', 'save']) {
  const xs = samples.filter((s) => s.op === op && s.status === 200)
  summary[op] = {
    n: xs.length,
    errors: samples.filter((s) => s.op === op && s.status !== 200).length,
  }
  for (const k of ['total', 'db', 'platform']) {
    const v = xs.map((s) => s[k])
    summary[op][k] = {
      p50: pct(v, 50),
      p99: pct(v, 99),
      p999: pct(v, 99.9),
      max: Math.max(...v),
      over50: v.filter((x) => x > 50).length,
      over150: v.filter((x) => x > 150).length,
    }
  }
}
const during = (s) =>
  events
    .filter((e) => e.t <= s.start + s.ms)
    .map((e) => e.what)
    .at(-1)
const tail = [...samples]
  .sort((a, b) => b.total - a.total)
  .slice(0, 25)
  .map((s) => ({ ...s, after: during(s) }))
writeFileSync(`${out}/raw.json`, JSON.stringify({ samples, events }, null, 1))
writeFileSync(`${out}/summary.json`, JSON.stringify({ summary, tail }, null, 1))
console.log(JSON.stringify(summary, null, 1))
console.log('slowest:')
for (const s of tail.slice(0, 15)) {
  console.log(
    `${(s.start / 1000).toFixed(2)}s ${s.op} total=${s.total} db=${s.db} platform=${s.platform} client=${s.ms.toFixed(1)} after="${s.after}"`,
  )
}
