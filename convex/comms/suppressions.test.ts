/**
 * Email suppression per address (E2a, reworked after review F1–F4): a hold
 * belongs to the address in the tenant, so no contact edit or restore can
 * lose it, and every contact using the address shows it.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api, internal } from '../_generated/api'
import { scopeWriter } from '../lib/tenancy'
import type { Role } from '../lib/tenancy'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { executeContract } from '../lib/contracts'
import { suppression } from './contracts'
import { suppressAddress } from './suppressions'

type Fixture = Awaited<ReturnType<typeof setup>>

const person = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
})
const email = (key: string, address: string) => ({
  key,
  label: 'home' as const,
  address,
  isPrimary: false,
})
const BOUNCED = 'lovelace@example.com'

let f: Fixture
let ada: Id<'contacts'>

const create = (who: Tenant, lastName = 'Lovelace') =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...person(lastName),
  })

const saveMethods = (
  expected: number,
  emails: Array<ReturnType<typeof email>>,
  id: Id<'contacts'> = ada,
  who: Tenant = f.a,
) =>
  who.as.mutation(api.contacts.mutations.saveMethods, {
    tenantId: who.tenantId,
    id,
    expected,
    emails,
    phones: [],
  })

const suppress = (address: string, who: Tenant = f.a) =>
  f.t.mutation(internal.comms.suppressions.suppress, {
    tenantId: who.tenantId,
    address,
    eventRef: 'ses-event-1',
  })

const release = (
  as: Tenant['as'],
  expected: number,
  address = BOUNCED,
  who: Tenant = f.a,
) =>
  as.mutation(api.comms.suppressions.release, {
    tenantId: who.tenantId,
    address,
    expected,
    note: ' bounced by mistake ',
  })

/** What the contact page shows: each email row (by key) held or not. */
const heldOf = async (id: Id<'contacts'> = ada, who: Tenant = f.a) => {
  const view = await who.as.query(api.contacts.queries.get, {
    tenantId: who.tenantId,
    id,
  })
  const held = await who.as.query(api.comms.suppressions.held, {
    tenantId: who.tenantId,
    addresses: view!.emails.map((e) => e.address),
  })
  return Object.fromEntries(
    view!.emails.map((e) => [e.key, e.address.toLowerCase() in held]),
  )
}

const suppressionRows = (who: Tenant = f.a) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('emailSuppressions').collect()).filter(
      (r) => r.tenantId === who.tenantId,
    ),
  )

const revisionsOf = (entity: string) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('revisions').collect()).filter(
      (r) => r.entity === entity,
    ),
  )

/** A user holding `role` in `who`'s tenant, as a caller. */
async function member(who: Tenant, role: Role) {
  const userId = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: `${role}@example.com` })
    await ctx.db.insert('memberships', {
      tenantId: who.tenantId,
      userId: id,
      role,
    })
    return id
  })
  return f.t.withIdentity({ subject: `${userId}|session-${role}` })
}

beforeEach(async () => {
  f = await setup()
  ada = await create(f.a)
  await saveMethods(0, [
    email('e1', 'ada@example.com'),
    email('e2', 'Lovelace@Example.com'),
  ])
})

describe('suppress', () => {
  test('suppresses the address in its tenant, with a comms revision', async () => {
    const bBefore = await snapshot(f.t, f.b.tenantId)
    expect(await suppress(' LOVELACE@example.com')).toEqual({
      changed: true,
      counter: 0,
    })
    expect(await heldOf()).toEqual({ e1: false, e2: true })
    const [row] = await suppressionRows()
    expect(row).toMatchObject({
      addressNormalized: BOUNCED,
      suppressed: true,
      reason: 'bounce',
      eventRef: 'ses-event-1',
      saveVersion: 0,
    })
    const [revision] = await revisionsOf('emailSuppressions')
    expect(revision).toMatchObject({
      contract: 'comms.suppression',
      entityId: row._id,
      source: 'comms',
    })
    expect(revision.actor).toBeUndefined()
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bBefore)
  })

  test('a second event changes nothing and keeps the first one’s time', async () => {
    await suppress(BOUNCED)
    const [first] = await suppressionRows()
    expect(await suppress(BOUNCED)).toEqual({ changed: false, counter: 0 })
    expect(await suppressionRows()).toEqual([first])
    expect(await revisionsOf('emailSuppressions')).toHaveLength(1)
  })

  test('the contact itself is untouched: no counter, no revision, no history moment', async () => {
    const before = await f.t.run((ctx) => ctx.db.get('contacts', ada))
    const contactRevisions = (await revisionsOf('contacts')).length
    await suppress(BOUNCED)
    expect(await f.t.run((ctx) => ctx.db.get('contacts', ada))).toEqual(before)
    expect(await revisionsOf('contacts')).toHaveLength(contactRevisions)
    const history = await f.a.as.query(api.contacts.queries.history, {
      tenantId: f.a.tenantId,
      id: ada,
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(history.page.map((m) => m.source)).not.toContain('comms')
  })

  // Review R1 (ADR 0021, rule 5): a complaint never blocks transactional
  // mail, so it is no suppression; a bounce is.
  test('a complaint doesn’t suppress; a bounce does', async () => {
    await expect(
      f.t.mutation(internal.comms.suppressions.suppress, {
        tenantId: f.a.tenantId,
        address: BOUNCED,
        reason: 'complaint',
      } as never),
    ).rejects.toThrow()
    // Nor through the contract: not a storable reason.
    await expect(
      f.t.run((ctx) =>
        executeContract(
          { db: scopeWriter(ctx, f.a.tenantId), userId: null, role: null },
          suppression,
          {
            addressNormalized: BOUNCED,
            suppressed: true,
            reason: 'complaint' as never,
          },
          { source: 'comms' },
        ),
      ),
    ).rejects.toThrow(/reason/)
    expect(await suppressionRows()).toEqual([])
    expect(await heldOf()).toEqual({ e1: false, e2: false })

    await suppress(BOUNCED)
    expect(await heldOf()).toEqual({ e1: false, e2: true })
  })

  test('refuses a caller with a role (only the system suppresses)', async () => {
    for (const role of ['admin', 'staff', 'viewer'] as const) {
      const data = await errorData(
        f.t.run((ctx) =>
          suppressAddress(
            { db: scopeWriter(ctx, f.a.tenantId), userId: f.a.userId, role },
            { address: BOUNCED },
          ),
        ),
      )
      expect(data).toMatchObject({ kind: 'rejected', reason: 'system_only' })
    }
    expect(await suppressionRows()).toEqual([])
  })
})

// Review F1: each of these lost the hold when it lived on the email row.
describe('a hold belongs to the address', () => {
  beforeEach(async () => {
    await suppress(BOUNCED)
  })

  test('restoring a methods revision that brings the row back', async () => {
    const [withBoth] = (await revisionsOf('contacts')).filter(
      (r) => r.contract === 'contacts.methods',
    )
    await saveMethods(1, [email('e1', 'ada@example.com')])
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: withBoth._id,
    })
    expect(await heldOf()).toEqual({ e1: false, e2: true })
  })

  test('restoring the contact to before the row was removed', async () => {
    const [withBoth] = (await revisionsOf('contacts')).filter(
      (r) => r.contract === 'contacts.methods',
    )
    await saveMethods(1, [email('e1', 'ada@example.com')])
    const suppressions = await suppressionRows()
    const result = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: withBoth._creationTime,
    })
    expect(result.restored).toEqual(['contacts.methods'])
    expect(await heldOf()).toEqual({ e1: false, e2: true })
    expect(await suppressionRows()).toEqual(suppressions)
  })

  test('removing the row and adding the same key back', async () => {
    await saveMethods(1, [email('e1', 'ada@example.com')])
    await saveMethods(2, [
      email('e1', 'ada@example.com'),
      email('e2', 'lovelace@example.com'),
    ])
    expect(await heldOf()).toEqual({ e1: false, e2: true })
  })

  test('the same address under a new key, in one save', async () => {
    await saveMethods(1, [
      email('e1', 'ada@example.com'),
      email('e9', 'LOVELACE@example.com'),
    ])
    expect(await heldOf()).toEqual({ e1: false, e9: true })
  })

  test('another contact using the address, in this tenant only', async () => {
    const carol = await create(f.a, 'Carol')
    await saveMethods(0, [email('c1', 'lovelace@example.com')], carol)
    expect(await heldOf(carol)).toEqual({ c1: true })

    const bob = await create(f.b, 'Bob')
    await saveMethods(0, [email('b1', 'lovelace@example.com')], bob, f.b)
    expect(await heldOf(bob, f.b)).toEqual({ b1: false })
  })
})

describe('release', () => {
  beforeEach(async () => {
    await suppress(BOUNCED)
  })

  test('an admin lifts it, logged with who and why, and the provider is told', async () => {
    expect(await release(f.a.as, 0, 'Lovelace@Example.com')).toMatchObject({
      counter: 1,
    })
    expect(await heldOf()).toEqual({ e1: false, e2: false })
    const [row] = await suppressionRows()
    expect(row).toMatchObject({
      suppressed: false,
      reason: 'release',
      note: 'bounced by mistake',
      saveVersion: 1,
    })
    const revisions = await revisionsOf('emailSuppressions')
    expect(revisions.at(-1)).toMatchObject({
      counter: 1,
      source: 'ui',
      actor: f.a.userId,
      payload: { suppressed: false, note: 'bounced by mistake' },
    })
    const scheduled = await f.t.run((ctx) =>
      ctx.db.system.query('_scheduled_functions').collect(),
    )
    expect(scheduled.map((s) => [s.name, s.args[0]])).toContainEqual([
      'comms/suppressions:releaseAtProvider',
      { address: BOUNCED, tenantId: f.a.tenantId },
    ])
  })

  test('a later bounce holds it again', async () => {
    await release(f.a.as, 0)
    expect(await suppress(BOUNCED)).toEqual({ changed: true, counter: 2 })
    expect(await heldOf()).toEqual({ e1: false, e2: true })
  })

  test('stale, not held, and another tenant’s address are refused', async () => {
    expect(await errorData(release(f.a.as, 5))).toMatchObject({
      kind: 'stale',
      current: 0,
    })
    expect(
      await errorData(release(f.a.as, 0, 'ada@example.com')),
    ).toMatchObject({ kind: 'rejected', reason: 'not_held' })
    // Tenant B's admin: the address isn't held in B.
    expect(await errorData(release(f.b.as, 0, BOUNCED, f.b))).toMatchObject({
      kind: 'rejected',
      reason: 'not_held',
    })
    expect(await heldOf()).toEqual({ e1: false, e2: true })
  })

  test.each<Role>(['staff', 'viewer'])('%s may not release', async (role) => {
    const as = await member(f.a, role)
    expect(await errorData(release(as, 0))).toMatchObject({
      kind: 'forbidden',
    })
    expect(await heldOf()).toEqual({ e1: false, e2: true })
  })
})

// Review F2: the role-null writer, and the contract under it, are
// reachable only from trusted modules.
const callersOf = (pattern: RegExp) =>
  Object.entries(
    import.meta.glob<string>('../**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )
    .filter(
      ([file]) => !file.includes('/_generated/') && !file.endsWith('.test.ts'),
    )
    .filter(([, text]) => pattern.test(text))
    .map(([file]) => file)
    .sort()

test('only comms and the backfill call the system writer', () => {
  expect(
    callersOf(/suppressAddress\b|comms\.suppressions\.suppress\b/),
  ).toEqual(['../contacts/migrations.ts', './suppressions.ts'])
})

test('only comms/suppressions runs the suppression contract', () => {
  // `executeContract(ctx, suppression, …)`; the registry names it without
  // a comma.
  expect(callersOf(/\bsuppression,/)).toEqual(['./suppressions.ts'])
})
