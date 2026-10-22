/**
 * Dropdown field definitions (plan: dropdown fields, step 2): the
 * `contacts.field` and `contacts.fieldOption` contracts, slots, options'
 * order and `used` marker, delete while unused, retire, the value rule
 * step 4 applies, and the "staff can manage fields" switch. Two tenants
 * throughout.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { defineContract, executeContract, restore } from '../lib/contracts'
import { FIELD_SLOTS, SLOT_FIELD_NAMES, slotFieldName } from '../lib/fieldSlots'
import type { FieldSlot } from '../lib/fieldSlots'
import { scopeWriter } from '../lib/tenancy'
import type { Role } from '../lib/tenancy'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { contactContracts } from './contracts'
import {
  FIELD_OPTION_LIMIT,
  fieldValueVerdict,
  fieldValuesFields,
  retireGroupName,
} from './fieldTypes'
import type { ContactKind, FieldValue } from './fieldTypes'
import {
  fieldContracts,
  fieldValuesOf,
  RETIRE_BATCH,
  fieldsBySlot,
  markOptionUsed,
  resolveFieldValue,
} from './fields'

type Fixture = Awaited<ReturnType<typeof setup>>
type FieldId = Id<'contactFields'>
type OptionId = Id<'contactFieldOptions'>

let f: Fixture

beforeEach(async () => {
  f = await setup()
})

// ── a stand-in for step 4's contract ─────────────────────────────────────────

/**
 * Retire runs `contacts.fields`, which step 4 builds. Until it is in
 * `contactContracts`, these tests register this minimal stand-in: values
 * through `resolveFieldValue` and `markOptionUsed`, slots copied onto
 * `contactSearch`. Once step 4 has merged, the real contract is used.
 */
const standIn = defineContract({
  name: 'contacts.fields',
  entity: 'contacts',
  version: 1,
  counter: 'fieldsVersion',
  fields: fieldValuesFields,
  apply: async (ctx, p, root, command) => {
    const contact = root!
    const patch: Partial<Record<string, OptionId | undefined>> =
      Object.fromEntries(SLOT_FIELD_NAMES.map((n) => [n, undefined]))
    for (const value of p.values) {
      const field = await ctx.db.get(value.fieldId)
      const current = field?.slot
        ? contact[slotFieldName(field.slot as FieldSlot)]
        : undefined
      const r = await resolveFieldValue(
        ctx.db,
        value,
        contact.kind,
        current,
        command.source === 'restore' ? 'restore' : 'save',
      )
      if (r.outcome !== 'set') continue
      patch[slotFieldName(r.slot)] = value.optionId
      if (value.optionId !== current) await markOptionUsed(ctx, value.optionId)
    }
    await ctx.db.patch('contacts', contact._id, patch)
    return contact._id
  },
  project: async (ctx, id) => {
    const contact = (await ctx.db.get(id))!
    const row = await ctx.db
      .query('contactSearch')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', id))
      .unique()
    await ctx.db.patch(
      'contactSearch',
      row!._id,
      Object.fromEntries(SLOT_FIELD_NAMES.map((n) => [n, contact[n]])),
    )
  },
})
if (!Object.hasOwn(contactContracts, 'contacts.fields')) {
  contactContracts['contacts.fields'] = standIn
}

// ── helpers ─────────────────────────────────────────────────────────────────

const scoped = (ctx: MutationCtx, tenantId: Id<'tenants'>) => ({
  db: scopeWriter(ctx, tenantId),
  userId: null,
  role: null,
})

const list = (who: Tenant, as: Tenant['as'] = who.as) =>
  as.query(api.contacts.fields.list, { tenantId: who.tenantId })

const createField = (
  who: Tenant,
  label: string,
  appliesTo: Array<ContactKind> = ['individual', 'organization', 'household'],
  as: Tenant['as'] = who.as,
) =>
  as.mutation(api.contacts.fields.createField, {
    tenantId: who.tenantId,
    label,
    appliesTo,
    isActive: true,
  })

const addOption = (
  who: Tenant,
  fieldId: FieldId,
  label: string,
  as: Tenant['as'] = who.as,
) =>
  as.mutation(api.contacts.fields.addOption, {
    tenantId: who.tenantId,
    fieldId,
    label,
  })

async function definition(who: Tenant, id: FieldId) {
  return (await list(who)).find((d) => d._id === id)!
}

async function option(who: Tenant, fieldId: FieldId, id: OptionId) {
  return (await definition(who, fieldId)).options.find((o) => o._id === id)!
}

async function saveField(
  who: Tenant,
  id: FieldId,
  change: Partial<{
    label: string
    appliesTo: Array<ContactKind>
    isActive: boolean
  }>,
) {
  const d = await definition(who, id)
  return who.as.mutation(api.contacts.fields.saveField, {
    tenantId: who.tenantId,
    id,
    expected: d.saveVersion,
    label: d.label,
    appliesTo: d.appliesTo,
    isActive: d.isActive,
    ...change,
  })
}

async function saveOption(
  who: Tenant,
  fieldId: FieldId,
  id: OptionId,
  change: Partial<{ label: string; isActive: boolean }>,
) {
  const o = await option(who, fieldId, id)
  return who.as.mutation(api.contacts.fields.saveOption, {
    tenantId: who.tenantId,
    id,
    expected: o.saveVersion,
    label: o.label,
    isActive: o.isActive,
    ...change,
  })
}

/** A field with options, in `who`'s tenant. */
async function fieldWith(
  who: Tenant,
  label: string,
  options: Array<string>,
  appliesTo?: Array<ContactKind>,
) {
  const { id } = await createField(who, label, appliesTo)
  const ids: Array<OptionId> = []
  for (const o of options) ids.push((await addOption(who, id, o)).id)
  return { id, options: ids }
}

const contact = (
  who: Tenant,
  firstName: string,
  kind: ContactKind = 'individual',
) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    kind,
    title: '',
    firstName,
    lastName: 'Test',
    nickname: '',
    name: kind === 'individual' ? '' : firstName,
    isDeceased: false,
  })

/** Set a contact's field values through `contacts.fields`. */
const setValues = (
  who: Tenant,
  id: Id<'contacts'>,
  values: Array<FieldValue>,
) =>
  f.t.run((ctx) =>
    executeContract(
      { ...scoped(ctx, who.tenantId), role: 'admin' },
      contactContracts['contacts.fields'],
      { values },
      { entityId: id, source: 'ui' },
    ),
  )

const getDoc = <T extends 'contacts' | 'contactFields' | 'contactFieldOptions'>(
  id: Id<T>,
) => f.t.run((ctx) => ctx.db.get(id)) as Promise<Doc<T> | null>

/** A user holding `role` in tenant A, as a caller. */
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

const revisionsOf = (who: Tenant, entity: string, entityId: string) =>
  f.t.run((ctx) =>
    ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q
          .eq('tenantId', who.tenantId)
          .eq('entity', entity)
          .eq('entityId', entityId),
      )
      .collect(),
  )

// ── fields ──────────────────────────────────────────────────────────────────

describe('contacts.field', () => {
  test('no fields to start with: five empty slots', async () => {
    expect(await list(f.a)).toEqual([])
    expect(await list(f.b)).toEqual([])
  })

  test('creates a field tidied, in slot 1, with a revision', async () => {
    const { id } = await createField(f.a, '  Volunteer   status ', [
      'household',
      'individual',
      'individual',
    ])
    expect(await list(f.a)).toEqual([
      {
        _id: id,
        label: 'Volunteer status',
        appliesTo: ['individual', 'household'],
        isActive: true,
        retiring: false,
        slot: 1,
        saveVersion: 0,
        options: [],
        deletable: true,
      },
    ])
    expect(await revisionsOf(f.a, 'contactFields', id)).toMatchObject([
      { contract: 'contacts.field', source: 'ui', counter: 0 },
    ])
    expect(await errorData(createField(f.a, '   '))).toMatchObject({
      kind: 'invalid',
    })
    expect(await errorData(createField(f.a, 'Region', []))).toMatchObject({
      kind: 'invalid',
      problems: [{ field: 'appliesTo' }],
    })
  })

  test('labels are unique per tenant, case-insensitively; other tenants free', async () => {
    const { id } = await createField(f.a, 'Region')
    expect(await errorData(createField(f.a, ' REGION '))).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate_field_label',
    })
    const other = await createField(f.a, 'Status')
    expect(
      await errorData(saveField(f.a, other.id, { label: 'region' })),
    ).toMatchObject({ reason: 'duplicate_field_label' })
    // An archived field still holds its label; re-casing its own is fine.
    await saveField(f.a, id, { isActive: false })
    expect(await errorData(createField(f.a, 'region'))).toMatchObject({
      reason: 'duplicate_field_label',
    })
    await saveField(f.a, id, { label: 'REGION' })
    await createField(f.b, 'Region')
  })

  test('rename, kinds and archive keep the id and the slot', async () => {
    const { id } = await createField(f.a, 'Region')
    await createField(f.a, 'Status')
    await saveField(f.a, id, { label: 'Area', appliesTo: ['organization'] })
    await saveField(f.a, id, { isActive: false })
    expect(await definition(f.a, id)).toMatchObject({
      label: 'Area',
      appliesTo: ['organization'],
      isActive: false,
      slot: 1,
      saveVersion: 2,
    })
    expect(
      await errorData(
        f.a.as.mutation(api.contacts.fields.saveField, {
          tenantId: f.a.tenantId,
          id,
          expected: 0,
          label: 'Stale',
          appliesTo: ['individual'],
          isActive: true,
        }),
      ),
    ).toMatchObject({ kind: 'stale', current: 2 })
  })
})

describe('slots', () => {
  test('lowest free slot; all five taken refuses a sixth', async () => {
    const ids: Array<FieldId> = []
    for (let i = 1; i <= FIELD_SLOTS; i++) {
      const { id } = await createField(f.a, `Field ${i}`)
      ids.push(id)
      expect((await definition(f.a, id)).slot).toBe(i)
    }
    expect(await errorData(createField(f.a, 'One too many'))).toMatchObject({
      kind: 'rejected',
      reason: 'no_free_slot',
    })
    // B's slots are its own.
    expect((await definition(f.b, (await createField(f.b, 'B')).id)).slot).toBe(
      1,
    )
    // Deleting the field in slot 2 frees it for the next.
    await f.a.as.mutation(api.contacts.fields.deleteField, {
      tenantId: f.a.tenantId,
      id: ids[1],
      expected: 0,
    })
    const { id } = await createField(f.a, 'Replacement')
    expect((await definition(f.a, id)).slot).toBe(2)
  })
})

// ── options ─────────────────────────────────────────────────────────────────

describe('contacts.fieldOption', () => {
  test('added in order at the end, tidied, with revisions', async () => {
    const field = await fieldWith(f.a, 'Level', ['Bronze', '  Silver ', 'Gold'])
    expect((await definition(f.a, field.id)).options).toMatchObject([
      { label: 'Bronze', position: 0, isActive: true, used: false },
      { label: 'Silver', position: 1 },
      { label: 'Gold', position: 2 },
    ])
    expect(
      await revisionsOf(f.a, 'contactFieldOptions', field.options[0]),
    ).toMatchObject([{ contract: 'contacts.fieldOption', counter: 0 }])
    expect(await errorData(addOption(f.a, field.id, '  '))).toMatchObject({
      kind: 'invalid',
    })
  })

  test('labels unique within the field only', async () => {
    const level = await fieldWith(f.a, 'Level', ['Gold'])
    const medal = await fieldWith(f.a, 'Medal', [])
    expect(await errorData(addOption(f.a, level.id, 'GOLD'))).toMatchObject({
      reason: 'duplicate_option_label',
    })
    await addOption(f.a, medal.id, 'Gold')
    const silver = await addOption(f.a, level.id, 'Silver')
    expect(
      await errorData(saveOption(f.a, level.id, silver.id, { label: 'gold' })),
    ).toMatchObject({ reason: 'duplicate_option_label' })
  })

  test('rename and archive keep the position', async () => {
    const field = await fieldWith(f.a, 'Level', ['Bronze', 'Silver'])
    await saveOption(f.a, field.id, field.options[0], {
      label: 'Copper',
      isActive: false,
    })
    expect(await option(f.a, field.id, field.options[0])).toMatchObject({
      label: 'Copper',
      isActive: false,
      position: 0,
      saveVersion: 1,
    })
  })

  test('a field holds at most FIELD_OPTION_LIMIT options', async () => {
    const { id } = await createField(f.a, 'Big')
    await f.t.run(async (ctx) => {
      const db = scopeWriter(ctx, f.a.tenantId)
      for (let i = 0; i < FIELD_OPTION_LIMIT; i++) {
        await db.insert('contactFieldOptions', {
          fieldId: id,
          label: `o${i}`,
          labelNormalized: `o${i}`,
          position: i,
          isActive: true,
          used: false,
          saveVersion: 0,
        })
      }
    })
    expect(await errorData(addOption(f.a, id, 'One more'))).toMatchObject({
      reason: 'option_limit',
    })
  })

  test('reorder: every option named, one contract per move, one group', async () => {
    const field = await fieldWith(f.a, 'Level', ['Gold', 'Silver', 'Bronze'])
    const [gold, silver, bronze] = field.options
    const reorder = (order: Array<OptionId>) =>
      f.a.as.mutation(api.contacts.fields.reorderOptions, {
        tenantId: f.a.tenantId,
        fieldId: field.id,
        order,
      })
    expect(await reorder([bronze, silver, gold])).toEqual({ moved: 2 })
    expect(
      (await definition(f.a, field.id)).options.map((o) => o.label),
    ).toEqual(['Bronze', 'Silver', 'Gold'])
    const [g] = await revisionsOf(f.a, 'contactFieldOptions', gold).then((r) =>
      r.filter((x) => x.counter === 1),
    )
    const [b] = await revisionsOf(f.a, 'contactFieldOptions', bronze).then(
      (r) => r.filter((x) => x.counter === 1),
    )
    expect(g.groupName).toBe('Reorder Level')
    expect(g.group).toBe(b.group)
    expect(await reorder([bronze, silver, gold])).toEqual({ moved: 0 })
    for (const bad of [
      [bronze, silver],
      [bronze, silver, gold, gold],
    ]) {
      expect(await errorData(reorder(bad))).toMatchObject({ kind: 'stale' })
    }
    const other = await fieldWith(f.a, 'Other', ['X'])
    expect(
      await errorData(reorder([bronze, silver, other.options[0]])),
    ).toMatchObject({ kind: 'stale' })
  })
})

// ── used, delete ────────────────────────────────────────────────────────────

describe('used marker and delete', () => {
  test('markOptionUsed sets it once; a used option can only be archived', async () => {
    const field = await fieldWith(f.a, 'Level', ['Gold', 'Silver'])
    const [gold, silver] = field.options
    await f.t.run((ctx) => markOptionUsed(scoped(ctx, f.a.tenantId), gold))
    await f.t.run((ctx) => markOptionUsed(scoped(ctx, f.a.tenantId), gold))
    expect((await getDoc(gold))!.used).toBe(true)
    // Not a revision: `used` is system-owned.
    expect(await revisionsOf(f.a, 'contactFieldOptions', gold)).toHaveLength(1)
    const del = (id: OptionId, expected = 0) =>
      f.a.as.mutation(api.contacts.fields.deleteOption, {
        tenantId: f.a.tenantId,
        id,
        expected,
      })
    expect(await errorData(del(gold))).toMatchObject({ reason: 'used' })
    expect(await errorData(del(silver, 3))).toMatchObject({ kind: 'stale' })
    expect(await del(silver)).toEqual({ deleted: 1 })
    expect((await definition(f.a, field.id)).options).toHaveLength(1)
  })

  test('the marker survives a save and a restore', async () => {
    const field = await fieldWith(f.a, 'Level', ['Gold'])
    const [gold] = field.options
    await f.t.run((ctx) => markOptionUsed(scoped(ctx, f.a.tenantId), gold))
    await saveOption(f.a, field.id, gold, { label: 'Golden' })
    expect((await getDoc(gold))!.used).toBe(true)
    const [first] = await revisionsOf(f.a, 'contactFieldOptions', gold)
    await f.t.run((ctx) =>
      restore(scoped(ctx, f.a.tenantId), fieldContracts, first._id),
    )
    expect(await getDoc(gold)).toMatchObject({ label: 'Gold', used: true })
  })

  test('a field can be deleted, with its options, until one is used', async () => {
    const field = await fieldWith(f.a, 'Level', ['Gold', 'Silver'])
    const del = (id: FieldId, expected: number) =>
      f.a.as.mutation(api.contacts.fields.deleteField, {
        tenantId: f.a.tenantId,
        id,
        expected,
      })
    await f.t.run((ctx) =>
      markOptionUsed(scoped(ctx, f.a.tenantId), field.options[1]),
    )
    expect(await errorData(del(field.id, 0))).toMatchObject({ reason: 'used' })
    expect((await definition(f.a, field.id)).deletable).toBe(false)

    const unused = await fieldWith(f.a, 'Unused', ['A', 'B'])
    expect(await errorData(del(unused.id, 5))).toMatchObject({ kind: 'stale' })
    expect(await del(unused.id, 0)).toEqual({ deleted: 3 })
    expect(await getDoc(unused.id)).toBeNull()
    expect(await getDoc(unused.options[0])).toBeNull()
  })
})

// ── the value rule ──────────────────────────────────────────────────────────

describe('fieldValueVerdict', () => {
  const field = {
    _id: 'f1' as FieldId,
    label: 'Level',
    appliesTo: ['individual'] as Array<ContactKind>,
    isActive: true,
    slot: 1 as number | undefined,
    retiring: false as boolean | undefined,
  }
  const opt = {
    _id: 'o1' as OptionId,
    fieldId: 'f1' as FieldId,
    label: 'Gold',
    isActive: true,
  }
  const verdict = (
    fieldChange: Partial<typeof field> | null,
    optChange: Partial<typeof opt> | null,
    kind: ContactKind = 'individual',
    current?: OptionId,
    mode: 'save' | 'restore' = 'save',
  ) =>
    fieldValueVerdict(
      fieldChange && { ...field, ...fieldChange },
      optChange && { ...opt, ...optChange },
      kind,
      current,
      mode,
    )

  test('existence and ownership, in both modes', () => {
    for (const mode of ['save', 'restore'] as const) {
      expect(verdict(null, {}, 'individual', undefined, mode)).toMatchObject({
        reason: 'unknown_field',
      })
      expect(verdict({}, null, 'individual', undefined, mode)).toMatchObject({
        reason: 'unknown_field',
      })
      expect(
        verdict(
          {},
          { fieldId: 'f2' as FieldId },
          'individual',
          'o1' as OptionId,
          mode,
        ),
      ).toMatchObject({ reason: 'option_not_in_field' })
    }
    expect(verdict({}, {})).toEqual({ ok: true })
  })

  test('retired: a save refuses, a restore skips', () => {
    expect(verdict({ slot: undefined }, {})).toMatchObject({
      reason: 'retired_field',
    })
    expect(
      verdict(
        { slot: undefined },
        {},
        'individual',
        'o1' as OptionId,
        'restore',
      ),
    ).toEqual({ ok: false, skip: 'retired' })
  })

  test('retiring: no new value (a save refuses, a restore skips); a kept one stays', () => {
    expect(verdict({ retiring: true }, {})).toMatchObject({
      reason: 'retiring_field',
    })
    expect(
      verdict({ retiring: true }, {}, 'individual', undefined, 'restore'),
    ).toEqual({ ok: false, skip: 'retired' })
    expect(
      verdict({ retiring: true }, {}, 'individual', 'o1' as OptionId),
    ).toEqual({ ok: true })
  })

  test('kind: only for a new value; a save refuses, a restore skips', () => {
    expect(verdict({}, {}, 'household')).toMatchObject({ reason: 'field_kind' })
    expect(verdict({}, {}, 'household', undefined, 'restore')).toEqual({
      ok: false,
      skip: 'wrong_kind',
    })
    expect(verdict({}, {}, 'household', 'o1' as OptionId)).toEqual({ ok: true })
  })

  test('archived field or option: refused only for a new value on a save', () => {
    expect(verdict({ isActive: false }, {})).toMatchObject({
      reason: 'archived_field',
    })
    expect(verdict({}, { isActive: false })).toMatchObject({
      reason: 'archived_option',
    })
    expect(
      verdict(
        { isActive: false },
        { isActive: false },
        'individual',
        'o1' as OptionId,
      ),
    ).toEqual({ ok: true })
    expect(
      verdict(
        { isActive: false },
        { isActive: false },
        'individual',
        undefined,
        'restore',
      ),
    ).toEqual({ ok: true })
  })
})

describe('resolveFieldValue and fieldValuesOf', () => {
  test('resolves to the slot; another tenant’s ids are unknown', async () => {
    await createField(f.a, 'First')
    const level = await fieldWith(f.a, 'Level', ['Gold'], ['individual'])
    const value = { fieldId: level.id, optionId: level.options[0] }
    const resolved = await f.t.run((ctx) =>
      resolveFieldValue(
        scopeWriter(ctx, f.a.tenantId),
        value,
        'individual',
        undefined,
      ),
    )
    expect(resolved).toMatchObject({ outcome: 'set', slot: 2 })
    expect(
      await errorData(
        f.t.run((ctx) =>
          resolveFieldValue(
            scopeWriter(ctx, f.b.tenantId),
            value,
            'individual',
            undefined,
          ),
        ),
      ),
    ).toMatchObject({ reason: 'unknown_field' })
    expect(
      await f.t.run((ctx) =>
        resolveFieldValue(
          scopeWriter(ctx, f.a.tenantId),
          value,
          'household',
          undefined,
          'restore',
        ),
      ),
    ).toMatchObject({ outcome: 'skipped', reason: 'wrong_kind' })
  })

  test('fieldValuesOf reads each live slot', async () => {
    const a = await fieldWith(f.a, 'A', ['a1'])
    const b = await fieldWith(f.a, 'B', ['b1'])
    const id = await contact(f.a, 'Ada')
    await setValues(f.a, id, [{ fieldId: b.id, optionId: b.options[0] }])
    const [doc, entries] = await f.t.run(
      async (ctx) =>
        [
          (await ctx.db.get(id))!,
          [...(await fieldsBySlot(scopeWriter(ctx, f.a.tenantId)))],
        ] as const,
    )
    const bySlot = new Map(entries)
    expect([...bySlot.keys()]).toEqual([1, 2])
    expect(fieldValuesOf(doc, bySlot)).toEqual([
      { fieldId: b.id, optionId: b.options[0] },
    ])
    void a
  })
})

// ── retire ──────────────────────────────────────────────────────────────────

describe('retire', () => {
  test('clears every carrier with history, frees the slot, keeps the rows', async () => {
    const level = await fieldWith(f.a, 'Level', ['Gold', 'Silver'])
    const region = await fieldWith(f.a, 'Region', ['North'])
    const [gold, silver] = level.options
    const north = region.options[0]
    const ada = await contact(f.a, 'Ada')
    const bob = await contact(f.a, 'Bob')
    const cy = await contact(f.a, 'Cy')
    await setValues(f.a, ada, [
      { fieldId: level.id, optionId: gold },
      { fieldId: region.id, optionId: north },
    ])
    await setValues(f.a, bob, [{ fieldId: level.id, optionId: silver }])
    await setValues(f.a, cy, [{ fieldId: region.id, optionId: north }])
    // B has a field in slot 1 too, with a value: untouched.
    const bLevel = await fieldWith(f.b, 'Level', ['Gold'])
    const bContact = await contact(f.b, 'Bea')
    await setValues(f.b, bContact, [
      { fieldId: bLevel.id, optionId: bLevel.options[0] },
    ])
    const before = await snapshot(f.t, f.b.tenantId)

    expect(
      await f.a.as.action(api.contacts.fields.retireField, {
        tenantId: f.a.tenantId,
        id: level.id,
      }),
    ).toEqual({ cleared: 2 })

    expect(await getDoc(ada)).toMatchObject({ field2: north })
    expect((await getDoc(ada))!.field1).toBeUndefined()
    expect((await getDoc(bob))!.field1).toBeUndefined()
    expect(await getDoc(cy)).toMatchObject({ field2: north })
    const retired = (await getDoc(level.id))!
    expect(retired).toMatchObject({ label: 'Level', isActive: false })
    expect(retired.slot).toBeUndefined()
    expect(await getDoc(gold)).toMatchObject({ label: 'Gold', used: true })
    expect((await list(f.a)).map((d) => d.label)).toEqual(['Region'])

    // Each carrier's clearing is a revision in the retire group; the
    // field's archive is one too.
    const cleared = (await revisionsOf(f.a, 'contacts', ada)).filter(
      (r) => r.contract === 'contacts.fields' && r.groupName,
    )
    expect(cleared).toMatchObject([
      {
        groupName: retireGroupName('Level'),
        payload: { values: [{ fieldId: region.id, optionId: north }] },
      },
    ])
    const bobs = (await revisionsOf(f.a, 'contacts', bob)).filter(
      (r) => r.groupName,
    )
    // One group per batch, and batches go option by option: Bob's Silver
    // is cleared in a batch of its own.
    expect(bobs).toMatchObject([{ groupName: retireGroupName('Level') }])
    // The caller is the actor on every revision and group retire writes.
    expect(cleared[0].actor).toBe(f.a.userId)
    expect(bobs[0].actor).toBe(f.a.userId)
    const group = await f.t.run((ctx) => ctx.db.get(cleared[0].group!))
    expect(group!.actor).toBe(f.a.userId)
    expect(
      (await revisionsOf(f.a, 'contactFields', level.id)).map((r) => r.actor),
    ).toEqual([f.a.userId, f.a.userId])
    expect(
      (await revisionsOf(f.a, 'contactFields', level.id)).map(
        (r) => r.payload.isActive,
      ),
    ).toEqual([true, false])

    expect(await snapshot(f.t, f.b.tenantId)).toBe(before)

    // The slot is reused, without the old values.
    const next = await fieldWith(f.a, 'Level', ['New'])
    expect((await definition(f.a, next.id)).slot).toBe(1)
    expect((await getDoc(ada))!.field1).toBeUndefined()

    // A retired field can't be edited, nor can its options, nor retired again.
    expect(
      await errorData(
        f.a.as.mutation(api.contacts.fields.saveField, {
          tenantId: f.a.tenantId,
          id: level.id,
          expected: 1,
          label: 'Back',
          appliesTo: ['individual'],
          isActive: true,
        }),
      ),
    ).toMatchObject({ reason: 'retired_field' })
    expect(await errorData(addOption(f.a, level.id, 'Bronze'))).toMatchObject({
      reason: 'retired_field',
    })
    expect(
      await errorData(
        f.a.as.action(api.contacts.fields.retireField, {
          tenantId: f.a.tenantId,
          id: level.id,
        }),
      ),
    ).toMatchObject({ reason: 'retired_field' })
  })

  test('a field in another slot retires from its own slot', async () => {
    await fieldWith(f.a, 'First', ['x'])
    const region = await fieldWith(f.a, 'Region', ['North', 'South'])
    const first = (await list(f.a))[0]
    const ada = await contact(f.a, 'Ada')
    const bob = await contact(f.a, 'Bob')
    await setValues(f.a, ada, [
      { fieldId: first._id, optionId: first.options[0]._id },
      { fieldId: region.id, optionId: region.options[1] },
    ])
    await setValues(f.a, bob, [
      { fieldId: region.id, optionId: region.options[0] },
    ])
    expect(
      await f.a.as.action(api.contacts.fields.retireField, {
        tenantId: f.a.tenantId,
        id: region.id,
      }),
    ).toEqual({ cleared: 2 })
    expect(await getDoc(ada)).toMatchObject({ field1: first.options[0]._id })
    expect((await getDoc(ada))!.field2).toBeUndefined()
    expect((await getDoc(bob))!.field2).toBeUndefined()
    expect((await getDoc(region.id))!.slot).toBeUndefined()
  })

  test('restoring a pre-retire value skips the retired field', async () => {
    const level = await fieldWith(f.a, 'Level', ['Gold'])
    const ada = await contact(f.a, 'Ada')
    await setValues(f.a, ada, [
      { fieldId: level.id, optionId: level.options[0] },
    ])
    await f.a.as.action(api.contacts.fields.retireField, {
      tenantId: f.a.tenantId,
      id: level.id,
    })
    const [set] = (await revisionsOf(f.a, 'contacts', ada)).filter(
      (r) => r.contract === 'contacts.fields' && !r.groupName,
    )
    await f.t.run((ctx) =>
      restore(scoped(ctx, f.a.tenantId), contactContracts, set._id),
    )
    expect((await getDoc(ada))!.field1).toBeUndefined()
  })

  test('more carriers than a batch: every one cleared, a group per batch', async () => {
    const level = await fieldWith(f.a, 'Level', ['Gold'])
    const value = { fieldId: level.id, optionId: level.options[0] }
    const ids: Array<Id<'contacts'>> = []
    for (let i = 0; i <= RETIRE_BATCH; i++) {
      const id = await contact(f.a, `P${i}`)
      await setValues(f.a, id, [value])
      ids.push(id)
    }
    expect(
      await f.a.as.action(api.contacts.fields.retireField, {
        tenantId: f.a.tenantId,
        id: level.id,
      }),
    ).toEqual({ cleared: RETIRE_BATCH + 1 })
    const groups = new Set<string>()
    for (const id of ids) {
      expect((await getDoc(id))!.field1).toBeUndefined()
      const [r] = (await revisionsOf(f.a, 'contacts', id)).filter(
        (x) => x.groupName,
      )
      groups.add(r.group!)
    }
    expect(groups.size).toBe(2)
  })

  test('resumes after an interruption; a retiring field takes no new value', async () => {
    const level = await fieldWith(f.a, 'Level', ['Gold', 'Silver'])
    const [gold, silver] = level.options
    const ada = await contact(f.a, 'Ada')
    const bob = await contact(f.a, 'Bob')
    await setValues(f.a, ada, [{ fieldId: level.id, optionId: gold }])
    // Bob had Silver once, then nothing: a revision to restore later.
    await setValues(f.a, bob, [{ fieldId: level.id, optionId: silver }])
    await setValues(f.a, bob, [])
    // A retire that stopped right after it started.
    await f.t.mutation(internal.contacts.fields.retireStart, {
      tenantId: f.a.tenantId,
      role: 'admin',
      actor: f.a.userId,
      id: level.id,
    })
    expect(await definition(f.a, level.id)).toMatchObject({
      isActive: false,
      retiring: true,
      slot: 1,
    })
    // No reactivating, no new values; a restore skips them.
    expect(
      await errorData(saveField(f.a, level.id, { isActive: true })),
    ).toMatchObject({ reason: 'retiring_field' })
    expect(
      await errorData(
        setValues(f.a, bob, [{ fieldId: level.id, optionId: gold }]),
      ),
    ).toMatchObject({ reason: 'retiring_field' })
    const [silverRevision] = (await revisionsOf(f.a, 'contacts', bob)).filter(
      (r) =>
        r.contract === 'contacts.fields' &&
        (r.payload as { values: Array<unknown> }).values.length === 1,
    )
    await f.t.run((ctx) =>
      restore(scoped(ctx, f.a.tenantId), contactContracts, silverRevision._id),
    )
    expect((await getDoc(bob))!.field1).toBeUndefined()
    // Ada's value stays until the retire clears it.
    expect(await getDoc(ada)).toMatchObject({ field1: gold })

    // Run again: it carries on, archiving no second time.
    expect(
      await f.a.as.action(api.contacts.fields.retireField, {
        tenantId: f.a.tenantId,
        id: level.id,
      }),
    ).toEqual({ cleared: 1 })
    const done = (await getDoc(level.id))!
    expect(done.slot).toBeUndefined()
    expect(done.retiring).toBeUndefined()
    expect((await getDoc(ada))!.field1).toBeUndefined()
    expect(
      (await revisionsOf(f.a, 'contactFields', level.id)).map(
        (r) => r.payload.isActive,
      ),
    ).toEqual([true, false])
  })

  test('finds holders from the contacts, not contactSearch; archived ones too', async () => {
    const level = await fieldWith(f.a, 'Level', ['Gold'])
    const region = await fieldWith(f.a, 'Region', ['North'])
    const gold = level.options[0]
    const ada = await contact(f.a, 'Ada')
    const bob = await contact(f.a, 'Bob')
    const cy = await contact(f.a, 'Cy')
    const dee = await contact(f.a, 'Dee')
    // Ada: archived, holding Gold.
    await setValues(f.a, ada, [{ fieldId: level.id, optionId: gold }])
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      archived: true,
    })
    // Bob: holds Gold, but his search row lost it (drift).
    await setValues(f.a, bob, [{ fieldId: level.id, optionId: gold }])
    // Cy: no value, but a stale search row claims Gold.
    // Dee: Gold, plus Region's slot holding Level's option (drift).
    await setValues(f.a, dee, [{ fieldId: level.id, optionId: gold }])
    await f.t.run(async (ctx) => {
      const row = (id: Id<'contacts'>) =>
        ctx.db
          .query('contactSearch')
          .withIndex('by_tenant_contact', (q) =>
            q.eq('tenantId', f.a.tenantId).eq('contactId', id),
          )
          .unique()
      await ctx.db.patch('contactSearch', (await row(bob))!._id, {
        field1: undefined,
      })
      await ctx.db.patch('contactSearch', (await row(cy))!._id, {
        field1: gold,
      })
      await ctx.db.patch('contacts', dee, { field2: gold })
    })
    expect(
      await f.a.as.action(api.contacts.fields.retireField, {
        tenantId: f.a.tenantId,
        id: level.id,
      }),
    ).toEqual({ cleared: 3 })
    for (const id of [ada, bob, dee]) {
      expect((await getDoc(id))!.field1, id).toBeUndefined()
    }
    expect((await getDoc(level.id))!.slot).toBeUndefined()
    void region
  })

  test('a field with no values retires straight away', async () => {
    const level = await fieldWith(f.a, 'Level', ['Gold'])
    expect(
      await f.a.as.action(api.contacts.fields.retireField, {
        tenantId: f.a.tenantId,
        id: level.id,
      }),
    ).toEqual({ cleared: 0 })
    expect((await getDoc(level.id))!.slot).toBeUndefined()
  })
})

// ── rights and isolation ────────────────────────────────────────────────────

describe('who manages fields', () => {
  test('admins; staff only while the switch is on; viewers never', async () => {
    const staff = await member('staff')
    const viewer = await member('viewer')
    const field = await fieldWith(f.a, 'Level', ['Gold'])
    const tryAll = async (as: Tenant['as']) => {
      const out: Record<string, unknown> = {}
      const kind = (p: Promise<unknown>) =>
        p.then(
          () => null,
          (e: unknown) => (e as { data?: { kind?: string } }).data?.kind,
        )
      out.create = await kind(
        createField(f.a, `By ${Math.random()}`, undefined, as),
      )
      out.option = await kind(addOption(f.a, field.id, `${Math.random()}`, as))
      out.retire = await kind(
        as.action(api.contacts.fields.retireField, {
          tenantId: f.a.tenantId,
          id: field.id,
        }),
      )
      return out
    }
    expect(await tryAll(staff)).toEqual({
      create: 'forbidden',
      option: 'forbidden',
      retire: 'forbidden',
    })
    expect(await tryAll(viewer)).toEqual({
      create: 'forbidden',
      option: 'forbidden',
      retire: 'forbidden',
    })
    // Viewers still read them.
    expect(await list(f.a, viewer)).toHaveLength(1)

    const mine = async (as: Tenant['as']) =>
      (await as.query(api.platform.tenants.mine, {})).find(
        (m) => m._id === f.a.tenantId,
      )!
    expect(await mine(staff)).toMatchObject({
      staffCanManageFields: false,
      fieldsVersion: null,
      canManageFields: false,
    })
    expect(
      await errorData(
        staff.mutation(api.platform.preferences.setStaffCanManageFields, {
          tenantId: f.a.tenantId,
          staffCanManageFields: true,
        }),
      ),
    ).toMatchObject({ kind: 'forbidden' })
    await f.a.as.mutation(api.platform.preferences.setStaffCanManageFields, {
      tenantId: f.a.tenantId,
      staffCanManageFields: true,
    })
    expect(await mine(staff)).toMatchObject({
      staffCanManageFields: true,
      fieldsVersion: 0,
      canManageFields: true,
    })
    expect(await mine(viewer)).toMatchObject({ canManageFields: false })
    const staffResult = await tryAll(staff)
    expect(staffResult).toEqual({ create: null, option: null, retire: null })
    expect((await tryAll(viewer)).create).toBe('forbidden')

    // B's switch is its own; the other lists' switches are untouched.
    const bPrefs = (await f.b.as.query(api.platform.tenants.mine, {})).find(
      (m) => m._id === f.b.tenantId,
    )!
    expect(bPrefs).toMatchObject({ staffCanManageFields: false })
    expect(await mine(staff)).toMatchObject({
      staffCanManageTags: false,
      canManageTags: false,
    })
  })

  test('tenant B can neither see nor change A’s fields or options', async () => {
    const field = await fieldWith(f.a, 'Level', ['Gold'])
    const before = await snapshot(f.t, f.a.tenantId)
    expect(await list(f.b)).toEqual([])
    expect(await errorData(addOption(f.b, field.id, 'Silver'))).toMatchObject({
      reason: 'unknown_field',
    })
    expect(
      await errorData(
        f.b.as.mutation(api.contacts.fields.saveField, {
          tenantId: f.b.tenantId,
          id: field.id,
          expected: 0,
          label: 'Mine',
          appliesTo: ['individual'],
          isActive: true,
        }),
      ),
    ).toMatchObject({ kind: 'not_found' })
    for (const call of [
      f.b.as.mutation(api.contacts.fields.deleteField, {
        tenantId: f.b.tenantId,
        id: field.id,
        expected: 0,
      }),
      f.b.as.mutation(api.contacts.fields.deleteOption, {
        tenantId: f.b.tenantId,
        id: field.options[0],
        expected: 0,
      }),
      f.b.as.mutation(api.contacts.fields.saveOption, {
        tenantId: f.b.tenantId,
        id: field.options[0],
        expected: 0,
        label: 'x',
        isActive: true,
      }),
      f.b.as.mutation(api.contacts.fields.reorderOptions, {
        tenantId: f.b.tenantId,
        fieldId: field.id,
        order: field.options,
      }),
      f.b.as.action(api.contacts.fields.retireField, {
        tenantId: f.b.tenantId,
        id: field.id,
      }),
    ]) {
      expect(await errorData(call)).toMatchObject({ kind: 'not_found' })
    }
    // B's contact can't take A's option.
    const bea = await contact(f.b, 'Bea')
    expect(
      await errorData(
        setValues(f.b, bea, [
          { fieldId: field.id, optionId: field.options[0] },
        ]),
      ),
    ).toMatchObject({ reason: 'unknown_field' })
    expect(await snapshot(f.t, f.a.tenantId)).toBe(before)
  })
})
