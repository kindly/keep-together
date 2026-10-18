import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import type { Id } from '../_generated/dataModel'
import { api, components, internal } from '../_generated/api'
import { setup } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
})

const createWithEmail = async (who: Tenant, key: string, address: string) => {
  const id = await who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    kind: 'individual',
    title: '',
    firstName: 'Ada',
    lastName: key,
    nickname: '',
    name: '',
    isDeceased: false,
  })
  await who.as.mutation(api.contacts.mutations.saveMethods, {
    tenantId: who.tenantId,
    id,
    expected: 0,
    emails: [{ key, label: 'home', address, isPrimary: true }],
    phones: [],
  })
  return id
}

/** Rows as before E2a: `onHold` stored on every row. */
const setStoredHold = (keys: Record<string, boolean>) =>
  f.t.run(async (ctx) => {
    for (const row of await ctx.db.query('contactEmails').collect()) {
      if (row.key in keys) {
        await ctx.db.patch('contactEmails', row._id, { onHold: keys[row.key] })
      }
    }
  })

const storedHolds = () =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('contactEmails').collect()).map((r) => 'onHold' in r),
  )

const backfill = (opts: { batchSize?: number; cursor?: null } = {}) =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.contacts.migrations.backfillEmailHolds,
      opts,
    ),
  )

const held = (who: Tenant, addresses: Array<string>) =>
  who.as.query(api.comms.suppressions.held, {
    tenantId: who.tenantId,
    addresses,
  })

describe('backfillEmailHolds', () => {
  test('a stored hold becomes a suppression of its address, in its tenant; every row loses the field', async () => {
    await createWithEmail(f.a, 'a1', 'Held@Example.com')
    await createWithEmail(f.a, 'a2', 'free@example.com')
    await createWithEmail(f.b, 'b1', 'held@example.com')
    await createWithEmail(f.b, 'b2', 'other@example.com')
    await setStoredHold({ a1: true, a2: false, b2: true })

    const status = await backfill({ batchSize: 1 })
    expect(status.isDone).toBe(true)
    expect(status.processed).toBe(4)
    expect(await storedHolds()).toEqual([false, false, false, false])
    expect(
      Object.keys(await held(f.a, ['held@example.com', 'free@example.com'])),
    ).toEqual(['held@example.com'])
    // b1 shares a1's address, but the hold was tenant A's.
    expect(
      Object.keys(await held(f.b, ['held@example.com', 'other@example.com'])),
    ).toEqual(['other@example.com'])
    const [suppression] = await f.t.run((ctx) =>
      ctx.db.query('emailSuppressions').collect(),
    )
    expect(suppression).toMatchObject({
      reason: 'bounce',
      note: 'carried over from the email row (E2a)',
    })
  })

  test('a rerun from the start changes nothing', async () => {
    const id: Id<'contacts'> = await createWithEmail(f.a, 'a1', 'x@example.com')
    await setStoredHold({ a1: true })
    await backfill()
    const snapshot = () =>
      f.t.run(async (ctx) => ({
        emails: await ctx.db.query('contactEmails').collect(),
        suppressions: await ctx.db.query('emailSuppressions').collect(),
        revisions: await ctx.db.query('revisions').collect(),
      }))
    const done = await snapshot()
    const status = await backfill({ cursor: null })
    expect(status.isDone).toBe(true)
    expect(await snapshot()).toEqual(done)
    expect(id).toBeDefined()
  })
})
