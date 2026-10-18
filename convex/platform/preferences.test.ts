/**
 * Tenant preferences: "staff can manage tags and identifier types" (off by
 * default). Admins always manage the lists, staff only while it is on,
 * viewers never; applying tags to contacts stays ordinary staff editing.
 * One tenant's switch never reaches another.
 */
import type { TestConvex } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type schema from '../schema'
import { errorData, setup } from '../../test/fixture'
import type { Role } from '../lib/tenancy'

type T = TestConvex<typeof schema>

async function member(t: T, tenantId: Id<'tenants'>, role: Role) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('users', {
      email: `${role}-${tenantId}@example.com`,
    })
    await ctx.db.insert('memberships', { tenantId, userId: id, role })
    return id
  })
  return t.withIdentity({ subject: `${userId}|session-${role}-${tenantId}` })
}

type Caller = Awaited<ReturnType<typeof member>>

async function prefs(as: Caller, tenantId: Id<'tenants'>) {
  const mine = await as.query(api.platform.tenants.mine, {})
  return mine.find((m) => m._id === tenantId)!
}

const set = (
  as: Caller,
  tenantId: Id<'tenants'>,
  on: boolean,
  expected?: number,
) =>
  as.mutation(api.platform.preferences.setStaffCanManageLists, {
    tenantId,
    staffCanManageLists: on,
    expected,
  })

/** Error kind of a list-management write, or null when it succeeds. */
async function manage(as: Caller, tenantId: Id<'tenants'>, name: string) {
  const attempt = async () => {
    await as.mutation(api.contacts.mutations.saveTag, {
      tenantId,
      name: `${name} tag`,
      isActive: true,
    })
    await as.mutation(api.contacts.mutations.saveIdentifierType, {
      tenantId,
      name: `${name} type`,
      isActive: true,
    })
  }
  return attempt().then(
    () => null,
    (e: unknown) => (e as { data?: { kind?: string } }).data?.kind ?? 'error',
  )
}

describe('staff can manage lists', () => {
  test('off by default: admins manage, staff and viewers are forbidden', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const viewer = await member(t, a.tenantId, 'viewer')

    expect(await prefs(a.as, a.tenantId)).toMatchObject({
      staffCanManageLists: false,
      listsVersion: null,
      canManageLists: true,
    })
    expect(await prefs(staff, a.tenantId)).toMatchObject({
      staffCanManageLists: false,
      canManageLists: false,
    })
    expect(await prefs(viewer, a.tenantId)).toMatchObject({
      canManageLists: false,
    })
    expect(await manage(a.as, a.tenantId, 'admin')).toBeNull()
    expect(await manage(staff, a.tenantId, 'staff')).toBe('forbidden')
    expect(await manage(viewer, a.tenantId, 'viewer')).toBe('forbidden')
  })

  test('on in A: A staff manage, viewers still cannot, B is untouched', async () => {
    const { t, a, b } = await setup()
    const staffA = await member(t, a.tenantId, 'staff')
    const viewerA = await member(t, a.tenantId, 'viewer')
    const staffB = await member(t, b.tenantId, 'staff')

    await set(a.as, a.tenantId, true)
    expect(await prefs(staffA, a.tenantId)).toMatchObject({
      staffCanManageLists: true,
      listsVersion: 0,
      canManageLists: true,
    })
    expect(await prefs(staffB, b.tenantId)).toMatchObject({
      staffCanManageLists: false,
      canManageLists: false,
    })
    expect(await manage(staffA, a.tenantId, 'staff')).toBeNull()
    expect(await manage(viewerA, a.tenantId, 'viewer')).toBe('forbidden')
    expect(await manage(staffB, b.tenantId, 'staff')).toBe('forbidden')
    expect(await manage(b.as, b.tenantId, 'admin')).toBeNull()

    // Staff may rename and archive too, then lose it when switched off.
    const tag = (
      await staffA.query(api.contacts.queries.tags, {
        tenantId: a.tenantId,
        includeInactive: true,
      })
    ).find((x) => x.name === 'staff tag')!
    await staffA.mutation(api.contacts.mutations.saveTag, {
      tenantId: a.tenantId,
      id: tag._id,
      expected: tag.saveVersion,
      name: 'staff tag',
      isActive: false,
    })
    await set(a.as, a.tenantId, false, 0)
    expect(
      await errorData(
        staffA.mutation(api.contacts.mutations.saveTag, {
          tenantId: a.tenantId,
          id: tag._id,
          expected: tag.saveVersion + 1,
          name: 'staff tag',
          isActive: true,
        }),
      ),
    ).toEqual({ kind: 'forbidden' })
  })

  test('applying tags to contacts stays staff editing while off', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const contactId = await staff.mutation(api.contacts.mutations.create, {
      tenantId: a.tenantId,
      kind: 'individual',
      title: '',
      firstName: '',
      lastName: 'Ames',
      nickname: '',
      name: '',
      isDeceased: false,
    })
    const member_ = (
      await staff.query(api.contacts.queries.tags, { tenantId: a.tenantId })
    ).find((x) => x.name === 'Member')!
    await staff.mutation(api.contacts.mutations.bulkTag, {
      tenantId: a.tenantId,
      contactIds: [contactId],
      tagId: member_._id,
      op: 'add',
    })
    const got = await staff.query(api.contacts.queries.get, {
      tenantId: a.tenantId,
      id: contactId,
    })
    expect(got?.tags.map((x) => x.tagId)).toEqual([member_._id])
  })

  test('only admins switch it; stale saves are refused; each save is a revision', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const viewer = await member(t, a.tenantId, 'viewer')
    for (const as of [staff, viewer]) {
      expect(await errorData(set(as, a.tenantId, true))).toEqual({
        kind: 'forbidden',
      })
    }

    await set(a.as, a.tenantId, true)
    // Another admin who still sees the default (no row), or an old version.
    expect(await errorData(set(a.as, a.tenantId, false))).toMatchObject({
      kind: 'stale',
      current: 0,
    })
    await set(a.as, a.tenantId, false, 0)
    expect(await errorData(set(a.as, a.tenantId, true, 0))).toMatchObject({
      kind: 'stale',
      current: 1,
    })

    const revisions = await t.run((ctx) =>
      ctx.db
        .query('revisions')
        .collect()
        .then((rows) =>
          rows.filter((r) => r.contract === 'tenantPreferences.lists'),
        ),
    )
    expect(revisions.map((r) => [r.tenantId, r.counter, r.payload])).toEqual([
      [a.tenantId, 0, { staffCanManageLists: true }],
      [a.tenantId, 1, { staffCanManageLists: false }],
    ])
  })
})

describe('restoring a list revision', () => {
  test('needs a list manager: staff only while on, admins always', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const viewer = await member(t, a.tenantId, 'viewer')
    // An old name to go back to, for a tag and an identifier type.
    const tagId = (
      await a.as.query(api.contacts.queries.tags, { tenantId: a.tenantId })
    ).find((x) => x.name === 'Member')!._id
    await a.as.mutation(api.contacts.mutations.saveTag, {
      tenantId: a.tenantId,
      id: tagId,
      expected: 0,
      name: 'Members',
      isActive: true,
    })
    const { id: typeId } = await a.as.mutation(
      api.contacts.mutations.saveIdentifierType,
      { tenantId: a.tenantId, name: 'Old CRM id', isActive: true },
    )
    await a.as.mutation(api.contacts.mutations.saveIdentifierType, {
      tenantId: a.tenantId,
      id: typeId,
      expected: 0,
      name: 'Legacy id',
      isActive: false,
    })
    const first = (entityId: string) =>
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query('revisions')
          .withIndex('by_tenant_entity', (q) => q.eq('tenantId', a.tenantId))
          .collect()
        return rows.find((r) => r.entityId === entityId && r.counter === 0)!._id
      })
    const revisions = [await first(tagId), await first(typeId)]
    const restore = (as: Caller, revisionId: (typeof revisions)[number]) =>
      as.mutation(api.contacts.mutations.restoreRevision, {
        tenantId: a.tenantId,
        revisionId,
      })

    for (const revisionId of revisions) {
      expect(await errorData(restore(staff, revisionId))).toEqual({
        kind: 'forbidden',
      })
      expect(await errorData(restore(viewer, revisionId))).toEqual({
        kind: 'forbidden',
      })
      await restore(a.as, revisionId)
    }
    await set(a.as, a.tenantId, true)
    for (const revisionId of revisions) await restore(staff, revisionId)
    expect(await errorData(restore(viewer, revisions[0]))).toEqual({
      kind: 'forbidden',
    })

    const tags = await staff.query(api.contacts.queries.tags, {
      tenantId: a.tenantId,
    })
    expect(tags.map((x) => x.name)).toContain('Member')
    const types = await staff.query(api.contacts.queries.listIdentifierTypes, {
      tenantId: a.tenantId,
      includeInactive: true,
    })
    expect(types.map((x) => [x.name, x.isActive])).toEqual([
      ['Old CRM id', true],
    ])
  })
})
