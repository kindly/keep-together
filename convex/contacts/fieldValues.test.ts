import { beforeEach, describe, expect, test } from 'vitest'
import type { Doc, Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { BULK_FIELD_LIMIT } from './rules'

// Dropdown fields step 4: the contact's values (`contacts.fields`), the
// form save, bulk set, the projection, history, the view and the list's
// field filters. Field definitions are step 2's: until its contracts land
// here, the fixture inserts definition rows as they would.

type Fixture = Awaited<ReturnType<typeof setup>>
type Kind = Doc<'contacts'>['kind']
type OptionId = Id<'contactFieldOptions'>
type Field = { id: Id<'contactFields'>; options: Record<string, OptionId> }

let f: Fixture

const ALL_KINDS: Array<Kind> = ['individual', 'organization', 'household']

/** A field in `slot` with its options, as step 2's contracts write them. */
function defineField(
  who: Tenant,
  label: string,
  slot: number,
  options: Array<string>,
  appliesTo: Array<Kind> = ALL_KINDS,
): Promise<Field> {
  return f.t.run(async (ctx) => {
    const id = await ctx.db.insert('contactFields', {
      tenantId: who.tenantId,
      label,
      labelNormalized: label.toLowerCase(),
      appliesTo,
      isActive: true,
      slot,
      saveVersion: 0,
    })
    const out: Record<string, OptionId> = {}
    for (const [position, name] of options.entries()) {
      out[name] = await ctx.db.insert('contactFieldOptions', {
        tenantId: who.tenantId,
        fieldId: id,
        label: name,
        labelNormalized: name.toLowerCase(),
        position,
        isActive: true,
        used: false,
        saveVersion: 0,
      })
    }
    return { id, options: out }
  })
}

const patchField = (
  id: Id<'contactFields'>,
  changes: Partial<Doc<'contactFields'>>,
) => f.t.run((ctx) => ctx.db.patch(id, changes))
const patchOption = (
  id: OptionId,
  changes: Partial<Doc<'contactFieldOptions'>>,
) => f.t.run((ctx) => ctx.db.patch(id, changes))
const option = (id: OptionId) => f.t.run((ctx) => ctx.db.get(id))

function contact(
  who: Tenant,
  lastName: string,
  kind: Kind = 'individual',
  firstName = '',
) {
  return who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    kind,
    title: '',
    firstName,
    lastName: kind === 'individual' ? lastName : '',
    nickname: '',
    name: kind === 'individual' ? '' : lastName,
    isDeceased: false,
  })
}

const root = (id: Id<'contacts'>) => f.t.run((ctx) => ctx.db.get(id))
/** The contact's `contacts.fields` revisions, oldest first. */
const fieldRevisions = (id: Id<'contacts'>) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('revisions').collect()).filter(
      (r) => r.entityId === id && r.contract === 'contacts.fields',
    ),
  )

async function saveFields(
  id: Id<'contacts'>,
  values: Array<{ fieldId: Id<'contactFields'>; optionId: OptionId }>,
  who: Tenant = f.a,
  expected?: number,
) {
  const current = (await who.as.query(api.contacts.queries.getRoot, {
    tenantId: who.tenantId,
    id,
  }))!
  return who.as.mutation(api.contacts.mutations.saveForm, {
    tenantId: who.tenantId,
    id,
    fields: { expected: expected ?? current.fieldsVersion, values },
  })
}

let region: Field
let type: Field
let ada: Id<'contacts'>

beforeEach(async () => {
  f = await setup()
  region = await defineField(f.a, 'Region', 1, ['North', 'South'])
  type = await defineField(f.a, 'Type', 2, ['Member', 'Donor'], ['individual'])
  ada = await contact(f.a, 'Lovelace', 'individual', 'Ada')
})

describe('the contacts.fields slice', () => {
  test('a save puts the option in its field slot, on the contact and its search row', async () => {
    const result = await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    expect(result.saved).toEqual(['fields'])
    expect(result.counters.fields).toBe(1)
    const after = (await root(ada))!
    expect(after.field1).toBe(region.options.North)
    expect(after.field2).toBeUndefined()
    expect(after.fieldsVersion).toBe(1)
    const row = await f.t.run((ctx) =>
      ctx.db
        .query('contactSearch')
        .filter((q) => q.eq(q.field('contactId'), ada))
        .unique(),
    )
    expect(row!.field1).toBe(region.options.North)
    // Option labels are not search words (g1q11).
    expect(row!.text).not.toContain('north')
  })

  test('a field left out of the payload is cleared, and history names the change', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
    ])
    await saveFields(ada, [{ fieldId: type.id, optionId: type.options.Donor }])
    const after = (await root(ada))!
    expect(after.field1).toBeUndefined()
    expect(after.field2).toBe(type.options.Donor)
    const revisions = await fieldRevisions(ada)
    expect(revisions.map((r) => r.groupName)).toEqual([
      'Region: North, Type: Member',
      'Region cleared, Type: Donor',
    ])
  })

  test('re-sending the current values is a no-op: no revision, no counter bump', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    const result = await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    expect(result.saved).toEqual([])
    expect((await fieldRevisions(ada)).length).toBe(1)
  })

  test('a stale counter is reported, not saved', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    const result = await saveFields(
      ada,
      [{ fieldId: region.id, optionId: region.options.South }],
      f.a,
      0,
    )
    expect(result.stale).toEqual({ fields: 1 })
    expect((await root(ada))!.field1).toBe(region.options.North)
  })

  test('the first use marks the option used, and the marker survives a save and a restore', async () => {
    expect((await option(region.options.North))!.used).toBe(false)
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    expect((await option(region.options.North))!.used).toBe(true)
    expect((await option(region.options.South))!.used).toBe(false)
    await saveFields(ada, [])
    const [first] = await fieldRevisions(ada)
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: first._id,
    })
    expect((await root(ada))!.field1).toBe(region.options.North)
    expect((await option(region.options.North))!.used).toBe(true)
  })

  test('the payload is validated: one value per field', async () => {
    const result = await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: region.id, optionId: region.options.South },
    ])
    expect(result.problems.fields?.[0].message).toMatch(/one option/)
    expect((await root(ada))!.field1).toBeUndefined()
  })
})

describe('tier-1 checks', () => {
  const refusal = async (
    values: Array<{ fieldId: Id<'contactFields'>; optionId: OptionId }>,
    id: Id<'contacts'> = ada,
  ) => {
    const result = await saveFields(id, values)
    expect(result.saved).not.toContain('fields')
    return result.problems.fields?.map((p) => p.message)
  }

  test('an option of another field is refused, on the form and in the contract', async () => {
    expect(
      await refusal([{ fieldId: region.id, optionId: type.options.Member }]),
    ).toEqual([expect.stringMatching(/not an option of Region/)])
    expect(
      await errorData(
        f.a.as.mutation(api.contacts.mutations.bulkSetField, {
          tenantId: f.a.tenantId,
          contactIds: [ada],
          fieldId: region.id,
          optionId: type.options.Member,
        }),
      ),
    ).toMatchObject({ kind: 'rejected', reason: 'option_not_in_field' })
  })

  test("a field that doesn't apply to the contact's kind is refused", async () => {
    const acme = await contact(f.a, 'Acme', 'organization')
    expect(
      await refusal(
        [{ fieldId: type.id, optionId: type.options.Member }],
        acme,
      ),
    ).toEqual([expect.stringMatching(/doesn’t apply/)])
  })

  test('a refused field value leaves the other slices saving', async () => {
    const current = (await root(ada))!
    const result = await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: ada,
      details: {
        expected: current.detailsVersion,
        kind: 'individual',
        title: '',
        firstName: 'Ada',
        lastName: 'Byron',
        nickname: '',
        name: '',
        isDeceased: false,
      },
      fields: {
        expected: 0,
        values: [{ fieldId: region.id, optionId: type.options.Member }],
      },
    })
    expect(result.saved).toEqual(['details'])
    expect(result.problems.fields).toHaveLength(1)
    expect((await root(ada))!.lastName).toBe('Byron')
  })

  test('an archived option is refused when newly set, and kept when already held', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    await patchOption(region.options.North, { isActive: false })
    await patchOption(region.options.South, { isActive: false })
    // Held: a save of another field keeps it.
    const kept = await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
    ])
    expect(kept.saved).toEqual(['fields'])
    expect((await root(ada))!.field1).toBe(region.options.North)
    // New: refused.
    expect(
      await refusal([{ fieldId: region.id, optionId: region.options.South }]),
    ).toEqual([expect.stringMatching(/South is archived/)])
  })

  test('narrowing a field to other kinds never blocks a contact that holds a value', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    await patchField(region.id, { appliesTo: ['organization'] })
    const result = await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Donor },
    ])
    expect(result.saved).toEqual(['fields'])
  })

  test('a new value on an archived field is refused', async () => {
    await patchField(region.id, { isActive: false })
    expect(
      await refusal([{ fieldId: region.id, optionId: region.options.North }]),
    ).toEqual([expect.stringMatching(/Region is archived/)])
  })
})

describe('two tenants', () => {
  test("tenant B can't set tenant A's option, or filter by it, and sees nothing of A's", async () => {
    const before = await snapshot(f.t, f.b.tenantId)
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    await f.a.as.mutation(api.contacts.mutations.bulkSetField, {
      tenantId: f.a.tenantId,
      contactIds: [ada],
      fieldId: type.id,
      optionId: type.options.Donor,
    })
    expect(await snapshot(f.t, f.b.tenantId)).toBe(before)

    const bea = await contact(f.b, 'Bea')
    const bRegion = await defineField(f.b, 'Region', 1, ['East'])
    // A's field and option ids read as nothing in B.
    const result = await saveFields(
      bea,
      [{ fieldId: region.id, optionId: region.options.North }],
      f.b,
    )
    expect(result.saved).toEqual([])
    expect(result.problems.fields).toHaveLength(1)
    const mixed = await saveFields(
      bea,
      [{ fieldId: bRegion.id, optionId: region.options.North }],
      f.b,
    )
    expect(mixed.problems.fields).toHaveLength(1)
    expect((await root(bea))!.field1).toBeUndefined()
    expect((await option(region.options.North))!.used).toBe(true)

    for (const fields of [
      [{ fieldId: region.id, optionId: region.options.North }],
      [{ fieldId: bRegion.id, optionId: region.options.North }],
    ]) {
      expect(
        await errorData(
          f.b.as.query(api.contacts.queries.list, {
            tenantId: f.b.tenantId,
            fields,
            paginationOpts: { numItems: 10, cursor: null },
          }),
        ),
      ).toMatchObject({ kind: 'rejected' })
      expect(
        await errorData(
          f.b.as.query(api.contacts.queries.search, {
            tenantId: f.b.tenantId,
            search: 'bea',
            fields,
          }),
        ),
      ).toMatchObject({ kind: 'rejected' })
    }
    expect(
      await errorData(
        f.b.as.mutation(api.contacts.mutations.bulkSetField, {
          tenantId: f.b.tenantId,
          contactIds: [bea],
          fieldId: region.id,
          optionId: null,
        }),
      ),
    ).toMatchObject({ kind: 'rejected', reason: 'unknown_field' })
  })
})

describe('bulkSetField', () => {
  const bulk = (
    contactIds: Array<Id<'contacts'>>,
    fieldId: Id<'contactFields'>,
    optionId: OptionId | null,
  ) =>
    f.a.as.mutation(api.contacts.mutations.bulkSetField, {
      tenantId: f.a.tenantId,
      contactIds,
      fieldId,
      optionId,
    })

  test('sets one option on many, skipping and counting contacts of the wrong kind', async () => {
    const bob = await contact(f.a, 'Bob')
    const acme = await contact(f.a, 'Acme', 'organization')
    const home = await contact(f.a, 'Home', 'household')
    await saveFields(bob, [{ fieldId: type.id, optionId: type.options.Member }])

    const result = await bulk(
      [ada, bob, acme, home, ada],
      type.id,
      type.options.Member,
    )
    // Bob already has it; Acme and Home are not individuals.
    expect(result).toMatchObject({ changed: 1, skipped: 2 })
    expect((await root(ada))!.field2).toBe(type.options.Member)
    expect((await root(acme))!.field2).toBeUndefined()

    const set = await bulk([ada, bob, acme], region.id, region.options.South)
    expect(set).toMatchObject({ changed: 3, skipped: 0 })
    // One revision per changed contact, all in the batch's group, each
    // keeping the contact's other values.
    const revisions = await f.t.run(async (ctx) =>
      (await ctx.db.query('revisions').collect()).filter(
        (r) => r.group === set.group,
      ),
    )
    expect(revisions.map((r) => r.entityId).sort()).toEqual(
      [ada, bob, acme].sort(),
    )
    expect(new Set(revisions.map((r) => r.groupName))).toEqual(
      new Set(['set Region to South']),
    )
    expect((await root(ada))!.field2).toBe(type.options.Member)
    for (const id of [ada, bob, acme]) {
      const row = await f.t.run((ctx) =>
        ctx.db
          .query('contactSearch')
          .filter((q) => q.eq(q.field('contactId'), id))
          .unique(),
      )
      expect(row!.field1).toBe(region.options.South)
    }
  })

  test('a clear reaches every holder, even one the field no longer applies to (L2)', async () => {
    const acme = await contact(f.a, 'Acme', 'organization')
    await bulk([ada, acme], region.id, region.options.North)
    await patchField(region.id, { appliesTo: ['individual'] })
    expect(await bulk([ada, acme], region.id, null)).toMatchObject({
      changed: 2,
      skipped: 0,
    })
    expect((await root(acme))!.field1).toBeUndefined()
    // Setting is still kind-checked.
    expect(await bulk([acme], region.id, region.options.South)).toMatchObject({
      changed: 0,
      skipped: 1,
    })
  })

  test('clears, and does nothing at all when nothing changes', async () => {
    await bulk([ada], region.id, region.options.North)
    expect(await bulk([ada], region.id, null)).toMatchObject({ changed: 1 })
    expect((await root(ada))!.field1).toBeUndefined()
    expect(await bulk([ada], region.id, null)).toEqual({
      changed: 0,
      skipped: 0,
      group: null,
    })
  })

  test('refuses an archived option, and more than the bulk limit', async () => {
    await patchOption(region.options.North, { isActive: false })
    expect(
      await errorData(bulk([ada], region.id, region.options.North)),
    ).toMatchObject({ kind: 'rejected', reason: 'archived_option' })
    const many = Array.from({ length: BULK_FIELD_LIMIT + 1 }, () => ada)
    // Duplicates collapse; distinct ids past the limit are refused.
    expect(await bulk(many, region.id, null)).toMatchObject({ changed: 0 })
    const ids = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = (await ctx.db.get(ada))!
      const out: Array<Id<'contacts'>> = []
      for (let i = 0; i <= BULK_FIELD_LIMIT; i++) {
        out.push(await ctx.db.insert('contacts', copy))
      }
      return out
    })
    expect(await errorData(bulk(ids, region.id, null))).toMatchObject({
      kind: 'invalid',
    })
  })
})

describe('retire and restore', () => {
  /** What step 2's retire does: clear every value, then free the slot. */
  async function retire(field: Field, carriers: Array<Id<'contacts'>>) {
    await f.a.as.mutation(api.contacts.mutations.bulkSetField, {
      tenantId: f.a.tenantId,
      contactIds: carriers,
      fieldId: field.id,
      optionId: null,
    })
    await patchField(field.id, { slot: undefined, isActive: false })
  }

  test('restoring a pre-retire revision skips the retired field and says so; the new field in its slot never sees old values', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
    ])
    const [before] = await fieldRevisions(ada)
    await retire(region, [ada])
    expect((await root(ada))!.field1).toBeUndefined()
    // The old value still reads by name in history (its group name).
    expect((await fieldRevisions(ada)).map((r) => r.groupName)).toContain(
      'Region: North, Type: Member',
    )

    const colour = await defineField(f.a, 'Colour', 1, ['Red'])
    const restored = await f.a.as.mutation(
      api.contacts.mutations.restoreRevision,
      { tenantId: f.a.tenantId, revisionId: before._id },
    )
    expect(restored.skippedFields).toEqual([
      { label: 'Region', reason: 'retired' },
    ])
    const after = (await root(ada))!
    expect(after.field1).toBeUndefined()
    expect(after.field2).toBe(type.options.Member)
    // A live save of the retired field is refused.
    const live = await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    expect(live.problems.fields?.[0].message).toMatch(/retired/)
    expect(colour.id).toBeDefined()
  })

  test('a restore records the state it wrote, so restoring that revision can only set what the contact held (M1)', async () => {
    await saveFields(ada, [{ fieldId: type.id, optionId: type.options.Member }])
    const [rev1] = await fieldRevisions(ada)
    await saveFields(ada, [{ fieldId: type.id, optionId: type.options.Donor }])
    await patchField(type.id, { appliesTo: ['organization'] })
    const restored = await f.a.as.mutation(
      api.contacts.mutations.restoreRevision,
      { tenantId: f.a.tenantId, revisionId: rev1._id },
    )
    expect(restored.skippedFields).toEqual([
      { label: 'Type', reason: 'wrong_kind' },
    ])
    const rev3 = (await fieldRevisions(ada)).at(-1)!
    // The revision is what Ada holds (Donor), not the payload restored.
    expect(rev3.payload).toEqual({
      values: [{ fieldId: type.id, optionId: type.options.Donor }],
    })
    await patchField(type.id, { appliesTo: ALL_KINDS })
    await saveFields(ada, [
      { fieldId: type.id, optionId: type.options.Member },
      { fieldId: region.id, optionId: region.options.North },
    ])
    const back = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: rev3._creationTime,
    })
    expect(back.restored).toEqual(['contacts.fields'])
    expect(back.skippedFields).toEqual([])
    const after = (await root(ada))!
    expect(after.field2).toBe(type.options.Donor)
    expect(after.field1).toBeUndefined()
  })

  test('a restore keeps the values of fields created after the revision, and says so (L3)', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
    ])
    const [before] = await fieldRevisions(ada)
    await retire(region, [ada])
    // A newer field in the retired one's slot, and one in a never-used slot.
    const colour = await defineField(f.a, 'Colour', 1, ['Red'])
    const size = await defineField(f.a, 'Size', 3, ['Large'])
    const unset = await defineField(f.a, 'Unset', 4, ['Any'])
    await saveFields(ada, [
      { fieldId: type.id, optionId: type.options.Donor },
      { fieldId: colour.id, optionId: colour.options.Red },
      { fieldId: size.id, optionId: size.options.Large },
    ])
    const restored = await f.a.as.mutation(
      api.contacts.mutations.restoreRevision,
      { tenantId: f.a.tenantId, revisionId: before._id },
    )
    expect(restored.skippedFields).toEqual([
      { label: 'Region', reason: 'retired' },
      { label: 'Colour', reason: 'added_after' },
      { label: 'Size', reason: 'added_after' },
    ])
    const after = (await root(ada))!
    expect(after.field1).toBe(colour.options.Red)
    expect(after.field2).toBe(type.options.Member)
    expect(after.field3).toBe(size.options.Large)
    expect(after.field4).toBeUndefined()
    expect(unset.id).toBeDefined()
    // A field that existed then but held nothing is the revision's to clear.
    await saveFields(ada, [
      { fieldId: type.id, optionId: type.options.Member },
      { fieldId: colour.id, optionId: colour.options.Red },
      { fieldId: size.id, optionId: size.options.Large },
      { fieldId: unset.id, optionId: unset.options.Any },
    ])
    const withColour = (await fieldRevisions(ada)).at(-1)!
    await saveFields(ada, [])
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: withColour._id,
    })
    expect((await root(ada))!.field4).toBe(unset.options.Any)
  })

  test('restoreTo reports the skipped values too', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    const [first] = await fieldRevisions(ada)
    await retire(region, [ada])
    const result = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: first._creationTime,
    })
    expect(result.restored).toEqual(['contacts.fields'])
    expect(result.skippedFields).toEqual([
      { label: 'Region', reason: 'retired' },
    ])
  })

  test('a restore may bring back an archived option, but skips a value whose field no longer applies (slot left as it is)', async () => {
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
    ])
    const [first] = await fieldRevisions(ada)
    await saveFields(ada, [{ fieldId: type.id, optionId: type.options.Donor }])
    await patchOption(region.options.North, { isActive: false })
    await patchField(type.id, { appliesTo: ['organization'] })
    const restored = await f.a.as.mutation(
      api.contacts.mutations.restoreRevision,
      { tenantId: f.a.tenantId, revisionId: first._id },
    )
    expect(restored.skippedFields).toEqual([
      { label: 'Type', reason: 'wrong_kind' },
    ])
    const after = (await root(ada))!
    expect(after.field1).toBe(region.options.North)
    expect(after.field2).toBe(type.options.Donor)
  })
})

describe('the view', () => {
  test('get names the values live: a renamed option shows its new label', async () => {
    await saveFields(ada, [
      { fieldId: type.id, optionId: type.options.Member },
      { fieldId: region.id, optionId: region.options.North },
    ])
    const view = async () =>
      (await f.a.as.query(api.contacts.queries.get, {
        tenantId: f.a.tenantId,
        id: ada,
      }))!.fields
    expect(await view()).toEqual([
      expect.objectContaining({
        label: 'Region',
        slot: 1,
        optionLabel: 'North',
        optionActive: true,
        fieldActive: true,
      }),
      expect.objectContaining({
        label: 'Type',
        slot: 2,
        optionLabel: 'Member',
      }),
    ])
    await patchOption(region.options.North, {
      label: 'Northern',
      isActive: false,
    })
    expect((await view())[0]).toMatchObject({
      optionLabel: 'Northern',
      optionActive: false,
    })
  })
})

describe('the list', () => {
  let bob: Id<'contacts'>
  let cara: Id<'contacts'>
  let dan: Id<'contacts'>
  let acme: Id<'contacts'>

  beforeEach(async () => {
    // Name order: Acme, Ada Lovelace, Bob Smith, Cara Smith, Dan Smith.
    bob = await contact(f.a, 'Smith', 'individual', 'Bob')
    cara = await contact(f.a, 'Smith', 'individual', 'Cara')
    dan = await contact(f.a, 'Smith', 'individual', 'Dan')
    acme = await contact(f.a, 'Acme', 'organization')
    await saveFields(ada, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    await saveFields(bob, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
    ])
    await saveFields(cara, [
      { fieldId: region.id, optionId: region.options.South },
    ])
    await saveFields(acme, [
      { fieldId: region.id, optionId: region.options.North },
    ])
    // Dan: no values.
  })

  const browse = async (
    fields: Array<{ fieldId: Id<'contactFields'>; optionId: OptionId | null }>,
    extra: { includeArchived?: boolean; kind?: Kind } = {},
  ) =>
    (
      await f.a.as.query(api.contacts.queries.list, {
        tenantId: f.a.tenantId,
        includeArchived: false,
        fields,
        ...extra,
        paginationOpts: { numItems: 100, cursor: null },
      })
    ).page.map((r) => r._id)

  const find = async (
    search: string | undefined,
    fields: Array<{ fieldId: Id<'contactFields'>; optionId: OptionId | null }>,
    extra: { includeArchived?: boolean; kind?: Kind } = {},
  ) =>
    (
      await f.a.as.query(api.contacts.queries.search, {
        tenantId: f.a.tenantId,
        ...(search !== undefined && { search }),
        fields,
        ...extra,
      })
    ).rows.map((r) => r._id)

  test('one field, in name order, through list and search without text', async () => {
    const north = [{ fieldId: region.id, optionId: region.options.North }]
    expect(await browse(north)).toEqual([acme, ada, bob])
    expect(await find(undefined, north)).toEqual([acme, ada, bob])
    expect(await browse(north, { kind: 'individual' })).toEqual([ada, bob])
  })

  test('"not set" is a filter', async () => {
    const unset = [{ fieldId: region.id, optionId: null }]
    expect(await browse(unset)).toEqual([dan])
    expect(await find(undefined, unset)).toEqual([dan])
    expect(await find('smith', unset)).toEqual([dan])
  })

  test('two fields combine: the first is the range, the second checked per row', async () => {
    const both = [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
    ]
    expect(await browse(both)).toEqual([bob])
    expect(await find(undefined, both)).toEqual([bob])
    expect(
      await browse([
        { fieldId: type.id, optionId: null },
        { fieldId: region.id, optionId: region.options.North },
      ]),
    ).toEqual([acme, ada])
  })

  test('with search text', async () => {
    expect(
      await find('smith', [
        { fieldId: region.id, optionId: region.options.North },
      ]),
    ).toEqual([bob])
    expect(
      await find('smith', [
        { fieldId: region.id, optionId: region.options.North },
        { fieldId: type.id, optionId: type.options.Donor },
      ]),
    ).toEqual([])
  })

  test('five field filters with text: four in the search index, the fifth per row', async () => {
    const extra = await Promise.all(
      [3, 4, 5].map((slot) => defineField(f.a, `F${slot}`, slot, ['Yes'])),
    )
    const yes = extra.map((x) => ({ fieldId: x.id, optionId: x.options.Yes }))
    await saveFields(bob, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
      ...yes,
    ])
    // Cara has the first four but not F5: only the per-row check drops her.
    await saveFields(cara, [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
      ...yes.slice(0, 2),
    ])
    const all = [
      { fieldId: region.id, optionId: region.options.North },
      { fieldId: type.id, optionId: type.options.Member },
      ...yes,
    ]
    expect(await find('smith', all, { kind: 'individual' })).toEqual([bob])
    expect(
      await find('smith', all.slice(0, 4), { kind: 'individual' }),
    ).toEqual([bob, cara])
  })

  test('archived contacts only when asked', async () => {
    const current = (await root(bob))!
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: bob,
      expected: current.archiveVersion,
      archived: true,
    })
    const north = [{ fieldId: region.id, optionId: region.options.North }]
    expect(await browse(north)).toEqual([acme, ada])
    expect(await browse(north, { includeArchived: true })).toEqual([
      acme,
      ada,
      bob,
    ])
    expect(await find('smith', north)).toEqual([])
    expect(await find('smith', north, { includeArchived: true })).toEqual([bob])
  })

  test('rows carry their option ids; a rename writes nothing to contacts or contactSearch', async () => {
    const rows = await f.a.as.query(api.contacts.queries.list, {
      tenantId: f.a.tenantId,
      paginationOpts: { numItems: 100, cursor: null },
    })
    expect(rows.page.find((r) => r._id === bob)!.fieldOptionIds).toEqual([
      region.options.North,
      type.options.Member,
    ])
    const dump = () =>
      f.t.run(async (ctx) =>
        JSON.stringify([
          await ctx.db.query('contacts').collect(),
          await ctx.db.query('contactSearch').collect(),
        ]),
      )
    const before = await dump()
    await patchOption(region.options.North, { label: 'Northern' })
    expect(await dump()).toBe(before)
  })

  test('each field at most once per filter', async () => {
    expect(
      await errorData(
        f.a.as.query(api.contacts.queries.list, {
          tenantId: f.a.tenantId,
          fields: [
            { fieldId: region.id, optionId: null },
            { fieldId: region.id, optionId: region.options.North },
          ],
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
    ).toMatchObject({ kind: 'invalid' })
  })
})
