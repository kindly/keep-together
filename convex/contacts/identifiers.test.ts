import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api, internal } from '../_generated/api'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { details, identifierType, identifiers } from './contracts'
import { prepareIdentifiers } from './rules'
import { assembleView } from './view'

type Fixture = Awaited<ReturnType<typeof setup>>
type Row = { key?: string; typeId: Id<'identifierTypes'>; value: string }

const individual = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
})

let f: Fixture
let ada: Id<'contacts'>
let oldCrm: Id<'identifierTypes'>
let membership: Id<'identifierTypes'>
let bSnapshot: string

/** Runs a contract as `who`'s tenant (no public type mutation until X4a). */
const runContract = <TArgs>(
  who: Tenant,
  fn: (ctx: Parameters<typeof executeContract>[0]) => Promise<TArgs>,
) =>
  f.t.run((ctx) =>
    fn({ db: scopeWriter(ctx, who.tenantId), userId: who.userId, role: null }),
  )
const saveType = (
  who: Tenant,
  name: string,
  opts: {
    id?: Id<'identifierTypes'>
    expected?: number
    isActive?: boolean
  } = {},
) =>
  runContract(who, (ctx) =>
    executeContract(
      ctx,
      identifierType,
      { name, isActive: opts.isActive ?? true },
      { entityId: opts.id, expected: opts.expected, source: 'test' },
    ),
  )
const createContact = (who: Tenant, lastName: string) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...individual(lastName),
  })
const get = (id: Id<'contacts'> = ada, who: Tenant = f.a) =>
  who.as.query(api.contacts.queries.get, { tenantId: who.tenantId, id })
const form = (
  args: Record<string, unknown>,
  id: Id<'contacts'> = ada,
  who: Tenant = f.a,
) =>
  who.as.mutation(api.contacts.mutations.saveForm, {
    tenantId: who.tenantId,
    id,
    ...args,
  })
const saveIds = (
  expected: number,
  rows: Array<Row>,
  id: Id<'contacts'> = ada,
  who: Tenant = f.a,
) => form({ identifiers: { expected, identifiers: rows } }, id, who)
const find = (
  typeId: Id<'identifierTypes'>,
  value: string,
  who: Tenant = f.a,
) =>
  f.t.query(internal.contacts.queries.findByIdentifier, {
    tenantId: who.tenantId,
    typeId,
    value,
  })
const rowsOf = (id: Id<'contacts'>) =>
  f.t.run((ctx) =>
    ctx.db
      .query('contactIdentifiers')
      .withIndex('by_tenant_contact', (q) =>
        q.eq('tenantId', f.a.tenantId).eq('contactId', id),
      )
      .collect(),
  )
const revisionsOf = (id: Id<'contacts'>, contract: string) =>
  f.t.run((ctx) =>
    ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity_contract', (q) =>
        q
          .eq('tenantId', f.a.tenantId)
          .eq('entity', 'contacts')
          .eq('entityId', id)
          .eq('contract', contract),
      )
      .collect(),
  )

beforeEach(async () => {
  f = await setup()
  bSnapshot = await snapshot(f.t, f.b.tenantId)
  ada = await createContact(f.a, 'Lovelace')
  oldCrm = (await saveType(f.a, 'Old CRM')).id
  membership = (await saveType(f.a, 'Membership number')).id
})

describe('identifier types', () => {
  test('names are tidied and unique per tenant, case-insensitively', async () => {
    const { id } = await saveType(f.a, '  Just   Giving ')
    const type = await f.t.run((ctx) => ctx.db.get(id))
    expect(type).toMatchObject({
      name: 'Just Giving',
      nameNormalized: 'just giving',
      isActive: true,
      saveVersion: 0,
    })
    expect(await errorData(saveType(f.a, 'old crm'))).toMatchObject({
      reason: 'duplicate_identifier_type_name',
    })
    expect(await errorData(saveType(f.a, '  '))).toMatchObject({
      kind: 'invalid',
    })
    // The same name in another tenant is a different type.
    await saveType(f.b, 'Old CRM')
  })

  test('renaming a type keeps every row', async () => {
    await saveIds(0, [{ typeId: oldCrm, value: 'C-1' }])
    await saveType(f.a, 'Previous system', { id: oldCrm, expected: 0 })
    const got = await get()
    expect(got?.identifiers).toEqual([
      expect.objectContaining({ value: 'C-1', typeName: 'Previous system' }),
    ])
  })
})

describe('the identifiers slice', () => {
  test('a create starts the counter at 0', async () => {
    expect((await get())?.contact.identifiersVersion).toBe(0)
  })

  test('rows save trimmed and normalised, shown as typed', async () => {
    const result = await saveIds(0, [
      { typeId: oldCrm, value: '  Ab-12 ' },
      { typeId: membership, value: 'M7' },
    ])
    expect(result.saved).toEqual(['identifiers'])
    expect(result.counters.identifiers).toBe(1)
    const rows = await rowsOf(ada)
    expect(rows.map((r) => [r.value, r.valueNormalized]).sort()).toEqual([
      ['Ab-12', 'ab-12'],
      ['M7', 'm7'],
    ])
    const got = await get()
    expect(got?.identifiers.map((r) => [r.typeName, r.value])).toEqual([
      ['Membership number', 'M7'],
      ['Old CRM', 'Ab-12'],
    ])
  })

  test('one contact may hold several values of one type', async () => {
    const result = await saveIds(0, [
      { typeId: oldCrm, value: 'C-1' },
      { typeId: oldCrm, value: 'C-2' },
    ])
    expect(result.saved).toEqual(['identifiers'])
  })

  test('a pair listed twice or a blank value is a problem on the slice', async () => {
    const twice = await saveIds(0, [
      { typeId: oldCrm, value: 'C-1' },
      { typeId: oldCrm, value: ' c-1' },
    ])
    expect(twice.saved).toEqual([])
    expect(twice.problems.identifiers?.[0].message).toBe('Duplicate identifier')
    const blank = await saveIds(0, [{ typeId: oldCrm, value: '  ' }])
    expect(blank.problems.identifiers?.[0].message).toMatch(/needs a value/)
    // The same value under two types is two identifiers.
    const twoTypes = await saveIds(0, [
      { typeId: oldCrm, value: 'X' },
      { typeId: membership, value: 'X' },
    ])
    expect(twoTypes.saved).toEqual(['identifiers'])
  })

  test('saving identifiers never bumps details, and vice versa', async () => {
    await saveIds(0, [{ typeId: oldCrm, value: 'C-1' }])
    const result = await form({
      details: { expected: 0, ...individual('Byron') },
      identifiers: {
        expected: 0, // what the form loaded; details changed, ids did not
        identifiers: (await get())!.identifiers.map(
          ({ key, typeId, value }) => ({ key, typeId, value }),
        ),
      },
    })
    expect(result.saved).toEqual(['details'])
    expect(result.stale).toEqual({})
    expect(result.counters).toMatchObject({ details: 1, identifiers: 1 })
  })

  test('typeId and value are immutable per key; remove + add works', async () => {
    await saveIds(0, [{ key: 'i1', typeId: oldCrm, value: 'C-1' }])
    for (const row of [
      { key: 'i1', typeId: oldCrm, value: 'C-2' },
      { key: 'i1', typeId: membership, value: 'C-1' },
      { key: 'i1', typeId: oldCrm, value: 'c-1' }, // a case change too
    ]) {
      expect(await errorData(saveIds(1, [row]))).toMatchObject({
        reason: 'immutable_child',
      })
    }
    // Surrounding whitespace on a kept key is not a change.
    expect(
      (await saveIds(1, [{ key: 'i1', typeId: oldCrm, value: ' C-1 ' }])).saved,
    ).toEqual([])
    await saveIds(1, [{ key: 'i2', typeId: oldCrm, value: 'C-2' }])
    expect((await rowsOf(ada)).map((r) => [r.key, r.value])).toEqual([
      ['i2', 'C-2'],
    ])
  })

  test('another contact’s row key is refused', async () => {
    const bob = await createContact(f.a, 'Babbage')
    await saveIds(0, [{ key: 'b1', typeId: oldCrm, value: 'C-9' }], bob)
    // A different value, so it is the key, not a clash, that is refused.
    expect(
      await errorData(
        saveIds(0, [{ key: 'b1', typeId: oldCrm, value: 'C-10' }]),
      ),
    ).toMatchObject({ reason: 'child_ownership' })
  })

  test('another tenant’s type is unknown', async () => {
    const theirs = (await saveType(f.b, 'Theirs')).id
    const result = await saveIds(0, [
      { key: 'x1', typeId: theirs, value: 'T-1' },
    ])
    expect(result.saved).toEqual([])
    expect(result.problems.identifiers).toMatchObject([{ key: 'x1' }])
    expect(
      await errorData(
        runContract(f.a, (ctx) =>
          executeContract(
            ctx,
            identifiers,
            { identifiers: [{ typeId: theirs, value: 'T-1' }] },
            { entityId: ada, expected: 0, source: 'test' },
          ),
        ),
      ),
    ).toMatchObject({ reason: 'unknown_identifier_type' })
  })
})

describe('uniqueness', () => {
  let bob: Id<'contacts'>
  beforeEach(async () => {
    bob = await createContact(f.a, 'Babbage')
    await saveIds(0, [{ key: 'b1', typeId: oldCrm, value: 'C-1' }], bob)
  })

  test('a pair another contact holds is "to fix" on the row, naming it; other slices save', async () => {
    const result = await form({
      details: { expected: 0, ...individual('Byron') },
      identifiers: {
        expected: 0,
        identifiers: [
          { key: 'a1', typeId: oldCrm, value: ' c-1 ' },
          { key: 'a2', typeId: membership, value: 'C-1' }, // other type: fine
        ],
      },
    })
    expect(result.saved).toEqual(['details'])
    expect(result.problems.identifiers).toEqual([
      {
        field: 'identifiers',
        message: 'c-1 is already used by Ada Babbage',
        key: 'a1',
        contactId: bob,
      },
    ])
    expect(await rowsOf(ada)).toEqual([])
    expect((await get())?.contact.identifiersVersion).toBe(0)
  })

  test('the contract refuses a clash on every path (here: run directly)', async () => {
    const data = await errorData(
      runContract(f.a, (ctx) =>
        executeContract(
          ctx,
          identifiers,
          { identifiers: [{ typeId: oldCrm, value: 'C-1' }] },
          { entityId: ada, expected: 0, source: 'test' },
        ),
      ),
    )
    expect(data).toMatchObject({ reason: 'duplicate_identifier' })
  })

  test('behind kept rows: the clash names its own row; the kept rows pass both checks', async () => {
    await saveIds(0, [
      { key: 'k1', typeId: oldCrm, value: 'K-1' },
      { key: 'k2', typeId: membership, value: 'K-2' },
    ])
    const rows = [
      { key: 'k1', typeId: oldCrm, value: 'K-1' },
      { key: 'k2', typeId: membership, value: 'K-2' },
      { key: 'a3', typeId: oldCrm, value: 'C-1' },
    ]
    expect((await saveIds(1, rows)).problems.identifiers).toEqual([
      {
        field: 'identifiers',
        message: 'C-1 is already used by Ada Babbage',
        key: 'a3',
        contactId: bob,
      },
    ])
    const data = await errorData(
      runContract(f.a, (ctx) =>
        executeContract(
          ctx,
          identifiers,
          { identifiers: rows },
          { entityId: ada, expected: 1, source: 'test' },
        ),
      ),
    )
    expect(data).toMatchObject({ reason: 'duplicate_identifier' })
    // Without the clash, the kept rows' own pairs don't count against them.
    expect((await saveIds(1, rows.slice(0, 2))).saved).toEqual([])
    expect(
      (await saveIds(1, [...rows.slice(0, 2), { ...rows[2], value: 'K-3' }]))
        .saved,
    ).toEqual(['identifiers'])
  })

  test('a removed pair is free for another contact', async () => {
    await saveIds(1, [], bob)
    expect(
      (await saveIds(0, [{ typeId: oldCrm, value: 'C-1' }])).saved,
    ).toEqual(['identifiers'])
    expect((await find(oldCrm, 'C-1'))?._id).toBe(ada)
  })

  test('restore cannot re-add a pair someone else now holds', async () => {
    await saveIds(1, [], bob)
    await saveIds(0, [{ typeId: oldCrm, value: 'C-1' }])
    const [withId] = await revisionsOf(bob, 'contacts.identifiers')
    expect(
      await errorData(
        f.a.as.mutation(api.contacts.mutations.restoreRevision, {
          tenantId: f.a.tenantId,
          revisionId: withId._id,
        }),
      ),
    ).toMatchObject({ reason: 'duplicate_identifier' })
  })
})

describe('archived types', () => {
  beforeEach(async () => {
    await saveIds(0, [{ key: 'i1', typeId: oldCrm, value: 'C-1' }])
    await saveType(f.a, 'Old CRM', { id: oldCrm, expected: 0, isActive: false })
  })

  test('cannot be newly added; kept rows stay, marked, and are still found', async () => {
    expect(
      await errorData(
        runContract(f.a, (ctx) =>
          executeContract(
            ctx,
            identifiers,
            {
              identifiers: [
                { key: 'i1', typeId: oldCrm, value: 'C-1' },
                { typeId: oldCrm, value: 'C-2' },
              ],
            },
            { entityId: ada, expected: 1, source: 'test' },
          ),
        ),
      ),
    ).toMatchObject({ reason: 'unknown_identifier_type' })
    // Adding a row of another type keeps the archived one.
    const result = await saveIds(1, [
      { key: 'i1', typeId: oldCrm, value: 'C-1' },
      { typeId: membership, value: 'M1' },
    ])
    expect(result.saved).toEqual(['identifiers'])
    const got = await get()
    expect(
      got?.identifiers.map((r) => [r.typeName, r.typeActive, r.value]),
    ).toEqual([
      ['Membership number', true, 'M1'],
      ['Old CRM', false, 'C-1'],
    ])
    expect((await find(oldCrm, 'c-1'))?._id).toBe(ada)
  })

  test('archived mid-edit: "to fix" on the row; other slices save', async () => {
    const result = await form({
      details: { expected: 0, ...individual('Byron') },
      identifiers: {
        expected: 1,
        identifiers: [
          { key: 'i1', typeId: oldCrm, value: 'C-1' }, // kept: fine
          { key: 'i2', typeId: oldCrm, value: 'C-2' },
        ],
      },
    })
    expect(result.saved).toEqual(['details'])
    expect(result.problems.identifiers).toEqual([
      {
        field: 'identifiers',
        message: 'That type has been archived: choose another',
        key: 'i2',
      },
    ])
    expect((await rowsOf(ada)).map((r) => r.key)).toEqual(['i1'])
  })

  test('restore re-adds a row of an archived type', async () => {
    await saveIds(1, [])
    const [withId] = await revisionsOf(ada, 'contacts.identifiers')
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: withId._id,
    })
    expect((await rowsOf(ada)).map((r) => [r.key, r.value])).toEqual([
      ['i1', 'C-1'],
    ])
  })
})

describe('lookup', () => {
  test('findByIdentifier: trimmed, case-insensitive, archived contacts included', async () => {
    await saveIds(0, [{ typeId: oldCrm, value: 'Ab-12' }])
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      archived: true,
    })
    expect((await find(oldCrm, '  aB-12 '))?._id).toBe(ada)
    expect(await find(membership, 'Ab-12')).toBeNull()
    expect(await find(oldCrm, '  ')).toBeNull()
  })

  test('the list search finds an exact identifier of any type', async () => {
    await createContact(f.a, 'M7 Smith') // a name match ranks after the exact one
    await saveIds(0, [{ typeId: membership, value: 'M7' }])
    const list = await f.a.as.query(api.contacts.queries.search, {
      tenantId: f.a.tenantId,
      search: ' m7 ',
    })
    expect(list.rows[0]._id).toBe(ada)
    // Values are in the full-text search too (search Q2): a prefix finds
    // them, with no exact match to rank first.
    const partial = await f.a.as.query(api.contacts.queries.search, {
      tenantId: f.a.tenantId,
      search: 'M',
    })
    expect(partial.rows.map((c) => c._id)).toContain(ada)
  })
})

describe('tenant isolation', () => {
  test('the same type name and value save in both tenants and never cross', async () => {
    const bType = (await saveType(f.b, 'Old CRM')).id
    const bAda = await createContact(f.b, 'Lovelace')
    await saveIds(0, [{ typeId: oldCrm, value: 'C-1' }])
    expect(
      (await saveIds(0, [{ typeId: bType, value: 'C-1' }], bAda, f.b)).saved,
    ).toEqual(['identifiers'])
    expect((await find(oldCrm, 'C-1'))?._id).toBe(ada)
    expect((await find(bType, 'C-1', f.b))?._id).toBe(bAda)
    // A's type id means nothing in B.
    expect(await find(oldCrm, 'C-1', f.b)).toBeNull()
    const bList = await f.b.as.query(api.contacts.queries.search, {
      tenantId: f.b.tenantId,
      search: 'C-1',
    })
    expect(bList.rows.map((c) => c._id)).toEqual([bAda])
  })

  test('tenant B observes nothing of tenant A', async () => {
    await saveIds(0, [{ typeId: oldCrm, value: 'C-1' }])
    await saveType(f.a, 'Renamed', { id: oldCrm, expected: 0 })
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })
})

describe("the contact page's per-slice queries", () => {
  /** What the contact page assembles from its per-slice queries. */
  const assembled = async (who: Tenant, tenantId: Id<'tenants'>, id = ada) => {
    const args = { tenantId, id }
    const [root, channels, rows, types] = await Promise.all([
      who.as.query(api.contacts.queries.getRoot, args),
      who.as.query(api.contacts.queries.getChannels, args),
      who.as.query(api.contacts.queries.getIdentifiers, args),
      who.as.query(api.contacts.queries.listIdentifierTypes, {
        tenantId,
        includeInactive: true,
      }),
    ])
    // As the page does: by the code id `getRoot` carries.
    const codeId = root?.acquisitionCodeId
    const acquisition = codeId
      ? await who.as.query(api.contacts.queries.getAcquisition, {
          tenantId,
          codeId,
        })
      : null
    return {
      root,
      channels,
      identifiers: rows,
      acquisition,
      view:
        root &&
        assembleView({
          root,
          channels,
          identifiers: rows,
          types,
          acquisition,
        }),
    }
  }

  test("assemble exactly get's view, an archived type named; nothing across tenants", async () => {
    await form({
      methods: {
        expected: 0,
        emails: [{ label: 'home', address: 'ada@x.com', isPrimary: true }],
        phones: [{ label: 'home', number: '01234 567890', isPrimary: true }],
      },
      addresses: {
        expected: 0,
        addresses: [
          {
            label: 'home',
            line1: '1 High St',
            line2: '',
            line3: '',
            town: 'Stroud',
            postcode: 'GL5 1AA',
            country: 'GB',
            isPrimary: true,
          },
        ],
      },
    })
    await saveIds(0, [
      { typeId: oldCrm, value: 'C-1' },
      { typeId: membership, value: 'M-2' },
      { typeId: membership, value: 'M-1' },
    ])
    await saveType(f.a, 'Old CRM', { id: oldCrm, expected: 0, isActive: false })

    const view = await get()
    expect(
      view!.identifiers.map((r) => [r.typeName, r.value, r.typeActive]),
    ).toEqual([
      ['Membership number', 'M-1', true],
      ['Membership number', 'M-2', true],
      ['Old CRM', 'C-1', false],
    ])
    expect(view!.emails).toHaveLength(1)
    expect((await assembled(f.a, f.a.tenantId)).view).toEqual(view)

    // B, in its own tenant, with A's contact id: nothing at all.
    expect(await assembled(f.b, f.b.tenantId)).toEqual({
      root: null,
      channels: { emails: [], phones: [], addresses: [] },
      identifiers: [],
      acquisition: null,
      view: null,
    })
    // B naming A's tenant: refused, by every one of them.
    for (const query of [
      api.contacts.queries.getRoot,
      api.contacts.queries.getChannels,
      api.contacts.queries.getIdentifiers,
    ]) {
      const data = await errorData(
        f.b.as.query(query, { tenantId: f.a.tenantId, id: ada }),
      )
      expect(data.kind).toBe('forbidden')
    }
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })
})

describe('details v2', () => {
  /** A details revision as v1 wrote it, with the old field in its payload. */
  const v1Revision = (lastName: string, externalIdentifier: string) =>
    f.t.run((ctx) =>
      ctx.db.insert('revisions', {
        tenantId: f.a.tenantId,
        entity: 'contacts',
        entityId: ada,
        contract: 'contacts.details',
        version: 1,
        counter: 0,
        payload: { ...individual(lastName), externalIdentifier },
        source: 'seed',
      }),
    )

  test('a v1 revision restores through the upcaster and leaves identifiers alone', async () => {
    const revisionId = await v1Revision('Byron', 'LEGACY-0001')
    await saveIds(0, [{ key: 'i1', typeId: oldCrm, value: 'C-1' }])
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId,
    })
    const got = await get()
    expect(got?.contact).toMatchObject({
      lastName: 'Byron',
      detailsVersion: 1,
      identifiersVersion: 1,
    })
    // The schema no longer has the field (X3); the upcaster kept it out.
    expect(got?.contact).not.toHaveProperty('externalIdentifier')
    expect(got?.identifiers.map((r) => r.key)).toEqual(['i1'])
    const latest = (await revisionsOf(ada, 'contacts.details')).at(-1)!
    expect(latest).toMatchObject({
      version: 2,
      source: 'restore',
      restoredFrom: revisionId,
    })
    expect(latest.payload).not.toHaveProperty('externalIdentifier')
  })

  test('restore to a moment compares a v1 and a v2 payload at the code version', async () => {
    const revisionId = await v1Revision('Lovelace', '')
    const moment = (await f.t.run((ctx) => ctx.db.get(revisionId)))!
      ._creationTime
    const save = (expected: number, lastName: string) =>
      form({ details: { expected, ...individual(lastName) } })
    await save(0, 'Byron')
    await save(1, 'Lovelace')
    const result = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: moment,
    })
    expect(result).toEqual({ restored: [], group: null, skippedFields: [] })
  })

  test('the upcaster drops only the old field', () => {
    const payload = { ...individual('Lovelace'), externalIdentifier: 'X' }
    expect(details.upcasters?.[1](payload)).toEqual(individual('Lovelace'))
  })
})

describe('prepareIdentifiers (pure)', () => {
  const typeId = 'type1' as Id<'identifierTypes'>
  test('mints keys and trims values', () => {
    const { identifiers: rows } = prepareIdentifiers({
      identifiers: [{ typeId, value: ' A ' }],
    })
    expect(rows[0].key).toBeTruthy()
    expect(rows[0].value).toBe('A')
  })
})
