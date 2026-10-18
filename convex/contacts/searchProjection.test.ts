import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import type { Id } from '../_generated/dataModel'
import { api, components, internal } from '../_generated/api'
import { setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { BULK_TAG_LIMIT } from './rules'
import { REINDEX_TAG_BATCH } from './searchProjection'

type Fixture = Awaited<ReturnType<typeof setup>>

const person = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: 'Priya',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
})

let f: Fixture
let priya: Id<'contacts'>

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
  priya = await createContact(f.a, 'Okonjo')
})

const createContact = (who: Tenant, lastName: string) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...person(lastName),
  })

/** Every contactSearch row, raw (both tenants). */
const allRows = () => f.t.run((ctx) => ctx.db.query('contactSearch').collect())

const rowOf = async (id: Id<'contacts'> = priya) => {
  const rows = (await allRows()).filter((r) => r.contactId === id)
  expect(rows).toHaveLength(1)
  return rows[0]
}
const wordsOf = async (id: Id<'contacts'> = priya) =>
  (await rowOf(id)).text.split(' ')

const counters = async (id: Id<'contacts'> = priya) => {
  const c = await f.t.run((ctx) => ctx.db.get('contacts', id))
  return c!
}

const tagNamed = async (who: Tenant, name: string) => {
  const tags = await who.as.query(api.contacts.queries.tags, {
    tenantId: who.tenantId,
  })
  return tags.find((t) => t.name.toLowerCase() === name)!
}

describe('the projection follows every searchable slice', () => {
  test('create writes the row: names, kind, not archived', async () => {
    const row = await rowOf()
    expect(row.kind).toBe('individual')
    expect(row.archived).toBe(false)
    expect(row.text.split(' ').sort()).toEqual(['okonjo', 'priya'])
    expect(row.tenantId).toBe(f.a.tenantId)
  })

  test('details', async () => {
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 0,
      ...person('Okonjo-Brontë'),
      nickname: 'Pri',
    })
    expect(await wordsOf()).toEqual(
      expect.arrayContaining(['okonjo-bronte', 'pri']),
    )
  })

  test('methods: emails and phones', async () => {
    await f.a.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 0,
      emails: [
        { label: 'home', address: 'priya@riverside.example', isPrimary: true },
      ],
      phones: [{ label: 'home', number: '+44 7700 900456', isPrimary: true }],
    })
    const row = await rowOf()
    expect(row.text.split(' ')).toEqual(
      expect.arrayContaining(['riverside', 'example', '07700900456', '900456']),
    )
    expect(row.phones).toEqual(['07700900456'])

    // Removing them takes them out again.
    await f.a.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 1,
      emails: [],
      phones: [],
    })
    expect((await rowOf()).text).not.toContain('riverside')
    expect((await rowOf()).phones).toEqual([])
  })

  test('addresses', async () => {
    await f.a.as.mutation(api.contacts.mutations.saveAddresses, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 0,
      addresses: [
        {
          label: 'home',
          line1: '4 Weavers Row',
          line2: 'Flat 2',
          line3: '',
          town: 'Nailsworth',
          postcode: 'gl6 0aa',
          country: 'GB',
          isPrimary: true,
        },
      ],
    })
    const w = await wordsOf()
    expect(w).toEqual(
      expect.arrayContaining([
        'weavers',
        'row',
        'nailsworth',
        'gl60aa',
        'gl6',
        '0aa',
      ]),
    )
    // Line 2 is not indexed.
    expect(w).not.toContain('flat')
  })

  test('archive', async () => {
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 0,
      archived: true,
    })
    expect((await rowOf()).archived).toBe(true)
  })

  test('tags, and a tag rename re-indexes its contacts', async () => {
    const volunteer = await tagNamed(f.a, 'volunteer')
    await f.a.as.mutation(api.contacts.mutations.saveTags, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 0,
      tags: [{ tagId: volunteer._id }],
    })
    expect(await wordsOf()).toContain('volunteer')

    // Tenant B's contact with B's own "volunteer" tag.
    const other = await createContact(f.b, 'Haddad')
    const bVolunteer = await tagNamed(f.b, 'volunteer')
    await f.b.as.mutation(api.contacts.mutations.saveTags, {
      tenantId: f.b.tenantId,
      id: other,
      expected: 0,
      tags: [{ tagId: bVolunteer._id }],
    })

    await f.a.as.mutation(api.contacts.mutations.saveTag, {
      tenantId: f.a.tenantId,
      id: volunteer._id,
      expected: volunteer.saveVersion,
      name: 'Helper',
      isActive: true,
    })
    await f.t.finishAllScheduledFunctions(() => {})
    const w = await wordsOf()
    expect(w).toContain('helper')
    expect(w).not.toContain('volunteer')
    expect(await wordsOf(other)).toContain('volunteer')
  })

  test('identifiers', async () => {
    const { id: typeId } = await f.a.as.mutation(
      api.contacts.mutations.saveIdentifierType,
      { tenantId: f.a.tenantId, name: 'Old CRM', isActive: true },
    )
    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: priya,
      identifiers: {
        expected: 0,
        identifiers: [{ typeId, value: 'OC-20931' }],
      },
    })
    expect(await wordsOf()).toContain('oc-20931')
  })

  test('a multi-slice form save and a restore', async () => {
    await f.a.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 0,
      emails: [
        { label: 'home', address: 'priya@okonjo.example', isPrimary: true },
      ],
      phones: [],
    })
    const before = (await rowOf()).text
    const at = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: priya,
      details: { expected: 0, ...person('Mensah') },
      methods: {
        expected: 1,
        emails: [
          { label: 'work', address: 'p.mensah@hall.example', isPrimary: true },
        ],
        phones: [],
      },
    })
    expect(await wordsOf()).toEqual(expect.arrayContaining(['mensah', 'hall']))
    await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: priya,
      at,
    })
    expect((await rowOf()).text).toBe(before)
  })

  test('a save that changes nothing searchable leaves the row alone', async () => {
    const row = await rowOf()
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id: priya,
      expected: 0,
      ...person('Okonjo'),
      birthDate: '1980-02-03',
    })
    expect(await rowOf()).toEqual(row)
  })
})

describe('tenant isolation', () => {
  test('rows carry their tenant; B observes nothing of A', async () => {
    const bSnapshot = await snapshot(f.t, f.b.tenantId)
    const bob = await createContact(f.a, 'Ferreira')
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: bob,
      expected: 0,
      archived: true,
    })
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
    const other = await createContact(f.b, 'Ferreira')
    expect((await rowOf(other)).tenantId).toBe(f.b.tenantId)
    expect((await rowOf(bob)).tenantId).toBe(f.a.tenantId)
  })

  test("a tag rename in A never touches B's rows", async () => {
    const other = await createContact(f.b, 'Haddad')
    const bRow = await rowOf(other)
    const member = await tagNamed(f.a, 'member')
    await f.a.as.mutation(api.contacts.mutations.saveTag, {
      tenantId: f.a.tenantId,
      id: member._id,
      expected: member.saveVersion,
      name: 'Friend',
      isActive: true,
    })
    await f.t.finishAllScheduledFunctions(() => {})
    expect(await rowOf(other)).toEqual(bRow)
  })
})

test('a rename re-indexes a tag on more contacts than one batch', async () => {
  const member = await tagNamed(f.a, 'member')
  const ids = [priya]
  for (let i = 0; i < REINDEX_TAG_BATCH; i++) {
    ids.push(await createContact(f.a, `Tan${i}`))
  }
  for (let i = 0; i < ids.length; i += BULK_TAG_LIMIT) {
    await f.a.as.mutation(api.contacts.mutations.bulkTag, {
      tenantId: f.a.tenantId,
      contactIds: ids.slice(i, i + BULK_TAG_LIMIT),
      tagId: member._id,
      op: 'add',
    })
  }
  await f.a.as.mutation(api.contacts.mutations.saveTag, {
    tenantId: f.a.tenantId,
    id: member._id,
    expected: member.saveVersion,
    name: 'Supporter',
    isActive: true,
  })
  await f.t.finishAllScheduledFunctions(() => {})
  const rows = (await allRows()).filter((r) => ids.includes(r.contactId))
  expect(rows).toHaveLength(ids.length)
  for (const r of rows) expect(r.text.split(' ')).toContain('supporter')
})

describe('backfill', () => {
  const backfill = (cursor?: null) =>
    f.t.run((ctx) =>
      runToCompletion(
        ctx,
        components.migrations,
        internal.contacts.migrations.backfillContactSearch,
        { batchSize: 2, cursor },
      ),
    )

  test('rebuilds missing and stale rows in both tenants, idempotently', async () => {
    const other = await createContact(f.b, 'Haddad')
    const third = await createContact(f.a, 'Lindqvist')
    const want = await allRows()
    const strip = (rows: typeof want) =>
      rows
        .map(({ _id: _i, _creationTime: _c, ...r }) => r)
        .sort((a, b) => a.contactId.localeCompare(b.contactId))
    // As before Q1: no rows; and one stale row.
    await f.t.run(async (ctx) => {
      for (const r of want) {
        if (r.contactId === third) {
          await ctx.db.patch('contactSearch', r._id, { text: 'stale' })
        } else {
          await ctx.db.delete('contactSearch', r._id)
        }
      }
    })
    await backfill()
    const got = await allRows()
    expect(strip(got)).toEqual(strip(want))
    expect(got.find((r) => r.contactId === other)?.tenantId).toBe(f.b.tenantId)

    // A rerun (from the start) writes nothing.
    const settled = await allRows()
    await backfill(null)
    expect(await allRows()).toEqual(settled)
    // The counters are untouched: it's not a contract.
    expect((await counters()).detailsVersion).toBe(0)
  })
})
