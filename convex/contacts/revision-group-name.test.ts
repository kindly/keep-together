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

const individual = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
}

/** A contact with one grouped form save (two revisions) and one ungrouped. */
async function contactWithHistory(who: Tenant): Promise<Id<'contacts'>> {
  const id = await who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...individual,
  })
  await who.as.mutation(api.contacts.mutations.saveForm, {
    tenantId: who.tenantId,
    id,
    details: { expected: 0, ...individual, nickname: 'Countess' },
    methods: {
      expected: 0,
      emails: [{ label: 'home', address: 'a@x.com', isPrimary: true }],
      phones: [],
    },
  })
  await who.as.mutation(api.contacts.mutations.saveDetails, {
    tenantId: who.tenantId,
    id,
    expected: 1,
    ...individual,
  })
  return id
}

/** Every revision as written before `executeContract` stamped names. */
const unstamp = () =>
  f.t.run(async (ctx) => {
    for (const r of await ctx.db.query('revisions').collect()) {
      if (r.groupName !== undefined) {
        await ctx.db.patch('revisions', r._id, { groupName: undefined })
      }
    }
  })

const stamps = () =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('revisions').collect()).map(
      ({ _id, tenantId, group, groupName }) => ({
        _id,
        tenantId,
        group,
        groupName,
      }),
    ),
  )

const backfill = (opts: { batchSize?: number } = {}) =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.contacts.migrations.backfillRevisionGroupName,
      opts,
    ),
  )

describe('backfillRevisionGroupName', () => {
  test('stamps every tenant’s grouped revisions with their group’s name, in batches, and nothing else', async () => {
    await contactWithHistory(f.a)
    await contactWithHistory(f.b)
    const stamped = await stamps()
    await unstamp()
    expect((await stamps()).every((r) => r.groupName === undefined)).toBe(true)

    const status = await backfill({ batchSize: 2 })
    expect(status.isDone).toBe(true)

    // Back to exactly what executeContract writes today: grouped rows carry
    // their group's name (each in its own tenant), ungrouped rows nothing.
    expect(await stamps()).toEqual(stamped)
    const grouped = stamped.filter((r) => r.group !== undefined)
    expect(new Set(grouped.map((r) => r.tenantId)).size).toBe(2)
    expect(grouped.every((r) => typeof r.groupName === 'string')).toBe(true)
    expect(stamped.some((r) => r.group === undefined)).toBe(true)
    expect(
      stamped
        .filter((r) => r.group === undefined)
        .every((r) => r.groupName === undefined),
    ).toBe(true)
  })

  test('running it again changes nothing', async () => {
    await contactWithHistory(f.a)
    await unstamp()
    await backfill()
    const once = await stamps()
    await f.t.run((ctx) =>
      runToCompletion(
        ctx,
        components.migrations,
        internal.contacts.migrations.backfillRevisionGroupName,
        { cursor: null },
      ),
    )
    expect(await stamps()).toEqual(once)
  })
})
