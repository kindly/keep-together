/**
 * Tenant preferences: "staff can manage identifier types" and "staff can
 * manage fields" (both off by default, independent; source codes' switch
 * is the same contract shape, covered by the roles meta-test). Admins
 * always manage both lists, staff each one only while its switch is on,
 * viewers never; setting field values on contacts stays ordinary staff
 * editing. One tenant's switches never reach another.
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

const KINDS = ['identifierTypes', 'fields'] as const
type Kind = (typeof KINDS)[number] & ListKind

const set = (
  as: Caller,
  tenantId: Id<'tenants'>,
  kind: Kind,
  on: boolean,
  expected?: number,
) =>
  kind === 'fields'
    ? as.mutation(api.platform.preferences.setStaffCanManageFields, {
        tenantId,
        staffCanManageFields: on,
        expected,
      })
    : as.mutation(api.platform.preferences.setStaffCanManageIdentifierTypes, {
        tenantId,
        staffCanManageIdentifierTypes: on,
        expected,
      })

const ALL_KINDS = ['individual', 'organization', 'household'] as const

/** Error kind of creating one entry in `kind`, or null when it succeeds. */
async function manage(
  as: Caller,
  tenantId: Id<'tenants'>,
  kind: Kind,
  name: string,
) {
  const attempt =
    kind === 'fields'
      ? as.mutation(api.contacts.fields.createField, {
          tenantId,
          label: `${name} field`,
          appliesTo: [...ALL_KINDS],
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

describe('staff can manage lists, per list', () => {
  test('both off by default: admins manage, staff and viewers are forbidden', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const viewer = await member(t, a.tenantId, 'viewer')

    expect(await prefs(a.as, a.tenantId)).toMatchObject({
      staffCanManageIdentifierTypes: false,
      identifierTypesVersion: null,
      staffCanManageFields: false,
      fieldsVersion: null,
      canManageIdentifierTypes: true,
      canManageFields: true,
    })
    expect(await prefs(staff, a.tenantId)).toMatchObject({
      canManageIdentifierTypes: false,
      canManageFields: false,
    })
    expect(await prefs(viewer, a.tenantId)).toMatchObject({
      canManageIdentifierTypes: false,
      canManageFields: false,
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
    const other: Kind = kind === 'fields' ? 'identifierTypes' : 'fields'
    test(`${kind} on in A: A staff manage ${kind} only, viewers never, B untouched`, async () => {
      const { t, a, b } = await setup()
      const staffA = await member(t, a.tenantId, 'staff')
      const viewerA = await member(t, a.tenantId, 'viewer')
      const staffB = await member(t, b.tenantId, 'staff')

      await set(a.as, a.tenantId, kind, true)
      const can = (k: Kind) =>
        k === 'fields' ? 'canManageFields' : 'canManageIdentifierTypes'
      expect(await prefs(staffA, a.tenantId)).toMatchObject({
        [can(kind)]: true,
        [can(other)]: false,
        // The row is new: both counters at 0, one revision (this one).
        fieldsVersion: 0,
        identifierTypesVersion: 0,
      })
      expect(await prefs(staffB, b.tenantId)).toMatchObject({
        canManageFields: false,
        canManageIdentifierTypes: false,
        fieldsVersion: null,
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
    await set(a.as, a.tenantId, 'fields', true)
    expect(await manage(staff, a.tenantId, 'fields', 'staff')).toBeNull()
    const field = (
      await staff.query(api.contacts.fields.list, { tenantId: a.tenantId })
    ).find((x) => x.label === 'staff field')!
    await staff.mutation(api.contacts.fields.saveField, {
      tenantId: a.tenantId,
      id: field._id,
      expected: field.saveVersion,
      label: 'staff field',
      appliesTo: [...ALL_KINDS],
      isActive: false,
    })
    await set(a.as, a.tenantId, 'fields', false, 0)
    expect(
      await errorData(
        staff.mutation(api.contacts.fields.saveField, {
          tenantId: a.tenantId,
          id: field._id,
          expected: field.saveVersion + 1,
          label: 'staff field',
          appliesTo: [...ALL_KINDS],
          isActive: true,
        }),
      ),
    ).toEqual({ kind: 'forbidden' })
  })

  test('setting field values on contacts stays staff editing while off', async () => {
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
    const { id: fieldId } = await a.as.mutation(
      api.contacts.fields.createField,
      {
        tenantId: a.tenantId,
        label: 'Region',
        appliesTo: [...ALL_KINDS],
        isActive: true,
      },
    )
    const { id: optionId } = await a.as.mutation(
      api.contacts.fields.addOption,
      {
        tenantId: a.tenantId,
        fieldId,
        label: 'North',
      },
    )
    await staff.mutation(api.contacts.mutations.bulkSetField, {
      tenantId: a.tenantId,
      contactIds: [contactId],
      fieldId,
      optionId,
    })
    const got = await staff.query(api.contacts.queries.get, {
      tenantId: a.tenantId,
      id: contactId,
    })
    expect(got?.fields.map((x) => x.optionId)).toEqual([optionId])
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

    await set(a.as, a.tenantId, 'fields', true)
    // Another admin who still sees the default (no row), or an old version.
    expect(
      await errorData(set(a.as, a.tenantId, 'fields', false)),
    ).toMatchObject({ kind: 'stale', current: 0 })
    expect(
      await errorData(set(a.as, a.tenantId, 'identifierTypes', true)),
    ).toMatchObject({ kind: 'stale', current: 0 })
    await set(a.as, a.tenantId, 'fields', false, 0)
    expect(
      await errorData(set(a.as, a.tenantId, 'fields', true, 0)),
    ).toMatchObject({ kind: 'stale', current: 1 })
    // The fields saves moved only the fields counter: no false conflict.
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
      [
        a.tenantId,
        'tenantPreferences.fields',
        0,
        { staffCanManageFields: true },
      ],
      [
        a.tenantId,
        'tenantPreferences.fields',
        1,
        { staffCanManageFields: false },
      ],
      [
        a.tenantId,
        'tenantPreferences.identifierTypes',
        1,
        { staffCanManageIdentifierTypes: true },
      ],
    ])
  })

  test('a row from before tags left, still holding the tag switch, keeps working', async () => {
    const { t, a } = await setup()
    // As written before dropdown fields step 7: every switch, tags too.
    await t.run((ctx) =>
      ctx.db.insert('tenantPreferences', {
        tenantId: a.tenantId,
        staffCanManageTags: true,
        tagsVersion: 3,
        staffCanManageIdentifierTypes: false,
        identifierTypesVersion: 0,
        staffCanManageSourceCodes: false,
        sourceCodesVersion: 0,
        staffCanManageFields: false,
        fieldsVersion: 0,
      }),
    )
    await set(a.as, a.tenantId, 'fields', true, 0)
    expect(await prefs(a.as, a.tenantId)).toMatchObject({
      staffCanManageFields: true,
      fieldsVersion: 1,
    })
    expect(await prefs(a.as, a.tenantId)).not.toHaveProperty(
      'staffCanManageTags',
    )
  })
})

describe('restoring a list revision', () => {
  test('needs a manager of that list: staff only while its switch is on', async () => {
    const { t, a } = await setup()
    const staff = await member(t, a.tenantId, 'staff')
    const viewer = await member(t, a.tenantId, 'viewer')
    // An old name to go back to.
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
    const typeRevision = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) => q.eq('tenantId', a.tenantId))
        .collect()
      return rows.find((r) => r.entityId === typeId && r.counter === 0)!._id
    })
    const restore = (as: Caller) =>
      as.mutation(api.contacts.mutations.restoreRevision, {
        tenantId: a.tenantId,
        revisionId: typeRevision,
      })

    expect(await errorData(restore(staff))).toEqual({ kind: 'forbidden' })
    expect(await errorData(restore(viewer))).toEqual({ kind: 'forbidden' })
    // Another list's switch alone opens nothing.
    await set(a.as, a.tenantId, 'fields', true)
    expect(await errorData(restore(staff))).toEqual({ kind: 'forbidden' })
    await set(a.as, a.tenantId, 'identifierTypes', true, 0)
    await restore(staff)
    expect(await errorData(restore(viewer))).toEqual({ kind: 'forbidden' })

    const types = await staff.query(api.contacts.queries.listIdentifierTypes, {
      tenantId: a.tenantId,
      includeInactive: true,
    })
    expect(types.map((x) => [x.name, x.isActive])).toEqual([
      ['Old CRM id', true],
    ])
  })
})
