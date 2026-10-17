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
    externalIdentifier: '',
  })

/** The tenant's seeded "Member" tag. */
const memberTag = async (who: Tenant) =>
  (
    await who.as.query(api.contacts.queries.tags, { tenantId: who.tenantId })
  ).find((t) => t.name === 'Member')!._id

const saveTags = (
  who: Tenant,
  id: Id<'contacts'>,
  expected: number,
  tagId: Id<'tags'>,
) =>
  who.as.mutation(api.contacts.mutations.saveTags, {
    tenantId: who.tenantId,
    id,
    expected,
    tags: [{ tagId }],
  })

/** Contacts never tagged lose `tagsVersion`, as if created before S3. */
const unbackfill = () =>
  f.t.run(async (ctx) => {
    for (const c of await ctx.db.query('contacts').collect()) {
      if (c.tagsVersion === 0) {
        await ctx.db.patch('contacts', c._id, { tagsVersion: undefined })
      }
    }
  })

const versions = () =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('contacts').collect()).map(
      ({ _id, tenantId, tagsVersion }) => ({ _id, tenantId, tagsVersion }),
    ),
  )

const backfill = (opts: { batchSize?: number; cursor?: null } = {}) =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.contacts.migrations.backfillTagsVersion,
      opts,
    ),
  )

describe('backfillTagsVersion', () => {
  test('sets 0 on every tenant’s untagged contacts, in batches, and nothing else', async () => {
    const a1 = await createContact(f.a, 'Lovelace')
    const a2 = await createContact(f.a, 'Babbage')
    const b1 = await createContact(f.b, 'Herschel')
    const b2 = await createContact(f.b, 'Somerville')
    const tagA = await memberTag(f.a)
    const tagB = await memberTag(f.b)
    await saveTags(f.a, a2, 0, tagA)
    await saveTags(f.b, b2, 0, tagB)
    await unbackfill()
    const before = await versions()
    expect(before.filter((c) => c.tagsVersion === undefined)).toHaveLength(2)

    const status = await backfill({ batchSize: 1 })
    expect(status.isDone).toBe(true)
    expect(status.processed).toBe(4)

    expect(await versions()).toEqual(
      before.map((c) => ({ ...c, tagsVersion: c.tagsVersion ?? 0 })),
    )
    // Tags work on the backfilled contacts, each in its own tenant.
    await saveTags(f.a, a1, 0, tagA)
    await saveTags(f.b, b1, 0, tagB)
    const tagsOf = (who: Tenant, id: Id<'contacts'>) =>
      who.as
        .query(api.contacts.queries.get, { tenantId: who.tenantId, id })
        .then((c) => c?.tags.map((t) => t.tagId))
    expect(await tagsOf(f.a, a1)).toEqual([tagA])
    expect(await tagsOf(f.b, b1)).toEqual([tagB])
    expect(await tagsOf(f.a, a2)).toEqual([tagA])
  })

  test('a rerun from the start changes nothing', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    await unbackfill()
    await backfill()
    const done = await versions()
    const status = await backfill({ cursor: null })
    expect(status.isDone).toBe(true)
    expect(await versions()).toEqual(done)
  })
})
