/**
 * Tenant preferences: "staff can manage tags" and "staff can manage
 * identifier types" (both off by default, independent). Admins always
 * manage both lists, staff each one only while its switch is on, viewers
 * never; applying tags to contacts stays ordinary staff editing. One
 * tenant's switches never reach another.
 */
import type { TestConvex } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type schema from '../schema'
import { errorData, setup } from '../../test/fixture'
import type { ListKind } from '../lib/lists'
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
  kind: ListKind,
  on: boolean,
  expected?: number,
) =>
  kind === 'tags'
    ? as.mutation(api.platform.preferences.setStaffCanManageTags, {
        tenantId,
        staffCanManageTags: on,
        expected,
      })
    : as.mutation(api.platform.preferences.setStaffCanManageIdentifierTypes, {
        tenantId,
        staffCanManageIdentifierTypes: on,
        expected,
      })

/** Error kind of creating one entry in `kind`, or null when it succeeds. */
async function manage(
  as: Caller,
  tenantId: Id<'tenants'>,
  kind: ListKind,
  name: string,
) {
  const attempt =
    kind === 'tags'
      ? as.mutation(api.contacts.mutations.saveTag, {
          tenantId,
          name: `${name} tag`,
          isActive: true,
        })
      : as.mutation(api.contacts.mutations.saveIdentifierType, {
          tenantId,
          name: `${name} type`,
          isActive: true,
        })
  return attempt.then(
    () => null,
    (e: unknown) => (e as { data?: { kind?: string } }).data?.kind ?? 'error',
  )
}

const KINDS = ['tags', 'identifierTypes'] as const

describe('staff can manage lists, per list', () => {
  test('both off by default: admins manage, staff and viewers are forbidden', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const viewer = await member(t, a.tenantId, 'viewer')

    expect(await prefs(a.as, a.tenantId)).toMatchObject({
      staffCanManageTags: false,
      tagsVersion: null,
      staffCanManageIdentifierTypes: false,
      identifierTypesVersion: null,
      canManageTags: true,
      canManageIdentifierTypes: true,
    })
    expect(await prefs(staff, a.tenantId)).toMatchObject({
      canManageTags: false,
      canManageIdentifierTypes: false,
    })
    expect(await prefs(viewer, a.tenantId)).toMatchObject({
      canManageTags: false,
      canManageIdentifierTypes: false,
    })
    for (const kind of KINDS) {
      expect(await manage(a.as, a.tenantId, kind, 'admin'), kind).toBeNull()
      expect(await manage(staff, a.tenantId, kind, 'staff'), kind).toBe(
        'forbidden',
      )
      expect(await manage(viewer, a.tenantId, kind, 'viewer'), kind).toBe(
        'forbidden',
      )
    }
  })

  for (const kind of KINDS) {
    const other = kind === 'tags' ? 'identifierTypes' : 'tags'
    test(`${kind} on in A: A staff manage ${kind} only, viewers never, B untouched`, async () => {
      const { t, a, b } = await setup()
      const staffA = await member(t, a.tenantId, 'staff')
      const viewerA = await member(t, a.tenantId, 'viewer')
      const staffB = await member(t, b.tenantId, 'staff')

      await set(a.as, a.tenantId, kind, true)
      const can = (k: ListKind) =>
        k === 'tags' ? 'canManageTags' : 'canManageIdentifierTypes'
      expect(await prefs(staffA, a.tenantId)).toMatchObject({
        [can(kind)]: true,
        [can(other)]: false,
        // The row is new: both counters at 0, one revision (this one).
        tagsVersion: 0,
        identifierTypesVersion: 0,
      })
      expect(await prefs(staffB, b.tenantId)).toMatchObject({
        canManageTags: false,
        canManageIdentifierTypes: false,
        tagsVersion: null,
      })
      expect(await manage(staffA, a.tenantId, kind, 'staff')).toBeNull()
      expect(await manage(staffA, a.tenantId, other, 'staff')).toBe('forbidden')
      expect(await manage(viewerA, a.tenantId, kind, 'viewer')).toBe(
        'forbidden',
      )
      expect(await manage(staffB, b.tenantId, kind, 'staff')).toBe('forbidden')

      // The other switch on too, then this one off: each moves alone.
      await set(a.as, a.tenantId, other, true, 0)
      expect(await manage(staffA, a.tenantId, other, 'staff2')).toBeNull()
      await set(a.as, a.tenantId, kind, false, 0)
      expect(await manage(staffA, a.tenantId, kind, 'staff3')).toBe('forbidden')
      expect(await manage(staffA, a.tenantId, other, 'staff3')).toBeNull()
    })
  }

  test('staff rename and archive under the switch, and lose it when off', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    await set(a.as, a.tenantId, 'tags', true)
    expect(await manage(staff, a.tenantId, 'tags', 'staff')).toBeNull()
    const tag = (
      await staff.query(api.contacts.queries.tags, {
        tenantId: a.tenantId,
        includeInactive: true,
      })
    ).find((x) => x.name === 'staff tag')!
    await staff.mutation(api.contacts.mutations.saveTag, {
      tenantId: a.tenantId,
      id: tag._id,
      expected: tag.saveVersion,
      name: 'staff tag',
      isActive: false,
    })
    await set(a.as, a.tenantId, 'tags', false, 0)
    expect(
      await errorData(
        staff.mutation(api.contacts.mutations.saveTag, {
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

  test('only admins switch them; stale saves are refused per switch; each save is a revision', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const viewer = await member(t, a.tenantId, 'viewer')
    for (const kind of KINDS) {
      for (const as of [staff, viewer]) {
        expect(await errorData(set(as, a.tenantId, kind, true))).toEqual({
          kind: 'forbidden',
        })
      }
    }

    await set(a.as, a.tenantId, 'tags', true)
    // Another admin who still sees the default (no row), or an old version.
    expect(await errorData(set(a.as, a.tenantId, 'tags', false))).toMatchObject(
      { kind: 'stale', current: 0 },
    )
    expect(
      await errorData(set(a.as, a.tenantId, 'identifierTypes', true)),
    ).toMatchObject({ kind: 'stale', current: 0 })
    await set(a.as, a.tenantId, 'tags', false, 0)
    expect(
      await errorData(set(a.as, a.tenantId, 'tags', true, 0)),
    ).toMatchObject({ kind: 'stale', current: 1 })
    // The tags saves moved only the tags counter: no false conflict.
    await set(a.as, a.tenantId, 'identifierTypes', true, 0)

    const revisions = await t.run((ctx) =>
      ctx.db
        .query('revisions')
        .collect()
        .then((rows) =>
          rows.filter((r) => r.contract.startsWith('tenantPreferences.')),
        ),
    )
    expect(
      revisions.map((r) => [r.tenantId, r.contract, r.counter, r.payload]),
    ).toEqual([
      [a.tenantId, 'tenantPreferences.tags', 0, { staffCanManageTags: true }],
      [a.tenantId, 'tenantPreferences.tags', 1, { staffCanManageTags: false }],
      [
        a.tenantId,
        'tenantPreferences.identifierTypes',
        1,
        { staffCanManageIdentifierTypes: true },
      ],
    ])
  })
})

describe('restoring a list revision', () => {
  test('needs a manager of that list: staff only while its switch is on', async () => {
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
    const tagRevision = await first(tagId)
    const typeRevision = await first(typeId)
    const restore = (as: Caller, revisionId: typeof tagRevision) =>
      as.mutation(api.contacts.mutations.restoreRevision, {
        tenantId: a.tenantId,
        revisionId,
      })

    for (const revisionId of [tagRevision, typeRevision]) {
      expect(await errorData(restore(staff, revisionId))).toEqual({
        kind: 'forbidden',
      })
      expect(await errorData(restore(viewer, revisionId))).toEqual({
        kind: 'forbidden',
      })
      await restore(a.as, revisionId)
    }
    // Tags on: staff restore the tag, not the identifier type.
    await set(a.as, a.tenantId, 'tags', true)
    await restore(staff, tagRevision)
    expect(await errorData(restore(staff, typeRevision))).toEqual({
      kind: 'forbidden',
    })
    // Identifier types on, tags off: the other way round.
    await set(a.as, a.tenantId, 'identifierTypes', true, 0)
    await set(a.as, a.tenantId, 'tags', false, 0)
    await restore(staff, typeRevision)
    expect(await errorData(restore(staff, tagRevision))).toEqual({
      kind: 'forbidden',
    })
    expect(await errorData(restore(viewer, typeRevision))).toEqual({
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
