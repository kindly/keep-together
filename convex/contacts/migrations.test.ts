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
    | typeof internal.contacts.migrations.backfillContactSearch
    | typeof internal.contacts.migrations.backfillContactTagName,
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

describe('backfillContactTagName copies the tag name onto its links', () => {
  const links = () => f.t.run((ctx) => ctx.db.query('contactTags').collect())
  const tagNamed = async (who: Tenant, name: string) =>
    (
      await who.as.query(api.contacts.queries.tags, { tenantId: who.tenantId })
    ).find((t) => t.name === name)!._id

  test('unnamed links get their tag’s name, per tenant; named ones and a rerun are no-ops', async () => {
    const tag = async (who: Tenant, lastName: string, name: string) =>
      who.as.mutation(api.contacts.mutations.saveTags, {
        tenantId: who.tenantId,
        id: await createContact(who, lastName),
        expected: 0,
        tags: [{ tagId: await tagNamed(who, name) }],
      })
    await tag(f.a, 'Lovelace', 'Member')
    await tag(f.a, 'Byron', 'Volunteer')
    await tag(f.b, 'Herschel', 'Member')
    const want = await links()

    // As written before step A: no name; and one already named (a
    // sentinel, to show the backfill leaves named rows alone).
    await f.t.run(async (ctx) => {
      for (const r of want) {
        await ctx.db.patch('contactTags', r._id, {
          name: r === want[1] ? 'Kept' : undefined,
        })
      }
    })
    await run(internal.contacts.migrations.backfillContactTagName, {
      batchSize: 2,
    })
    const done = await links()
    expect(done.map((r) => [r.tenantId, r.name])).toEqual([
      [want[0].tenantId, want[0].name],
      [want[1].tenantId, 'Kept'],
      [f.b.tenantId, 'Member'],
    ])
    await run(internal.contacts.migrations.backfillContactTagName, {
      cursor: null,
    })
    expect(await links()).toEqual(done)
  })
})
