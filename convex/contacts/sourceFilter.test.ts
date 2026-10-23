import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { setup } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'

// The contacts list's source filter (source codes plan, step 5, g3q4): by
// category, detail or version, with and without search text.

type Fixture = Awaited<ReturnType<typeof setup>>
type Level = 'category' | 'detail' | 'version'

let f: Fixture
let street: { category: Id<'sourceCodes'>; detail: Id<'sourceCodes'> }
let wesser1: Id<'sourceCodes'>
let wesser2: Id<'sourceCodes'>
let online: { category: Id<'sourceCodes'>; version: Id<'sourceCodes'> }
let ada: Id<'contacts'>
let bob: Id<'contacts'>
let cara: Id<'contacts'>
let dan: Id<'contacts'>
let bStreet: Id<'sourceCodes'>
let bContact: Id<'contacts'>

/** The seeded category `name` in `who`'s tenant. */
const category = (who: Tenant, name: string) =>
  f.t.run(async (ctx) => {
    const row = await ctx.db
      .query('sourceCodes')
      .withIndex('by_tenant_parent', (q) =>
        q
          .eq('tenantId', who.tenantId)
          .eq('parentId', undefined)
          .eq('nameNormalized', name.toLowerCase()),
      )
      .unique()
    return row!._id
  })

/** A detail under `parentId`, with its version `001`. */
const detail = (who: Tenant, parentId: Id<'sourceCodes'>, name: string) =>
  who.as.mutation(api.sources.mutations.create, {
    tenantId: who.tenantId,
    parentId,
    name,
    isActive: true,
  }) as Promise<{ id: Id<'sourceCodes'>; versionId: Id<'sourceCodes'> }>

async function person(
  who: Tenant,
  firstName: string,
  lastName: string,
  codeId?: Id<'sourceCodes'>,
  email?: string,
): Promise<Id<'contacts'>> {
  const id = await who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    kind: 'individual',
    title: '',
    firstName,
    lastName,
    nickname: '',
    name: '',
    isDeceased: false,
    ...(codeId && { acquisitionCodeId: codeId }),
  })
  if (email) {
    await who.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: who.tenantId,
      id,
      expected: 0,
      emails: [{ label: 'home', address: email, isPrimary: true }],
      phones: [],
    })
  }
  return id
}

const list = (
  source: { level: Level; id: Id<'sourceCodes'> } | undefined,
  extra: {
    search?: string
    includeArchived?: boolean
    kind?: 'individual' | 'organization'
  } = {},
  who: Tenant = f.a,
) =>
  who.as.query(api.contacts.queries.search, {
    tenantId: who.tenantId,
    ...(source && { source }),
    ...extra,
  })

const ids = async (result: ReturnType<typeof list>) =>
  (await result).rows.map((r) => r._id)

beforeEach(async () => {
  f = await setup()
  const streetId = await category(f.a, 'Street')
  const wesser = await detail(f.a, streetId, 'Wesser')
  street = { category: streetId, detail: wesser.id }
  wesser1 = wesser.versionId
  wesser2 = (
    await f.a.as.mutation(api.sources.mutations.create, {
      tenantId: f.a.tenantId,
      parentId: wesser.id,
      name: '002',
      isActive: true,
    })
  ).id
  const onlineId = await category(f.a, 'Online')
  online = {
    category: onlineId,
    version: (await detail(f.a, onlineId, 'Website')).versionId,
  }
  // Names chosen so name order differs from creation order.
  bob = await person(f.a, 'Bob', 'Zebra', wesser2)
  ada = await person(f.a, 'Ada', 'Lovelace', wesser1, 'ada@example.com')
  cara = await person(f.a, 'Cara', 'Lovelace', online.version)
  dan = await person(f.a, 'Dan', 'Lovelace')
  bStreet = await category(f.b, 'Street')
  bContact = await person(
    f.b,
    'Ada',
    'Lovelace',
    (await detail(f.b, bStreet, 'Wesser')).versionId,
  )
})

describe('without search text', () => {
  test('category, detail and version, each in name order', async () => {
    expect(await ids(list({ level: 'category', id: street.category }))).toEqual(
      [ada, bob],
    )
    expect(await ids(list({ level: 'detail', id: street.detail }))).toEqual([
      ada,
      bob,
    ])
    expect(await ids(list({ level: 'version', id: wesser2 }))).toEqual([bob])
    expect(await ids(list({ level: 'category', id: online.category }))).toEqual(
      [cara],
    )
    // Unfiltered still lists everyone, coded or not.
    expect(await ids(list(undefined))).toEqual(
      expect.arrayContaining([ada, bob, cara, dan]),
    )
  })

  test('with kind and archived filters', async () => {
    const archive = await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: bob,
      expected: 0,
      archived: true,
    })
    expect(archive.counter).toBe(1)
    const byStreet = { level: 'category', id: street.category } as const
    expect(await ids(list(byStreet))).toEqual([ada])
    expect(await ids(list(byStreet, { includeArchived: true }))).toEqual([
      ada,
      bob,
    ])
    expect(await ids(list(byStreet, { kind: 'organization' }))).toEqual([])
  })

  test('a contact keeps matching once its code is archived', async () => {
    await f.a.as.mutation(api.sources.mutations.save, {
      tenantId: f.a.tenantId,
      id: street.detail,
      expected: 0,
      name: 'Wesser',
      isActive: false,
    })
    expect(await ids(list({ level: 'detail', id: street.detail }))).toEqual([
      ada,
      bob,
    ])
  })

  test('a code changed or cleared moves the contact between filters', async () => {
    await f.a.as.mutation(api.contacts.mutations.setAcquisition, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 1,
      codeId: online.version,
    })
    expect(await ids(list({ level: 'category', id: street.category }))).toEqual(
      [bob],
    )
    expect(await ids(list({ level: 'version', id: online.version }))).toEqual([
      ada,
      cara,
    ])
    await f.a.as.mutation(api.contacts.mutations.setAcquisition, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 2,
      codeId: null,
    })
    expect(await ids(list({ level: 'category', id: online.category }))).toEqual(
      [cara],
    )
  })
})

describe('with search text', () => {
  test('the filter narrows the full-text hits', async () => {
    const search = 'lovelace'
    expect(await ids(list(undefined, { search }))).toHaveLength(3)
    expect(
      await ids(list({ level: 'category', id: street.category }, { search })),
    ).toEqual([ada])
    expect(
      await ids(list({ level: 'version', id: online.version }, { search })),
    ).toEqual([cara])
    expect(
      await ids(list({ level: 'version', id: wesser2 }, { search })),
    ).toEqual([])
  })

  test('an exact email match obeys the filter at every level', async () => {
    const search = 'ada@example.com'
    for (const source of [
      { level: 'category', id: street.category },
      { level: 'detail', id: street.detail },
      { level: 'version', id: wesser1 },
    ] as const) {
      expect(await ids(list(source, { search }))).toEqual([ada])
    }
    expect(
      await ids(list({ level: 'category', id: online.category }, { search })),
    ).toEqual([])
    expect(
      await ids(list({ level: 'version', id: wesser2 }, { search })),
    ).toEqual([])
  })
})

describe('tenancy', () => {
  test("another tenant's code finds nothing, either way", async () => {
    const theirs = { level: 'category', id: bStreet } as const
    expect(await ids(list(theirs))).toEqual([])
    expect(await ids(list(theirs, { search: 'lovelace' }))).toEqual([])
    expect(
      await ids(list({ level: 'category', id: street.category }, {}, f.b)),
    ).toEqual([])
    expect(await ids(list(theirs, {}, f.b))).toEqual([bContact])
  })
})

describe('filter options', () => {
  test('every part, archived too, with only what the selects show; per tenant', async () => {
    await f.a.as.mutation(api.sources.mutations.save, {
      tenantId: f.a.tenantId,
      id: street.detail,
      expected: 0,
      name: 'Wesser',
      isActive: false,
    })
    const options = await f.a.as.query(api.sources.queries.filterOptions, {
      tenantId: f.a.tenantId,
    })
    const wesser = options.find((o) => o._id === street.detail)
    expect(wesser).toEqual({
      _id: street.detail,
      level: 'detail',
      parentId: street.category,
      name: 'Wesser',
      isActive: false,
    })
    expect(
      options.filter((o) => o.parentId === street.detail).map((o) => o.name),
    ).toEqual(['001', '002'])
    const theirs = await f.b.as.query(api.sources.queries.filterOptions, {
      tenantId: f.b.tenantId,
    })
    const ours = new Set(options.map((o) => o._id))
    expect(theirs.some((o) => ours.has(o._id))).toBe(false)
  })
})
