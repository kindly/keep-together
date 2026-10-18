import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { BULK_TAG_LIMIT } from './rules'
import { BY_TAG_PAGE_LIMIT, LIST_LIMIT, LIST_TAG_SCAN } from './queries'

type Fixture = Awaited<ReturnType<typeof setup>>

const individual = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
  externalIdentifier: '',
})

let f: Fixture
let ada: Id<'contacts'>
let member: Id<'tags'>
let volunteer: Id<'tags'>
let bSnapshot: string

const tagList = (who: Tenant, includeInactive?: boolean) =>
  who.as.query(api.contacts.queries.tags, {
    tenantId: who.tenantId,
    includeInactive,
  })
const createContact = (who: Tenant, lastName: string) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...individual(lastName),
  })
const get = (id: Id<'contacts'> = ada) =>
  f.a.as.query(api.contacts.queries.get, { tenantId: f.a.tenantId, id })
const saveTags = (
  expected: number,
  tags: Array<{ key?: string; tagId: Id<'tags'> }>,
  id: Id<'contacts'> = ada,
) =>
  f.a.as.mutation(api.contacts.mutations.saveTags, {
    tenantId: f.a.tenantId,
    id,
    expected,
    tags,
  })
const saveTag = (
  args: {
    name: string
    isActive?: boolean
    id?: Id<'tags'>
    expected?: number
  },
  who: Tenant = f.a,
) =>
  who.as.mutation(api.contacts.mutations.saveTag, {
    tenantId: who.tenantId,
    isActive: true,
    ...args,
  })
const bulkTag = (
  contactIds: Array<Id<'contacts'>>,
  tagId: Id<'tags'>,
  op: 'add' | 'remove',
) =>
  f.a.as.mutation(api.contacts.mutations.bulkTag, {
    tenantId: f.a.tenantId,
    contactIds,
    tagId,
    op,
  })
const revisionsOf = (id: Id<'contacts'>) =>
  f.t.run((ctx) =>
    ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q
          .eq('tenantId', f.a.tenantId)
          .eq('entity', 'contacts')
          .eq('entityId', id),
      )
      .collect(),
  )

beforeEach(async () => {
  f = await setup()
  bSnapshot = await snapshot(f.t, f.b.tenantId)
  ada = await createContact(f.a, 'Lovelace')
  const seeded = await tagList(f.a)
  member = seeded.find((t) => t.name === 'Member')!._id
  volunteer = seeded.find((t) => t.name === 'Volunteer')!._id
})

describe('tag definitions', () => {
  test('member and volunteer are seeded per tenant, alphabetical', async () => {
    expect((await tagList(f.a)).map((t) => t.name)).toEqual([
      'Member',
      'Volunteer',
    ])
    expect((await tagList(f.b)).map((t) => t.name)).toEqual([
      'Member',
      'Volunteer',
    ])
  })

  test('names are trimmed, whitespace collapsed, and never blank', async () => {
    const { id } = await saveTag({ name: '  Christmas   fair  ' })
    const got = (await tagList(f.a)).find((t) => t._id === id)
    expect(got).toMatchObject({
      name: 'Christmas fair',
      nameNormalized: 'christmas fair',
      saveVersion: 0,
    })
    expect(await errorData(saveTag({ name: '   ' }))).toMatchObject({
      kind: 'invalid',
    })
  })

  test('names are unique per tenant, case-insensitively', async () => {
    expect(await errorData(saveTag({ name: ' volunteer ' }))).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate_tag_name',
    })
    await saveTag({ name: 'Trustee' })
    expect(
      await errorData(saveTag({ id: member, expected: 0, name: 'TRUSTEE' })),
    ).toMatchObject({ reason: 'duplicate_tag_name' })
    // Re-casing a tag's own name is not a clash.
    await saveTag({ id: member, expected: 0, name: 'member' })
    // The same name in another tenant is fine.
    await saveTag({ name: 'Trustee' }, f.b)
  })

  test('a stale tag save conflicts', async () => {
    await saveTag({ id: member, expected: 0, name: 'Members' })
    expect(
      await errorData(saveTag({ id: member, expected: 0, name: 'Paid up' })),
    ).toMatchObject({ kind: 'stale', current: 1 })
  })

  test('an update without the version it edits is refused', async () => {
    expect(
      await errorData(saveTag({ id: member, name: 'Members' })),
    ).toMatchObject({ kind: 'invalid' })
    expect((await tagList(f.a)).find((t) => t._id === member)).toMatchObject({
      name: 'Member',
      saveVersion: 0,
    })
  })

  test('archived tags leave the picker but not the admin list', async () => {
    await saveTag({
      id: volunteer,
      expected: 0,
      name: 'Volunteer',
      isActive: false,
    })
    expect((await tagList(f.a)).map((t) => t.name)).toEqual(['Member'])
    expect((await tagList(f.a, true)).map((t) => t.name)).toEqual([
      'Member',
      'Volunteer',
    ])
  })
})

describe('contacts.tags slice', () => {
  test('a new contact starts at tagsVersion 0 with no tags', async () => {
    const got = await get()
    expect(got?.contact.tagsVersion).toBe(0)
    expect(got?.tags).toEqual([])
  })

  test('tags save, get returns them by name, and a revision is written', async () => {
    const result = await saveTags(0, [{ tagId: volunteer }, { tagId: member }])
    expect(result.counter).toBe(1)
    const got = await get()
    expect(got?.tags.map((t) => t.name)).toEqual(['Member', 'Volunteer'])
    expect(got?.tags.every((t) => t.key && t.isActive)).toBe(true)
    const revs = (await revisionsOf(ada)).filter(
      (r) => r.contract === 'contacts.tags',
    )
    expect(revs).toHaveLength(1)
    expect(revs[0].payload.tags).toHaveLength(2)
  })

  test('duplicate tagIds are rejected', async () => {
    expect(
      await errorData(saveTags(0, [{ tagId: member }, { tagId: member }])),
    ).toMatchObject({ kind: 'invalid' })
    expect((await get())?.contact.tagsVersion).toBe(0)
  })

  test('tagId is immutable per key', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    expect(
      await errorData(saveTags(1, [{ key: 'k1', tagId: volunteer }])),
    ).toMatchObject({ reason: 'immutable_child' })
  })

  test('a tags save never stales the other slices, and vice versa', async () => {
    await saveTags(0, [{ tagId: member }])
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      ...individual('Lovelace'),
      nickname: 'Countess',
    })
    await f.a.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      emails: [],
      phones: [],
    })
    await f.a.as.mutation(api.contacts.mutations.saveAddresses, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      addresses: [],
    })
    await saveTags(1, [])
    expect((await get())?.contact).toMatchObject({
      detailsVersion: 1,
      methodsVersion: 1,
      addressesVersion: 1,
      tagsVersion: 2,
    })
  })

  test('a stale tags save conflicts and leaves no trace', async () => {
    await saveTags(0, [{ tagId: member }])
    expect(await errorData(saveTags(0, [{ tagId: volunteer }]))).toMatchObject({
      kind: 'stale',
      contract: 'contacts.tags',
      current: 1,
    })
    expect((await get())?.tags.map((t) => t.name)).toEqual(['Member'])
  })

  test('an archived tag cannot be newly added, but an existing assignment stays', async () => {
    await saveTags(0, [{ key: 'k1', tagId: volunteer }])
    await saveTag({
      id: volunteer,
      expected: 0,
      name: 'Volunteer',
      isActive: false,
    })
    // Kept: still visible, marked inactive, and other saves keep it.
    await saveTags(1, [{ key: 'k1', tagId: volunteer }, { tagId: member }])
    const got = await get()
    expect(got?.tags).toMatchObject([
      { name: 'Member', isActive: true },
      { key: 'k1', name: 'Volunteer', isActive: false },
    ])
    // A fresh row for the archived tag is refused.
    const bob = await createContact(f.a, 'Babbage')
    expect(
      await errorData(saveTags(0, [{ tagId: volunteer }], bob)),
    ).toMatchObject({ reason: 'unknown_tag' })
  })

  test('renaming a tag renames it on every contact', async () => {
    await saveTags(0, [{ tagId: member }])
    await saveTag({ id: member, expected: 0, name: 'Paid-up member' })
    expect((await get())?.tags.map((t) => t.name)).toEqual(['Paid-up member'])
  })

  test('restore recreates removed tag rows with the same keys', async () => {
    await saveTags(0, [
      { key: 'k1', tagId: member },
      { key: 'k2', tagId: volunteer },
    ])
    const [first] = (await revisionsOf(ada)).filter(
      (r) => r.contract === 'contacts.tags',
    )
    await saveTags(1, [])
    expect((await get())?.tags).toEqual([])
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: first._id,
    })
    const got = await get()
    expect(got?.tags.map((t) => t.key).sort()).toEqual(['k1', 'k2'])
    expect(got?.contact.tagsVersion).toBe(3)
  })

  test('a restore may re-add an archived tag; a plain save may not', async () => {
    await saveTags(0, [{ key: 'k1', tagId: volunteer }])
    const [first] = (await revisionsOf(ada)).filter(
      (r) => r.contract === 'contacts.tags',
    )
    await saveTags(1, [])
    await saveTag({
      id: volunteer,
      expected: 0,
      name: 'Volunteer',
      isActive: false,
    })
    // A plain save of the old state is refused…
    expect(
      await errorData(saveTags(2, [{ key: 'k1', tagId: volunteer }])),
    ).toMatchObject({ reason: 'unknown_tag' })
    // …but restoring it brings the assignment back, still archived.
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: first._id,
    })
    expect((await get())?.tags).toMatchObject([
      { key: 'k1', name: 'Volunteer', isActive: false },
    ])
    expect((await tagList(f.a)).map((t) => t.name)).toEqual(['Member'])
    // A whole-contact restore never fails on tags either.
    await saveTags(3, [])
    const result = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: first._creationTime,
    })
    expect(result.restored).toContain('contacts.tags')
    expect((await get())?.tags.map((t) => t.key)).toEqual(['k1'])
  })

  test('the form save carries tags as its own slice', async () => {
    const save = (tagsSlice: {
      expected: number
      tags: Array<{ key?: string; tagId: Id<'tags'> }>
    }) =>
      f.a.as.mutation(api.contacts.mutations.saveForm, {
        tenantId: f.a.tenantId,
        id: ada,
        details: { expected: 0, ...individual('Lovelace') },
        tags: tagsSlice,
      })
    const first = await save({
      expected: 0,
      tags: [{ key: 'k1', tagId: member }],
    })
    expect(first.saved).toEqual(['tags'])
    expect(first.counters).toMatchObject({ details: 0, tags: 1 })
    // Same set again: no command.
    const again = await save({
      expected: 1,
      tags: [{ key: 'k1', tagId: member }],
    })
    expect(again.saved).toEqual([])
    // Stale: reported, not written.
    const stale = await save({ expected: 0, tags: [] })
    expect(stale.stale).toEqual({ tags: 1 })
    expect((await get())?.tags).toHaveLength(1)
  })
})

describe('bulk tagging', () => {
  test('adds under one command group, skipping contacts that already have it', async () => {
    const bob = await createContact(f.a, 'Babbage')
    const cat = await createContact(f.a, 'Herschel')
    await saveTags(0, [{ tagId: member }], cat)
    const result = await bulkTag([ada, bob, cat, ada], member, 'add')
    expect(result.changed).toBe(2)
    const revs = [
      ...(await revisionsOf(ada)),
      ...(await revisionsOf(bob)),
      ...(await revisionsOf(cat)),
    ].filter((r) => r.contract === 'contacts.tags' && r.group !== undefined)
    expect(revs).toHaveLength(2)
    expect(new Set(revs.map((r) => r.group))).toEqual(new Set([result.group]))
    const group = await f.t.run((ctx) => ctx.db.get(result.group!))
    expect(group?.name).toBe('add tag Member')
    for (const id of [ada, bob, cat]) {
      expect((await get(id))?.tags.map((t) => t.name)).toEqual(['Member'])
    }
  })

  test('removes, keeping the contact’s other tags', async () => {
    await saveTags(0, [{ tagId: member }, { key: 'v', tagId: volunteer }])
    const result = await bulkTag([ada], member, 'remove')
    expect(result.changed).toBe(1)
    expect((await get())?.tags).toMatchObject([{ key: 'v', name: 'Volunteer' }])
  })

  test('nothing to change writes nothing', async () => {
    const result = await bulkTag([ada], member, 'remove')
    expect(result).toEqual({ changed: 0, group: null })
    expect((await get())?.contact.tagsVersion).toBe(0)
  })

  test('the batch is bounded', async () => {
    const ids = Array.from({ length: BULK_TAG_LIMIT + 1 }, () => ada)
    // Duplicates collapse, so this one is within the bound…
    expect((await bulkTag(ids, member, 'add')).changed).toBe(1)
    // …but more distinct contacts than the bound are refused.
    const many = await f.t.run(async (ctx) => {
      const out: Array<Id<'contacts'>> = []
      for (let i = 0; i <= BULK_TAG_LIMIT; i++) {
        out.push(
          await ctx.db.insert('contacts', {
            tenantId: f.a.tenantId,
            ...individual(`Bulk ${i}`),
            displayName: `Ada Bulk ${i}`,
            sortName: `Bulk ${i}, Ada`,
            archived: false,
            detailsVersion: 0,
            methodsVersion: 0,
            addressesVersion: 0,
            archiveVersion: 0,
            tagsVersion: 0,
          }),
        )
      }
      return out
    })
    expect(await errorData(bulkTag(many, member, 'add'))).toMatchObject({
      kind: 'invalid',
    })
  })

  test('an archived tag can be bulk-removed but not bulk-added', async () => {
    await saveTags(0, [{ tagId: volunteer }])
    await saveTag({
      id: volunteer,
      expected: 0,
      name: 'Volunteer',
      isActive: false,
    })
    const bob = await createContact(f.a, 'Babbage')
    expect(await errorData(bulkTag([bob], volunteer, 'add'))).toMatchObject({
      reason: 'unknown_tag',
    })
    expect((await bulkTag([ada], volunteer, 'remove')).changed).toBe(1)
  })

  test('one unknown contact refuses the whole batch', async () => {
    const other = await createContact(f.b, 'Elsewhere')
    expect(
      await errorData(bulkTag([ada, other as never], member, 'add')),
    ).toMatchObject({ reason: 'unknown_contact' })
    expect((await get())?.tags).toEqual([])
  })
})

describe('contacts by tag', () => {
  test('a page reads at most BY_TAG_PAGE_LIMIT assignments', async () => {
    await f.t.run(async (ctx) => {
      for (let i = 0; i <= BY_TAG_PAGE_LIMIT; i++) {
        const contactId = await ctx.db.insert('contacts', {
          tenantId: f.a.tenantId,
          ...individual(`Page ${i}`),
          displayName: `Ada Page ${i}`,
          sortName: `Page ${i}, Ada`,
          archived: false,
          detailsVersion: 0,
          methodsVersion: 0,
          addressesVersion: 0,
          archiveVersion: 0,
          tagsVersion: 0,
        })
        await ctx.db.insert('contactTags', {
          tenantId: f.a.tenantId,
          contactId,
          key: `page-${i}`,
          tagId: member,
        })
      }
    })
    const page = await f.a.as.query(api.contacts.queries.byTag, {
      tenantId: f.a.tenantId,
      tagId: member,
      paginationOpts: { numItems: 20_000, cursor: null },
    })
    expect(page.page).toHaveLength(BY_TAG_PAGE_LIMIT)
    expect(page.isDone).toBe(false)
  })

  test('paginates, hiding archived contacts unless asked', async () => {
    const ids = [ada]
    for (const name of ['Babbage', 'Herschel', 'Somerville', 'Fry']) {
      ids.push(await createContact(f.a, name))
    }
    await bulkTag(ids, volunteer, 'add')
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: ids[4],
      expected: 0,
      archived: true,
    })
    const page = (cursor: string | null, includeArchived?: boolean) =>
      f.a.as.query(api.contacts.queries.byTag, {
        tenantId: f.a.tenantId,
        tagId: volunteer,
        includeArchived,
        paginationOpts: { numItems: 2, cursor },
      })
    const seen: Array<string> = []
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const p = await page(cursor)
      pages++
      seen.push(...p.page.map((c) => c.sortName))
      if (p.isDone) break
      cursor = p.continueCursor
    }
    expect(pages).toBeGreaterThan(1)
    expect(seen.sort()).toEqual([
      'Babbage, Ada',
      'Herschel, Ada',
      'Lovelace, Ada',
      'Somerville, Ada',
    ])
    const all = await page(null, true)
    expect(all.page).toHaveLength(2)
    expect(
      (
        await f.a.as.query(api.contacts.queries.byTag, {
          tenantId: f.a.tenantId,
          tagId: member,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page,
    ).toEqual([])
  })
})

describe('the list filtered by tag', () => {
  const list = (
    who: Tenant,
    args: { tagId?: Id<'tags'>; search?: string; includeArchived?: boolean },
  ) =>
    who.as
      .query(api.contacts.queries.list, { tenantId: who.tenantId, ...args })
      .then((r) => r.rows)

  test('rows carry their tag ids; a tag filter keeps only its contacts, by name', async () => {
    const fry = await createContact(f.a, 'Fry')
    const bob = await createContact(f.a, 'Babbage')
    await bulkTag([ada, fry], volunteer, 'add')
    await bulkTag([ada], member, 'add')
    const all = await list(f.a, {})
    expect(all.find((r) => r._id === ada)?.tagIds.sort()).toEqual(
      [member, volunteer].sort(),
    )
    expect(all.find((r) => r._id === bob)?.tagIds).toEqual([])
    expect(
      (await list(f.a, { tagId: volunteer })).map((r) => r.sortName),
    ).toEqual(['Fry, Ada', 'Lovelace, Ada'])
  })

  test('with a search, only hits carrying the tag; archived hidden unless asked', async () => {
    const fry = await createContact(f.a, 'Fry')
    await createContact(f.a, 'Fryer')
    await bulkTag([fry, ada], volunteer, 'add')
    expect(
      (await list(f.a, { tagId: volunteer, search: 'Fry' })).map((r) => r._id),
    ).toEqual([fry])
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: fry,
      expected: 0,
      archived: true,
    })
    expect(await list(f.a, { tagId: volunteer, search: 'Fry' })).toEqual([])
    expect(
      (await list(f.a, { tagId: volunteer, includeArchived: true })).map(
        (r) => r._id,
      ),
    ).toEqual([fry, ada])
  })

  test('truncated says when the cap or the tag scan was hit', async () => {
    const full = (args: { tagId?: Id<'tags'> }) =>
      f.a.as.query(api.contacts.queries.list, {
        tenantId: f.a.tenantId,
        ...args,
      })
    await bulkTag([ada], member, 'add')
    expect(await full({ tagId: member })).toMatchObject({ truncated: false })
    expect(await full({})).toMatchObject({ truncated: false })
    // LIST_TAG_SCAN volunteers, half of them archived: the scan is full, and
    // fewer than LIST_LIMIT rows show although more may exist.
    await f.t.run(async (ctx) => {
      for (let i = 0; i < LIST_TAG_SCAN; i++) {
        const contactId = await ctx.db.insert('contacts', {
          tenantId: f.a.tenantId,
          ...individual(`Scan ${i}`),
          displayName: `Ada Scan ${i}`,
          sortName: `Scan ${i}, Ada`,
          archived: i % 2 === 0,
          detailsVersion: 0,
          methodsVersion: 0,
          addressesVersion: 0,
          archiveVersion: 0,
          tagsVersion: 0,
        })
        await ctx.db.insert('contactTags', {
          tenantId: f.a.tenantId,
          contactId,
          key: `scan-${i}`,
          tagId: volunteer,
        })
      }
    })
    const tagged = await full({ tagId: volunteer })
    expect(tagged.rows).toHaveLength(LIST_LIMIT)
    expect(tagged.truncated).toBe(true)
    // Unfiltered: more than LIST_LIMIT live contacts.
    expect(await full({})).toMatchObject({ truncated: true })
  })

  test('another tenant’s tag filters to nothing', async () => {
    await bulkTag([ada], member, 'add')
    await createContact(f.b, 'Babbage')
    expect(await list(f.b, { tagId: member })).toEqual([])
  })
})

describe('tenant isolation', () => {
  test('tenant A’s tags are invisible and unusable from tenant B', async () => {
    await saveTags(0, [{ tagId: member }])
    await bulkTag([ada], volunteer, 'add')
    await saveTag({ name: 'Trustee' })
    const bobB = await createContact(f.b, 'Babbage')
    // An A tag id through B's mutations.
    expect(
      await errorData(
        f.b.as.mutation(api.contacts.mutations.saveTags, {
          tenantId: f.b.tenantId,
          id: bobB,
          expected: 0,
          tags: [{ tagId: member }],
        }),
      ),
    ).toMatchObject({ reason: 'unknown_tag' })
    expect(
      await errorData(
        f.b.as.mutation(api.contacts.mutations.bulkTag, {
          tenantId: f.b.tenantId,
          contactIds: [bobB],
          tagId: member,
          op: 'add',
        }),
      ),
    ).toMatchObject({ reason: 'unknown_tag' })
    // Renaming A's tag from B.
    await expect(
      f.b.as.mutation(api.contacts.mutations.saveTag, {
        tenantId: f.b.tenantId,
        id: member,
        expected: 0,
        name: 'Hijacked',
        isActive: true,
      }),
    ).rejects.toThrow()
    // Reading A's assignments from B.
    const fromB = await f.b.as.query(api.contacts.queries.byTag, {
      tenantId: f.b.tenantId,
      tagId: member,
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(fromB.page).toEqual([])
    expect((await tagList(f.b, true)).map((t) => t.name)).toEqual([
      'Member',
      'Volunteer',
    ])
    // Every assignment that exists is A's.
    await f.t.run(async (ctx) => {
      const rows = await ctx.db.query('contactTags').collect()
      expect(rows.every((r) => r.tenantId === f.a.tenantId)).toBe(true)
    })
  })

  test('tenant B observes nothing of tenant A’s tag operations', async () => {
    await saveTags(0, [{ tagId: member }])
    await saveTag({ name: 'Trustee' })
    await saveTag({
      id: volunteer,
      expected: 0,
      name: 'Volunteer',
      isActive: false,
    })
    await bulkTag([ada], member, 'remove')
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })
})
