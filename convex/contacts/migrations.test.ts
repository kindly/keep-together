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
  fn: typeof internal.contacts.migrations.backfillContactSearch,
  opts: { batchSize?: number; cursor?: null } = {},
) => f.t.run((ctx) => runToCompletion(ctx, components.migrations, fn, opts))

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
