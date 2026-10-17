import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>

const individual = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
  externalIdentifier: '',
}
const organisation = {
  kind: 'organization' as const,
  title: '',
  firstName: '',
  lastName: '',
  nickname: '',
  name: 'Anytown Hall',
  isDeceased: false,
  externalIdentifier: '',
}
const email = (
  address: string,
  extra: Partial<{
    key: string
    isPrimary: boolean
    label: 'home' | 'work' | 'other'
  }> = {},
) => ({
  label: 'home' as const,
  address,
  isPrimary: false,
  ...extra,
})
const address = (
  postcode: string,
  extra: Partial<{ key: string; country: string; line1: string }> = {},
) => ({
  label: 'home' as const,
  line1: '1 High St',
  line2: '',
  line3: '',
  town: 'Stroud',
  postcode,
  country: 'GB',
  isPrimary: false,
  ...extra,
})

let f: Fixture
let ada: Id<'contacts'>
let bSnapshot: string

beforeEach(async () => {
  f = await setup()
  bSnapshot = await snapshot(f.t, f.b.tenantId)
  ada = await f.a.as.mutation(api.contacts.mutations.create, {
    tenantId: f.a.tenantId,
    ...individual,
  })
})

const getAda = () =>
  f.a.as.query(api.contacts.queries.get, { tenantId: f.a.tenantId, id: ada })
const saveMethods = (
  expected: number,
  emails: Array<ReturnType<typeof email>>,
  phones: Array<{
    key?: string
    label: 'home'
    number: string
    isPrimary: boolean
  }> = [],
) =>
  f.a.as.mutation(api.contacts.mutations.saveMethods, {
    tenantId: f.a.tenantId,
    id: ada,
    expected,
    emails,
    phones,
  })
const saveAddresses = (
  expected: number,
  addresses: Array<ReturnType<typeof address>>,
) =>
  f.a.as.mutation(api.contacts.mutations.saveAddresses, {
    tenantId: f.a.tenantId,
    id: ada,
    expected,
    addresses,
  })

describe('details', () => {
  test('individual names computed', async () => {
    const got = await getAda()
    expect(got?.contact.displayName).toBe('Ada Lovelace')
    expect(got?.contact.sortName).toBe('Lovelace, Ada')
  })

  test('organisation names computed', async () => {
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...organisation,
    })
    const got = await f.a.as.query(api.contacts.queries.get, {
      tenantId: f.a.tenantId,
      id,
    })
    expect(got?.contact.displayName).toBe('Anytown Hall')
    expect(got?.contact.sortName).toBe('Anytown Hall')
  })

  test('individual requires a last name', async () => {
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.create, {
        tenantId: f.a.tenantId,
        ...individual,
        lastName: '',
      }),
    )
    expect(data.kind).toBe('invalid')
    expect((data.problems as Array<{ field: string }>)[0].field).toBe(
      'lastName',
    )
  })

  test('organisation rejects individual fields', async () => {
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.create, {
        tenantId: f.a.tenantId,
        ...organisation,
        firstName: 'x',
      }),
    )
    expect(data.kind).toBe('invalid')
  })

  test('deceased date requires the flag', async () => {
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.create, {
        tenantId: f.a.tenantId,
        ...individual,
        deceasedDate: '2020-01-01',
      }),
    )
    expect(data.kind).toBe('invalid')
  })

  test('kind cannot change', async () => {
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.saveDetails, {
        tenantId: f.a.tenantId,
        id: ada,
        expected: 0,
        ...organisation,
      }),
    )
    expect(data.kind).toBe('rejected')
    expect(data.reason).toBe('kind_change')
  })

  test('create with clientKey is idempotent', async () => {
    const first = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
      clientKey: 'k1',
    })
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.create, {
        tenantId: f.a.tenantId,
        ...individual,
        clientKey: 'k1',
      }),
    )
    expect(data).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate',
      message: first,
    })
  })

  test('external identifier unique per tenant', async () => {
    await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
      externalIdentifier: 'X1',
    })
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.create, {
        tenantId: f.a.tenantId,
        ...individual,
        externalIdentifier: 'X1',
      }),
    )
    expect(data.reason).toBe('duplicate_external_identifier')
    // Same identifier in another tenant is fine.
    await f.b.as.mutation(api.contacts.mutations.create, {
      tenantId: f.b.tenantId,
      ...individual,
      externalIdentifier: 'X1',
    })
  })
})

describe('methods (child rows)', () => {
  test('replace set', async () => {
    await saveMethods(0, [email('a@x.com'), email('b@x.com')])
    expect((await getAda())?.emails).toHaveLength(2)
    await saveMethods(1, [email('b@x.com')])
    const got = await getAda()
    expect(got?.emails.map((e) => e.address)).toEqual(['b@x.com'])
  })

  test('first entry promoted to primary', async () => {
    await saveMethods(0, [email('a@x.com'), email('b@x.com')])
    const got = await getAda()
    expect(
      got?.emails.filter((e) => e.isPrimary).map((e) => e.address),
    ).toEqual(['a@x.com'])
  })

  test('two primaries rejected', async () => {
    const data = await errorData(
      saveMethods(0, [
        email('a@x.com', { isPrimary: true }),
        email('b@x.com', { isPrimary: true }),
      ]),
    )
    expect(data.kind).toBe('invalid')
  })

  test('duplicate emails rejected, case-insensitively', async () => {
    const data = await errorData(
      saveMethods(0, [email('a@x.com'), email('A@X.com')]),
    )
    expect(data.kind).toBe('invalid')
  })

  test('malformed email saves and is warned, not blocked', async () => {
    await saveMethods(0, [email('not-an-email')])
    const got = await getAda()
    expect(got?.emails[0].address).toBe('not-an-email')
    expect(got?.warnings.map((w) => w.anchor)).toEqual(['emails.0'])
  })

  test('kept keys leave rows untouched and onHold survives', async () => {
    await saveMethods(0, [email('a@x.com', { key: 'e1' })])
    const before = (await getAda())!.emails[0]
    await f.t.run(async (ctx) => {
      await ctx.db.patch('contactEmails', before._id, { onHold: true })
    })
    await saveMethods(1, [email('a@x.com', { key: 'e1', label: 'work' })])
    const after = (await getAda())!.emails[0]
    expect(after._id).toBe(before._id)
    expect(after.label).toBe('work')
    expect(after.onHold).toBe(true)
  })

  test('identity fields are immutable per key', async () => {
    await saveMethods(0, [email('a@x.com', { key: 'e1' })])
    const data = await errorData(
      saveMethods(1, [email('b@x.com', { key: 'e1' })]),
    )
    expect(data).toMatchObject({ kind: 'rejected', reason: 'immutable_child' })
  })

  test('row key of another contact rejected', async () => {
    const other = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...organisation,
    })
    await f.a.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: f.a.tenantId,
      id: other,
      expected: 0,
      emails: [email('o@x.com', { key: 'shared' })],
      phones: [],
    })
    const data = await errorData(
      saveMethods(0, [email('o@x.com', { key: 'shared' })]),
    )
    expect(data).toMatchObject({ kind: 'rejected', reason: 'child_ownership' })
  })

  test('duplicate row keys rejected', async () => {
    const data = await errorData(
      saveMethods(0, [
        email('a@x.com', { key: 'k' }),
        email('b@x.com', { key: 'k' }),
      ]),
    )
    expect(data.kind).toBe('invalid')
  })
})

describe('addresses', () => {
  test('postcode normalised, country upper-cased', async () => {
    await saveAddresses(0, [address(' gl5 1dl ', { country: 'gb' })])
    const got = await getAda()
    expect(got?.addresses[0].postcode).toBe('GL5 1DL')
    expect(got?.addresses[0].country).toBe('GB')
    expect(got?.warnings).toEqual([])
  })

  test('bad UK postcode saved and warned', async () => {
    await saveAddresses(0, [address('NOT A CODE')])
    const got = await getAda()
    expect(got?.addresses[0].postcode).toBe('NOT A CODE')
    expect(got?.warnings.map((w) => w.anchor)).toEqual(['addresses.0'])
  })

  test('non-GB postcode not checked', async () => {
    await saveAddresses(0, [address('75001', { country: 'FR' })])
    expect((await getAda())?.warnings).toEqual([])
  })

  test('address fields update in place by key', async () => {
    await saveAddresses(0, [address('GL5 1DL', { key: 'a1' })])
    const before = (await getAda())!.addresses[0]
    await saveAddresses(1, [
      address('GL5 1DX', { key: 'a1', line1: '2 High St' }),
    ])
    const after = (await getAda())!.addresses[0]
    expect(after._id).toBe(before._id)
    expect(after.postcode).toBe('GL5 1DX')
    expect(after.line1).toBe('2 High St')
  })
})

describe('counters and conflicts', () => {
  test('slices do not conflict with each other', async () => {
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      ...individual,
      nickname: 'Countess',
    })
    await saveMethods(0, [email('a@x.com')]) // methods still at 0
    const got = await getAda()
    expect(got?.contact.detailsVersion).toBe(1)
    expect(got?.contact.methodsVersion).toBe(1)
  })

  test('same slice conflicts and leaves no trace', async () => {
    await saveMethods(0, [email('a@x.com')])
    const data = await errorData(saveMethods(0, [email('loser@x.com')]))
    expect(data).toMatchObject({
      kind: 'stale',
      contract: 'contacts.methods',
      current: 1,
    })
    const got = await getAda()
    expect(got?.emails.map((e) => e.address)).toEqual(['a@x.com'])
    const history = await f.a.as.query(api.contacts.queries.history, {
      tenantId: f.a.tenantId,
      id: ada,
    })
    expect(history.map((m) => m.slices)).toEqual([['methods'], ['details']])
  })

  test('archive toggles with its own counter', async () => {
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      archived: true,
    })
    expect((await getAda())?.contact.archived).toBe(true)
    const list = await f.a.as.query(api.contacts.queries.list, {
      tenantId: f.a.tenantId,
    })
    expect(list.map((c) => c._id)).not.toContain(ada)
    const all = await f.a.as.query(api.contacts.queries.list, {
      tenantId: f.a.tenantId,
      includeArchived: true,
    })
    expect(all.map((c) => c._id)).toContain(ada)
  })
})

describe('the form save', () => {
  const form = (args: Record<string, unknown>) =>
    f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: ada,
      ...args,
    })

  test('no-op save creates no revisions', async () => {
    const result = await form({ details: { expected: 0, ...individual } })
    expect(result.saved).toEqual([])
    expect(result.counters.details).toBe(0)
  })

  test('one changed slice = one command', async () => {
    const result = await form({
      details: { expected: 0, ...individual, nickname: 'Countess' },
      methods: { expected: 0, emails: [], phones: [] },
    })
    expect(result.saved).toEqual(['details'])
    expect(result.counters).toMatchObject({ details: 1, methods: 0 })
  })

  test('multi-slice save shares a command group', async () => {
    await form({
      details: { expected: 0, ...individual, nickname: 'Countess' },
      methods: { expected: 0, emails: [email('a@x.com')], phones: [] },
    })
    const history = await f.a.as.query(api.contacts.queries.history, {
      tenantId: f.a.tenantId,
      id: ada,
    })
    expect(history[0].slices.sort()).toEqual(['details', 'methods'])
    expect(history[0].groupName).toBe('contact form save')
  })

  test('blocking error in one slice still saves the others', async () => {
    const result = await form({
      details: { expected: 0, ...individual, lastName: '' },
      methods: { expected: 0, emails: [email('a@x.com')], phones: [] },
    })
    expect(result.saved).toEqual(['methods'])
    expect(result.problems.details?.[0].field).toBe('lastName')
  })

  test('stale slice is reported and never overwrites', async () => {
    await saveMethods(0, [email('theirs@x.com')])
    const result = await form({
      details: { expected: 0, ...individual, nickname: 'Countess' },
      methods: { expected: 0, emails: [email('mine@x.com')], phones: [] },
    })
    expect(result.saved).toEqual(['details'])
    expect(result.stale).toEqual({ methods: 1 })
    expect((await getAda())?.emails.map((e) => e.address)).toEqual([
      'theirs@x.com',
    ])
  })
})

describe('history and restore', () => {
  test('restore recreates removed rows with their keys', async () => {
    await saveMethods(0, [email('a@x.com', { key: 'e1' })])
    await saveMethods(1, [])
    const history = await f.a.as.query(api.contacts.queries.history, {
      tenantId: f.a.tenantId,
      id: ada,
    })
    const withEmail = history.find(
      (m) => m.slices.includes('methods') && m.at < history[0].at,
    )!
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: withEmail.revisionId,
    })
    const got = await getAda()
    expect(got?.emails.map((e) => e.key)).toEqual(['e1'])
    expect(got?.contact.methodsVersion).toBe(3)
  })

  test('restore to a moment reverts the whole contact in one grouped entry', async () => {
    await saveMethods(0, [email('a@x.com', { key: 'e1' })])
    const moment = (
      await f.a.as.query(api.contacts.queries.history, {
        tenantId: f.a.tenantId,
        id: ada,
      })
    )[0].at
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      ...individual,
      lastName: 'Byron',
    })
    await saveMethods(1, [])
    const result = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: moment,
    })
    expect(result.restored.sort()).toEqual([
      'contacts.details',
      'contacts.methods',
    ])
    const got = await getAda()
    expect(got?.contact.lastName).toBe('Lovelace')
    expect(got?.emails.map((e) => e.address)).toEqual(['a@x.com'])
    const history = await f.a.as.query(api.contacts.queries.history, {
      tenantId: f.a.tenantId,
      id: ada,
    })
    expect(history[0].restored).toBe(true)
    expect(history[0].groupName).toMatch(/^restore to /)
    expect(history[0].slices.sort()).toEqual(['details', 'methods'])
  })

  test('restore to the current moment is a no-op', async () => {
    const now = Date.now() + 1000
    const result = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: now,
    })
    expect(result).toEqual({ restored: [], group: null })
  })
})

describe('relationships', () => {
  test('seeded types present', async () => {
    const types = await f.a.as.query(api.contacts.relationships.types, {
      tenantId: f.a.tenantId,
    })
    expect(types.map((t) => t.labelAB)).toContain('Employee of')
    expect(types).toHaveLength(7)
  })

  test('create, kind compatibility and self-relationship', async () => {
    const types = await f.a.as.query(api.contacts.relationships.types, {
      tenantId: f.a.tenantId,
    })
    const employee = types.find((t) => t.labelAB === 'Employee of')!
    const org = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...organisation,
    })
    await f.a.as.mutation(api.contacts.relationships.save, {
      tenantId: f.a.tenantId,
      contactA: ada,
      contactB: org,
      typeId: employee._id,
      isActive: true,
      description: '',
    })
    const rels = await f.a.as.query(api.contacts.relationships.forContact, {
      tenantId: f.a.tenantId,
      id: org,
    })
    expect(rels[0]).toMatchObject({
      otherName: 'Ada Lovelace',
      label: 'Employer of',
    })

    const wrongWay = await errorData(
      f.a.as.mutation(api.contacts.relationships.save, {
        tenantId: f.a.tenantId,
        contactA: org,
        contactB: ada,
        typeId: employee._id,
        isActive: true,
        description: '',
      }),
    )
    expect(wrongWay.reason).toBe('kind_mismatch')

    const self = await errorData(
      f.a.as.mutation(api.contacts.relationships.save, {
        tenantId: f.a.tenantId,
        contactA: ada,
        contactB: ada,
        typeId: employee._id,
        isActive: true,
        description: '',
      }),
    )
    expect(self.kind).toBe('invalid')
  })
})

describe('tenant isolation', () => {
  test('tenant B observes nothing of tenant A', async () => {
    await saveMethods(0, [email('a@x.com')])
    await saveAddresses(0, [address('GL5 1DL')])
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      archived: true,
    })
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
    expect(
      await f.b.as.query(api.contacts.queries.list, {
        tenantId: f.b.tenantId,
        includeArchived: true,
      }),
    ).toEqual([])
    expect(
      await f.b.as.query(api.contacts.queries.get, {
        tenantId: f.b.tenantId,
        id: ada,
      }),
    ).toBeNull()
    const data = await errorData(
      f.b.as.mutation(api.contacts.mutations.saveDetails, {
        tenantId: f.b.tenantId,
        id: ada,
        expected: 0,
        ...individual,
      }),
    )
    expect(data.kind).toBe('not_found')
    // B's member cannot even call into A's tenant.
    const forbidden = await errorData(
      f.b.as.query(api.contacts.queries.get, {
        tenantId: f.a.tenantId,
        id: ada,
      }),
    )
    expect(forbidden.kind).toBe('forbidden')
  })
})
