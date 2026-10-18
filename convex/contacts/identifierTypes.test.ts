import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import type { Role } from '../lib/tenancy'

// Identifier types through their public functions (external-ids X4a): the
// settings page's create / rename / archive / reactivate, admin only.

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

/** A caller holding `role` in tenant A. */
async function member(role: Role) {
  const userId = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: `${role}@example.com` })
    await ctx.db.insert('memberships', {
      tenantId: f.a.tenantId,
      userId: id,
      role,
    })
    return id
  })
  return f.t.withIdentity({ subject: `${userId}|session-${role}` })
}

const save = (
  args: {
    name: string
    isActive?: boolean
    id?: Id<'identifierTypes'>
    expected?: number
  },
  who: Tenant = f.a,
  as: Tenant['as'] = who.as,
) =>
  as.mutation(api.contacts.mutations.saveIdentifierType, {
    tenantId: who.tenantId,
    isActive: true,
    ...args,
  })
const list = (
  who: Tenant = f.a,
  includeInactive?: boolean,
  as: Tenant['as'] = who.as,
) =>
  as.query(api.contacts.queries.listIdentifierTypes, {
    tenantId: who.tenantId,
    includeInactive,
  })

beforeEach(async () => {
  f = await setup()
})

describe('saveIdentifierType', () => {
  test('no types are seeded', async () => {
    expect(await list(f.a, true)).toEqual([])
    expect(await list(f.b, true)).toEqual([])
  })

  test('creates a type tidied, at saveVersion 0, with a revision', async () => {
    const { id } = await save({ name: '  Membership   number ' })
    expect(await list()).toMatchObject([
      {
        _id: id,
        name: 'Membership number',
        nameNormalized: 'membership number',
        isActive: true,
        saveVersion: 0,
      },
    ])
    const revisions = await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'identifierTypes')
            .eq('entityId', id),
        )
        .collect(),
    )
    expect(revisions).toMatchObject([
      { contract: 'contacts.identifierType', source: 'ui' },
    ])
    expect(await errorData(save({ name: '   ' }))).toMatchObject({
      kind: 'invalid',
    })
  })

  test('names are unique per tenant: trimmed, case-insensitive', async () => {
    const { id } = await save({ name: 'Old CRM id' })
    const other = await save({ name: 'Payroll ref' })
    expect(await errorData(save({ name: '  old crm ID ' }))).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate_identifier_type_name',
    })
    expect(
      await errorData(save({ id: other.id, expected: 0, name: 'OLD CRM ID' })),
    ).toMatchObject({ reason: 'duplicate_identifier_type_name' })
    // An archived type still holds its name.
    await save({ id, expected: 0, name: 'Old CRM id', isActive: false })
    expect(await errorData(save({ name: 'old crm id' }))).toMatchObject({
      reason: 'duplicate_identifier_type_name',
    })
    // Re-casing a type's own name is not a clash.
    await save({ id, expected: 1, name: 'Old CRM ID', isActive: false })
    // The same name in another tenant is fine.
    await save({ name: 'Old CRM id' }, f.b)
  })

  test('rename, archive and reactivate keep the id; archived leaves the default list', async () => {
    const { id } = await save({ name: 'Old CRM id' })
    await save({ name: 'Membership number' })
    await save({ id, expected: 0, name: 'Previous system id' })
    await save({ id, expected: 1, name: 'Previous system id', isActive: false })
    expect((await list()).map((t) => t.name)).toEqual(['Membership number'])
    expect(
      (await list(f.a, true)).map((t) => [t.name, t.isActive, t.saveVersion]),
    ).toEqual([
      ['Membership number', true, 0],
      ['Previous system id', false, 2],
    ])
    await save({ id, expected: 2, name: 'Previous system id', isActive: true })
    expect((await list()).map((t) => t._id)).toContain(id)
  })

  test('a stale save conflicts; an update without its version is refused', async () => {
    const { id } = await save({ name: 'Old CRM id' })
    await save({ id, expected: 0, name: 'Old CRM' })
    expect(
      await errorData(save({ id, expected: 0, name: 'Legacy' })),
    ).toMatchObject({ kind: 'stale', current: 1 })
    expect(await errorData(save({ id, name: 'Legacy' }))).toMatchObject({
      kind: 'invalid',
    })
    expect(await list()).toMatchObject([{ name: 'Old CRM', saveVersion: 1 }])
  })

  test('another tenant’s type cannot be edited, and B observes nothing', async () => {
    const bBefore = await snapshot(f.t, f.b.tenantId)
    const { id } = await save({ name: 'Old CRM id' })
    await save({ id, expected: 0, name: 'Renamed', isActive: false })
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bBefore)
    expect(await list(f.b, true)).toEqual([])

    const bType = await save({ name: 'Theirs' }, f.b)
    expect(
      await errorData(
        f.a.as.mutation(api.contacts.mutations.saveIdentifierType, {
          tenantId: f.a.tenantId,
          id: bType.id,
          expected: 0,
          name: 'Hijacked',
          isActive: true,
        }),
      ),
    ).toEqual({ kind: 'not_found' })
    expect(await list(f.b)).toMatchObject([{ name: 'Theirs', saveVersion: 0 }])
  })
})

describe('roles', () => {
  test('admin writes; staff and viewer are forbidden; every member reads', async () => {
    const staff = await member('staff')
    const viewer = await member('viewer')
    const { id } = await save({ name: 'Old CRM id' })

    for (const as of [staff, viewer]) {
      expect(await errorData(save({ name: 'Nope' }, f.a, as))).toEqual({
        kind: 'forbidden',
      })
      expect(
        await errorData(save({ id, expected: 0, name: 'Nope' }, f.a, as)),
      ).toEqual({ kind: 'forbidden' })
      expect((await list(f.a, true, as)).map((t) => t.name)).toEqual([
        'Old CRM id',
      ])
    }
    expect(await list()).toMatchObject([{ name: 'Old CRM id', saveVersion: 0 }])
    // A role in A grants nothing in B.
    expect(await errorData(list(f.b, true, viewer))).toEqual({
      kind: 'forbidden',
    })
  })
})
