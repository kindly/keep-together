import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { LIST_SEARCH_SCAN } from './queries'
import { setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>
type Kind = 'individual' | 'organization' | 'household'

let f: Fixture

beforeEach(async () => {
  f = await setup()
})

/** A contact with the given searchable children, in `who`'s tenant. */
async function contact(
  who: Tenant,
  opts: {
    first?: string
    last?: string
    org?: string
    kind?: Kind
    email?: string
    phone?: string
    line1?: string
    town?: string
    postcode?: string
  },
): Promise<Id<'contacts'>> {
  const kind = opts.kind ?? (opts.org ? 'organization' : 'individual')
  const id = await who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    kind,
    title: '',
    firstName: opts.first ?? '',
    lastName: opts.last ?? '',
    nickname: '',
    name: opts.org ?? '',
    isDeceased: false,
  })
  if (opts.email || opts.phone) {
    await who.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: who.tenantId,
      id,
      expected: 0,
      emails: opts.email
        ? [{ label: 'home', address: opts.email, isPrimary: true }]
        : [],
      phones: opts.phone
        ? [{ label: 'home', number: opts.phone, isPrimary: true }]
        : [],
    })
  }
  if (opts.postcode || opts.line1 || opts.town) {
    await who.as.mutation(api.contacts.mutations.saveAddresses, {
      tenantId: who.tenantId,
      id,
      expected: 0,
      addresses: [
        {
          label: 'home',
          line1: opts.line1 ?? '',
          line2: '',
          line3: '',
          town: opts.town ?? '',
          postcode: opts.postcode ?? '',
          country: 'GB',
          isPrimary: true,
        },
      ],
    })
  }
  return id
}

const list = (
  search: string,
  extra: { includeArchived?: boolean; kind?: Kind; tagId?: Id<'tags'> } = {},
  who: Tenant = f.a,
) =>
  who.as.query(api.contacts.queries.search, {
    tenantId: who.tenantId,
    search,
    ...extra,
  })
const ids = async (...args: Parameters<typeof list>) =>
  (await list(...args)).rows.map((r) => r._id)

describe('what one search box finds', () => {
  test('a phone in any common format, and by its last six digits', async () => {
    const priya = await contact(f.a, {
      first: 'Priya',
      last: 'Okonjo',
      phone: '07700 900123',
    })
    await contact(f.a, {
      first: 'Tomas',
      last: 'Lindqvist',
      phone: '01452 300400',
    })
    for (const typed of [
      '07700 900123',
      '07700900123',
      '+44 7700 900123',
      '+44 (0)7700 900-123',
      '900123',
      '07700 9',
    ]) {
      expect(await ids(typed), typed).toEqual([priya])
    }
  })

  test('an exact phone ranks before a longer number it prefixes', async () => {
    const longer = await contact(f.a, { last: 'Achebe', phone: '077009001234' })
    const exact = await contact(f.a, { last: 'Mensah', phone: '07700 900123' })
    expect(await ids('07700900123')).toEqual([exact, longer])
  })

  test('a postcode with or without its space', async () => {
    const id = await contact(f.a, { last: 'Haddad', postcode: 'GL5 1AB' })
    const other = await contact(f.a, { last: 'Ferreira', postcode: 'GL6 0AA' })
    expect(await ids('gl51ab')).toEqual([id])
    expect(await ids('GL5 1AB')).toEqual([id])
    expect((await ids('GL')).sort()).toEqual([id, other].sort())
  })

  test('part of an email: the domain, the local part, a prefix', async () => {
    const id = await contact(f.a, {
      last: 'Osei',
      email: 'kwame.osei@riverside.example',
    })
    expect(await ids('riverside')).toEqual([id])
    expect(await ids('kwame')).toEqual([id])
    expect(await ids('kwame.osei@river')).toEqual([id])
  })

  test('an organisation by its name; street and town', async () => {
    const hall = await contact(f.a, {
      org: 'Oakfield Community Bakery',
      line1: '3 Weavers Row',
      town: 'Nailsworth',
    })
    expect(await ids('oakfield bak')).toEqual([hall])
    expect(await ids('weavers row')).toEqual([hall])
    expect(await ids('nailsworth')).toEqual([hall])
  })

  test('every word must match; accents fold both ways', async () => {
    const zoe = await contact(f.a, {
      first: 'Zoë',
      last: 'Ndiaye',
      town: 'Stroud',
    })
    await contact(f.a, { first: 'Zoe', last: 'Achterberg', town: 'Bath' })
    expect(await ids('zoe stroud')).toEqual([zoe])
    expect(await ids('Zoë Ndiaye')).toEqual([zoe])
    expect((await ids('ZOE')).length).toBe(2)
    expect(await ids('zoe london')).toEqual([])
  })

  test('a tag name', async () => {
    const id = await contact(f.a, { last: 'Achebe' })
    const tags = await f.a.as.query(api.contacts.queries.tags, {
      tenantId: f.a.tenantId,
    })
    const volunteer = tags.find((t) => t.name === 'Volunteer')!
    await f.a.as.mutation(api.contacts.mutations.saveTags, {
      tenantId: f.a.tenantId,
      id,
      expected: 0,
      tags: [{ tagId: volunteer._id }],
    })
    expect(await ids('volunteer')).toEqual([id])
    // The tag filter intersects a search.
    await contact(f.a, { last: 'Achebe-Ward' })
    expect((await ids('achebe')).length).toBe(2)
    expect(await ids('achebe', { tagId: volunteer._id })).toEqual([id])
  })

  test('exact email, then exact identifier, then exact phone, then the rest', async () => {
    const byText = await contact(f.a, {
      last: 'Mensah',
      email: 'other@mensah.example',
    })
    const byEmail = await contact(f.a, {
      last: 'Lindqvist',
      email: 'mensah@riverside.example',
    })
    expect(await ids('mensah@riverside.example')).toEqual([byEmail])
    expect((await ids('mensah')).sort()).toEqual([byText, byEmail].sort())

    const { id: typeId } = await f.a.as.mutation(
      api.contacts.mutations.saveIdentifierType,
      { tenantId: f.a.tenantId, name: 'Old CRM', isActive: true },
    )
    const byPhone = await contact(f.a, { last: 'Osei', phone: '01452 300400' })
    const byId = await contact(f.a, { last: 'Ferreira' })
    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: byId,
      identifiers: {
        expected: 0,
        identifiers: [{ typeId, value: '01452300400' }],
      },
    })
    expect(await ids('01452300400')).toEqual([byId, byPhone])
  })
})

describe('filters', () => {
  test('kind, with and without a search; archived hidden unless asked', async () => {
    const person = await contact(f.a, { first: 'Ruth', last: 'Oakfield' })
    const org = await contact(f.a, { org: 'Oakfield Trust' })
    // Households are dormant, not broken: one still saves and filters.
    const home = await contact(f.a, {
      org: 'The Oakfield Household',
      kind: 'household',
    })
    expect(await ids('oakfield', { kind: 'organization' })).toEqual([org])
    expect(await ids('oakfield', { kind: 'household' })).toEqual([home])
    expect(await ids('', { kind: 'individual' })).toEqual([person])
    expect(await ids('', { kind: 'organization' })).toEqual([org])

    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: org,
      expected: 0,
      archived: true,
    })
    expect(await ids('oakfield trust')).toEqual([])
    expect(await ids('oakfield trust', { includeArchived: true })).toEqual([
      org,
    ])
    expect(await ids('', { kind: 'organization' })).toEqual([])
  })

  test('an exact email match respects the kind filter', async () => {
    const org = await contact(f.a, {
      org: 'Ludlow Hall',
      email: 'hello@ludlow.example',
    })
    expect(await ids('hello@ludlow.example', { kind: 'individual' })).toEqual(
      [],
    )
    expect(await ids('hello@ludlow.example', { kind: 'organization' })).toEqual(
      [org],
    )
  })
})

describe('tenant isolation on every new path', () => {
  test("B's searches never return A's contacts, and A's saves leave B alone", async () => {
    const bSnapshot = await snapshot(f.t, f.b.tenantId)
    await contact(f.a, {
      first: 'Priya',
      last: 'Okonjo',
      email: 'priya@riverside.example',
      phone: '07700 900123',
      line1: '3 Weavers Row',
      postcode: 'GL5 1AB',
    })
    await contact(f.a, { org: 'Oakfield Trust' })
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)

    const inB = await contact(f.b, { last: 'Haddad', phone: '07700 900123' })
    for (const typed of [
      'okonjo',
      'riverside',
      '900123',
      'GL5 1AB',
      'weavers',
      'oakfield',
    ]) {
      expect(await ids(typed, {}, f.b), typed).toEqual(
        typed === '900123' ? [inB] : [],
      )
    }
    expect(await ids('', { kind: 'organization' }, f.b)).toEqual([])
    expect(await ids('07700900123', {}, f.a)).not.toContain(inB)
  })
})

test('a scan of only partial matches says the search is too broad', async () => {
  for (let i = 0; i < LIST_SEARCH_SCAN; i++) {
    await contact(f.a, { first: `Nadia${i}`, last: 'Haddad' })
  }
  const broad = await list('haddad osei')
  expect(broad.rows).toEqual([])
  expect(broad.tooBroad).toBe(true)
  // A full match found, or a scan that isn't full, is not too broad.
  expect((await list('haddad nadia7')).tooBroad).toBe(false)
  await contact(f.a, { last: 'Osei' })
  expect((await list('osei')).tooBroad).toBe(false)
  expect((await list('osei', {}, f.b)).tooBroad).toBe(false)
})
