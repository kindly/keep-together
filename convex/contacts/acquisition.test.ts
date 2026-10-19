import { beforeEach, describe, expect, test } from 'vitest'
import type { Doc, Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { scopeWriter } from '../lib/tenancy'
import { projectContactSearch } from './searchProjection'

type Fixture = Awaited<ReturnType<typeof setup>>

const individual = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
}

let f: Fixture
let bSnapshot: string
let ada: Id<'contacts'>
let street: Code
let online: Code

type Code = {
  category: Id<'sourceCodes'>
  detail: Id<'sourceCodes'>
  version: Id<'sourceCodes'>
}

/**
 * A category, detail and version, written raw: the `sources` contracts are
 * step 2's (builder-src2). Only the fields `describe` / `markUsed` read
 * matter here.
 */
async function code(
  who: Tenant,
  names: [string, string, string],
  version: Partial<Doc<'sourceCodes'>> = {},
): Promise<Code> {
  return f.t.run(async (ctx) => {
    const row = (
      level: Doc<'sourceCodes'>['level'],
      name: string,
      parentId: Id<'sourceCodes'> | undefined,
      codeNormalized: string,
    ) => ({
      tenantId: who.tenantId,
      level,
      parentId,
      name,
      nameNormalized: name.toLowerCase(),
      codeNormalized,
      isActive: true,
      used: false,
      saveVersion: 0,
    })
    const [c, d, v] = names
    const category = await ctx.db.insert(
      'sourceCodes',
      row('category', c, undefined, c.toLowerCase()),
    )
    const detail = await ctx.db.insert(
      'sourceCodes',
      row('detail', d, category, `${c}-${d}`.toLowerCase()),
    )
    const versionId = await ctx.db.insert('sourceCodes', {
      ...row('version', v, detail, `${c}-${d}-${v}`.toLowerCase()),
      ...version,
    })
    return { category, detail, version: versionId }
  })
}

const patchCode = (
  id: Id<'sourceCodes'>,
  fields: Partial<Doc<'sourceCodes'>>,
) => f.t.run((ctx) => ctx.db.patch(id, fields))

const set = (
  codeId: Id<'sourceCodes'> | null,
  expected: number,
  who: Tenant = f.a,
  id = ada,
) =>
  who.as.mutation(api.contacts.mutations.setAcquisition, {
    tenantId: who.tenantId,
    id,
    expected,
    codeId,
  })

const get = (id = ada, who: Tenant = f.a) =>
  who.as.query(api.contacts.queries.get, { tenantId: who.tenantId, id })

const searchRowOf = (id = ada) =>
  f.t.run((ctx) =>
    ctx.db
      .query('contactSearch')
      .withIndex('by_tenant_contact', (q) =>
        q.eq('tenantId', f.a.tenantId).eq('contactId', id),
      )
      .unique(),
  )

const acquisitionIds = async (id = ada) => {
  const row = await searchRowOf(id)
  return [
    row?.acquisitionCodeId,
    row?.acquisitionDetailId,
    row?.acquisitionCategoryId,
  ]
}

const revisionsOf = (id = ada) =>
  f.t.run((ctx) =>
    ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity_contract', (q) =>
        q
          .eq('tenantId', f.a.tenantId)
          .eq('entity', 'contacts')
          .eq('entityId', id)
          .eq('contract', 'contacts.acquisition'),
      )
      .collect(),
  )

const usedOf = (c: Code) =>
  f.t.run(async (ctx) =>
    Promise.all(
      [c.version, c.detail, c.category].map(
        async (id) => (await ctx.db.get(id))!.used,
      ),
    ),
  )

beforeEach(async () => {
  f = await setup()
  street = await code(f.a, ['Street', 'Wesser', '001'])
  online = await code(f.a, ['Online', 'Website', '001'])
  bSnapshot = await snapshot(f.t, f.b.tenantId)
  ada = await f.a.as.mutation(api.contacts.mutations.create, {
    tenantId: f.a.tenantId,
    ...individual,
  })
})

describe('setting and clearing', () => {
  test('set: one revision, the code described on the contact, marked used', async () => {
    expect((await get())!.acquisition).toBeNull()
    expect(await usedOf(street)).toEqual([false, false, false])

    expect(await set(street.version, 0)).toEqual({ id: ada, counter: 1 })

    const view = (await get())!
    expect(view.contact.acquisitionCodeId).toBe(street.version)
    expect(view.contact.acquisitionVersion).toBe(1)
    expect(view.acquisition).toMatchObject({
      code: 'Street-Wesser-001',
      versionId: street.version,
      detailId: street.detail,
      categoryId: street.category,
      categoryName: 'Street',
      detailName: 'Wesser',
      versionName: '001',
      isActive: true,
    })
    expect(await usedOf(street)).toEqual([true, true, true])
    const revs = await revisionsOf()
    expect(revs.map((r) => [r.counter, r.payload])).toEqual([
      [1, { codeId: street.version }],
    ])
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })

  test('change and clear; re-sending the current code is a no-op', async () => {
    await set(street.version, 0)
    expect(await set(street.version, 1)).toEqual({ id: ada, counter: 1 })
    // Even with a stale counter: nothing would change.
    expect(await set(street.version, 0)).toEqual({ id: ada, counter: 1 })
    expect(await revisionsOf()).toHaveLength(1)

    await set(online.version, 1)
    expect((await get())!.acquisition?.code).toBe('Online-Website-001')

    await set(null, 2)
    const view = (await get())!
    expect(view.contact.acquisitionCodeId).toBeUndefined()
    expect(view.acquisition).toBeNull()
    expect(await acquisitionIds()).toEqual([undefined, undefined, undefined])
    expect((await revisionsOf()).map((r) => r.payload)).toEqual([
      { codeId: street.version },
      { codeId: online.version },
      { codeId: null },
    ])
    // Clearing a never-set code is a no-op too.
    const other = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
      firstName: 'Bea',
    })
    expect(await set(null, 0, f.a, other)).toEqual({ id: other, counter: 0 })
  })

  test('stale: a counter behind is refused with the current one', async () => {
    await set(street.version, 0)
    const data = await errorData(set(online.version, 0))
    expect(data).toMatchObject({
      kind: 'stale',
      contract: 'contacts.acquisition',
      current: 1,
    })
    expect((await get())!.contact.acquisitionCodeId).toBe(street.version)
  })

  test('the new-contact form sets it in the same action', async () => {
    const bea = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
      firstName: 'Bea',
      acquisitionCodeId: street.version,
    })
    const view = (await get(bea))!
    expect(view.acquisition?.code).toBe('Street-Wesser-001')
    expect(view.contact.acquisitionVersion).toBe(1)
    expect(await acquisitionIds(bea)).toEqual([
      street.version,
      street.detail,
      street.category,
    ])
    const [moment] = (
      await f.a.as.query(api.contacts.queries.history, {
        tenantId: f.a.tenantId,
        id: bea,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page
    expect(moment.groupName).toBe('new contact')
    expect(moment.slices.sort()).toEqual(['acquisition code', 'details'])
  })

  test('a viewer cannot set it', async () => {
    const viewer = await f.t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', { email: 'v@example.com' })
      await ctx.db.insert('memberships', {
        tenantId: f.a.tenantId,
        userId,
        role: 'viewer',
      })
      return userId
    })
    const as = f.t.withIdentity({ subject: `${viewer}|session-viewer` })
    const data = await errorData(
      as.mutation(api.contacts.mutations.setAcquisition, {
        tenantId: f.a.tenantId,
        id: ada,
        expected: 0,
        codeId: street.version,
      }),
    )
    expect(data.kind).toBe('forbidden')
  })
})

describe('validation', () => {
  const reason = async (p: Promise<unknown>) =>
    (await errorData(p)).reason as string

  test("another tenant's code is refused, and nothing is marked", async () => {
    const bea = await f.b.as.mutation(api.contacts.mutations.create, {
      tenantId: f.b.tenantId,
      ...individual,
    })
    expect(await reason(set(street.version, 0, f.b, bea))).toBe(
      'unknown_source_code',
    )
    expect(
      await reason(
        f.b.as.mutation(api.contacts.mutations.create, {
          tenantId: f.b.tenantId,
          ...individual,
          acquisitionCodeId: street.version,
        }),
      ),
    ).toBe('unknown_source_code')
    expect(await usedOf(street)).toEqual([false, false, false])
    expect((await get(bea, f.b))!.contact.acquisitionCodeId).toBeUndefined()
  })

  test('only a version: a category or a detail is refused', async () => {
    expect(await reason(set(street.category, 0))).toBe('unknown_source_code')
    expect(await reason(set(street.detail, 0))).toBe('unknown_source_code')
    expect(await revisionsOf()).toEqual([])
  })

  test('archived (the version or a parent) is refused; out of date is fine', async () => {
    await patchCode(street.version, { isActive: false })
    expect(await reason(set(street.version, 0))).toBe('archived_source_code')
    await patchCode(street.version, { isActive: true })
    await patchCode(street.category, { isActive: false })
    expect(await reason(set(street.version, 0))).toBe('archived_source_code')
    expect(await usedOf(street)).toEqual([false, false, false])

    const ended = await code(f.a, ['Event', 'Gala', '2019'], {
      startDate: '2019-01-01',
      endDate: '2019-12-31',
    })
    await set(ended.version, 0)
    expect((await get())!.acquisition).toMatchObject({
      code: 'Event-Gala-2019',
      endDate: '2019-12-31',
    })
  })

  test('a kept code stays once archived, and shows as archived', async () => {
    await set(street.version, 0)
    await patchCode(street.detail, { isActive: false })
    // Other slices still save, and so does re-sending the same code.
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      ...individual,
      nickname: 'Countess',
    })
    expect(await set(street.version, 1)).toEqual({ id: ada, counter: 1 })
    expect((await get())!.acquisition).toMatchObject({
      code: 'Street-Wesser-001',
      isActive: false,
    })
    expect(await acquisitionIds()).toEqual([
      street.version,
      street.detail,
      street.category,
    ])
  })
})

describe('the contactSearch projection', () => {
  test('carries the version, detail and category ids', async () => {
    const before = await searchRowOf()
    await set(street.version, 0)
    const after = (await searchRowOf())!
    expect(await acquisitionIds()).toEqual([
      street.version,
      street.detail,
      street.category,
    ])
    // Nothing else on the row moved.
    expect({ ...after, ...idsOf(before!) }).toEqual(before)
    await set(online.version, 1)
    expect(await acquisitionIds()).toEqual([
      online.version,
      online.detail,
      online.category,
    ])
  })

  test('a save of another slice keeps the ids, and a rebuild finds them', async () => {
    await set(street.version, 0)
    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: ada,
      details: { expected: 0, ...individual, nickname: 'Countess' },
      methods: {
        expected: 0,
        emails: [{ label: 'home', address: 'ada@x.com', isPrimary: true }],
        phones: [],
      },
    })
    const ids = [street.version, street.detail, street.category]
    expect(await acquisitionIds()).toEqual(ids)
    expect((await searchRowOf())!.text).toContain('countess')

    // The backfill's path, from scratch.
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query('contactSearch')
        .withIndex('by_tenant_contact', (q) =>
          q.eq('tenantId', f.a.tenantId).eq('contactId', ada),
        )
        .unique()
      await ctx.db.delete(row!._id)
      await projectContactSearch({ db: scopeWriter(ctx, f.a.tenantId) }, ada)
    })
    expect(await acquisitionIds()).toEqual(ids)
  })

  test('a rename changes the code shown, with no write to the contact or its row', async () => {
    await set(street.version, 0)
    const [contact, row] = [(await get())!.contact, await searchRowOf()]
    await patchCode(street.category, {
      name: 'Streets',
      nameNormalized: 'streets',
    })
    const view = (await get())!
    expect(view.acquisition?.code).toBe('Streets-Wesser-001')
    expect(view.contact).toEqual(contact)
    expect(await searchRowOf()).toEqual(row)
  })
})

function idsOf(row: Doc<'contactSearch'>) {
  return {
    acquisitionCodeId: row.acquisitionCodeId,
    acquisitionDetailId: row.acquisitionDetailId,
    acquisitionCategoryId: row.acquisitionCategoryId,
  }
}

describe('history and restore', () => {
  const moments = () =>
    f.a.as
      .query(api.contacts.queries.history, {
        tenantId: f.a.tenantId,
        id: ada,
        paginationOpts: { numItems: 10, cursor: null },
      })
      .then((r) => r.page)

  test('a moment names the code as it read then, and the slice "acquisition code"', async () => {
    await set(street.version, 0)
    await patchCode(street.detail, { name: 'Wessex', nameNormalized: 'wessex' })
    await set(null, 1)
    const [cleared, setTo] = await moments()
    expect([setTo.groupName, setTo.slices]).toEqual([
      'acquisition code Street-Wesser-001',
      ['acquisition code'],
    ])
    expect([cleared.groupName, cleared.slices]).toEqual([
      'acquisition code cleared',
      ['acquisition code'],
    ])
  })

  test('restore brings a code back, even an archived one, with no new marking', async () => {
    await set(street.version, 0)
    await set(online.version, 1)
    await patchCode(street.version, { isActive: false })
    const [first] = await revisionsOf()
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: first._id,
    })
    const view = (await get())!
    expect(view.contact.acquisitionCodeId).toBe(street.version)
    expect(view.contact.acquisitionVersion).toBe(3)
    expect(view.acquisition?.isActive).toBe(false)
    expect(await acquisitionIds()).toEqual([
      street.version,
      street.detail,
      street.category,
    ])
    const last = (await revisionsOf()).at(-1)!
    expect([last.source, last.restoredFrom]).toEqual(['restore', first._id])
  })

  test('restore to a moment includes the acquisition slice', async () => {
    await set(street.version, 0)
    const at = (await revisionsOf())[0]._creationTime
    await set(online.version, 1)
    await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at,
    })
    expect((await get())!.contact.acquisitionCodeId).toBe(street.version)
  })

  test("restoring a revision onto another tenant's code is refused", async () => {
    // A forged revision in tenant A naming tenant B's code.
    const foreign = await code(f.b, ['Street', 'Other', '001'])
    const forged = await f.t.run((ctx) =>
      ctx.db.insert('revisions', {
        tenantId: f.a.tenantId,
        entity: 'contacts',
        entityId: ada,
        contract: 'contacts.acquisition',
        version: 1,
        counter: 1,
        payload: { codeId: foreign.version },
        source: 'ui',
      }),
    )
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.restoreRevision, {
        tenantId: f.a.tenantId,
        revisionId: forged,
      }),
    )
    expect(data.reason).toBe('unknown_source_code')
  })
})
