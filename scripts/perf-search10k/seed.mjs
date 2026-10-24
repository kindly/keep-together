#!/usr/bin/env node
// Seed a tenant with realistic contacts through the public create path
// (contacts/mutations:create, then saveForm for methods, addresses and the
// dropdown field, then setArchived), as a signed-in admin, `--workers`
// calls in flight. Re-runnable: a create already done comes back as a
// `duplicate` (by clientKey) and its follow-up saves are no-ops.
//
//   node scripts/perf-search10k/seed.mjs --url <deployment url> \
//     --email <admin> --password <pw> --tenant <tenantId> \
//     --count 10000 [--seed 1] [--prefix perf] [--workers 16]
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { people } from './data.mjs'

const api = anyApi
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const url = arg('url')
const email = arg('email')
const password = arg('password')
const tenantId = arg('tenant')
const count = Number(arg('count', 10000))
const seed = Number(arg('seed', 1))
const prefix = arg('prefix', 'perf')
const workers = Number(arg('workers', 16))

async function signIn() {
  const c = new ConvexHttpClient(url)
  const { tokens } = await c.action(api.auth.signIn, {
    provider: 'password',
    params: { email, password, flow: 'signIn' },
  })
  if (!tokens) throw new Error(`no session for ${email}`)
  return tokens.token
}

const token = await signIn()
const client = () => {
  const c = new ConvexHttpClient(url)
  c.setAuth(token)
  return c
}
const c0 = client()
const fields = await c0.query(api.contacts.fields.list, { tenantId })
const field = fields.find((f) => f.isActive && f.options?.length)
const options = field ? field.options.filter((o) => o.isActive) : []
const versions = (await c0.query(api.sources.queries.tree, { tenantId }))
  .filter((p) => p.level === 'version' && p.visible)
  .map((p) => p._id)
console.log(
  `field: ${field?.label ?? 'none'} (${options.length} options); ${versions.length} code versions`,
)

const all = people(count, seed)
let next = 0
let done = 0
let failed = 0
const started = Date.now()

async function one(c, p, i) {
  const clientKey = `${prefix}-${seed}-${i}`
  const code =
    p.code !== null && versions.length
      ? versions[p.code % versions.length]
      : undefined
  let id
  try {
    id = await c.mutation(api.contacts.mutations.create, {
      tenantId,
      ...p.details,
      clientKey,
      ...(code ? { acquisitionCodeId: code } : {}),
    })
  } catch (e) {
    const d = e.data
    if (d?.kind === 'rejected' && d.reason === 'duplicate') id = d.message
    else throw e
  }
  const values =
    p.option !== null && field && options[p.option]
      ? [{ fieldId: field._id, optionId: options[p.option]._id }]
      : []
  if (
    p.emails.length ||
    p.phones.length ||
    p.addresses.length ||
    values.length
  ) {
    await c.mutation(api.contacts.mutations.saveForm, {
      tenantId,
      id,
      methods: { expected: 0, emails: p.emails, phones: p.phones },
      addresses: { expected: 0, addresses: p.addresses },
      fields: { expected: 0, values },
    })
  }
  if (p.archived) {
    await c
      .mutation(api.contacts.mutations.setArchived, {
        tenantId,
        id,
        expected: 0,
        archived: true,
      })
      .catch((e) => {
        if (e.data?.kind !== 'stale') throw e
      })
  }
}

async function worker() {
  const c = client()
  for (;;) {
    const i = next++
    if (i >= all.length) return
    for (let attempt = 0; ; attempt++) {
      try {
        await one(c, all[i], i)
        break
      } catch (e) {
        if (attempt >= 12) {
          failed++
          console.error(
            `#${i}: ${e.message?.slice(0, 300)} ${JSON.stringify(e.data ?? '')}`,
          )
          break
        }
        await new Promise((r) =>
          setTimeout(r, 200 + Math.random() * 400 * (attempt + 1)),
        )
      }
    }
    if (++done % 500 === 0) {
      const s = (Date.now() - started) / 1000
      console.log(`${done}/${all.length} in ${s.toFixed(0)} s`)
    }
  }
}

await Promise.all(Array.from({ length: workers }, worker))
console.log(
  `done: ${done}, failed: ${failed}, ${((Date.now() - started) / 1000).toFixed(0)} s`,
)
