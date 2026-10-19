import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import { api, components, internal } from '../_generated/api'
import { setup } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
})

const createContact = (who: Tenant, lastName: string) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    kind: 'individual',
    title: '',
    firstName: 'Ada',
    lastName,
    nickname: '',
    name: '',
    isDeceased: false,
  })

const run = (
  fn:
    | typeof internal.contacts.migrations.backfillAcquisitionVersion
    | typeof internal.contacts.migrations.backfillContactSearch,
  opts: { batchSize?: number; cursor?: null } = {},
) => f.t.run((ctx) => runToCompletion(ctx, components.migrations, fn, opts))

describe('backfillAcquisitionVersion', () => {
  /** Contacts lose `acquisitionVersion`, as if created before step 1. */
  const unbackfill = () =>
    f.t.run(async (ctx) => {
      for (const c of await ctx.db.query('contacts').collect()) {
        await ctx.db.patch('contacts', c._id, { acquisitionVersion: undefined })
      }
    })

  const contacts = () => f.t.run((ctx) => ctx.db.query('contacts').collect())

  test('a new contact is created with 0', async () => {
    await createContact(f.a, 'Lovelace')
    expect((await contacts()).map((c) => c.acquisitionVersion)).toEqual([0])
  })

  test('sets 0 on every tenant’s contacts, in batches, and nothing else', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.a, 'Babbage')
    await createContact(f.b, 'Herschel')
    await unbackfill()
    const before = await contacts()
    expect(before.every((c) => c.acquisitionVersion === undefined)).toBe(true)
    expect(new Set(before.map((c) => c.tenantId)).size).toBe(2)

    const status = await run(
      internal.contacts.migrations.backfillAcquisitionVersion,
      { batchSize: 1 },
    )
    expect(status.isDone).toBe(true)
    expect(status.processed).toBe(3)
    expect(await contacts()).toEqual(
      before.map((c) => ({ ...c, acquisitionVersion: 0 })),
    )
  })

  test('a rerun from the start changes nothing', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    await unbackfill()
    await run(internal.contacts.migrations.backfillAcquisitionVersion)
    const done = await contacts()
    const status = await run(
      internal.contacts.migrations.backfillAcquisitionVersion,
      { cursor: null },
    )
    expect(status.isDone).toBe(true)
    expect(await contacts()).toEqual(done)
  })
})

describe('backfillContactSearch fills contactSearch.sortName', () => {
  const rows = () => f.t.run((ctx) => ctx.db.query('contactSearch').collect())

  test('projected rows carry sortName; old rows get it from the backfill, per tenant, and a rerun is a no-op', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    expect((await rows()).map((r) => r.sortName).sort()).toEqual([
      'Herschel, Ada',
      'Lovelace, Ada',
    ])

    // As projected before step 1: no sortName.
    await f.t.run(async (ctx) => {
      for (const r of await ctx.db.query('contactSearch').collect()) {
        await ctx.db.patch('contactSearch', r._id, { sortName: undefined })
      }
    })
    await run(internal.contacts.migrations.backfillContactSearch)
    const done = await rows()
    expect(
      done
        .map((r) => [r.tenantId, r.sortName])
        .sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
    ).toEqual([
      [f.b.tenantId, 'Herschel, Ada'],
      [f.a.tenantId, 'Lovelace, Ada'],
    ])
    await run(internal.contacts.migrations.backfillContactSearch, {
      cursor: null,
    })
    expect(await rows()).toEqual(done)
  })
})
