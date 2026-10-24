#!/usr/bin/env node
// The perf-search10k cases (scripts/perf-search10k/measure.mjs) against the
// Rust spike's API, so the numbers line up with
// factory/out/tester-search10k-report.md. One call at a time, 20 reps a
// case after 3 warm-ups. Server time per call is `total` from the
// response's Server-Timing header (`db` and `platform` are kept too);
// client time is wall time around fetch. Search cases run on both FTS
// variants (`fts=words` and `fts=trigram`). Source-code cases are skipped:
// source codes aren't in the spike.
//
//   KEEP_DATA_DIR=rs/data KEEP_DEV_AUTH=1 rs/target/release/api &
//   node scripts/perf-search10k-rs/measure.mjs --url http://127.0.0.1:8787 \
//     --slug perf-a --email perf-a@example.com \
//     --slugB perf-b --emailB perf-b@example.com --out <dir> [--reps 20]
//   node scripts/perf-search10k-rs/analyze.mjs <dir>/raw.json [--rtt 30]
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { people } from '../perf-search10k/data.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const url = arg('url', 'http://127.0.0.1:8787')
const slug = arg('slug', 'perf-a')
const slugB = arg('slugB', 'perf-b')
const reps = Number(arg('reps', 20))
const out = arg('out')
mkdirSync(out, { recursive: true })

// ── clients ─────────────────────────────────────────────────────────────
async function login(email) {
  const res = await fetch(`${url}/api/dev/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`)
  return res.headers.get('set-cookie').split(';')[0]
}
const cookieA = await login(arg('email', 'perf-a@example.com'))
const cookieB = await login(arg('emailB', 'perf-b@example.com'))

/** `platform;dur=0.1, db;dur=2.3, total;dur=2.9` → { platform, db, total } */
function serverTiming(header) {
  const out = {}
  for (const part of (header ?? '').split(',')) {
    const m = part.trim().match(/^(\w+);dur=([\d.]+)$/)
    if (m) out[m[1]] = Number(m[2])
  }
  return out
}

async function get(cookie, path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
  )
  const t0 = performance.now()
  const res = await fetch(`${url}${path}?${qs}`, { headers: { cookie } })
  const body = await res.json()
  const ms = performance.now() - t0
  return { status: res.status, ms, timing: serverTiming(res.headers.get('server-timing')), body }
}

// ── test values, from the seeded people (as the Convex script) ──────────
const all = people(10000, 1)
const fullName = (p) => `${p.details.firstName} ${p.details.lastName}`
const bySurname = new Map()
for (const p of all) {
  if (p.details.kind !== 'individual') continue
  bySurname.set(p.details.lastName, (bySurname.get(p.details.lastName) ?? 0) + 1)
}
const rare = all.find(
  (p, i) =>
    i > 4000 &&
    !p.archived &&
    p.details.kind === 'individual' &&
    bySurname.get(p.details.lastName) === 1,
)
const withEmail = all.find((p, i) => i > 6000 && !p.archived && p.emails.length)
const withPhone = all.find(
  (p, i) => i > 7000 && !p.archived && p.phones[0]?.number.startsWith('07'),
)
const ls6 = all.find(
  (p, i) => i > 3000 && !p.archived && p.addresses[0]?.postcode.startsWith('LS6 '),
)
const phoneDigits = withPhone.phones[0].number.replace(/\D/g, '')
function checkDigit(sequence) {
  const digits = String(sequence)
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}
const seq = 15123
const written = `${seq}${checkDigit(seq)}`

// ── reference data ──────────────────────────────────────────────────────
const fields = (await get(cookieA, `/api/t/${slug}/fields`)).body
const field = fields.find((f) => f.isActive && f.options?.length)

// ── calls ───────────────────────────────────────────────────────────────
const calls = []
const rtts = []

// The network share of a call: client time minus server total, on a
// near-free call (`GET /api/me`).
async function measureRtt(n = 15) {
  for (let i = 0; i < n; i++) {
    const r = await get(cookieA, '/api/me')
    rtts.push(r.ms - (r.timing.total ?? 0))
  }
}

function record(group, label, fn, r, extra) {
  if (r.status !== 200) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`)
  calls.push({
    group,
    label,
    fn,
    clientMs: r.ms,
    serverMs: r.timing.total,
    dbMs: r.timing.db,
    platformMs: r.timing.platform,
    ...extra,
  })
}

async function searchCase(label, text, extra = {}, group = 'search') {
  for (const fts of ['words', 'trigram']) {
    for (let i = 0; i < reps; i++) {
      const r = await get(cookieA, `/api/t/${slug}/contacts/search`, { q: text, fts, ...extra })
      record(`${group} (${fts})`, label, 'contacts/search', r, {
        rows: r.body.rows.length,
        checked: r.body.checked,
        truncated: r.body.truncated,
      })
    }
  }
}

async function listCase(label, extra = {}, cursor = null, group = 'list') {
  let last
  for (let i = 0; i < reps; i++) {
    const r = await get(cookieA, `/api/t/${slug}/contacts`, { ...extra, cursor })
    record(group, label, 'contacts/list', r, {
      rows: r.body.rows.length,
      isDone: r.body.isDone,
    })
    last = r.body
  }
  return last
}

// Warm up (not counted).
for (let i = 0; i < 3; i++) {
  await get(cookieA, `/api/t/${slug}/contacts/search`, { q: `warm${i}` })
  await get(cookieA, `/api/t/${slug}/contacts/search`, { q: `warm${i}`, fts: 'trigram' })
  await get(cookieA, `/api/t/${slug}/contacts`)
}
await measureRtt()

console.log('values:', {
  rare: fullName(rare),
  email: withEmail.emails[0].address,
  postcode: ls6.addresses[0].postcode,
  phone: withPhone.phones[0].number,
  written,
})

await searchCase('rare full name', fullName(rare))
await searchCase('rare surname only', rare.details.lastName)
await searchCase('smith', 'smith')
await searchCase('smi (prefix)', 'smi')
await searchCase('jones', 'jones')
await searchCase('john smith', 'john smith')
await searchCase('full email', withEmail.emails[0].address)
await searchCase('email domain gmail', 'gmail')
await searchCase('email domain gmail.com', 'gmail.com')
await searchCase('postcode area LS6', 'LS6')
await searchCase('full postcode', ls6.addresses[0].postcode)
await searchCase('contact number (written)', written)
await searchCase('full phone', withPhone.phones[0].number)
await searchCase('phone tail (6)', phoneDigits.slice(-6))
await searchCase('no match', 'zzqx')
await searchCase('smith + archived', 'smith', { includeArchived: true })
await searchCase('smith + kind individual', 'smith', { kind: 'individual' })
await measureRtt()

const first = await listCase('first page plain')
await listCase('kind organization', { kind: 'organization' })
await listCase('kind individual', { kind: 'individual' })
await listCase(`field ${field.label}=${field.options[0].label}`, {
  fields: `${field.id}:${field.options[0].id}`,
})
await listCase(`field ${field.label} not set`, { fields: `${field.id}:none` })
await listCase('with archived', { includeArchived: true })
let cursor = first.nextCursor
for (let page = 2; page <= 5; page++) {
  const r = await listCase(`load more page ${page}`, {}, cursor, 'load more')
  cursor = r.nextCursor
}
// Filtered pages 2–5 as well: a filter that can't use the sort index.
let fcursor = (
  await get(cookieA, `/api/t/${slug}/contacts`, { fields: `${field.id}:${field.options[0].id}` })
).body.nextCursor
for (let page = 2; page <= 5 && fcursor; page++) {
  const r = await listCase(
    `field=${field.options[0].label} page ${page}`,
    { fields: `${field.id}:${field.options[0].id}` },
    fcursor,
    'load more (field filter)',
  )
  fcursor = r.nextCursor
}
await measureRtt()

for (const [salt, keys] of [
  [1, ['s', 'sm', 'smi', 'smit', 'smith']],
  [2, ['s', 'sm', 'smi', 'smit', 'smith']],
  [3, ['j', 'jo', 'joh', 'john']],
  [3, ['l', 'ls', 'ls6']],
]) {
  const word = keys.at(-1)
  const group = `keystrokes ${word}${salt === 2 ? ' (2nd pass)' : ''}`
  for (const k of keys) await searchCase(`keystroke "${k}"`, k, {}, group)
}
await measureRtt()

// ── isolation ───────────────────────────────────────────────────────────
const iso = {}
const aIds = new Set(
  (await get(cookieA, `/api/t/${slug}/contacts/search`, { q: 'smith' })).body.rows.map((r) => r.id),
)
const bSmith = (await get(cookieB, `/api/t/${slugB}/contacts/search`, { q: 'smith' })).body
iso.bSmithRows = bSmith.rows.length
iso.overlap = bSmith.rows.filter((r) => aIds.has(r.id)).length
iso.bGmail = (await get(cookieB, `/api/t/${slugB}/contacts/search`, { q: 'gmail' })).body.rows.length
iso.bListAll = (
  await get(cookieB, `/api/t/${slugB}/contacts`, { includeArchived: true })
).body.rows.length
const cross = await get(cookieB, `/api/t/${slug}/contacts/search`, { q: 'smith' })
iso.crossTenant =
  cross.status === 200 ? 'ALLOWED (bad)' : `refused: ${cross.status} ${JSON.stringify(cross.body)}`

const rtt = [...rtts].sort((x, y) => x - y)[Math.floor(rtts.length / 2)]
writeFileSync(
  path.join(out, 'raw.json'),
  JSON.stringify({ url, rtt, rtts, iso, calls }, null, 1),
)
console.log(`rtt median ${rtt.toFixed(2)} ms; calls ${calls.length}`)
console.log('isolation', iso)
