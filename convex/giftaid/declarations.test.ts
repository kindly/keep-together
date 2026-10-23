import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { executeContract, restore, restoreEntityTo } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import type { Role } from '../lib/tenancy'
import {
  cancellation,
  coverage,
  currentDeclaration,
  declaration,
  giftaidContracts,
} from './declarations'
import { ukDate } from './rules'
import { HMRC_MODEL_WORDING_VERSION } from './validators'

type Fixture = Awaited<ReturnType<typeof setup>>
type T = Fixture['t']

const person = (firstName: string, lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName,
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
})
const organisation = (kind: 'organization' | 'household', name: string) => ({
  kind,
  title: '',
  firstName: '',
  lastName: '',
  nickname: '',
  name,
  isDeceased: false,
})

const newContact = (
  who: Tenant,
  details: ReturnType<typeof person> | ReturnType<typeof organisation>,
) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...details,
  })

const scoped = (ctx: MutationCtx, tenantId: Id<'tenants'>) => ({
  db: scopeWriter(ctx, tenantId),
  userId: null,
  role: null,
})

/**
 * A gift row for a "this gift only" declaration to name: a raw fixture
 * row is all `describeGift` reads.
 */
const giftFor = (
  t: T,
  who: Tenant,
  contactId: Id<'contacts'>,
  receivedOn: string,
  status: 'completed' | 'void' = 'completed',
) =>
  t.run(async (ctx) => {
    const code = await ctx.db
      .query('sourceCodes')
      .withIndex('by_tenant_parent', (q) => q.eq('tenantId', who.tenantId))
      .first()
    return ctx.db.insert('contributions', {
      tenantId: who.tenantId,
      contactId,
      receivedOn,
      amount: 2000n,
      method: 'cash',
      allocations: [{ key: 'a', sourceCodeId: code!._id, amount: 2000n }],
      status,
      giftVersion: 0,
      statusVersion: 0,
    })
  })

async function member(t: T, who: Tenant, role: Role) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: `${role}@example.com` })
    await ctx.db.insert('memberships', {
      tenantId: who.tenantId,
      userId: id,
      role,
    })
    return id
  })
  return { ...who, as: t.withIdentity({ subject: `${userId}|s-${role}` }) }
}

let f: Fixture
let jo: Id<'contacts'>
let bSnapshot: string

beforeEach(async () => {
  f = await setup()
  bSnapshot = await snapshot(f.t, f.b.tenantId)
  jo = await newContact(f.a, person('Jo', 'Bloggs'))
})

const snapshotFields = {
  firstName: 'Jo',
  lastName: 'Bloggs',
  addressLine1: '12',
  postcode: 'SW1A 1AA',
}

const declare = (
  extra: Partial<{
    contactId: Id<'contacts'>
    scope: 'thisGift' | 'future' | 'futureAndPast4y'
    contributionId: Id<'contributions'>
    madeOn: string
    method: 'staffTickedNoEvidence' | 'paperForm' | 'onScreenByDonor' | 'oral'
    wordingVersion: string
  }> = {},
  who: Tenant = f.a,
) =>
  who.as.mutation(api.giftaid.mutations.declare, {
    tenantId: who.tenantId,
    contactId: jo,
    scope: 'futureAndPast4y',
    madeOn: '2026-03-03',
    method: 'paperForm',
    wordingVersion: HMRC_MODEL_WORDING_VERSION,
    ...snapshotFields,
    ...extra,
  })

const voidIt = (
  id: Id<'giftAidDeclarations'>,
  reason = 'entered against the wrong Jo',
  who: Tenant = f.a,
) =>
  who.as.mutation(api.giftaid.mutations.voidDeclaration, {
    tenantId: who.tenantId,
    id,
    reason,
  })

const cancel = (
  cancelledFrom: string,
  note?: string,
  who: Tenant = f.a,
  contactId: Id<'contacts'> = jo,
) =>
  who.as.mutation(api.giftaid.mutations.recordCancellation, {
    tenantId: who.tenantId,
    contactId,
    cancelledFrom,
    note,
  })

const panel = (today = '2026-10-23', who: Tenant = f.a, contactId = jo) =>
  who.as.query(api.giftaid.queries.byContact, {
    tenantId: who.tenantId,
    contactId,
    today,
  })

const kind = async (p: Promise<unknown>) => (await errorData(p)).kind
const reason = async (p: Promise<unknown>) => (await errorData(p)).reason

describe('giftaid.declaration', () => {
  test('records method, scope, date, snapshot and who entered it', async () => {
    const { id, counter } = await declare({ method: 'oral' })
    expect(counter).toBe(0)
    const { declarations, currentId } = await panel()
    expect(currentId).toBe(id)
    expect(declarations).toHaveLength(1)
    expect(declarations[0]).toMatchObject({
      _id: id,
      contactId: jo,
      scope: 'futureAndPast4y',
      madeOn: '2026-03-03',
      method: 'oral',
      wordingVersion: HMRC_MODEL_WORDING_VERSION,
      ...snapshotFields,
      enteredBy: f.a.userId,
      declarationVersion: 0,
      cancellationVersion: 0,
      voidVersion: 0,
    })
    expect(declarations[0].warnings.map((w) => w.anchor)).toEqual(['method'])
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })

  test('the snapshot is not the contact: a later name change leaves it', async () => {
    await declare()
    const contact = await f.a.as.query(api.contacts.queries.get, {
      tenantId: f.a.tenantId,
      id: jo,
    })
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id: jo,
      expected: contact!.contact.detailsVersion,
      ...person('Joanna', 'Smith'),
    })
    const [d] = (await panel()).declarations
    expect(d).toMatchObject({ firstName: 'Jo', lastName: 'Bloggs' })
  })

  test('refused for an organisation or a household', async () => {
    for (const k of ['organization', 'household'] as const) {
      const org = await newContact(f.a, organisation(k, 'Acme'))
      expect(await reason(declare({ contactId: org }))).toBe('not_individual')
    }
  })

  test('missing snapshot fields store, with warnings', async () => {
    const { id } = await f.a.as.mutation(api.giftaid.mutations.declare, {
      tenantId: f.a.tenantId,
      contactId: jo,
      scope: 'future',
      madeOn: '2026-04-01',
      method: 'paperForm',
      wordingVersion: HMRC_MODEL_WORDING_VERSION,
      firstName: 'Jo',
      lastName: 'Bloggs',
      addressLine1: '',
      postcode: '',
    })
    const d = (await panel()).declarations.find((x) => x._id === id)!
    expect(d.warnings.map((w) => w.anchor)).toEqual(['addressLine1'])
  })

  test('a bad date is refused', async () => {
    expect(await kind(declare({ madeOn: '2026-02-30' }))).toBe('invalid')
  })

  test('made today stores; made in the future is refused', async () => {
    const today = ukDate(Date.now())
    await declare({ madeOn: today })
    const tomorrow = ukDate(Date.now() + 36 * 3600 * 1000)
    const err = await errorData(declare({ madeOn: tomorrow }))
    expect(err.kind).toBe('invalid')
    expect(err.problems).toEqual([
      { field: 'madeOn', message: 'A declaration can’t be made in the future' },
    ])
  })

  test('onScreenByDonor is refused until a donor screen exists; staff ticked stores', async () => {
    const err = await errorData(declare({ method: 'onScreenByDonor' }))
    expect(err.kind).toBe('invalid')
    expect(err.problems).toMatchObject([{ field: 'method' }])
    const { id } = await declare({ method: 'staffTickedNoEvidence' })
    const d = (await panel()).declarations.find((x) => x._id === id)!
    expect(d.method).toBe('staffTickedNoEvidence')
    expect(d.warnings.map((w) => w.label)).toEqual(['No evidence yet'])
  })

  test('immutable: an update and a restore are both refused', async () => {
    const { id } = await declare()
    expect(
      await reason(
        f.t.run((ctx) =>
          executeContract(
            scoped(ctx, f.a.tenantId),
            declaration,
            {
              contactId: jo,
              scope: 'future',
              madeOn: '2026-03-03',
              method: 'paperForm',
              wordingVersion: HMRC_MODEL_WORDING_VERSION,
              ...snapshotFields,
            },
            { entityId: id, source: 'test' },
          ),
        ),
      ),
    ).toBe('immutable')
    const revisionId = await f.t.run(async (ctx) => {
      const r = await ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity_contract', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'giftAidDeclarations')
            .eq('entityId', id)
            .eq('contract', 'giftaid.declaration'),
        )
        .first()
      return r!._id
    })
    expect(
      await reason(
        f.t.run((ctx) =>
          restore(scoped(ctx, f.a.tenantId), giftaidContracts, revisionId),
        ),
      ),
    ).toBe('immutable')
  })

  test('thisGift names one of the contact’s own gifts', async () => {
    const gift = await giftFor(f.t, f.a, jo, '2026-03-03')
    const { id } = await declare({ scope: 'thisGift', contributionId: gift })
    expect((await panel()).declarations[0]).toMatchObject({
      _id: id,
      contributionId: gift,
    })
    // Not current: it covers one gift, so the form offers the tick again.
    expect((await panel()).currentId).toBeNull()

    const sam = await newContact(f.a, person('Sam', 'Other'))
    const samsGift = await giftFor(f.t, f.a, sam, '2026-03-03')
    expect(
      await reason(declare({ scope: 'thisGift', contributionId: samsGift })),
    ).toBe('unknown_gift')
    expect(await kind(declare({ scope: 'thisGift' }))).toBe('invalid')
    expect(await kind(declare({ scope: 'future', contributionId: gift }))).toBe(
      'invalid',
    )
  })

  test('thisGift: a void gift or one already declared is refused; voiding frees it', async () => {
    const voidGift = await giftFor(f.t, f.a, jo, '2026-03-03', 'void')
    expect(
      await reason(declare({ scope: 'thisGift', contributionId: voidGift })),
    ).toBe('void_gift')

    const gift = await giftFor(f.t, f.a, jo, '2026-03-03')
    const first = await declare({ scope: 'thisGift', contributionId: gift })
    expect(
      await reason(declare({ scope: 'thisGift', contributionId: gift })),
    ).toBe('duplicate_gift_declaration')
    await voidIt(first.id)
    await declare({ scope: 'thisGift', contributionId: gift })
  })
})

describe('voidDeclaration (made in error)', () => {
  const covering = (date: string, contributionId?: Id<'contributions'>) =>
    f.t.run((ctx) =>
      coverage(
        { db: scopeWriter(ctx, f.a.tenantId) },
        jo,
        date,
        contributionId,
      ),
    )

  test('a mistaken futureAndPast4y voided the same day covers no gift, past or future', async () => {
    const today = ukDate(Date.now())
    const { id } = await declare({ madeOn: today })
    expect(await covering(today)).not.toBeNull()

    const { counter } = await voidIt(id)
    expect(counter).toBe(1)
    for (const date of [
      today.replace(/^\d{4}/, (y) => String(Number(y) - 4)),
      '2024-06-01',
      today,
      '2099-01-01',
    ]) {
      expect(await covering(date)).toBeNull()
    }
    expect(
      await f.t.run((ctx) =>
        currentDeclaration({ db: scopeWriter(ctx, f.a.tenantId) }, jo, today),
      ),
    ).toBeNull()

    const { declarations, currentId } = await panel(today)
    expect(currentId).toBeNull()
    expect(declarations[0]).toMatchObject({
      _id: id,
      voidReason: 'entered against the wrong Jo',
      voidedBy: f.a.userId,
      voidVersion: 1,
    })
    expect(typeof declarations[0].voidedAt).toBe('number')
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })

  test('a voided thisGift no longer covers its gift', async () => {
    const gift = await giftFor(f.t, f.a, jo, '2026-03-03')
    const { id } = await declare({ scope: 'thisGift', contributionId: gift })
    expect((await covering('2026-03-03', gift))?.id).toBe(id)
    await voidIt(id)
    expect(await covering('2026-03-03', gift)).toBeNull()
  })

  test('a cancelled declaration can still be voided; a voided one can’t be cancelled', async () => {
    const { id } = await declare()
    await cancel('2026-06-01')
    expect(await covering('2025-01-01')).not.toBeNull()
    await voidIt(id)
    expect(await covering('2025-01-01')).toBeNull()

    // recordCancellation finds nothing open; the contract refuses directly.
    expect(await kind(cancel('2026-04-01'))).toBe('invalid')
    expect(
      await reason(
        f.t.run((ctx) =>
          executeContract(
            scoped(ctx, f.a.tenantId),
            cancellation,
            {},
            { entityId: id, source: 'test' },
          ),
        ),
      ),
    ).toBe('voided')
  })

  test('create-only: a second void, a restore and a restore-to-before leave it voided', async () => {
    const { id } = await declare()
    await voidIt(id)
    expect(await reason(voidIt(id, 'again'))).toBe('immutable')
    expect(await kind(voidIt(id, '  '))).toBe('invalid')

    const revisionId = await f.t.run(async (ctx) => {
      const r = await ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity_contract', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'giftAidDeclarations')
            .eq('entityId', id)
            .eq('contract', 'giftaid.void'),
        )
        .first()
      return r!._id
    })
    expect(
      await reason(
        f.t.run((ctx) =>
          restore(scoped(ctx, f.a.tenantId), giftaidContracts, revisionId),
        ),
      ),
    ).toBe('immutable')
    // No void revision before the void: restoring to then changes nothing.
    await f.t.run((ctx) =>
      restoreEntityTo(
        scoped(ctx, f.a.tenantId),
        giftaidContracts,
        'giftAidDeclarations',
        id,
        0,
      ),
    )
    expect((await panel()).declarations[0].voidedAt).toBeDefined()
  })

  test('another tenant can’t void it; a viewer can’t either', async () => {
    const { id } = await declare()
    expect(await kind(voidIt(id, 'nope', f.b))).toBe('not_found')
    const viewer = await member(f.t, f.a, 'viewer')
    expect(await kind(voidIt(id, 'nope', viewer))).toBe('forbidden')
    expect((await panel()).declarations[0].voidedAt).toBeUndefined()
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })
})

describe('recordCancellation', () => {
  test('cancels every declaration open at the date, in one named group', async () => {
    const first = await declare({ scope: 'future', madeOn: '2024-01-01' })
    const second = await declare({ madeOn: '2025-01-01' })
    // Already cancelled before the date: left alone.
    const old = await declare({ scope: 'future', madeOn: '2020-01-01' })
    await cancel('2021-01-01')
    // Made after the date: the donor declared again since; left alone.
    const later = await declare({ scope: 'future', madeOn: '2026-08-01' })

    const { cancelled } = await cancel('2026-06-01', 'phoned to cancel')
    expect(cancelled.sort()).toEqual([first.id, second.id].sort())

    const byId = new Map(
      (await panel()).declarations.map((d) => [d._id, d] as const),
    )
    expect(byId.get(first.id)).toMatchObject({
      cancelledFrom: '2026-06-01',
      cancellationNote: 'phoned to cancel',
      cancellationVersion: 1,
    })
    expect(byId.get(second.id)?.cancelledFrom).toBe('2026-06-01')
    expect(byId.get(old.id)?.cancelledFrom).toBe('2021-01-01')
    expect(byId.get(later.id)?.cancelledFrom).toBeUndefined()

    const groups = await f.t.run(async (ctx) => {
      const revs = await ctx.db
        .query('revisions')
        .collect()
        .then((rs) =>
          rs.filter(
            (r) =>
              r.contract === 'giftaid.cancellation' &&
              r.payload.cancelledFrom === '2026-06-01',
          ),
        )
      return [...new Set(revs.map((r) => r.groupName))]
    })
    expect(groups).toEqual(['Gift Aid cancelled from 2026-06-01'])
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
  })

  test('an earlier date moves an existing cancellation back', async () => {
    const { id } = await declare({ scope: 'future', madeOn: '2024-01-01' })
    await cancel('2026-06-01')
    expect((await cancel('2025-06-01')).cancelled).toEqual([id])
    expect((await panel()).declarations[0].cancelledFrom).toBe('2025-06-01')
  })

  test('nothing open, or a bad date, is refused', async () => {
    expect(await kind(cancel('2026-06-01'))).toBe('invalid')
    await declare({ madeOn: '2026-03-03' })
    expect(await kind(cancel('2026-03-02'))).toBe('invalid')
    expect(await kind(cancel('2026-02-30'))).toBe('invalid')
  })

  test('the cancellation contract is stale-checked and can be cleared', async () => {
    const { id } = await declare()
    await cancel('2026-06-01')
    const run = (expected: number, cancelledFrom?: string) =>
      f.t.run((ctx) =>
        executeContract(
          scoped(ctx, f.a.tenantId),
          cancellation,
          { cancelledFrom },
          { entityId: id, expected, source: 'test' },
        ),
      )
    expect(await kind(run(0))).toBe('stale')
    await run(1)
    expect((await panel()).declarations[0].cancelledFrom).toBeUndefined()
    expect((await panel()).currentId).toBe(id)
  })
})

describe('coverage and currentDeclaration', () => {
  const covering = (date: string, contributionId?: Id<'contributions'>) =>
    f.t.run((ctx) =>
      coverage(
        { db: scopeWriter(ctx, f.a.tenantId) },
        jo,
        date,
        contributionId,
      ),
    )

  test('derived from the chain, from a gift date', async () => {
    const enduring = await declare({ madeOn: '2026-03-03' })
    expect(await covering('2022-03-03')).toMatchObject({
      id: enduring.id,
      scope: 'futureAndPast4y',
      method: 'paperForm',
      madeOn: '2026-03-03',
    })
    expect(await covering('2022-03-02')).toBeNull()
    await cancel('2026-06-01')
    expect(await covering('2026-05-31')).not.toBeNull()
    expect(await covering('2026-06-01')).toBeNull()

    const gift = await giftFor(f.t, f.a, jo, '2026-07-01')
    const one = await declare({
      scope: 'thisGift',
      contributionId: gift,
      madeOn: '2026-07-01',
    })
    expect((await covering('2026-07-01', gift))?.id).toBe(one.id)
    expect(await covering('2026-07-01')).toBeNull()

    expect(
      await f.t.run((ctx) =>
        currentDeclaration(
          { db: scopeWriter(ctx, f.a.tenantId) },
          jo,
          '2026-10-23',
        ),
      ),
    ).toBeNull()
  })
})

describe('tenancy and permissions', () => {
  test('another tenant’s contact, gift or declaration is refused or invisible', async () => {
    await declare()
    const bob = await newContact(f.b, person('Bob', 'Beta'))
    bSnapshot = await snapshot(f.t, f.b.tenantId)

    expect(await reason(declare({ contactId: bob }))).toBe('unknown_contact')
    const bGift = await giftFor(f.t, f.b, bob, '2026-03-03')
    bSnapshot = await snapshot(f.t, f.b.tenantId)
    expect(
      await reason(declare({ scope: 'thisGift', contributionId: bGift })),
    ).toBe('unknown_gift')

    // B cannot see or cancel A's declarations.
    expect((await panel('2026-10-23', f.b, jo)).declarations).toEqual([])
    expect(await kind(cancel('2026-06-01', undefined, f.b, jo))).toBe('invalid')
    const [aDecl] = (await panel()).declarations
    expect(
      await kind(
        f.t.run((ctx) =>
          executeContract(
            scoped(ctx, f.b.tenantId),
            cancellation,
            { cancelledFrom: '2026-06-01' },
            { entityId: aDecl._id, source: 'test' },
          ),
        ),
      ),
    ).toBe('not_found')
    expect(
      await f.t.run((ctx) =>
        coverage({ db: scopeWriter(ctx, f.b.tenantId) }, jo, '2026-06-01'),
      ),
    ).toBeNull()
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
    expect((await panel()).declarations[0].cancelledFrom).toBeUndefined()
  })

  test('a viewer reads but never writes', async () => {
    await declare()
    const viewer = await member(f.t, f.a, 'viewer')
    expect(await kind(declare({}, viewer))).toBe('forbidden')
    expect(await kind(cancel('2026-06-01', undefined, viewer))).toBe(
      'forbidden',
    )
    expect((await panel('2026-10-23', viewer)).declarations).toHaveLength(1)
    const staff = await member(f.t, f.a, 'staff')
    await declare({ madeOn: '2026-04-01' }, staff)
  })
})
