import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import type { Id } from '../_generated/dataModel'
import { api, components, internal } from '../_generated/api'
import { setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
})

/** A contact with these email addresses, saved through the contracts. */
async function contactWith(tenant: Tenant, addresses: Array<string>) {
  const id = await tenant.as.mutation(api.contacts.mutations.create, {
    tenantId: tenant.tenantId,
    kind: 'individual',
    title: '',
    firstName: 'Ada',
    lastName: 'Lovelace',
    nickname: '',
    name: '',
    isDeceased: false,
    externalIdentifier: '',
  })
  await tenant.as.mutation(api.contacts.mutations.saveMethods, {
    tenantId: tenant.tenantId,
    id,
    expected: 0,
    emails: addresses.map((address, i) => ({
      label: 'home' as const,
      address,
      isPrimary: i === 0,
    })),
    phones: [],
  })
  return id
}

/** Put a tenant's email rows back in their pre-S1 shape. */
async function unbackfill(tenantId: Id<'tenants'>) {
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query('contactEmails').collect()) {
      if (row.tenantId === tenantId) {
        await ctx.db.patch('contactEmails', row._id, {
          addressNormalized: undefined,
        })
      }
    }
  })
}

const emailRows = (tenantId: Id<'tenants'>) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('contactEmails').collect()).filter(
      (r) => r.tenantId === tenantId,
    ),
  )

const backfill = (opts: { batchSize?: number; cursor?: null } = {}) =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.contacts.migrations.backfillAddressNormalized,
      opts,
    ),
  )

const findByEmail = (tenant: Tenant, address: string) =>
  f.t.query(internal.contacts.queries.findByEmail, {
    tenantId: tenant.tenantId,
    address,
  })

describe('backfillAddressNormalized', () => {
  test('fills missing rows in every tenant, in batches', async () => {
    await contactWith(f.a, [' Ann@Example.COM ', 'ann.work@x.org', 'c@x.org'])
    await contactWith(f.b, ['Bob@Example.com', 'BOB@home.net'])
    await unbackfill(f.a.tenantId)
    await unbackfill(f.b.tenantId)
    const before = [
      ...(await emailRows(f.a.tenantId)),
      ...(await emailRows(f.b.tenantId)),
    ]
    expect(before.every((r) => r.addressNormalized === undefined)).toBe(true)

    const status = await backfill({ batchSize: 2 })
    expect(status.isDone).toBe(true)
    expect(status.processed).toBe(5)

    const after = [
      ...(await emailRows(f.a.tenantId)),
      ...(await emailRows(f.b.tenantId)),
    ]
    expect(after.map((r) => r.addressNormalized).sort()).toEqual([
      'ann.work@x.org',
      'ann@example.com',
      'bob@example.com',
      'bob@home.net',
      'c@x.org',
    ])
    // Only addressNormalized changed.
    const strip = (rows: typeof before) =>
      rows.map(({ addressNormalized: _, ...rest }) => rest)
    expect(strip(after)).toEqual(strip(before))
  })

  test('backfilled rows are found by email, each in its own tenant', async () => {
    const annA = await contactWith(f.a, ['Ann@Example.com'])
    const annB = await contactWith(f.b, ['ann@example.com '])
    await unbackfill(f.a.tenantId)
    await unbackfill(f.b.tenantId)
    expect((await findByEmail(f.a, 'ann@example.com')).contacts).toEqual([])

    await backfill()

    const inA = await findByEmail(f.a, 'ANN@example.com')
    const inB = await findByEmail(f.b, 'ANN@example.com')
    expect(inA.contacts.map((c) => c._id)).toEqual([annA])
    expect(inB.contacts.map((c) => c._id)).toEqual([annB])
  })

  test('leaves rows that already have it untouched', async () => {
    await contactWith(f.a, ['Ann@Example.com'])
    await contactWith(f.b, ['Bob@Example.com'])
    await unbackfill(f.a.tenantId)
    const bBefore = await snapshot(f.t, f.b.tenantId)

    await backfill()
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bBefore)

    // Running it again from the start changes nothing anywhere.
    const aBackfilled = await snapshot(f.t, f.a.tenantId)
    const status = await backfill({ cursor: null })
    expect(status.isDone).toBe(true)
    expect(await snapshot(f.t, f.a.tenantId)).toBe(aBackfilled)
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bBefore)
  })
})
