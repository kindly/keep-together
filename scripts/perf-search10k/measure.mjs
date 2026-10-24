#!/usr/bin/env node
// Time contacts/queries:search and :list on a seeded rehearsal slot
// (factory task perf/search-10k). Calls run one at a time; each is made
// distinct (search text padded with whitespace the handler trims, list
// `paginationOpts.id`), so Convex never answers from its query cache.
// Server time per call comes from the slot's `convex logs --jsonl`
// stream, joined to the calls by order per function; client time minus
// the median round trip of a cached no-op query is kept as a cross-check.
//
//   node scripts/perf-search10k/measure.mjs --slot 1 --url <url> \
//     --email <A admin> --emailB <B admin> --password <pw> \
//     --tenant <A> --tenantB <B> --out <dir> [--reps 20]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { people } from './data.mjs'

const api = anyApi
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const slot = arg('slot', '1')
const url = arg('url')
const password = arg('password')
const tenantId = arg('tenant')
const tenantB = arg('tenantB')
const reps = Number(arg('reps', 20))
const out = arg('out')
mkdirSync(out, { recursive: true })

const root = path.resolve(import.meta.dirname, '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── log stream ──────────────────────────────────────────────────────────
const events = []
const logs = spawn(
  'node',
  ['scripts/rehearsal.mjs', 'run', slot, '--', 'logs', '--success', '--jsonl'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
let buf = ''
let watching = false
const onData = (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.includes('Watching logs')) watching = true
    if (!line.startsWith('{')) continue
    try {
      const ev = JSON.parse(line)
      if (ev.kind === 'Completion') events.push(ev)
    } catch {
      // not an event
    }
  }
}
logs.stdout.on('data', onData)
logs.stderr.on('data', onData)
for (let i = 0; i < 300 && !watching; i++) await sleep(100)
if (!watching) throw new Error('log stream never started')
// Let the stream replay whatever it shows first, then mark the start.
await sleep(3000)
const startedAt = Date.now() / 1000

// ── clients ─────────────────────────────────────────────────────────────
async function signedIn(email) {
  const c = new ConvexHttpClient(url)
  const { tokens } = await c.action(api.auth.signIn, {
    provider: 'password',
    params: { email, password, flow: 'signIn' },
  })
  c.setAuth(tokens.token)
  return c
}
const a = await signedIn(arg('email'))
const b = await signedIn(arg('emailB'))

// ── test values, from the seeded people ─────────────────────────────────
const all = people(10000, 1)
const fullName = (p) => `${p.details.firstName} ${p.details.lastName}`
const byName = new Map()
const bySurname = new Map()
for (const p of all) {
  if (p.details.kind !== 'individual') continue
  byName.set(fullName(p), (byName.get(fullName(p)) ?? 0) + 1)
  bySurname.set(
    p.details.lastName,
    (bySurname.get(p.details.lastName) ?? 0) + 1,
  )
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
  (p, i) =>
    i > 3000 && !p.archived && p.addresses[0]?.postcode.startsWith('LS6 '),
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
const fields = await a.query(api.contacts.fields.list, { tenantId })
const field = fields.find((f) => f.isActive && f.options?.length)
const tree = await a.query(api.sources.queries.tree, { tenantId })
const street = tree.find(
  (p) =>
    p.level === 'detail' &&
    tree.find((q) => q._id === p.parentId)?.name === 'Street',
)
const version = tree.find(
  (p) => p.level === 'version' && p.parentId === street._id,
)

// ── calls ───────────────────────────────────────────────────────────────
const calls = []
let listId = 1
let rtts = []

async function timed(c, fn, args) {
  const t0 = performance.now()
  const result = await c.query(fn, args)
  return { ms: performance.now() - t0, result }
}

// Cached no-op: after its first call the server answers from cache, so
// the round trip is the network, not the function.
async function measureRtt(n = 15) {
  await a.query(api.platform.qcProbe.rtt, {})
  for (let i = 0; i < n; i++) {
    rtts.push((await timed(a, api.platform.qcProbe.rtt, {})).ms)
  }
}

// Whitespace the handler trims, distinct per (salt, i): 5 × 5 × salt.
const pad = (text, i, salt) =>
  `${' '.repeat(i % 5)}${'\t'.repeat(salt)}${text}${' '.repeat(Math.floor(i / 5) % 5)}${'\t'.repeat(Math.floor(i / 25))}`

async function searchCase(label, text, extra = {}, salt = 0, group = 'search') {
  for (let i = 0; i < reps; i++) {
    const { ms, result } = await timed(a, api.contacts.queries.search, {
      tenantId,
      search: pad(text, i, salt),
      ...extra,
    })
    calls.push({
      group,
      label,
      fn: 'contacts/queries:search',
      clientMs: ms,
      rows: result.rows.length,
      checked: result.checked,
      truncated: result.truncated,
    })
  }
}

async function listCase(label, extra = {}, cursor = null, group = 'list') {
  let last
  for (let i = 0; i < reps; i++) {
    const { ms, result } = await timed(a, api.contacts.queries.list, {
      tenantId,
      ...extra,
      paginationOpts: { numItems: 100, cursor, id: listId++ },
    })
    last = result
    calls.push({
      group,
      label,
      fn: 'contacts/queries:list',
      clientMs: ms,
      rows: result.page.length,
      isDone: result.isDone,
    })
  }
  return last
}

// Warm the isolates (not counted).
for (let i = 0; i < 3; i++) {
  await a.query(api.contacts.queries.search, { tenantId, search: `warm${i}` })
  await a.query(api.contacts.queries.list, {
    tenantId,
    paginationOpts: { numItems: 100, cursor: null, id: 900000 + i },
  })
}
await sleep(3000)
// Server clock vs ours: events after this are the timed calls.
const warmEnd = Date.now() / 1000 - 1.5
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
  fields: [{ fieldId: field._id, optionId: field.options[0]._id }],
})
await listCase(`field ${field.label} not set`, {
  fields: [{ fieldId: field._id, optionId: null }],
})
await listCase(`source detail Street/${street.name}`, {
  source: { level: 'detail', id: street._id },
})
await listCase(`source version ${version.name}`, {
  source: { level: 'version', id: version._id },
})
await listCase('source detail + kind organization', {
  source: { level: 'detail', id: street._id },
  kind: 'organization',
})
await listCase('with archived', { includeArchived: true })
let cursor = first.continueCursor
for (let page = 2; page <= 5; page++) {
  const r = await listCase(`load more page ${page}`, {}, cursor, 'load more')
  cursor = r.continueCursor
}
await measureRtt()

for (let salt = 1; salt <= 2; salt++) {
  for (const k of ['s', 'sm', 'smi', 'smit', 'smith']) {
    await searchCase(
      `keystroke "${k}"`,
      k,
      {},
      salt,
      `keystrokes ${salt === 1 ? 'smith' : 'smith (2nd pass)'}`,
    )
  }
}
for (const k of ['j', 'jo', 'joh', 'john']) {
  await searchCase(`keystroke "${k}"`, k, {}, 3, 'keystrokes john')
}
for (const k of ['l', 'ls', 'ls6']) {
  await searchCase(`keystroke "${k}"`, k, {}, 3, 'keystrokes ls6')
}
await measureRtt()

// ── isolation ───────────────────────────────────────────────────────────
const iso = {}
const aSmith = await a.query(api.contacts.queries.search, {
  tenantId,
  search: 'smith  iso',
})
const bSmith = await b.query(api.contacts.queries.search, {
  tenantId: tenantB,
  search: 'smith',
})
const aIds = new Set(
  (
    await a.query(api.contacts.queries.search, { tenantId, search: 'smith' })
  ).rows.map((r) => r._id),
)
iso.bSmithRows = bSmith.rows.length
iso.overlap = bSmith.rows.filter((r) => aIds.has(r._id)).length
iso.bGmail = (
  await b.query(api.contacts.queries.search, {
    tenantId: tenantB,
    search: 'gmail',
  })
).rows.length
iso.bListAll = (
  await b.query(api.contacts.queries.list, {
    tenantId: tenantB,
    includeArchived: true,
    paginationOpts: { numItems: 100, cursor: null },
  })
).page.length
try {
  await b.query(api.contacts.queries.search, { tenantId, search: 'smith' })
  iso.crossTenant = 'ALLOWED (bad)'
} catch (e) {
  iso.crossTenant = `refused: ${JSON.stringify(e.data ?? e.message).slice(0, 80)}`
}
void aSmith

// ── join with server events ─────────────────────────────────────────────
await sleep(8000)
logs.kill()
const mine = events.filter(
  (e) =>
    e.timestamp >= warmEnd &&
    e.caller === 'HttpApi' &&
    (e.identifier === 'contacts/queries:search' ||
      e.identifier === 'contacts/queries:list'),
)
// Isolation calls at the end: 5 after the timed ones (b's cross-tenant
// call fails, and failures aren't in --success).
const byFn = {}
for (const e of mine) (byFn[e.identifier] ??= []).push(e)
const used = {}
for (const c of calls) {
  const i = (used[c.fn] = (used[c.fn] ?? -1) + 1)
  const e = byFn[c.fn]?.[i]
  if (e) {
    c.serverMs = e.executionTime * 1000
    c.cached = e.cachedResult
    c.readDocs = e.usageStats?.databaseReadDocuments
    c.readBytes = e.usageStats?.databaseReadBytes
    c.textBytes = e.usageStats?.textIndexQueryBytes
  }
}
const rtt = rtts.sort((x, y) => x - y)[Math.floor(rtts.length / 2)]
writeFileSync(
  path.join(out, 'raw.json'),
  JSON.stringify(
    {
      startedAt,
      rtt,
      rtts,
      iso,
      counts: Object.fromEntries(
        Object.entries(byFn).map(([k, v]) => [k, v.length]),
      ),
      calls,
    },
    null,
    1,
  ),
)
console.log(
  'rtt median',
  rtt.toFixed(1),
  'ms; events',
  Object.fromEntries(Object.entries(byFn).map(([k, v]) => [k, v.length])),
  'calls',
  calls.length,
)
console.log('isolation', iso)
process.exit(0)
