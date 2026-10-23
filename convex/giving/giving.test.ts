import { beforeEach, describe, expect, test } from 'vitest'
import type { Doc, Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { canonical, restoreEntityTo } from '../lib/contracts'
import { scopeReader, scopeWriter } from '../lib/tenancy'
import { givingContracts } from './contracts'
import { describeGift } from './gifts'
import { RECENT_LIMIT } from './queries'
import { formatPence, isIsoDate } from './rules'
import { giftWarnings, yearsBefore } from './warnings'

type Fixture = Awaited<ReturnType<typeof setup>>
type Code = {
  category: Id<'sourceCodes'>
  detail: Id<'sourceCodes'>
  version: Id<'sourceCodes'>
}

const person = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Jo',
  lastName: 'Bloggs',
  nickname: '',
  name: '',
  isDeceased: false,
}

let f: Fixture
let bSnapshot: string
let jo: Id<'contacts'>
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

const contact = (who: Tenant, firstName = 'Jo') =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...person,
    firstName,
  })

function giftArgs(
  overrides: Partial<{
    contactId: Id<'contacts'>
    receivedOn: string
    amount: bigint
    method: 'cash' | 'card'
    reference: string
    allocations: Array<{
      key?: string
      sourceCodeId: Id<'sourceCodes'>
      amount: bigint
    }>
  }> = {},
) {
  const amount = overrides.amount ?? 2000n
  return {
    contactId: jo,
    receivedOn: '2026-10-20',
    amount,
    method: 'cash' as const,
    allocations: [{ sourceCodeId: street.version, amount }],
    ...overrides,
  }
}

const create = (args = giftArgs(), who: Tenant = f.a) =>
  who.as.mutation(api.giving.mutations.create, {
    tenantId: who.tenantId,
    ...args,
  })

const save = (
  id: Id<'contributions'>,
  expected: number,
  args = giftArgs(),
  who: Tenant = f.a,
) =>
  who.as.mutation(api.giving.mutations.save, {
    tenantId: who.tenantId,
    id,
    expected,
    ...args,
  })

const setStatus = (
  id: Id<'contributions'>,
  expected: number,
  status: 'completed' | 'void',
  who: Tenant = f.a,
) =>
  who.as.mutation(api.giving.mutations.setStatus, {
    tenantId: who.tenantId,
    id,
    expected,
    status,
  })

const gift = (id: Id<'contributions'>) =>
  f.t.run((ctx) => ctx.db.get(id)) as Promise<Doc<'contributions'>>

const allocations = (id: Id<'contributions'>) =>
  f.t.run((ctx) =>
    ctx.db
      .query('contributionAllocations')
      .withIndex('by_tenant_contribution', (q) =>
        q.eq('tenantId', f.a.tenantId).eq('contributionId', id),
      )
      .collect(),
  )

const revisions = (id: Id<'contributions'>) =>
  f.t.run((ctx) =>
    ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q
          .eq('tenantId', f.a.tenantId)
          .eq('entity', 'contributions')
          .eq('entityId', id),
      )
      .collect(),
  )

const sourceCode = (id: Id<'sourceCodes'>) =>
  f.t.run((ctx) => ctx.db.get(id)) as Promise<Doc<'sourceCodes'>>

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
  f = await setup()
  jo = await contact(f.a)
  street = await code(f.a, 'Street', 'Wesser')
  online = await code(f.a, 'Online', 'Spring')
  bSnapshot = await snapshot(f.t, f.b.tenantId)
})

/** Tenant B saw nothing of what tenant A did. */
async function bUntouched() {
  expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
}

describe('creating a gift', () => {
  test('stores the gift, its status and one allocation row per share', async () => {
    const id = await create(giftArgs({ amount: 1234567n }))
    const g = await gift(id)
    expect(g).toMatchObject({
      contactId: jo,
      receivedOn: '2026-10-20',
      amount: 1234567n,
      method: 'cash',
      status: 'completed',
      enteredBy: f.a.userId,
      giftVersion: 0,
      statusVersion: 1,
    })
    expect(typeof g.amount).toBe('bigint')
    expect(g.allocations).toHaveLength(1)
    expect(g.allocations[0].key).toBeTruthy()

    const rows = await allocations(id)
    expect(rows).toEqual([
      expect.objectContaining({
        contributionId: id,
        key: g.allocations[0].key,
        contactId: jo,
        sourceCodeId: street.version,
        detailId: street.detail,
        categoryId: street.category,
        receivedOn: '2026-10-20',
        amount: 1234567n,
        status: 'completed',
      }),
    ])
    await bUntouched()
  })

  test('runs both contracts in one group named after the gift', async () => {
    const id = await create()
    const revs = await revisions(id)
    expect(revs.map((r) => r.contract).sort()).toEqual([
      'giving.gift',
      'giving.status',
    ])
    expect(new Set(revs.map((r) => r.group)).size).toBe(1)
    expect(revs[0].groupName).toBe('gift £20 cash, Street-Wesser-001')
  })

  test('marks the code used, with its detail and category', async () => {
    await create()
    for (const part of [street.version, street.detail, street.category]) {
      expect((await sourceCode(part)).used).toBe(true)
    }
    expect((await sourceCode(online.version)).used).toBe(false)
  })

  test('a card reference is kept; an empty one is none', async () => {
    const id = await create(
      giftArgs({ method: 'card', reference: '  SUMUP-123 ' }),
    )
    expect((await gift(id)).reference).toBe('SUMUP-123')
    const blank = await create(giftArgs({ method: 'card', reference: ' ' }))
    expect((await gift(blank)).reference).toBeUndefined()
  })

  // Built per test: the codes exist only once `beforeEach` has run.
  const split = (a: bigint, b: bigint) => [
    { sourceCodeId: street.version, amount: a },
    { sourceCodeId: online.version, amount: b },
  ]
  test.each([
    ['a zero amount', () => giftArgs({ amount: 0n }), 'amount'],
    ['a negative amount', () => giftArgs({ amount: -100n }), 'amount'],
    ['not a date', () => giftArgs({ receivedOn: '2026-02-30' }), 'receivedOn'],
    ['no source code', () => giftArgs({ allocations: [] }), 'allocations'],
    [
      'shares not adding up',
      () => giftArgs({ allocations: split(1500n, 400n) }),
      'allocations',
    ],
    [
      'a zero share',
      () => giftArgs({ allocations: split(2000n, 0n) }),
      'allocations',
    ],
    ['a reference on cash', () => giftArgs({ reference: 'R1' }), 'reference'],
  ])('refuses %s', async (_name, args, field) => {
    const data = await errorData(create(args()))
    expect(data.kind).toBe('invalid')
    expect(data.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ field })]),
    )
    expect(
      await f.t.run((ctx) => ctx.db.query('contributions').collect()),
    ).toEqual([])
  })

  test('refuses an archived code, and nothing is written', async () => {
    await f.t.run((ctx) => ctx.db.patch(street.detail, { isActive: false }))
    const before = await snapshot(f.t, f.a.tenantId)
    const data = await errorData(create())
    expect(data).toMatchObject({ reason: 'archived_source_code' })
    expect(await snapshot(f.t, f.a.tenantId)).toBe(before)
  })

  test('refuses a detail or category as the code', async () => {
    const data = await errorData(
      create(
        giftArgs({
          allocations: [{ sourceCodeId: street.detail, amount: 2000n }],
        }),
      ),
    )
    expect(data).toMatchObject({ reason: 'unknown_source_code' })
  })
})

describe('tenancy', () => {
  test("another tenant's contact or code is refused", async () => {
    const bContact = await contact(f.b, 'Bea')
    const bCode = await code(f.b, 'Street', 'Other')
    bSnapshot = await snapshot(f.t, f.b.tenantId)
    expect(
      await errorData(create(giftArgs({ contactId: bContact }))),
    ).toMatchObject({ reason: 'unknown_contact' })
    expect(
      await errorData(
        create(
          giftArgs({
            allocations: [{ sourceCodeId: bCode.version, amount: 2000n }],
          }),
        ),
      ),
    ).toMatchObject({ reason: 'unknown_source_code' })
    await bUntouched()
  })

  test("tenant B can't read or change tenant A's gift", async () => {
    const id = await create()
    const read = { tenantId: f.b.tenantId }
    expect(
      await f.b.as.query(api.giving.queries.get, { ...read, id }),
    ).toBeNull()
    expect(await f.b.as.query(api.giving.queries.myRecent, read)).toEqual([])
    expect(
      (
        await f.b.as.query(api.giving.queries.byContact, {
          ...read,
          contactId: jo,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page,
    ).toEqual([])
    expect(
      (
        await f.b.as.query(api.giving.queries.history, {
          ...read,
          id,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page,
    ).toEqual([])
    const bJo = await contact(f.b)
    bSnapshot = await snapshot(f.t, f.b.tenantId)
    expect(
      await errorData(save(id, 0, giftArgs({ contactId: bJo }), f.b)),
    ).toMatchObject({ kind: 'not_found' })
    expect(await errorData(setStatus(id, 1, 'void', f.b))).toMatchObject({
      kind: 'not_found',
    })
    await bUntouched()
  })

  test('describeGift is tenant-scoped', async () => {
    const id = await create()
    const seen = (tenantId: Id<'tenants'>) =>
      f.t.run((ctx) => describeGift(scopeReader(ctx, tenantId), id))
    expect(await seen(f.a.tenantId)).toEqual({
      contactId: jo,
      receivedOn: '2026-10-20',
    })
    expect(await seen(f.b.tenantId)).toBeNull()
  })
})

describe('editing a gift', () => {
  test('follows edits in the projection, by allocation key', async () => {
    const id = await create()
    const [first] = (await gift(id)).allocations
    // Split across two codes, a new date and amount.
    await save(
      id,
      0,
      giftArgs({
        amount: 5000n,
        receivedOn: '2026-10-01',
        allocations: [
          { key: first.key, sourceCodeId: street.version, amount: 3000n },
          { sourceCodeId: online.version, amount: 2000n },
        ],
      }),
    )
    let rows = await allocations(id)
    expect(
      rows
        .map((r) => [r.sourceCodeId, r.detailId, r.amount, r.receivedOn])
        .sort(),
    ).toEqual(
      [
        [street.version, street.detail, 3000n, '2026-10-01'],
        [online.version, online.detail, 2000n, '2026-10-01'],
      ].sort(),
    )
    const kept = rows.find((r) => r.key === first.key)!
    // Back to one share: the other row goes, the kept one is the same row.
    await save(
      id,
      1,
      giftArgs({
        amount: 5000n,
        allocations: [
          { key: first.key, sourceCodeId: online.version, amount: 5000n },
        ],
      }),
    )
    rows = await allocations(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]._id).toBe(kept._id)
    expect(rows[0]).toMatchObject({
      sourceCodeId: online.version,
      detailId: online.detail,
      categoryId: online.category,
      amount: 5000n,
    })
    await bUntouched()
  })

  test("the donor can't change", async () => {
    const id = await create()
    const other = await contact(f.a, 'Sam')
    expect(
      await errorData(save(id, 0, giftArgs({ contactId: other }))),
    ).toMatchObject({ reason: 'contact_change' })
  })

  test('a stale expected throws stale', async () => {
    const id = await create()
    await save(id, 0, giftArgs({ amount: 2500n }))
    expect(await errorData(save(id, 0))).toMatchObject({
      kind: 'stale',
      current: 1,
    })
  })

  test('status and gift edits never conflict', async () => {
    const id = await create()
    // Both forms opened at giftVersion 0, statusVersion 1.
    await setStatus(id, 1, 'void')
    await save(id, 0, giftArgs({ amount: 2500n }))
    expect(await gift(id)).toMatchObject({
      status: 'void',
      amount: 2500n,
      giftVersion: 1,
      statusVersion: 2,
    })
  })

  test('an unchanged archived code is kept; a new archived one is refused', async () => {
    const id = await create()
    await f.t.run((ctx) => ctx.db.patch(street.version, { isActive: false }))
    await save(id, 0, giftArgs({ amount: 2000n, receivedOn: '2026-10-19' }))
    expect((await gift(id)).receivedOn).toBe('2026-10-19')
    await f.t.run((ctx) => ctx.db.patch(online.category, { isActive: false }))
    expect(
      await errorData(
        save(
          id,
          1,
          giftArgs({
            allocations: [{ sourceCodeId: online.version, amount: 2000n }],
          }),
        ),
      ),
    ).toMatchObject({ reason: 'archived_source_code' })
  })

  test('enteredBy survives another member’s save and a restore', async () => {
    const id = await create()
    const staff = await member('staff')
    await save(id, 0, giftArgs({ amount: 2500n }), staff)
    const [created] = (await revisions(id)).filter(
      (r) => r.contract === 'giving.gift' && r.counter === 0,
    )
    await staff.as.mutation(api.giving.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: created._id,
    })
    const g = await gift(id)
    expect(g.amount).toBe(2000n)
    expect(g.enteredBy).toBe(f.a.userId)
  })
})

describe('void and restore', () => {
  test('void marks the projection; un-void restores it', async () => {
    const id = await create()
    await setStatus(id, 1, 'void')
    expect((await allocations(id)).map((r) => r.status)).toEqual(['void'])
    // Re-sending the current status writes nothing.
    expect(await setStatus(id, 2, 'void')).toEqual({ id, counter: 2 })
    await setStatus(id, 2, 'completed')
    expect((await allocations(id)).map((r) => r.status)).toEqual(['completed'])
    await bUntouched()
  })

  test('the projection follows restores of either slice', async () => {
    const id = await create()
    await save(
      id,
      0,
      giftArgs({
        amount: 3000n,
        allocations: [{ sourceCodeId: online.version, amount: 3000n }],
      }),
    )
    await setStatus(id, 1, 'void')
    const revs = await revisions(id)
    const firstGift = revs.find(
      (r) => r.contract === 'giving.gift' && r.counter === 0,
    )!
    const firstStatus = revs.find(
      (r) => r.contract === 'giving.status' && r.counter === 1,
    )!
    for (const r of [firstGift, firstStatus]) {
      await f.a.as.mutation(api.giving.mutations.restoreRevision, {
        tenantId: f.a.tenantId,
        revisionId: r._id,
      })
    }
    const rows = await allocations(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sourceCodeId: street.version,
      amount: 2000n,
      status: 'completed',
    })
  })

  test('restore brings back a code archived since', async () => {
    const id = await create()
    await save(
      id,
      0,
      giftArgs({
        allocations: [{ sourceCodeId: online.version, amount: 2000n }],
      }),
    )
    await f.t.run((ctx) => ctx.db.patch(street.version, { isActive: false }))
    const first = (await revisions(id)).find(
      (r) => r.contract === 'giving.gift' && r.counter === 0,
    )!
    await f.a.as.mutation(api.giving.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: first._id,
    })
    expect((await allocations(id))[0].sourceCodeId).toBe(street.version)
  })
})

describe('restoring a gift to a moment', () => {
  /** Run `restoreEntityTo` on gift `id` as tenant A, to time `at`. */
  const restoreTo = (id: Id<'contributions'>, at: number) =>
    f.t.run((ctx) =>
      restoreEntityTo(
        { db: scopeWriter(ctx, f.a.tenantId), userId: f.a.userId, role: null },
        givingContracts,
        'contributions',
        id,
        at,
      ),
    )
  const latest = async (id: Id<'contributions'>) =>
    Math.max(...(await revisions(id)).map((r) => r._creationTime))

  test('brings back the amounts, and only the slice that changed', async () => {
    const id = await create()
    const moment = await latest(id)
    await save(
      id,
      0,
      giftArgs({
        amount: 3000n,
        allocations: [
          { sourceCodeId: street.version, amount: 1000n },
          { sourceCodeId: online.version, amount: 2000n },
        ],
      }),
    )
    const result = await restoreTo(id, moment)
    expect(result.restored).toEqual(['giving.gift'])
    const g = await gift(id)
    expect(g).toMatchObject({ amount: 2000n, giftVersion: 2, statusVersion: 1 })
    expect(g.allocations).toEqual([
      expect.objectContaining({ sourceCodeId: street.version, amount: 2000n }),
    ])
    expect((await allocations(id)).map((r) => r.amount)).toEqual([2000n])
    await bUntouched()
  })

  test('a gift already in that state restores nothing', async () => {
    const id = await create()
    const moment = await latest(id)
    // Stored int64s read back as bigints and compare equal to themselves.
    expect(await restoreTo(id, moment)).toEqual({ restored: [], group: null })
    const [{ key }] = (await gift(id)).allocations
    const back = (amount: bigint) =>
      giftArgs({
        amount,
        allocations: [{ key, sourceCodeId: street.version, amount }],
      })
    await save(id, 0, back(2500n))
    await save(id, 1, back(2000n))
    // The gift is back as it was then: nothing to restore.
    expect(await restoreTo(id, moment)).toEqual({ restored: [], group: null })
  })

  test('a stored payload is canonically equal to the one sent', async () => {
    const sent = giftArgs({ amount: 1234567n })
    const id = await create(sent)
    const stored = (await revisions(id)).find(
      (r) => r.contract === 'giving.gift',
    )!
    const [{ key }] = (await gift(id)).allocations
    expect(canonical(stored.payload)).toBe(
      canonical({
        ...sent,
        allocations: [{ ...sent.allocations[0], key }],
      }),
    )
    expect(canonical({ amount: 5n })).not.toBe(canonical({ amount: 5 }))
  })
})

describe('permissions', () => {
  test('a viewer reads gifts but is refused every write', async () => {
    const id = await create()
    const viewer = await member('viewer')
    const t = { tenantId: f.a.tenantId }
    expect(
      (await viewer.as.query(api.giving.queries.get, { ...t, id }))?.amount,
    ).toBe(2000n)
    const revisionId = (await revisions(id))[0]._id
    for (const write of [
      create(giftArgs(), viewer),
      save(id, 0, giftArgs(), viewer),
      setStatus(id, 1, 'void', viewer),
      viewer.as.mutation(api.giving.mutations.restoreRevision, {
        ...t,
        revisionId,
      }),
    ]) {
      expect(await errorData(write)).toMatchObject({ kind: 'forbidden' })
    }
  })
})

describe('queries', () => {
  test('myRecent: only my gifts, newest entered first, void marked', async () => {
    const staff = await member('staff')
    const ids: Array<Id<'contributions'>> = []
    for (let i = 0; i < RECENT_LIMIT + 2; i++) {
      ids.push(await create(giftArgs({ amount: BigInt(100 + i) })))
    }
    await create(giftArgs({ amount: 999n }), staff)
    await setStatus(ids.at(-1)!, 1, 'void')
    const recent = await f.a.as.query(api.giving.queries.myRecent, {
      tenantId: f.a.tenantId,
    })
    expect(recent.map((r) => r._id)).toEqual(ids.slice(-RECENT_LIMIT).reverse())
    expect(recent[0]).toMatchObject({
      contactId: jo,
      contactName: 'Jo Bloggs',
      amount: BigInt(100 + RECENT_LIMIT + 1),
      status: 'void',
      method: 'cash',
    })
    expect(recent.slice(1).every((r) => r.status === 'completed')).toBe(true)
    const theirs = await staff.as.query(api.giving.queries.myRecent, {
      tenantId: f.a.tenantId,
    })
    expect(theirs.map((r) => r.amount)).toEqual([999n])
  })

  test('byContact: newest date first, a page at a time, codes named', async () => {
    const sam = await contact(f.a, 'Sam')
    for (const day of ['05', '20', '12']) {
      await create(giftArgs({ receivedOn: `2026-10-${day}` }))
    }
    await create(giftArgs({ contactId: sam }))
    const page = (cursor: string | null) =>
      f.a.as.query(api.giving.queries.byContact, {
        tenantId: f.a.tenantId,
        contactId: jo,
        paginationOpts: { numItems: 2, cursor },
      })
    const first = await page(null)
    expect(first.page.map((g) => g.receivedOn)).toEqual([
      '2026-10-20',
      '2026-10-12',
    ])
    expect(first.page[0].allocations[0].code).toBe('Street-Wesser-001')
    const second = await page(first.continueCursor)
    expect(second.page.map((g) => g.receivedOn)).toEqual(['2026-10-05'])
    expect(second.isDone).toBe(true)
  })

  test('get: the gift with its donor and codes; history as moments', async () => {
    const id = await create(giftArgs({ method: 'card', reference: 'R-1' }))
    await f.t.run((ctx) => ctx.db.patch(street.detail, { name: 'Wessex' }))
    await setStatus(id, 1, 'void')
    const t = { tenantId: f.a.tenantId }
    const view = await f.a.as.query(api.giving.queries.get, { ...t, id })
    expect(view).toMatchObject({
      reference: 'R-1',
      status: 'void',
      contact: { _id: jo, displayName: 'Jo Bloggs', kind: 'individual' },
      allocations: [{ code: 'Street-Wessex-001', amount: 2000n }],
    })
    const history = await f.a.as.query(api.giving.queries.history, {
      ...t,
      id,
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(
      history.page.map((m) => [m.groupName, [...m.slices].sort()]),
    ).toEqual([
      [null, ['status']],
      // The group keeps the code as it read then.
      ['gift £20 card, Street-Wesser-001', ['gift', 'status']],
    ])
  })
})

describe('rules and warnings', () => {
  test('dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-1-01')).toBe(false)
    expect(yearsBefore('2026-10-23', 4)).toBe('2022-10-23')
  })

  test('formatPence', () => {
    expect(formatPence(2000n)).toBe('£20')
    expect(formatPence(2050n)).toBe('£20.50')
    expect(formatPence(123456705n)).toBe('£1,234,567.05')
  })

  const today = '2026-10-23'
  const warned = (receivedOn: string, amount = 2000n) =>
    giftWarnings({ receivedOn, amount }, today).map((w) => w.anchor)

  test.each([
    ['today', today, 2000n, []],
    ['tomorrow', '2026-10-24', 2000n, ['receivedOn']],
    ['exactly 4 years ago', '2022-10-23', 2000n, []],
    ['a day over 4 years ago', '2022-10-22', 2000n, ['receivedOn']],
    ['exactly £10,000', today, 1_000_000n, []],
    ['over £10,000', today, 1_000_001n, ['amount']],
  ] as const)('%s', (_name, date, amount, anchors) => {
    expect(warned(date, amount)).toEqual(anchors)
  })
})
