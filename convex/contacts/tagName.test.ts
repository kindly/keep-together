/**
 * `contactTags.name`: the tag's name copied onto each link, derived (not
 * payload, not revisions), set on insert and refreshed by a rename's
 * re-index batches.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { BULK_TAG_LIMIT } from './rules'
import { REINDEX_TAG_BATCH } from './searchProjection'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture
let ada: Id<'contacts'>
let member: Id<'tags'>
let volunteer: Id<'tags'>

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
const tagId = async (who: Tenant, name: string) =>
  (
    await who.as.query(api.contacts.queries.tags, { tenantId: who.tenantId })
  ).find((t) => t.name === name)!._id
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
const rename = async (who: Tenant, id: Id<'tags'>, name: string) => {
  const tag = await f.t.run((ctx) => ctx.db.get('tags', id))
  await who.as.mutation(api.contacts.mutations.saveTag, {
    tenantId: who.tenantId,
    id,
    expected: tag!.saveVersion,
    name,
    isActive: true,
  })
}
/** Every contactTags row (both tenants), raw. */
const links = () => f.t.run((ctx) => ctx.db.query('contactTags').collect())
const namesOn = async (id: Id<'contacts'> = ada) =>
  (await links())
    .filter((r) => r.contactId === id)
    .map((r) => [r.key, r.name])
    .sort()
const searchWords = async (id: Id<'contacts'> = ada) =>
  (await f.t.run((ctx) =>
    ctx.db
      .query('contactSearch')
      .filter((q) => q.eq(q.field('contactId'), id))
      .unique(),
  ))!.text.split(' ')

beforeEach(async () => {
  f = await setup()
  ada = await createContact(f.a, 'Lovelace')
  member = await tagId(f.a, 'Member')
  volunteer = await tagId(f.a, 'Volunteer')
})

describe('set on insert', () => {
  test('saveTags, the form save and bulk tagging all copy the name', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    expect(await namesOn()).toEqual([['k1', 'Member']])

    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: ada,
      tags: {
        expected: 1,
        tags: [
          { key: 'k1', tagId: member },
          { key: 'k2', tagId: volunteer },
        ],
      },
    })
    expect(await namesOn()).toEqual([
      ['k1', 'Member'],
      ['k2', 'Volunteer'],
    ])

    const bob = await createContact(f.a, 'Babbage')
    await f.a.as.mutation(api.contacts.mutations.bulkTag, {
      tenantId: f.a.tenantId,
      contactIds: [bob],
      tagId: volunteer,
      op: 'add',
    })
    expect((await namesOn(bob)).map(([, n]) => n)).toEqual(['Volunteer'])
  })

  test('the name is not payload: revisions carry only key and tagId', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    const [rev] = await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .filter((q) => q.eq(q.field('contract'), 'contacts.tags'))
        .collect(),
    )
    expect(rev.payload).toEqual({ tags: [{ key: 'k1', tagId: member }] })
  })
})

describe('preserved across reconcile and restore', () => {
  test('a save that keeps a row leaves its name (and row) alone', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    const [before] = await links()
    await saveTags(1, [
      { key: 'k1', tagId: member },
      { key: 'k2', tagId: volunteer },
    ])
    const kept = (await links()).find((r) => r.key === 'k1')
    expect(kept).toEqual(before)
  })

  test('a restore re-inserts removed rows under the tag’s current name', async () => {
    await saveTags(0, [
      { key: 'k1', tagId: member },
      { key: 'k2', tagId: volunteer },
    ])
    const [first] = await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .filter((q) => q.eq(q.field('contract'), 'contacts.tags'))
        .collect(),
    )
    await saveTags(1, [{ key: 'k1', tagId: member }])
    await rename(f.a, volunteer, 'Helper')
    await f.t.finishAllScheduledFunctions(() => {})
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: first._id,
    })
    expect(await namesOn()).toEqual([
      ['k1', 'Member'],
      ['k2', 'Helper'],
    ])
    expect(await searchWords()).toContain('helper')
  })
})

describe('refreshed by a rename', () => {
  test('every link to the tag, across more than one batch, then search', async () => {
    const ids = [ada]
    for (let i = 0; i < REINDEX_TAG_BATCH; i++) {
      ids.push(await createContact(f.a, `Tan${i}`))
    }
    for (let i = 0; i < ids.length; i += BULK_TAG_LIMIT) {
      await f.a.as.mutation(api.contacts.mutations.bulkTag, {
        tenantId: f.a.tenantId,
        contactIds: ids.slice(i, i + BULK_TAG_LIMIT),
        tagId: member,
        op: 'add',
      })
    }
    await saveTags(1, [
      ...(await links())
        .filter((r) => r.contactId === ada)
        .map((r) => ({ key: r.key, tagId: r.tagId })),
      { key: 'v', tagId: volunteer },
    ])
    await rename(f.a, member, 'Supporter')
    await f.t.finishAllScheduledFunctions(() => {})
    const rows = (await links()).filter((r) => r.tagId === member)
    expect(rows).toHaveLength(ids.length)
    for (const r of rows) expect(r.name).toBe('Supporter')
    // Other tags' links are untouched.
    expect((await links()).find((r) => r.key === 'v')?.name).toBe('Volunteer')
    expect(await searchWords(ids[ids.length - 1])).toContain('supporter')
  })

  test('two renames before the re-index runs end on the latest name', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    await rename(f.a, member, 'Friend')
    await rename(f.a, member, 'Patron')
    await f.t.finishAllScheduledFunctions(() => {})
    expect(await namesOn()).toEqual([['k1', 'Patron']])
  })
})

describe('while a re-index is running', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * More than one batch of `member` links, renamed to Friend, with only the
   * first batch run: the chain's next batch is scheduled, not yet run.
   */
  const renameAndRunOneBatch = async () => {
    const ids = [ada]
    for (let i = 0; i < REINDEX_TAG_BATCH; i++) {
      ids.push(await createContact(f.a, `Tan${i}`))
    }
    for (let i = 0; i < ids.length; i += BULK_TAG_LIMIT) {
      await f.a.as.mutation(api.contacts.mutations.bulkTag, {
        tenantId: f.a.tenantId,
        contactIds: ids.slice(i, i + BULK_TAG_LIMIT),
        tagId: member,
        op: 'add',
      })
    }
    vi.useFakeTimers()
    await rename(f.a, member, 'Friend')
    vi.runOnlyPendingTimers()
    await f.t.finishInProgressScheduledFunctions()
    const names = (await links())
      .filter((r) => r.tagId === member)
      .map((r) => r.name)
    // Genuinely mid-run: one batch renamed, the rest not yet.
    expect(names.filter((n) => n === 'Friend')).toHaveLength(REINDEX_TAG_BATCH)
    expect(names.filter((n) => n === 'Member')).toHaveLength(
      ids.length - REINDEX_TAG_BATCH,
    )
    return ids
  }
  const finish = () => f.t.finishAllScheduledFunctions(vi.runAllTimers)

  test('a rename between two batches: every link ends on the latest name', async () => {
    const ids = await renameAndRunOneBatch()
    await rename(f.a, member, 'Patron')
    await finish()
    const rows = (await links()).filter((r) => r.tagId === member)
    expect(rows).toHaveLength(ids.length)
    for (const r of rows) expect(r.name).toBe('Patron')
    for (const id of [ids[0], ids[ids.length - 1]]) {
      const words = await searchWords(id)
      expect(words).toContain('patron')
      expect(words).not.toContain('friend')
    }
  })

  test('a tag added mid-run takes the current name, and the run reaches it', async () => {
    const ids = await renameAndRunOneBatch()
    const late = await createContact(f.a, 'Late')
    await saveTags(0, [{ key: 'late', tagId: member }], late)
    expect(await namesOn(late)).toEqual([['late', 'Friend']])
    await finish()
    const rows = (await links()).filter((r) => r.tagId === member)
    expect(rows).toHaveLength(ids.length + 1)
    for (const r of rows) expect(r.name).toBe('Friend')
    expect(await searchWords(late)).toContain('friend')
  })
})

describe('tenant isolation', () => {
  test("a rename in A never touches B's links; B observes nothing", async () => {
    const other = await createContact(f.b, 'Haddad')
    const bMember = await tagId(f.b, 'Member')
    await f.b.as.mutation(api.contacts.mutations.saveTags, {
      tenantId: f.b.tenantId,
      id: other,
      expected: 0,
      tags: [{ key: 'b1', tagId: bMember }],
    })
    const bSnapshot = await snapshot(f.t, f.b.tenantId)
    await saveTags(0, [{ key: 'a1', tagId: member }])
    await rename(f.a, member, 'Friend')
    await f.t.finishAllScheduledFunctions(() => {})
    expect(await namesOn()).toEqual([['a1', 'Friend']])
    expect(await namesOn(other)).toEqual([['b1', 'Member']])
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })
})

const getTags = () =>
  f.a.as.query(api.contacts.queries.getTags, {
    tenantId: f.a.tenantId,
    id: ada,
  })

describe('readers', () => {
  test('getTags names tags from the rows, not the tag documents', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    // A copy that differs from the tag shows it is the copy being read.
    await f.t.run(async (ctx) => {
      const [r] = await ctx.db.query('contactTags').collect()
      await ctx.db.patch('contactTags', r._id, { name: 'Copied' })
    })
    expect(await getTags()).toEqual([
      { key: 'k1', tagId: member, name: 'Copied' },
    ])
  })
})

describe('rows without a name (before the backfill)', () => {
  test('getTags falls back to the tag document', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    await f.t.run(async (ctx) => {
      const [r] = await ctx.db.query('contactTags').collect()
      await ctx.db.patch('contactTags', r._id, { name: undefined })
    })
    expect(await getTags()).toEqual([
      { key: 'k1', tagId: member, name: 'Member' },
    ])
  })

  test('search still names the tag from the tag document', async () => {
    await saveTags(0, [{ key: 'k1', tagId: member }])
    await f.t.run(async (ctx) => {
      for (const r of await ctx.db.query('contactTags').collect()) {
        await ctx.db.patch('contactTags', r._id, { name: undefined })
      }
    })
    // A save that rebuilds search without touching the tag row.
    await saveTags(1, [
      { key: 'k1', tagId: member },
      { key: 'k2', tagId: volunteer },
    ])
    const words = await searchWords()
    expect(words).toContain('member')
    expect(words).toContain('volunteer')
    expect(await namesOn()).toEqual([
      ['k1', undefined],
      ['k2', 'Volunteer'],
    ])
  })
})
