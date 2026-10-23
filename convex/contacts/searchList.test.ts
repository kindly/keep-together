import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { LIST_SEARCH_SCAN } from './queries'
import { formatNumber } from './number'
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
  extra: { includeArchived?: boolean; kind?: Kind } = {},
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

  test('a hyphenated, apostrophe or multi-word name however it is typed; own tenant only', async () => {
    const sj = await contact(f.a, { first: 'Ann', last: 'Smith-Jones' })
    const ob = await contact(f.a, { first: 'Liam', last: 'O’Brien' })
    const dc = await contact(f.a, { first: 'Rosa', last: 'de la Cruz' })
    await contact(f.a, { first: 'Ann', last: 'Smith' })
    await contact(f.b, { first: 'Ann', last: 'Smith-Jones' })
    await contact(f.b, { first: 'Liam', last: "O'Brien" })
    for (const typed of [
      'smith-jones',
      'smithjones',
      'smithj',
      'ann smithjones',
    ]) {
      expect(await ids(typed), typed).toEqual([sj])
    }
    for (const typed of ["o'brien", 'o’brien', 'obrien', 'liam obri']) {
      expect(await ids(typed), typed).toEqual([ob])
    }
    for (const typed of ['delacruz', 'de la cruz', 'rosa dela']) {
      expect(await ids(typed), typed).toEqual([dc])
    }
    expect((await ids('smithjones', {}, f.b)).length).toBe(1)
    expect(await ids('smithjones', {}, f.b)).not.toContain(sj)
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

describe('by contact number', () => {
  const numberOf = (id: Id<'contacts'>) =>
    f.t.run(async (ctx) => (await ctx.db.get(id))!.number!)

  test('exact number first, then a phone ending in the same digits', async () => {
    await contact(f.a, { last: 'Achterberg' })
    const target = await contact(f.a, { last: 'Mensah' })
    const written = formatNumber(await numberOf(target))
    // Its phone's last six digits are the number: a phone-tail match.
    const byPhone = await contact(f.a, {
      last: 'Osei',
      phone: `01452 ${written}`,
    })
    const found = await list(written)
    expect(found.rows.map((r) => r._id)).toEqual([target, byPhone])
    expect(found.numberMatch).toBe(target)
    expect(found.invalidNumber).toBeNull()
    // A phone that is exactly the six digits: after the number, before
    // the tail.
    const exactPhone = await contact(f.a, { last: 'Lindqvist', phone: written })
    expect(await ids(written)).toEqual([target, exactPhone, byPhone])
  })

  test('the sequence without its check digit; spaces and hyphens ignored', async () => {
    await contact(f.a, { last: 'Achterberg' })
    const target = await contact(f.a, { last: 'Mensah' })
    const sequence = await numberOf(target)
    const written = formatNumber(sequence)
    for (const typed of [
      String(sequence),
      `${written.slice(0, 3)} ${written.slice(3)}`,
      `${written.slice(0, 3)}-${written.slice(3)}`,
    ]) {
      const found = await list(typed)
      expect(
        found.rows.map((r) => r._id),
        typed,
      ).toEqual([target])
      expect(found.numberMatch, typed).toBe(target)
    }
  })

  test('a wrong check digit says so and still lists phone matches', async () => {
    const target = await contact(f.a, { last: 'Mensah' })
    const written = formatNumber(await numberOf(target))
    const typo = written.slice(0, 5) + ((Number(written[5]) + 1) % 10)
    const byPhone = await contact(f.a, { last: 'Osei', phone: `01452 ${typo}` })
    const found = await list(typo)
    expect(found.invalidNumber).toBe(
      `${typo} isn’t a valid contact number. Check the last digit.`,
    )
    expect(found.numberMatch).toBeNull()
    expect(found.rows.map((r) => r._id)).toEqual([byPhone])
  })

  test('no prefix matching, and the number is not in the search text', async () => {
    const target = await contact(f.a, { last: 'Mensah' })
    const written = formatNumber(await numberOf(target))
    for (const typed of [written.slice(0, 4), written.slice(0, 3)]) {
      const found = await list(typed)
      expect(found.rows, typed).toEqual([])
      expect(found.numberMatch, typed).toBeNull()
    }
    const text = await f.t.run(async (ctx) =>
      (await ctx.db.query('contactSearch').collect()).map((r) => r.text),
    )
    for (const t of text) {
      expect(t).not.toContain(written)
      expect(t).not.toContain(written.slice(0, 5))
    }
  })

  test('the number match respects the filters: archived and kind', async () => {
    const target = await contact(f.a, { org: 'Ludlow Hall' })
    const written = formatNumber(await numberOf(target))
    expect(await ids(written, { kind: 'individual' })).toEqual([])
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: target,
      expected: 0,
      archived: true,
    })
    const hidden = await list(written)
    expect(hidden.rows).toEqual([])
    expect(hidden.numberMatch).toBeNull()
    expect(await ids(written, { includeArchived: true })).toEqual([target])
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

  test("B's contact number never finds A's contact", async () => {
    // A's third contact has a number B hasn't reached; B's first has the
    // same number as A's first.
    const aFirst = await contact(f.a, { last: 'Achterberg' })
    await contact(f.a, { last: 'Mensah' })
    const aThird = await contact(f.a, { last: 'Okonjo' })
    const bFirst = await contact(f.b, { last: 'Haddad' })
    const number = (id: Id<'contacts'>) =>
      f.t.run(async (ctx) => formatNumber((await ctx.db.get(id))!.number!))
    const shared = await number(aFirst)
    expect(await number(bFirst)).toBe(shared)

    const inB = await list(shared, {}, f.b)
    expect(inB.rows.map((r) => r._id)).toEqual([bFirst])
    expect(inB.numberMatch).toBe(bFirst)
    const aOnly = await number(aThird)
    for (const typed of [aOnly, aOnly.slice(0, 5)]) {
      const found = await list(typed, {}, f.b)
      expect(found.rows, typed).toEqual([])
      expect(found.numberMatch, typed).toBeNull()
    }
    expect(await ids(shared)).toEqual([aFirst])
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
