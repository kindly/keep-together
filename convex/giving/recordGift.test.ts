/**
 * `giving.recordGift`, the record-gift page's one save (cash gifts plan,
 * step 2): contact, acquisition code, gift and declaration in one mutation
 * and one named command group, all or nothing.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FunctionArgs } from 'convex/server'
import type { Doc, Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { declarationWarnings } from '../giftaid/warnings'
import { HMRC_MODEL_WORDING_VERSION } from '../giftaid/validators'

type Fixture = Awaited<ReturnType<typeof setup>>
type Code = {
  category: Id<'sourceCodes'>
  detail: Id<'sourceCodes'>
  version: Id<'sourceCodes'>
}

let f: Fixture
let aSnapshot: string
let bSnapshot: string
let street: Code
let online: Code

/** A detail (with its version 001) under a seeded category. */
async function code(who: Tenant, category: string, detail: string) {
  const parent = await f.t.run((ctx) =>
    ctx.db
      .query('sourceCodes')
      .withIndex('by_tenant_parent', (q) =>
        q
          .eq('tenantId', who.tenantId)
          .eq('parentId', undefined)
          .eq('nameNormalized', category.toLowerCase()),
      )
      .unique(),
  )
  const made = await who.as.mutation(api.sources.mutations.create, {
    tenantId: who.tenantId,
    parentId: parent!._id,
    name: detail,
    isActive: true,
  })
  return { category: parent!._id, detail: made.id, version: made.versionId! }
}

const person = {
  kind: 'individual' as const,
  firstName: 'Jo',
  lastName: 'Bloggs',
  name: '',
}

const organisation = {
  kind: 'organization' as const,
  firstName: '',
  lastName: '',
  name: 'Acme Ltd',
}

/** An existing contact, made the usual way (no acquisition code). */
const existing = (
  who: Tenant,
  details: Partial<Omit<typeof person, 'kind'>> & {
    kind?: 'individual' | 'organization'
  } = {},
  acquisitionCodeId?: Id<'sourceCodes'>,
) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...person,
    title: '',
    nickname: '',
    isDeceased: false,
    ...details,
    acquisitionCodeId,
  })

type RecordArgs = Omit<
  FunctionArgs<typeof api.giving.mutations.recordGift>,
  'tenantId'
>

function recordWith(args: RecordArgs, who: Tenant = f.a) {
  return who.as.mutation(api.giving.mutations.recordGift, {
    tenantId: who.tenantId,
    ...args,
  })
}

/** £20 cash under Street-Wesser-001 from a new Jo Bloggs, plus `over`. */
function record(over: Partial<RecordArgs> = {}, who: Tenant = f.a) {
  const amount = over.amount ?? 2000n
  return recordWith(
    {
      contact: person,
      receivedOn: '2026-10-20',
      amount,
      method: 'cash',
      allocations: [{ sourceCodeId: street.version, amount }],
      ...over,
    },
    who,
  )
}

const get = <T extends 'contacts' | 'contributions' | 'giftAidDeclarations'>(
  id: Id<T>,
) => f.t.run((ctx) => ctx.db.get(id)) as Promise<Doc<T>>

const rowsOf = <T extends 'contactEmails' | 'contactAddresses'>(
  table: T,
  contactId: Id<'contacts'>,
) =>
  f.t.run((ctx) =>
    ctx.db
      .query(table as 'contactAddresses')
      .withIndex('by_tenant_contact', (q) =>
        q.eq('tenantId', f.a.tenantId).eq('contactId', contactId),
      )
      .collect(),
  ) as unknown as Promise<Array<Doc<T>>>

/** Every revision of tenant A, with the group it ran under. */
const revisionsOfA = () =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('revisions').collect()).filter(
      (r) => r.tenantId === f.a.tenantId,
    ),
  )

const groupsOfA = () =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('commandGroups').collect()).filter(
      (g) => g.tenantId === f.a.tenantId,
    ),
  )

/** Another member of tenant A with `role`. */
async function member(role: 'admin' | 'staff' | 'viewer'): Promise<Tenant> {
  const userId = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: `${role}@a.test` })
    await ctx.db.insert('memberships', {
      tenantId: f.a.tenantId,
      userId: id,
      role,
    })
    return id
  })
  return {
    tenantId: f.a.tenantId,
    userId,
    as: f.t.withIdentity({ subject: `${userId}|session-${role}` }),
  }
}

beforeEach(async () => {
  // Declarations can't be made after today (UK time).
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 23, 12)))
  f = await setup()
  street = await code(f.a, 'Street', 'Wesser')
  online = await code(f.a, 'Online', 'Spring')
  bSnapshot = await snapshot(f.t, f.b.tenantId)
})

afterEach(async () => {
  // Tenant B saw nothing of what tenant A did.
  expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  vi.useRealTimers()
})

describe('a new contact', () => {
  test('is created with a number, the gift’s code as acquisition code, email and address', async () => {
    const { contactId, giftId, declarationId } = await record({
      contact: { ...person, email: ' jo@example.com ' },
      home: { line1: '12 High St', postcode: 'ab1 2cd' },
    })
    const contact = await get(contactId)
    expect(contact).toMatchObject({
      kind: 'individual',
      firstName: 'Jo',
      lastName: 'Bloggs',
      acquisitionCodeId: street.version,
    })
    expect(contact.number).toBeGreaterThan(0)
    expect(
      (await rowsOf('contactEmails', contactId)).map((e) => e.address),
    ).toEqual(['jo@example.com'])
    expect(await rowsOf('contactAddresses', contactId)).toMatchObject([
      { line1: '12 High St', postcode: 'AB1 2CD', isPrimary: true },
    ])
    expect(await get(giftId)).toMatchObject({
      contactId,
      amount: 2000n,
      status: 'completed',
      enteredBy: f.a.userId,
    })
    expect(declarationId).toBeNull()
  })

  test('an organisation needs only its name', async () => {
    const { contactId, giftId } = await record({ contact: organisation })
    expect(await get(contactId)).toMatchObject({
      kind: 'organization',
      name: 'Acme Ltd',
      acquisitionCodeId: street.version,
    })
    expect((await get(giftId)).contactId).toBe(contactId)
  })

  test('marks the code used', async () => {
    await record()
    const used = await f.t.run((ctx) =>
      Promise.all(
        [street.version, street.detail, street.category].map((id) =>
          ctx.db.get(id),
        ),
      ),
    )
    expect(used.map((p) => p!.used)).toEqual([true, true, true])
  })
})

describe('one named command group', () => {
  test('every write of the save runs under the gift’s group', async () => {
    await record({
      contact: { ...person, email: 'jo@example.com' },
      home: { line1: '12 High St', postcode: 'AB1 2CD' },
      giftAid: {},
    })
    const groups = await groupsOfA()
    const ours = groups.filter((g) => g.name.startsWith('gift '))
    expect(ours.map((g) => g.name)).toEqual([
      'gift £20 cash, Street-Wesser-001',
    ])
    const revs = (await revisionsOfA()).filter((r) => r.group === ours[0]._id)
    expect(revs.map((r) => r.contract).sort()).toEqual([
      'contacts.acquisition',
      'contacts.addresses',
      'contacts.details',
      'contacts.methods',
      'giftaid.declaration',
      'giving.gift',
      'giving.status',
    ])
    expect(new Set(revs.map((r) => r.groupName))).toEqual(
      new Set(['gift £20 cash, Street-Wesser-001']),
    )
  })
})

describe('an existing contact’s acquisition code', () => {
  test('empty: filled with the gift’s code, in the gift’s group', async () => {
    const jo = await existing(f.a)
    const { contactId } = await record({ contact: jo })
    expect(contactId).toBe(jo)
    const contact = await get(jo)
    expect(contact.acquisitionCodeId).toBe(street.version)
    expect(contact.acquisitionVersion).toBe(1)
    const revs = await revisionsOfA()
    const fill = revs.find((r) => r.contract === 'contacts.acquisition')!
    expect(fill.groupName).toBe('gift £20 cash, Street-Wesser-001')
  })

  test('set: kept, even when the gift is under another code', async () => {
    const jo = await existing(f.a, {}, online.version)
    const before = (await get(jo)).acquisitionVersion
    await record({ contact: jo })
    const contact = await get(jo)
    expect(contact.acquisitionCodeId).toBe(online.version)
    expect(contact.acquisitionVersion).toBe(before)
  })

  test('set but archived since: still kept', async () => {
    const jo = await existing(f.a, {}, online.version)
    await f.t.run((ctx) => ctx.db.patch(online.version, { isActive: false }))
    await record({ contact: jo })
    expect((await get(jo)).acquisitionCodeId).toBe(online.version)
  })

  test('a second gift doesn’t change the code the first one filled', async () => {
    const jo = await existing(f.a)
    await record({ contact: jo })
    await record({
      contact: jo,
      allocations: [{ sourceCodeId: online.version, amount: 2000n }],
    })
    expect((await get(jo)).acquisitionCodeId).toBe(street.version)
  })
})

describe('Gift Aid', () => {
  test('defaults: staff ticked, past 4 years and future, made on the gift’s date, current wording', async () => {
    const { contactId, declarationId } = await record({
      home: { line1: '12 High St', postcode: 'ab1 2cd' },
      giftAid: {},
    })
    expect(await get(declarationId!)).toMatchObject({
      contactId,
      scope: 'futureAndPast4y',
      method: 'staffTickedNoEvidence',
      madeOn: '2026-10-20',
      wordingVersion: HMRC_MODEL_WORDING_VERSION,
      firstName: 'Jo',
      lastName: 'Bloggs',
      // The snapshot is the address as saved (postcode normalised).
      addressLine1: '12 High St',
      postcode: 'AB1 2CD',
      enteredBy: f.a.userId,
    })
  })

  test('a “this gift only” declaration names the new gift', async () => {
    const { giftId, declarationId } = await record({
      giftAid: { scope: 'thisGift', method: 'paperForm', madeOn: '2026-10-21' },
    })
    expect(await get(declarationId!)).toMatchObject({
      scope: 'thisGift',
      contributionId: giftId,
      method: 'paperForm',
      madeOn: '2026-10-21',
    })
  })

  test('an existing person’s primary address is the snapshot', async () => {
    const jo = await existing(f.a)
    await f.a.as.mutation(api.contacts.mutations.saveAddresses, {
      tenantId: f.a.tenantId,
      id: jo,
      expected: 0,
      addresses: [
        {
          label: 'work',
          line1: '1 Office Rd',
          line2: '',
          line3: '',
          town: '',
          postcode: 'ZZ1 1ZZ',
          country: 'GB',
          isPrimary: false,
        },
        {
          label: 'home',
          line1: '7 Elm Row',
          line2: '',
          line3: '',
          town: '',
          postcode: 'EH1 1AA',
          country: 'GB',
          isPrimary: true,
        },
      ],
    })
    const { declarationId } = await record({ contact: jo, giftAid: {} })
    expect(await get(declarationId!)).toMatchObject({
      addressLine1: '7 Elm Row',
      postcode: 'EH1 1AA',
    })
    expect(await rowsOf('contactAddresses', jo)).toHaveLength(2)
  })

  test('an existing person with no address: the one entered is saved and snapshotted (g3q3)', async () => {
    const jo = await existing(f.a)
    const { declarationId } = await record({
      contact: jo,
      home: { line1: '3 Mill Lane', postcode: 'm1 1aa' },
      giftAid: {},
    })
    expect(await rowsOf('contactAddresses', jo)).toMatchObject([
      {
        line1: '3 Mill Lane',
        postcode: 'M1 1AA',
        isPrimary: true,
        country: 'GB',
      },
    ])
    expect(await get(declarationId!)).toMatchObject({
      addressLine1: '3 Mill Lane',
      postcode: 'M1 1AA',
    })
  })

  test('an added address keeps the ones the contact has, and their primary', async () => {
    const jo = await existing(f.a)
    await f.a.as.mutation(api.contacts.mutations.saveAddresses, {
      tenantId: f.a.tenantId,
      id: jo,
      expected: 0,
      addresses: [
        {
          label: 'work',
          line1: '1 Office Rd',
          line2: '',
          line3: '',
          town: '',
          postcode: 'ZZ1 1ZZ',
          country: 'GB',
          isPrimary: true,
        },
      ],
    })
    await record({
      contact: jo,
      home: { line1: '3 Mill Lane', postcode: 'M1 1AA' },
    })
    const rows = await rowsOf('contactAddresses', jo)
    expect(rows.map((r) => [r.line1, r.isPrimary])).toEqual([
      ['1 Office Rd', true],
      ['3 Mill Lane', false],
    ])
  })

  test('left without an address it saves, and the declaration is warned about', async () => {
    const { declarationId } = await record({ giftAid: {} })
    const d = await get(declarationId!)
    expect([d.addressLine1, d.postcode]).toEqual(['', ''])
    expect(declarationWarnings(d).map((w) => w.label)).toContain('Home address')
  })

  test('blank address fields add no address', async () => {
    const { contactId } = await record({ home: { line1: ' ', postcode: '' } })
    expect(await rowsOf('contactAddresses', contactId)).toEqual([])
  })
})

describe('any refusal leaves nothing behind', () => {
  beforeEach(async () => {
    aSnapshot = await snapshot(f.t, f.a.tenantId)
  })

  /** Tenant A is exactly as before the refused save. */
  async function aUntouched() {
    expect(await snapshot(f.t, f.a.tenantId)).toBe(aSnapshot)
  }

  const refusal = async (p: Promise<unknown>) => {
    const data = await errorData(p)
    await aUntouched()
    return data
  }

  test('no source code', async () => {
    expect(await refusal(record({ allocations: [] }))).toMatchObject({
      kind: 'invalid',
    })
  })

  test('amount of £0: the new contact and its number are rolled back too', async () => {
    const data = await refusal(
      record({
        amount: 0n,
        allocations: [{ sourceCodeId: street.version, amount: 0n }],
        contact: { ...person, email: 'jo@example.com' },
        home: { line1: '1 A St', postcode: 'A1 1AA' },
      }),
    )
    expect(data).toMatchObject({ kind: 'invalid' })
    // The next contact still gets the first number.
    const next = await existing(f.a)
    const first = await existing(f.b)
    expect((await get(next)).number).toBe(
      (await f.t.run((ctx) => ctx.db.get(first)))!.number,
    )
    // Tenant B's snapshot was taken before; restore it for afterEach.
    bSnapshot = await snapshot(f.t, f.b.tenantId)
  })

  test('shares not adding up to the amount', async () => {
    const data = await refusal(
      record({
        allocations: [{ sourceCodeId: street.version, amount: 1999n }],
      }),
    )
    expect(data).toMatchObject({ kind: 'invalid' })
  })

  test('a reference on a cash gift', async () => {
    expect(await refusal(record({ reference: 'TX1' }))).toMatchObject({
      kind: 'invalid',
    })
  })

  test('an archived code, for a new contact', async () => {
    await f.t.run((ctx) => ctx.db.patch(street.detail, { isActive: false }))
    aSnapshot = await snapshot(f.t, f.a.tenantId)
    expect(await refusal(record())).toMatchObject({
      reason: 'archived_source_code',
    })
  })

  test('an archived code, for an existing contact with no acquisition code', async () => {
    const jo = await existing(f.a)
    await f.t.run((ctx) => ctx.db.patch(street.version, { isActive: false }))
    aSnapshot = await snapshot(f.t, f.a.tenantId)
    expect(await refusal(record({ contact: jo }))).toMatchObject({
      reason: 'archived_source_code',
    })
  })

  test('a new person with no last name', async () => {
    const data = await refusal(
      record({ contact: { ...person, lastName: ' ' } }),
    )
    expect(data).toMatchObject({ kind: 'invalid' })
  })

  test('Gift Aid for a new organisation: contact and gift rolled back', async () => {
    const data = await refusal(record({ contact: organisation, giftAid: {} }))
    expect(data).toMatchObject({ reason: 'not_individual' })
  })

  test('Gift Aid for an existing organisation: its acquisition fill rolled back', async () => {
    const acme = await existing(f.a, organisation)
    aSnapshot = await snapshot(f.t, f.a.tenantId)
    const data = await refusal(record({ contact: acme, giftAid: {} }))
    expect(data).toMatchObject({ reason: 'not_individual' })
  })

  test('a declaration made after today', async () => {
    const data = await refusal(
      record({
        home: { line1: '1 A St', postcode: 'A1 1AA' },
        giftAid: { madeOn: '2026-10-24' },
      }),
    )
    expect(data).toMatchObject({ kind: 'invalid' })
  })

  test('a gift dated after today with the default declaration date', async () => {
    const data = await refusal(
      record({ receivedOn: '2026-11-01', giftAid: {} }),
    )
    expect(data).toMatchObject({ kind: 'invalid' })
  })

  test('an on-screen declaration (no donor screen yet)', async () => {
    const data = await refusal(
      record({ giftAid: { method: 'onScreenByDonor' } }),
    )
    expect(data).toMatchObject({ kind: 'invalid' })
  })

  test('a double submit with the same client key', async () => {
    const contact = { ...person, clientKey: 'form-1' }
    await record({ contact })
    aSnapshot = await snapshot(f.t, f.a.tenantId)
    expect(await refusal(record({ contact }))).toMatchObject({
      reason: 'duplicate',
    })
  })

  test('a viewer', async () => {
    const viewer = await member('viewer')
    aSnapshot = await snapshot(f.t, f.a.tenantId)
    expect(await refusal(record({}, viewer))).toMatchObject({
      kind: 'forbidden',
    })
  })

  test('staff may record', async () => {
    const staff = await member('staff')
    const { giftId } = await record({}, staff)
    expect((await get(giftId)).enteredBy).toBe(staff.userId)
  })
})

describe('two tenants', () => {
  beforeEach(async () => {
    aSnapshot = await snapshot(f.t, f.a.tenantId)
  })

  test('tenant B’s contact is unknown in A', async () => {
    const theirs = await existing(f.b)
    bSnapshot = await snapshot(f.t, f.b.tenantId)
    const data = await errorData(record({ contact: theirs }))
    expect(data).toMatchObject({ reason: 'unknown_contact' })
    expect(await snapshot(f.t, f.a.tenantId)).toBe(aSnapshot)
  })

  test('tenant B’s source code is unknown in A, new contact or existing', async () => {
    const theirs = await code(f.b, 'Street', 'Wesser')
    bSnapshot = await snapshot(f.t, f.b.tenantId)
    const allocations = [{ sourceCodeId: theirs.version, amount: 2000n }]
    expect(await errorData(record({ allocations }))).toMatchObject({
      reason: 'unknown_source_code',
    })
    const jo = await existing(f.a)
    aSnapshot = await snapshot(f.t, f.a.tenantId)
    expect(await errorData(record({ contact: jo, allocations }))).toMatchObject(
      { reason: 'unknown_source_code' },
    )
    expect(await snapshot(f.t, f.a.tenantId)).toBe(aSnapshot)
  })

  test('the same save in both tenants stays in each', async () => {
    const bStreet = await code(f.b, 'Street', 'Wesser')
    const inA = await record({ giftAid: {} })
    const inB = await record(
      {
        giftAid: {},
        allocations: [{ sourceCodeId: bStreet.version, amount: 2000n }],
      },
      f.b,
    )
    bSnapshot = await snapshot(f.t, f.b.tenantId)
    const [contactA, contactB] = await Promise.all([
      get(inA.contactId),
      get(inB.contactId),
    ])
    expect(contactA.tenantId).toBe(f.a.tenantId)
    expect(contactB.tenantId).toBe(f.b.tenantId)
    // Each tenant numbers its own contacts.
    expect(contactA.number).toBe(contactB.number)
    const recent = await f.a.as.query(api.giving.queries.myRecent, {
      tenantId: f.a.tenantId,
    })
    expect(recent.map((g) => g._id)).toEqual([inA.giftId])
  })
})
