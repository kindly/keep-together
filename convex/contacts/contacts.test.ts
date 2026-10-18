import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api, internal } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import { contactWarnings } from './warnings'

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

  test('byClientKey finds the contact a form created, in its own tenant only', async () => {
    const byKey = (
      who: typeof f.a,
      tenantId: Id<'tenants'>,
      clientKey: string,
    ) => who.as.query(api.contacts.queries.byClientKey, { tenantId, clientKey })
    expect(await byKey(f.a, f.a.tenantId, 'form-1')).toBeNull()
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
      clientKey: 'form-1',
    })
    // The same view `get` gives, so the contact page can render it.
    expect(await byKey(f.a, f.a.tenantId, 'form-1')).toEqual(
      await f.a.as.query(api.contacts.queries.get, {
        tenantId: f.a.tenantId,
        id,
      }),
    )
    // B, in its own tenant, with A's key: nothing.
    expect(await byKey(f.b, f.b.tenantId, 'form-1')).toBeNull()
    // B naming A's tenant: refused.
    const data = await errorData(byKey(f.b, f.a.tenantId, 'form-1'))
    expect(data.kind).toBe('forbidden')
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
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

describe('email lookup', () => {
  const findByEmail = (tenant: Fixture['a'], emailAddress: string) =>
    f.t
      .query(internal.contacts.queries.findByEmail, {
        tenantId: tenant.tenantId,
        address: emailAddress,
      })
      .then((r) => r.contacts)
  const createWithEmail = async (
    tenant: Fixture['a'],
    lastName: string,
    emailAddress: string,
  ) => {
    const id = await tenant.as.mutation(api.contacts.mutations.create, {
      tenantId: tenant.tenantId,
      ...individual,
      firstName: 'Ann',
      lastName,
    })
    await tenant.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: tenant.tenantId,
      id,
      expected: 0,
      emails: [email(emailAddress)],
      phones: [],
    })
    return id
  }

  test('lookup ignores case and surrounding whitespace', async () => {
    await saveMethods(0, [email(' Ann@Example.com ')])
    const got = await getAda()
    expect(got?.emails[0].address).toBe('Ann@Example.com')
    expect(got?.emails[0].addressNormalized).toBe('ann@example.com')
    const found = await findByEmail(f.a, '  ANN@example.COM ')
    expect(found.map((c) => c._id)).toEqual([ada])
    expect(await findByEmail(f.a, 'nobody@example.com')).toEqual([])
  })

  test('addressNormalized survives a kept-key reconcile', async () => {
    await saveMethods(0, [email('Ann@Example.com', { key: 'e1' })])
    await saveMethods(1, [
      email('Ann@Example.com', { key: 'e1', label: 'work' }),
    ])
    const row = (await getAda())!.emails[0]
    expect(row.label).toBe('work')
    expect(row.addressNormalized).toBe('ann@example.com')
  })

  test('remove + add of a changed address moves the lookup', async () => {
    await saveMethods(0, [email('old@x.com', { key: 'e1' })])
    await saveMethods(1, [email('new@x.com', { key: 'e2' })])
    expect(await findByEmail(f.a, 'old@x.com')).toEqual([])
    expect((await findByEmail(f.a, 'NEW@x.com')).map((c) => c._id)).toEqual([
      ada,
    ])
  })

  test('the list finds a contact by exact email', async () => {
    await saveMethods(0, [email('countess@analytical.org')])
    const list = await f.a.as
      .query(api.contacts.queries.list, {
        tenantId: f.a.tenantId,
        search: ' Countess@Analytical.org',
      })
      .then((r) => r.rows)
    expect(list.map((c) => c._id)).toEqual([ada])
  })

  test('a shared address saves on both, each warned naming the other', async () => {
    await saveMethods(0, [email('ann@example.com', { key: 'e1' })])
    const bob = await createWithEmail(f.a, 'Smith', 'ANN@example.com')
    const adaWarnings = (await getAda())!.warnings
    expect(adaWarnings).toEqual([
      expect.objectContaining({
        anchor: 'emails#e1',
        message: 'Also used by Ann Smith',
      }),
    ])
    const other = await f.a.as.query(api.contacts.queries.get, {
      tenantId: f.a.tenantId,
      id: bob,
    })
    expect(other!.warnings).toEqual([
      expect.objectContaining({
        anchor: `emails#${other!.emails[0].key}`,
        message: 'Also used by Ada Lovelace',
      }),
    ])
    expect(
      (await findByEmail(f.a, 'ann@example.com')).map((c) => c._id).sort(),
    ).toEqual([ada, bob].sort())
  })

  test('the same address in another tenant is invisible', async () => {
    await saveMethods(0, [email('Ann@Example.com')])
    const before = await snapshot(f.t, f.b.tenantId)
    expect(before).toBe(bSnapshot)
    const inB = await createWithEmail(f.b, 'Beta', 'ann@example.com')
    expect(
      (await findByEmail(f.b, 'Ann@Example.com')).map((c) => c._id),
    ).toEqual([inB])
    expect(
      (await findByEmail(f.a, 'Ann@Example.com')).map((c) => c._id),
    ).toEqual([ada])
    expect((await getAda())!.warnings).toEqual([])
    const bList = await f.b.as
      .query(api.contacts.queries.list, {
        tenantId: f.b.tenantId,
        search: 'ann@example.com',
      })
      .then((r) => r.rows)
    expect(bList.map((c) => c._id)).toEqual([inB])
  })
})

describe('shared-email warning (pure)', () => {
  const sharers = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      displayName: `P${i + 1}`,
      archived: false,
    }))
  const warn = (n: number, truncated = false) =>
    contactWarnings(
      {
        emails: [
          { key: 'k1', address: 'a@x.com' },
          { key: 'k2', address: 'b@x.com' },
        ],
        phones: [],
        addresses: [],
      },
      { k2: { contacts: sharers(n), truncated } },
    )

  test('anchored by row key, not position', () => {
    expect(warn(1)).toEqual([
      { anchor: 'emails#k2', label: 'email 2', message: 'Also used by P1' },
    ])
  })

  test('names the first three, then counts the rest', () => {
    expect(warn(3)[0].message).toBe('Also used by P1, P2, P3')
    expect(warn(4)[0].message).toBe('Also used by P1, P2, P3 and 1 other')
    expect(warn(6)[0].message).toBe('Also used by P1, P2, P3 and 3 others')
    expect(warn(6, true)[0].message).toBe(
      'Also used by P1, P2, P3 and at least 3 others',
    )
  })

  test('no sharers, no warning', () => {
    expect(warn(0)).toEqual([])
  })
})

describe('email lookup edges', () => {
  const findIds = async (tenant: Fixture['a'], emailAddress: string) =>
    (
      await f.t.query(internal.contacts.queries.findByEmail, {
        tenantId: tenant.tenantId,
        address: emailAddress,
      })
    ).contacts.map((c) => c._id)
  const listIds = async (
    tenant: Fixture['a'],
    search: string,
    includeArchived = false,
  ) =>
    (
      await tenant.as
        .query(api.contacts.queries.list, {
          tenantId: tenant.tenantId,
          search,
          includeArchived,
        })
        .then((r) => r.rows)
    ).map((c) => c._id)
  const createWithEmail = async (
    tenant: Fixture['a'],
    lastName: string,
    emailAddress: string,
  ) => {
    const id = await tenant.as.mutation(api.contacts.mutations.create, {
      tenantId: tenant.tenantId,
      ...individual,
      firstName: 'Ann',
      lastName,
    })
    await tenant.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: tenant.tenantId,
      id,
      expected: 0,
      emails: [email(emailAddress)],
      phones: [],
    })
    return id
  }
  const archive = (tenant: Fixture['a'], id: Id<'contacts'>) =>
    tenant.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: tenant.tenantId,
      id,
      expected: 0,
      archived: true,
    })

  test('two emails that normalise the same are rejected and nothing saves', async () => {
    const data = await errorData(
      saveMethods(0, [email(' ann@x.com'), email('ANN@X.COM  ')]),
    )
    expect(data.kind).toBe('invalid')
    expect((data.problems as Array<{ field: string }>)[0].field).toBe('emails')
    const got = await getAda()
    expect(got?.emails).toEqual([])
    expect(got?.contact.methodsVersion).toBe(0)
  })

  test('a case-only change on a kept key is rejected, never re-normalised', async () => {
    await saveMethods(0, [email('Ann@Example.com', { key: 'e1' })])
    const data = await errorData(
      saveMethods(1, [email('ann@example.com', { key: 'e1' })]),
    )
    expect(data).toMatchObject({ kind: 'rejected', reason: 'immutable_child' })
    const got = (await getAda())!
    expect(got.emails[0].address).toBe('Ann@Example.com')
    expect(got.contact.methodsVersion).toBe(1)
  })

  test('surrounding whitespace on a kept key is not a change', async () => {
    await saveMethods(0, [email('ann@x.com', { key: 'e1' })])
    const before = (await getAda())!.emails[0]
    await saveMethods(1, [email('  ann@x.com ', { key: 'e1', label: 'work' })])
    const after = (await getAda())!.emails[0]
    expect(after._id).toBe(before._id)
    expect(after.address).toBe('ann@x.com')
    expect(after.addressNormalized).toBe('ann@x.com')
    expect(after.label).toBe('work')
  })

  test('remove + add of a re-cased address in one save swaps the row', async () => {
    await saveMethods(0, [email('Ann@Example.com', { key: 'e1' })])
    await saveMethods(1, [email('ANN@example.com', { key: 'e2' })])
    const got = (await getAda())!
    expect(
      got.emails.map((e) => [e.key, e.address, e.addressNormalized]),
    ).toEqual([['e2', 'ANN@example.com', 'ann@example.com']])
    expect(await findIds(f.a, 'ann@example.com')).toEqual([ada])
  })

  test('a blank lookup finds nothing, even with a blank address stored', async () => {
    await saveMethods(0, [email('   ')])
    expect(await findIds(f.a, '')).toEqual([])
    expect(await findIds(f.a, '   ')).toEqual([])
  })

  test('the form save and restore both set the lookup field', async () => {
    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: ada,
      methods: {
        expected: 0,
        emails: [email('Form@X.com', { key: 'e1' })],
        phones: [],
      },
    })
    expect(await findIds(f.a, 'form@x.com')).toEqual([ada])
    await saveMethods(1, [])
    expect(await findIds(f.a, 'form@x.com')).toEqual([])
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
    expect((await getAda())!.emails[0].addressNormalized).toBe('form@x.com')
    expect(await findIds(f.a, 'FORM@x.com')).toEqual([ada])
  })

  test('a stale methods save leaves the lookup unchanged', async () => {
    await saveMethods(0, [email('kept@x.com')])
    const data = await errorData(saveMethods(0, [email('loser@x.com')]))
    expect(data).toMatchObject({
      kind: 'stale',
      contract: 'contacts.methods',
      current: 1,
    })
    expect(await findIds(f.a, 'loser@x.com')).toEqual([])
    expect(await findIds(f.a, 'kept@x.com')).toEqual([ada])
  })

  test('findByEmail includes archived contacts; the list hides them unless asked', async () => {
    await saveMethods(0, [email('ann@example.com')])
    await archive(f.a, ada)
    expect(await findIds(f.a, 'Ann@Example.com')).toEqual([ada])
    expect(await listIds(f.a, 'ann@example.com')).toEqual([])
    expect(await listIds(f.a, 'ann@example.com', true)).toEqual([ada])
  })

  test('an archived contact sharing the address is named and marked archived', async () => {
    await saveMethods(0, [email('ann@example.com', { key: 'e1' })])
    const bob = await createWithEmail(f.a, 'Smith', 'ann@example.com')
    await archive(f.a, bob)
    expect((await getAda())!.warnings).toEqual([
      expect.objectContaining({
        anchor: 'emails#e1',
        message: 'Also used by Ann Smith (archived)',
      }),
    ])
  })

  test('findByEmail returns the 50 oldest contacts sharing an address and flags the rest', async () => {
    await saveMethods(0, [email('shared@x.com')])
    const ids = [ada]
    for (let i = 1; i <= 50; i++) {
      ids.push(await createWithEmail(f.a, `Shared${i}`, 'Shared@X.com'))
    }
    const found = await findIds(f.a, 'shared@x.com')
    expect(found).toHaveLength(50)
    expect(found).toEqual(ids.slice(0, 50))
    const raw = await f.t.query(internal.contacts.queries.findByEmail, {
      tenantId: f.a.tenantId,
      address: 'shared@x.com',
    })
    expect(raw.truncated).toBe(true)
    // The 51st still sees the shared address; three names, then a lower bound.
    const last = await f.a.as.query(api.contacts.queries.get, {
      tenantId: f.a.tenantId,
      id: ids[50],
    })
    expect(last!.warnings).toHaveLength(1)
    expect(last!.warnings[0].message).toBe(
      'Also used by Ada Lovelace, Ann Shared1, Ann Shared2 and at least 47 others',
    )
    // No match: nothing to flag.
    const exact = await f.t.query(internal.contacts.queries.findByEmail, {
      tenantId: f.a.tenantId,
      address: 'nobody@x.com',
    })
    expect(exact).toEqual({ contacts: [], truncated: false })
    expect(await listIds(f.a, 'shared@x.com')).toEqual(ids.slice(0, 50))
  })

  test('tenant isolation on every lookup path', async () => {
    await saveMethods(0, [email('Ann@Example.com', { key: 'e1' })])
    await errorData(saveMethods(1, [email('ann@example.com', { key: 'e1' })]))
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
    const inB = await createWithEmail(f.b, 'Beta', 'ann@example.com')
    // A's list never returns B's contact, and B's warning never names A's.
    expect(await listIds(f.a, 'ann@example.com', true)).toEqual([ada])
    const bGot = await f.b.as.query(api.contacts.queries.get, {
      tenantId: f.b.tenantId,
      id: inB,
    })
    expect(bGot!.warnings).toEqual([])
    expect(await findIds(f.b, 'ANN@example.com')).toEqual([inB])
    // B's member cannot search A's tenant.
    const forbidden = await errorData(
      f.b.as
        .query(api.contacts.queries.list, {
          tenantId: f.a.tenantId,
          search: 'ann@example.com',
        })
        .then((r) => r.rows),
    )
    expect(forbidden.kind).toBe('forbidden')
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
    const list = await f.a.as
      .query(api.contacts.queries.list, {
        tenantId: f.a.tenantId,
      })
      .then((r) => r.rows)
    expect(list.map((c) => c._id)).not.toContain(ada)
    const all = await f.a.as
      .query(api.contacts.queries.list, {
        tenantId: f.a.tenantId,
        includeArchived: true,
      })
      .then((r) => r.rows)
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
      await f.b.as
        .query(api.contacts.queries.list, {
          tenantId: f.b.tenantId,
          includeArchived: true,
        })
        .then((r) => r.rows),
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
