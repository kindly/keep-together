/**
 * Dropdown field definitions (plan: dropdown fields, step 2). A tenant's
 * fields live in numbered slots (lib/fieldSlots); a contact's value for
 * the field in slot N is its `fieldN`, an option id, set by step 4's
 * `contacts.fields` contract. Payloads, types and pure rules are in
 * `fieldTypes.ts`, which also lists what step 4 uses from here.
 *
 * Two aggregates, each its own contract and counter:
 *   contacts.field       → label, appliesTo, isActive (saveVersion)
 *   contacts.fieldOption → label, position, isActive (saveVersion)
 * System-owned, written here and nowhere else, never by a payload: a
 * field's `slot` (lowest free one on create; cleared by retire, which
 * frees it) and an option's `used` (`markOptionUsed`).
 *
 * Getting rid of things:
 *   - an option: deleted while unused, only archived after;
 *   - a field: archived (hidden, values and slot kept), retired (every
 *     value cleared through `contacts.fields`, then the slot freed, rows
 *     kept so history can name them), or deleted while none of its
 *     options was ever used.
 *
 * Managed by admins, plus staff while "staff can manage fields" is on
 * (`managesList: 'fields'`; lib/lists). Setting values is ordinary staff
 * editing.
 */
import { ConvexError, v } from 'convex/values'
import { validate } from 'convex-helpers/validators'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import {
  commandGroup,
  defineContract,
  executeContract,
  registry,
  rejected,
} from '../lib/contracts'
import type { ContractCtx } from '../lib/contracts'
import {
  FIELD_SLOTS,
  FIELD_SLOT_NUMBERS,
  slotFieldName,
} from '../lib/fieldSlots'
import type { FieldSlot } from '../lib/fieldSlots'
import { requireListManager } from '../lib/lists'
import {
  internalTenantMutation,
  roleValidator,
  tenantAction,
  tenantMutation,
  tenantQuery,
} from '../lib/tenancy'
import type {
  Role,
  ScopedDatabaseReader,
  ScopedDatabaseWriter,
} from '../lib/tenancy'
import { contactContracts } from './contracts'
import {
  FIELD_OPTION_LIMIT,
  fieldFields,
  fieldValueVerdict,
  fieldOptionCreateFields,
  fieldOptionFields,
  normaliseFieldLabel,
  prepareField,
  prepareFieldOption,
  retireGroupName,
} from './fieldTypes'
import type {
  ContactKind,
  FieldDefinition,
  FieldValue,
  FieldValueMode,
  FieldValuesPayload,
  ResolvedFieldValue,
} from './fieldTypes'

// ── reads ──────────────────────────────────────────────────────────────────

/** The live fields (those with a slot), in slot order. One read. */
function liveFields(db: ScopedDatabaseReader) {
  return db
    .query('contactFields')
    .withIndex('by_tenant_slot', (q) => q.gte('slot', 1))
    .take(FIELD_SLOTS)
}

/** A field's options in the admin's order. One read. */
function optionsOf(db: ScopedDatabaseReader, fieldId: Id<'contactFields'>) {
  return db
    .query('contactFieldOptions')
    .withIndex('by_tenant_field_position', (q) => q.eq('fieldId', fieldId))
    .take(FIELD_OPTION_LIMIT)
}

/** The live field in each slot. Retired fields (no slot) are absent. One read. */
export async function fieldsBySlot(
  db: ScopedDatabaseReader,
): Promise<Map<FieldSlot, Doc<'contactFields'>>> {
  return new Map(
    (await liveFields(db)).map((f) => [f.slot as FieldSlot, f] as const),
  )
}

/** The live field in `slot`, or null if the slot is free. */
export async function fieldInSlot(
  db: ScopedDatabaseReader,
  slot: FieldSlot,
): Promise<Doc<'contactFields'> | null> {
  return db
    .query('contactFields')
    .withIndex('by_tenant_slot', (q) => q.eq('slot', slot))
    .first()
}

/**
 * The tier-1 checks for one value on a contact of `kind`
 * (`fieldValueVerdict` in fieldTypes.ts; `current` is the option already
 * in the field's slot on the contact). Throws `rejected(...)` on a failed
 * check. A save gets `outcome: 'set'` or a throw; a restore may also get
 * `outcome: 'skipped'` (the field was retired, or no longer applies to
 * the kind), to leave the value out and report it. Does not mark the
 * option used: the apply calls `markOptionUsed` for each value it newly
 * sets.
 */
export async function resolveFieldValue(
  db: ScopedDatabaseReader,
  value: FieldValue,
  kind: ContactKind,
  current: Id<'contactFieldOptions'> | undefined,
  mode: FieldValueMode = 'save',
): Promise<ResolvedFieldValue> {
  // Another tenant's ids read as null through the scoped db.
  const [field, option] = await Promise.all([
    db.get(value.fieldId),
    db.get(value.optionId),
  ])
  const verdict = fieldValueVerdict(field, option, kind, current, mode)
  if (verdict.ok) {
    return {
      outcome: 'set',
      slot: field!.slot as FieldSlot,
      field: field!,
      option: option!,
    }
  }
  if (verdict.skip === null) throw rejected(verdict.reason, verdict.message)
  return {
    outcome: 'skipped',
    reason: verdict.skip,
    field: field!,
    option: option!,
  }
}

/**
 * Set the option's `used` marker if not yet set (after that, a read-only
 * check, so a popular option is no write hot spot). Never cleared; no
 * contract, no revision, no list-manager check. Idempotent. Runs in the
 * caller's transaction: call it from the `contacts.fields` apply for each
 * option newly put on the contact.
 */
export async function markOptionUsed(
  ctx: { db: ScopedDatabaseWriter },
  optionId: Id<'contactFieldOptions'>,
): Promise<void> {
  const option = await ctx.db.get(optionId)
  if (!option) throw rejected('unknown_field', 'The option must exist')
  if (!option.used) {
    await ctx.db.patch('contactFieldOptions', optionId, { used: true })
  }
}

/** A contact's current values as a `contacts.fields` payload's `values`. Pure. */
export function fieldValuesOf(
  contact: Doc<'contacts'>,
  bySlot: Map<FieldSlot, Doc<'contactFields'>>,
): Array<FieldValue> {
  const out: Array<FieldValue> = []
  for (const slot of FIELD_SLOT_NUMBERS) {
    const field = bySlot.get(slot)
    const optionId = contact[slotFieldName(slot)]
    if (field && optionId) out.push({ fieldId: field._id, optionId })
  }
  return out
}

/**
 * The live fields in slot order, each with its options in the admin's
 * order (archived ones included). Also served as `list`.
 */
export async function fieldDefinitions(
  db: ScopedDatabaseReader,
): Promise<Array<FieldDefinition>> {
  const fields = await liveFields(db)
  const options = await Promise.all(fields.map((f) => optionsOf(db, f._id)))
  return fields.map((f, i) => ({
    _id: f._id,
    label: f.label,
    appliesTo: f.appliesTo,
    isActive: f.isActive,
    slot: f.slot as FieldSlot,
    saveVersion: f.saveVersion,
    options: options[i].map((o) => ({
      _id: o._id,
      fieldId: o.fieldId,
      label: o.label,
      position: o.position,
      isActive: o.isActive,
      used: o.used,
      saveVersion: o.saveVersion,
    })),
    deletable: !options[i].some((o) => o.used),
  }))
}

// ── contracts ──────────────────────────────────────────────────────────────

/**
 * A field definition. Labels are unique among the live fields,
 * case-insensitively (a retired field's label is free again). Create takes
 * the lowest free slot, or refuses when all FIELD_SLOTS are taken; the
 * slot is preserved by every save and restore. A retired field can't be
 * edited, bar a restore, which leaves it retired.
 */
export const field = defineContract({
  name: 'contacts.field',
  entity: 'contactFields',
  version: 1,
  managesList: 'fields',
  counter: 'saveVersion',
  fields: fieldFields,
  prepare: prepareField,
  apply: async (ctx, p, root, command) => {
    if (root && root.slot === undefined && command.source !== 'restore') {
      throw rejected('retired_field', 'This field has been retired')
    }
    const labelNormalized = normaliseFieldLabel(p.label)
    const fields = {
      label: p.label,
      labelNormalized,
      appliesTo: p.appliesTo,
      isActive: p.isActive,
    }
    if (root && root.slot === undefined) {
      await ctx.db.patch('contactFields', root._id, fields)
      return root._id
    }
    const live = await liveFields(ctx.db)
    const clash = live.find(
      (f) => f.labelNormalized === labelNormalized && f._id !== root?._id,
    )
    if (clash) {
      throw rejected('duplicate_field_label', `${clash.label} already exists`)
    }
    if (root) {
      await ctx.db.patch('contactFields', root._id, fields)
      return root._id
    }
    const taken = new Set(live.map((f) => f.slot))
    const slot = FIELD_SLOT_NUMBERS.find((s) => !taken.has(s))
    if (slot === undefined) {
      throw rejected(
        'no_free_slot',
        `A group can have at most ${FIELD_SLOTS} fields: retire one to free its slot`,
      )
    }
    return ctx.db.insert('contactFields', { ...fields, slot, saveVersion: 0 })
  },
})

/**
 * One option of a field. Create takes the field (`createWith`), fixed for
 * good. Labels are unique within the field, case-insensitively, archived
 * options included; a field holds at most FIELD_OPTION_LIMIT. `used` is
 * created false and never touched here. A retired field's options can't
 * be edited, bar a restore.
 */
export const fieldOption = defineContract({
  name: 'contacts.fieldOption',
  entity: 'contactFieldOptions',
  version: 1,
  managesList: 'fields',
  counter: 'saveVersion',
  fields: fieldOptionFields,
  prepare: prepareFieldOption,
  apply: async (ctx, p, root, command) => {
    let fieldId: Id<'contactFields'>
    if (root) {
      fieldId = root.fieldId
    } else {
      validate(v.object(fieldOptionCreateFields), command.createWith, {
        throw: true,
      })
      fieldId = (command.createWith as { fieldId: Id<'contactFields'> }).fieldId
    }
    // Another tenant's field reads as null through the scoped db.
    const [parent, siblings] = await Promise.all([
      ctx.db.get(fieldId),
      optionsOf(ctx.db, fieldId),
    ])
    if (!parent) throw rejected('unknown_field', 'The field must exist')
    if (parent.slot === undefined && command.source !== 'restore') {
      throw rejected('retired_field', `${parent.label} has been retired`)
    }
    const labelNormalized = normaliseFieldLabel(p.label)
    const clash = siblings.find(
      (o) => o.labelNormalized === labelNormalized && o._id !== root?._id,
    )
    if (clash) {
      throw rejected(
        'duplicate_option_label',
        `${parent.label} already has ${clash.label}`,
      )
    }
    const fields = {
      label: p.label,
      labelNormalized,
      position: p.position,
      isActive: p.isActive,
    }
    if (root) {
      await ctx.db.patch('contactFieldOptions', root._id, fields)
      return root._id
    }
    if (siblings.length >= FIELD_OPTION_LIMIT) {
      throw rejected(
        'option_limit',
        `A field can have at most ${FIELD_OPTION_LIMIT} options, archived ones included`,
      )
    }
    return ctx.db.insert('contactFieldOptions', {
      ...fields,
      fieldId,
      used: false,
      saveVersion: 0,
    })
  },
})

/** Everything restore needs to know about field definitions. */
export const fieldContracts = registry(field, fieldOption)

// ── queries ────────────────────────────────────────────────────────────────

/**
 * The live fields with their options, archived ones included: the
 * Settings tab, the contact form and the list's filters.
 */
export const list = tenantQuery({
  args: {},
  handler: async (ctx) => fieldDefinitions(ctx.db),
})

// ── managing fields ────────────────────────────────────────────────────────

/** A new field in the lowest free slot. */
export const createField = tenantMutation({
  args: fieldFields,
  handler: async (ctx, payload) =>
    executeContract(ctx, field, payload, { source: 'ui' }),
})

/** Rename a field, change its kinds, archive or reactivate it. */
export const saveField = tenantMutation({
  args: { id: v.id('contactFields'), expected: v.number(), ...fieldFields },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, field, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

/** Stale unless the caller saw the row at its current counter. */
function checkExpected(
  row: { saveVersion: number },
  expected: number,
  contract: string,
) {
  if (row.saveVersion !== expected) {
    throw new ConvexError({
      kind: 'stale' as const,
      contract,
      current: row.saveVersion,
    })
  }
}

/**
 * Delete a field none of whose options was ever used, with its options.
 * Nothing references them (a value marks its option used), so nothing
 * dangles; their revisions stay as history. Not a contract (no root left
 * to carry a counter): the caller is checked as a contract would be.
 */
export const deleteField = tenantMutation({
  args: { id: v.id('contactFields'), expected: v.number() },
  handler: async (ctx, { id, expected }) => {
    await requireListManager(ctx, 'fields')
    const row = await ctx.db.get(id)
    if (!row) throw new ConvexError({ kind: 'not_found' as const })
    checkExpected(row, expected, field.name)
    const options = await optionsOf(ctx.db, id)
    if (options.some((o) => o.used)) {
      throw rejected(
        'used',
        `${row.label} has been used: archive or retire it instead`,
      )
    }
    for (const o of options) await ctx.db.delete('contactFieldOptions', o._id)
    await ctx.db.delete('contactFields', id)
    return { deleted: options.length + 1 }
  },
})

// ── managing options ───────────────────────────────────────────────────────

/** A new option at the end of the field's list. */
export const addOption = tenantMutation({
  args: {
    fieldId: v.id('contactFields'),
    label: v.string(),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { fieldId, label, isActive }) => {
    const siblings = await optionsOf(ctx.db, fieldId)
    const position = siblings.reduce(
      (max, o) => Math.max(max, o.position + 1),
      0,
    )
    return executeContract(
      ctx,
      fieldOption,
      { label, position, isActive: isActive ?? true },
      { source: 'ui', createWith: { fieldId } },
    )
  },
})

/** Rename, archive or reactivate an option (its position is `reorderOptions`'). */
export const saveOption = tenantMutation({
  args: {
    id: v.id('contactFieldOptions'),
    expected: v.number(),
    label: v.string(),
    isActive: v.boolean(),
  },
  handler: async (ctx, { id, expected, label, isActive }) => {
    const row = await ctx.db.get(id)
    if (!row) throw new ConvexError({ kind: 'not_found' as const })
    return executeContract(
      ctx,
      fieldOption,
      { label, isActive, position: row.position },
      { entityId: id, expected, source: 'ui' },
    )
  },
})

/**
 * Put a field's options in `order`, which must name every one of them,
 * archived ones included (anything else is stale: an option was added or
 * deleted meanwhile). Each option whose position changes gets its own
 * contract, under one command group.
 */
export const reorderOptions = tenantMutation({
  args: {
    fieldId: v.id('contactFields'),
    order: v.array(v.id('contactFieldOptions')),
  },
  handler: async (ctx, { fieldId, order }) => {
    await requireListManager(ctx, 'fields')
    const [parent, options] = await Promise.all([
      ctx.db.get(fieldId),
      optionsOf(ctx.db, fieldId),
    ])
    if (!parent) throw new ConvexError({ kind: 'not_found' as const })
    const byId = new Map(options.map((o) => [o._id as string, o]))
    if (
      order.length !== options.length ||
      new Set(order).size !== order.length ||
      order.some((id) => !byId.has(id))
    ) {
      throw new ConvexError({
        kind: 'stale' as const,
        contract: fieldOption.name,
      })
    }
    const moves = order.flatMap((id, position) => {
      const o = byId.get(id)!
      return o.position === position ? [] : [{ o, position }]
    })
    if (moves.length === 0) return { moved: 0 }
    const group = await commandGroup(ctx, `Reorder ${parent.label}`)
    for (const { o, position } of moves) {
      await executeContract(
        ctx,
        fieldOption,
        { label: o.label, isActive: o.isActive, position },
        { entityId: o._id, source: 'ui', group },
      )
    }
    return { moved: moves.length }
  },
})

/**
 * Delete an option that has never been on a contact. Once used, it can
 * only be archived: contacts keep it and history names it. Not a contract;
 * the caller is checked as a contract would be.
 */
export const deleteOption = tenantMutation({
  args: { id: v.id('contactFieldOptions'), expected: v.number() },
  handler: async (ctx, { id, expected }) => {
    await requireListManager(ctx, 'fields')
    const row = await ctx.db.get(id)
    if (!row) throw new ConvexError({ kind: 'not_found' as const })
    checkExpected(row, expected, fieldOption.name)
    if (row.used) {
      throw rejected(
        'used',
        `${row.label} has been used, so it can only be archived`,
      )
    }
    await ctx.db.delete('contactFieldOptions', id)
    return { deleted: 1 }
  },
})

// ── retire ─────────────────────────────────────────────────────────────────

/** How many contacts one retire batch clears: one contract each. */
export const RETIRE_BATCH = 100

/** Rounds of "clear, then check none are left" before giving up. */
const RETIRE_ROUNDS = 5

/**
 * Retire a field: archive it (so the form stops offering it), clear its
 * value on every contact through `contacts.fields`, a batch at a time,
 * each batch its own command group ("Retire field *Label*"), then free its
 * slot. The field and option rows stay, so history can still name them,
 * and restore skips values of a retired field. Resumable: a retire that
 * stops part way leaves the field archived, and running it again carries
 * on.
 */
export const retireField = tenantAction({
  args: { id: v.id('contactFields') },
  handler: async (ctx, { id }): Promise<{ cleared: number }> => {
    let { optionIds }: { optionIds: Array<Id<'contactFieldOptions'>> } =
      await ctx.runMutation(internal.contacts.fields.retireStart, {
        tenantId: ctx.tenantId,
        role: ctx.role,
        id,
      })
    let cleared = 0
    for (let round = 0; round < RETIRE_ROUNDS; round++) {
      for (const optionId of optionIds) {
        let cursor: string | null = null
        for (;;) {
          const batch: { cleared: number; cursor: string | null } =
            await ctx.runMutation(internal.contacts.fields.retireBatch, {
              tenantId: ctx.tenantId,
              role: ctx.role,
              id,
              optionId,
              cursor,
            })
          cleared += batch.cleared
          if (batch.cursor === null) break
          cursor = batch.cursor
        }
      }
      const finish: {
        done: boolean
        optionIds: Array<Id<'contactFieldOptions'>>
      } = await ctx.runMutation(internal.contacts.fields.retireFinish, {
        tenantId: ctx.tenantId,
        role: ctx.role,
        id,
      })
      if (finish.done) return { cleared }
      optionIds = finish.optionIds
    }
    throw rejected(
      'retire_incomplete',
      'Values kept being set while retiring: try again',
    )
  },
})

/** The caller's role, carried from the action: never `null` here. */
const retireArgs = { role: roleValidator, id: v.id('contactFields') }

/** Load a live field for retire, checking the caller may manage fields. */
async function retiring(
  ctx: { db: ScopedDatabaseReader; role: Role },
  id: Id<'contactFields'>,
) {
  await requireListManager(ctx, 'fields')
  const row = await ctx.db.get(id)
  if (!row) throw new ConvexError({ kind: 'not_found' as const })
  return row
}

/** Archive the field (a `contacts.field` revision) and list its options. */
export const retireStart = internalTenantMutation({
  args: retireArgs,
  handler: async (ctx, { role, id }) => {
    const row = await retiring({ db: ctx.db, role }, id)
    if (row.slot === undefined) {
      throw rejected('retired_field', `${row.label} is already retired`)
    }
    if (row.isActive) {
      await executeContract(
        { ...ctx, role },
        field,
        { label: row.label, appliesTo: row.appliesTo, isActive: false },
        { entityId: id, source: 'ui' },
      )
    }
    const options = await optionsOf(ctx.db, id)
    return { optionIds: options.map((o) => o._id) }
  },
})

/** Index of the projection rows carrying an option in `slot`. */
function carriers(
  db: ScopedDatabaseReader,
  slot: FieldSlot,
  optionId: Id<'contactFieldOptions'>,
) {
  const name = slotFieldName(slot)
  // The slot's index is picked at run time; its shape is `fieldSlots`'.
  return db
    .query('contactSearch')
    .withIndex(`by_tenant_${name}_sort` as 'by_tenant_field1_sort', (q) =>
      q.eq(name as 'field1', optionId),
    )
}

/**
 * Clear the field on up to RETIRE_BATCH contacts carrying `optionId`,
 * found through their `contactSearch` rows, under one command group.
 */
export const retireBatch = internalTenantMutation({
  args: {
    ...retireArgs,
    optionId: v.id('contactFieldOptions'),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { role, id, optionId, cursor }) => {
    const row = await retiring({ db: ctx.db, role }, id)
    if (row.slot === undefined) return { cleared: 0, cursor: null }
    const slot = row.slot as FieldSlot
    const page = await carriers(ctx.db, slot, optionId).paginate({
      numItems: RETIRE_BATCH,
      cursor,
    })
    const contacts = (
      await Promise.all(page.page.map((s) => ctx.db.get(s.contactId)))
    ).filter(
      (c): c is Doc<'contacts'> =>
        c !== null && c[slotFieldName(slot)] === optionId,
    )
    if (contacts.length > 0) {
      // Looked up when run, not imported: contracts.ts imports this file.
      if (!Object.hasOwn(contactContracts, 'contacts.fields')) {
        throw new Error('retire needs the contacts.fields contract (step 4)')
      }
      const contract = contactContracts['contacts.fields']
      const bySlot = await fieldsBySlot(ctx.db)
      const scoped: ContractCtx = { ...ctx, role }
      const group = await commandGroup(scoped, retireGroupName(row.label))
      for (const contact of contacts) {
        const payload: FieldValuesPayload = {
          values: fieldValuesOf(contact, bySlot).filter(
            (value) => value.fieldId !== id,
          ),
        }
        await executeContract(scoped, contract, payload, {
          entityId: contact._id,
          source: 'ui',
          group,
        })
      }
    }
    return {
      cleared: contacts.length,
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})

/**
 * Free the slot, if no contact carries the field any more. Someone may
 * have set a value (or added an option) meanwhile: then not done, with
 * the options as they are now, and the action goes round again. A system
 * write, like `markOptionUsed`: `slot` is in no payload.
 */
export const retireFinish = internalTenantMutation({
  args: retireArgs,
  handler: async (ctx, { role, id }) => {
    const row = await retiring({ db: ctx.db, role }, id)
    const options = await optionsOf(ctx.db, id)
    const optionIds = options.map((o) => o._id)
    if (row.slot === undefined) return { done: true, optionIds }
    const slot = row.slot as FieldSlot
    const left = await Promise.all(
      options.map((o) => carriers(ctx.db, slot, o._id).first()),
    )
    if (left.some((s) => s !== null)) return { done: false, optionIds }
    await ctx.db.patch('contactFields', id, { slot: undefined })
    return { done: true, optionIds }
  },
})
