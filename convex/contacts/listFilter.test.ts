import { beforeEach, describe, expect, test } from 'vitest'
import type { Doc, Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { setup } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { LIST_LIMIT, LIST_SCAN_CAP } from './queries'

// A filtered contacts list never says "none" while matching contacts
// exist: the window or page must not fill with rows the filter then hides.
// Each case puts more hidden contacts first in name order than the old
// window read (2 × LIST_LIMIT), then a few that show.

type Fixture = Awaited<ReturnType<typeof setup>>
type Kind = Doc<'contacts'>['kind']

let f: Fixture
let member: Id<'tags'>
let code: {
  category: Id<'sourceCodes'>
  detail: Id<'sourceCodes'>
  version: Id<'sourceCodes'>
}

/** More than the old window, so a post-filter would show nothing. */
const HIDDEN = 2 * LIST_LIMIT + 50

/**
 * `n` contacts written straight to the tables (a contract per contact
 * would make these tests slow): the root, its `contactSearch` row and an
 * optional tag. Names are `${prefix} ${i}`, so a prefix sets name order.
 */
async function bulk(
  who: Tenant,
  n: number,
  prefix: string,
  opts: {
    archived?: boolean
    kind?: Kind
    tagId?: Id<'tags'>
    source?: typeof code
  } = {},
): Promise<Array<Id<'contacts'>>> {
  return f.t.run(async (ctx) => {
    const ids: Array<Id<'contacts'>> = []
    for (let i = 0; i < n; i++) {
      const sortName = `${prefix} ${String(i).padStart(4, '0')}`
      const kind = opts.kind ?? 'individual'
      const archived = opts.archived ?? false
      const contactId = await ctx.db.insert('contacts', {
        tenantId: who.tenantId,
        kind,
        title: '',
        firstName: '',
        lastName: sortName,
        nickname: '',
        name: '',
        isDeceased: false,
        displayName: sortName,
        sortName,
        archived,
        detailsVersion: 0,
        methodsVersion: 0,
        addressesVersion: 0,
        archiveVersion: 0,
        tagsVersion: 0,
        identifiersVersion: 0,
        acquisitionVersion: 0,
        ...(opts.source && { acquisitionCodeId: opts.source.version }),
      })
      await ctx.db.insert('contactSearch', {
        tenantId: who.tenantId,
        contactId,
        text: sortName.toLowerCase(),
        archived,
        kind,
        phones: [],
        sortName,
        ...(opts.source && {
          acquisitionCodeId: opts.source.version,
          acquisitionDetailId: opts.source.detail,
          acquisitionCategoryId: opts.source.category,
        }),
      })
      if (opts.tagId) {
        await ctx.db.insert('contactTags', {
          tenantId: who.tenantId,
          contactId,
          key: `${prefix}-${i}`,
          tagId: opts.tagId,
          name: 'Member',
        })
      }
      ids.push(contactId)
    }
    return ids
  })
}

const list = (
  args: {
    search?: string
    includeArchived?: boolean
    kind?: Kind
    tagId?: Id<'tags'>
    source?: { level: 'category' | 'detail' | 'version'; id: Id<'sourceCodes'> }
  },
  who: Tenant = f.a,
) =>
  who.as.query(api.contacts.queries.search, { tenantId: who.tenantId, ...args })

const ids = async (...a: Parameters<typeof list>) =>
  (await list(...a)).rows.map((r) => r._id)

beforeEach(async () => {
  f = await setup()
  const tags = await f.a.as.query(api.contacts.queries.tags, {
    tenantId: f.a.tenantId,
  })
  member = tags.find((t) => t.name === 'Member')!._id
  const category = await f.t.run(
    async (ctx) =>
      (await ctx.db
        .query('sourceCodes')
        .withIndex('by_tenant_parent', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('parentId', undefined)
            .eq('nameNormalized', 'street'),
        )
        .unique())!._id,
  )
  const made = (await f.a.as.mutation(api.sources.mutations.create, {
    tenantId: f.a.tenantId,
    parentId: category,
    name: 'Wesser',
    isActive: true,
  })) as { id: Id<'sourceCodes'>; versionId: Id<'sourceCodes'> }
  code = { category, detail: made.id, version: made.versionId }
})

describe('archived contacts first in name order, "show archived" off', () => {
  test('no other filter: the live ones show', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { archived: true })
    const live = await bulk(f.a, 3, 'Zed')
    expect(await list({})).toMatchObject({ truncated: false, tooBroad: false })
    expect(await ids({})).toEqual(live)
    // Shown when asked, a page's worth.
    const all = await list({ includeArchived: true })
    expect(all.rows).toHaveLength(LIST_LIMIT)
    expect(all.truncated).toBe(true)
  })

  test('with a kind', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { archived: true, kind: 'organization' })
    await bulk(f.a, HIDDEN, 'Bbb', { kind: 'individual' })
    const orgs = await bulk(f.a, 2, 'Zed', { kind: 'organization' })
    expect(await ids({ kind: 'organization' })).toEqual(orgs)
  })

  test('with a source, at every level, with and without a kind', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { archived: true, source: code })
    await bulk(f.a, HIDDEN, 'Bbb', { kind: 'household', source: code })
    const live = await bulk(f.a, 2, 'Zed', { source: code })
    for (const level of ['category', 'detail', 'version'] as const) {
      const source = { level, id: code[level] }
      expect(await ids({ source, kind: 'individual' })).toEqual(live)
      const sourced = await list({ source })
      expect(sourced.rows).toHaveLength(LIST_LIMIT)
      expect(sourced.rows.every((r) => !r.archived)).toBe(true)
    }
  })

  test('with a tag', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { archived: true, tagId: member })
    const live = await bulk(f.a, 2, 'Zed', { tagId: member })
    expect(await list({ tagId: member })).toMatchObject({
      truncated: false,
      tooBroad: false,
    })
    expect(await ids({ tagId: member })).toEqual(live)
  })
})

describe('a filter the index cannot hold reads on to a cap', () => {
  test('a tag under a source: untagged contacts first', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { source: code })
    const tagged = await bulk(f.a, 1, 'Zed', { source: code, tagId: member })
    expect(
      await ids({
        source: { level: 'version', id: code.version },
        tagId: member,
      }),
    ).toEqual(tagged)
  })

  test('past the cap it says it looked, never "none"', async () => {
    await bulk(f.a, LIST_SCAN_CAP, 'Aaa', { archived: true, tagId: member })
    await bulk(f.a, 1, 'Zed', { tagId: member })
    const result = await list({ tagId: member })
    expect(result).toMatchObject({
      rows: [],
      truncated: true,
      tooBroad: true,
      checked: LIST_SCAN_CAP,
    })
  })

  test('a search whose full window has no tagged contact is too broad', async () => {
    await bulk(f.a, 2 * LIST_LIMIT, 'Haddad')
    expect(await list({ search: 'haddad', tagId: member })).toMatchObject({
      rows: [],
      tooBroad: true,
    })
    // A window that isn't full and has no match does mean none.
    await bulk(f.a, 3, 'Osei')
    expect(await list({ search: 'osei', tagId: member })).toMatchObject({
      rows: [],
      tooBroad: false,
    })
  })
})

describe('tenancy', () => {
  test("B's list never shows A's contacts and A's never hide B's", async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { tagId: member, source: code })
    await bulk(f.b, HIDDEN, 'Aaa', { archived: true })
    const inB = await bulk(f.b, 2, 'Zed')
    expect(await ids({}, f.b)).toEqual(inB)
    expect(await ids({ tagId: member }, f.b)).toEqual([])
    expect(
      await ids({ source: { level: 'version', id: code.version } }, f.b),
    ).toEqual([])
    expect((await ids({}, f.a)).some((id) => inB.includes(id))).toBe(false)
  })
})

/** Every page of `list`, `numItems` at a time, until `isDone`. */
async function pages(
  args: {
    includeArchived?: boolean
    kind?: Kind
    source?: { level: 'category' | 'detail' | 'version'; id: Id<'sourceCodes'> }
  },
  who: Tenant = f.a,
  numItems = LIST_LIMIT,
) {
  const out: Array<Array<Id<'contacts'>>> = []
  let cursor: string | null = null
  for (;;) {
    const page: {
      page: Array<{ _id: Id<'contacts'> }>
      isDone: boolean
      continueCursor: string
    } = await who.as.query(api.contacts.queries.list, {
      tenantId: who.tenantId,
      ...args,
      paginationOpts: { numItems, cursor },
    })
    out.push(page.page.map((r) => r._id))
    if (page.isDone) return out
    cursor = page.continueCursor
  }
}

describe('the paged list (browsing)', () => {
  test('archived first in name order: the first page is the live ones, and the end', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { archived: true })
    const live = await bulk(f.a, 3, 'Zed')
    expect(await pages({})).toEqual([live])
  })

  test('pages are full, contiguous and in name order, archived included when asked', async () => {
    const archived = await bulk(f.a, HIDDEN, 'Aaa', { archived: true })
    const live = await bulk(f.a, 3, 'Zed')
    const got = await pages({ includeArchived: true })
    expect(got.slice(0, -1).every((p) => p.length === LIST_LIMIT)).toBe(true)
    expect(got.flat()).toEqual([...archived, ...live])
  })

  test('a page never asks for more than LIST_LIMIT rows', async () => {
    await bulk(f.a, LIST_LIMIT + 5, 'Aaa')
    const first = await f.a.as.query(api.contacts.queries.list, {
      tenantId: f.a.tenantId,
      paginationOpts: { numItems: 10 * LIST_LIMIT, cursor: null },
    })
    expect(first.page).toHaveLength(LIST_LIMIT)
    expect(first.isDone).toBe(false)
  })

  test('kind and archived sit in the range: full pages of one kind', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { kind: 'organization' })
    await bulk(f.a, HIDDEN, 'Bbb', { archived: true, kind: 'household' })
    const homes = await bulk(f.a, 2, 'Zed', { kind: 'household' })
    expect(await pages({ kind: 'household' })).toEqual([homes])
  })

  test('a source filter, archived in the range, at every level', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { archived: true, source: code })
    const live = await bulk(f.a, 2, 'Zed', { source: code })
    await bulk(f.a, 2, 'Zzz')
    for (const level of ['category', 'detail', 'version'] as const) {
      expect(await pages({ source: { level, id: code[level] } })).toEqual([
        live,
      ])
    }
  })

  test('a kind under a source is checked per row: short pages, then the matches, then the end', async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { kind: 'household', source: code })
    const people = await bulk(f.a, 2, 'Zed', { source: code })
    const got = await pages({
      source: { level: 'version', id: code.version },
      kind: 'individual',
    })
    // Pages of households read as empty pages, but the list goes on.
    expect(got.length).toBeGreaterThan(1)
    expect(got[0]).toEqual([])
    expect(got.flat()).toEqual(people)
  })

  test("tenancy: B's pages hold only B's contacts", async () => {
    await bulk(f.a, HIDDEN, 'Aaa', { source: code })
    const inB = await bulk(f.b, 3, 'Zed')
    expect(await pages({}, f.b)).toEqual([inB])
    expect(
      await pages({ source: { level: 'version', id: code.version } }, f.b),
    ).toEqual([[]])
  })
})
