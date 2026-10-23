/**
 * Contact contracts (ADR 0014). Seven partitioned slices on the Contact
 * root, plus IdentifierType, RelationshipType, Relationship and
 * ContactNote (two slices) as their own aggregates.
 * Apply functions are pure state application — restore re-runs them.
 */
import { ConvexError, v } from 'convex/values'
import { validate } from 'convex-helpers/validators'
import type { Doc, Id } from '../_generated/dataModel'
import type { ContractCtx } from '../lib/contracts'
import { defineContract, registry, rejected } from '../lib/contracts'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import {
  IDENTIFIER_TYPE_LIMIT,
  computedNames,
  normaliseEmail,
  normaliseIdentifier,
  normaliseListName,
  prepareAddresses,
  prepareDetails,
  prepareFields,
  prepareIdentifierType,
  prepareIdentifiers,
  prepareMethods,
  prepareNote,
  prepareRelationship,
  prepareRelationshipType,
} from './rules'
import { describe, markUsed } from '../sources/code'
import {
  acquisitionFields,
  addressesFields,
  archiveFields,
  detailsFields,
  identifierTypeFields,
  identifiersFields,
  methodsFields,
  noteCreateFields,
  noteFields,
  noteFlagsFields,
  relationshipFields,
  relationshipTypeFields,
} from './validators'
import {
  projectAcquisition,
  projectContact,
  projectFields,
} from './searchProjection'
import { fieldsBySlot, markOptionUsed, resolveFieldValue } from './fieldDefs'
import { fieldValuesFields } from './fieldTypes'
import type { FieldValue, FieldValueSkip } from './fieldTypes'
import { optionIdsOf, slotValues, sortValues } from './fieldValues'
import { slotFieldName } from '../lib/fieldSlots'
import type { SlotFieldName } from '../lib/fieldSlots'

/**
 * v2 (external identifiers X1): `externalIdentifier` left the payload for
 * the `contacts.identifiers` slice. A v1 revision restores through the
 * upcaster and leaves the contact's identifiers as they are. Keep it: old
 * revisions still carry the field, which the schema dropped in X3.
 */
export const details = defineContract({
  name: 'contacts.details',
  entity: 'contacts',
  version: 2,
  counter: 'detailsVersion',
  project: projectContact,
  fields: detailsFields,
  prepare: prepareDetails,
  upcasters: {
    1: (payload) => {
      const { externalIdentifier: _, ...rest } = payload as {
        externalIdentifier?: string
      }
      return rest
    },
  },
  apply: async (ctx, p, root) => {
    const names = computedNames(p)
    const fields = {
      title: p.title,
      firstName: p.firstName,
      lastName: p.lastName,
      nickname: p.nickname,
      name: p.name,
      birthDate: p.birthDate,
      isDeceased: p.isDeceased,
      deceasedDate: p.deceasedDate,
      ...names,
    }
    if (root === null) {
      if (p.clientKey) {
        const existing = await ctx.db
          .query('contacts')
          .withIndex('by_tenant_clientKey', (q) =>
            q.eq('clientKey', p.clientKey),
          )
          .unique()
        if (existing) {
          // The command was already executed (double submit / retried import).
          throw rejected('duplicate', existing._id)
        }
      }
      return ctx.db.insert('contacts', {
        ...fields,
        clientKey: p.clientKey,
        kind: p.kind,
        archived: false,
        detailsVersion: 0,
        methodsVersion: 0,
        addressesVersion: 0,
        archiveVersion: 0,
        tagsVersion: 0,
        identifiersVersion: 0,
        acquisitionVersion: 0,
        fieldsVersion: 0,
      })
    }
    if (root.kind !== p.kind) {
      // CiviCRM allows changing kind; that is a bug farm, not a feature.
      throw rejected(
        'kind_change',
        `Contact is ${root.kind}; kind cannot change`,
      )
    }
    await ctx.db.patch('contacts', root._id, fields)
    return root._id
  },
})

// ── child-row reconciliation ───────────────────────────────────────────────

type ChildTable =
  'contactEmails' | 'contactPhones' | 'contactAddresses' | 'contactIdentifiers'
type Row = { key?: string } & Record<string, unknown>

/**
 * Reconcile a child table against the payload by `key`: removed keys are
 * deleted, new keys created, kept keys updated in place — except identity
 * fields (the value the row *is*, e.g. an email address), which are
 * immutable per key because state may hang off them. A field the payload
 * doesn't carry (system-owned) is never patched, so it survives a save.
 * Whether an address is on hold is not row state: comms keeps it per
 * address (`emailSuppressions`), so no edit or restore here can lose it.
 */
async function reconcile(
  ctx: ContractCtx,
  table: ChildTable,
  contactId: Id<'contacts'>,
  rows: Array<Row>,
  identityFields: Array<string>,
  /** The contact's current rows, when the caller has just read them. */
  known?: Array<Doc<ChildTable>>,
) {
  // A key on another contact's row is refused; one on this contact's is
  // simply kept. Without `known`, the ownership lookups go with the read of
  // the current rows (one level, not two) at a lookup per row. With it,
  // only keys new to the contact need one: each lookup is a read, which a
  // contact with many rows would pay for on every save of the slice.
  const lookup = (row: Row) =>
    ctx.db
      .query(table)
      .withIndex('by_tenant_key', (q) => q.eq('key', row.key as string))
      .first()
  const [existing, byKeyAnywhere] = known
    ? [
        known,
        await Promise.all(
          rows.filter((r) => !known.some((d) => d.key === r.key)).map(lookup),
        ),
      ]
    : await Promise.all([
        ctx.db
          .query(table)
          .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
          .collect(),
        Promise.all(rows.map(lookup)),
      ])
  const byKey = new Map(existing.map((d) => [d.key, d]))
  const payloadKeys = new Set(rows.map((r) => r.key as string))

  // Every check before any write, and the reads and writes each as one
  // concurrent batch: a save's latency is the depth of its awaits.
  const updates: Array<{
    id: Id<ChildTable>
    changes: Record<string, unknown>
  }> = []
  const added: Array<Row> = []
  for (const row of rows) {
    const current = byKey.get(row.key as string)
    if (!current) {
      added.push(row)
      continue
    }
    const doc = current as unknown as Record<string, unknown>
    const frozen = identityFields.filter((f) => doc[f] !== row[f])
    if (frozen.length) {
      throw rejected(
        'immutable_child',
        `${frozen.join(', ')} can't be edited — remove the entry and add a new one`,
      )
    }
    const changes: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(row)) {
      if (field === 'key' || identityFields.includes(field)) continue
      if (doc[field] !== value) changes[field] = value
    }
    if (Object.keys(changes).length) updates.push({ id: current._id, changes })
  }
  const owned = byKeyAnywhere.find(
    (d) => d !== null && d.contactId !== contactId,
  )
  if (owned) {
    throw rejected(
      'child_ownership',
      `${table} row ${owned.key} belongs to another contact`,
    )
  }

  await Promise.all([
    ...existing
      .filter((doc) => !payloadKeys.has(doc.key))
      .map((doc) => ctx.db.delete(table, doc._id)),
    ...added.map((row) =>
      ctx.db.insert(table, {
        ...(row as object),
        key: row.key,
        contactId,
        ...(table === 'contactEmails'
          ? {
              // Derived from the identity field, so it never changes per key.
              addressNormalized: normaliseEmail(row.address as string),
            }
          : {}),
        ...(table === 'contactIdentifiers'
          ? { valueNormalized: normaliseIdentifier(row.value as string) }
          : {}),
      } as never),
    ),
    ...updates.map(({ id, changes }) =>
      ctx.db.patch(table, id, changes as never),
    ),
  ])
}

export const methods = defineContract({
  name: 'contacts.methods',
  entity: 'contacts',
  version: 1,
  counter: 'methodsVersion',
  project: projectContact,
  fields: methodsFields,
  prepare: prepareMethods,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected('no_root', 'contacts.methods targets an existing contact')
    await Promise.all([
      reconcile(ctx, 'contactEmails', root._id, p.emails, ['address']),
      reconcile(ctx, 'contactPhones', root._id, p.phones, ['number']),
    ])
    return root._id
  },
})

export const addresses = defineContract({
  name: 'contacts.addresses',
  entity: 'contacts',
  version: 1,
  counter: 'addressesVersion',
  project: projectContact,
  fields: addressesFields,
  prepare: prepareAddresses,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected(
        'no_root',
        'contacts.addresses targets an existing contact',
      )
    // No identity field: the key is the identity, every field is correctable.
    await reconcile(ctx, 'contactAddresses', root._id, p.addresses, [])
    return root._id
  },
})

export const archive = defineContract({
  name: 'contacts.archive',
  entity: 'contacts',
  version: 1,
  counter: 'archiveVersion',
  project: projectContact,
  fields: archiveFields,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected('no_root', 'contacts.archive targets an existing contact')
    await ctx.db.patch('contacts', root._id, { archived: p.archived })
    return root._id
  },
})

/**
 * How the contact was recruited: a source code at version level, or none
 * (source codes plan, g1q7). Set at creation or later and editable, every
 * change in history. A new code must be a version of this tenant and not
 * archived (out of date is fine), and its first assignment marks it used.
 * A kept code stays even once archived, and a restore may bring one back
 * (it was assigned before, so it is already marked).
 */
export const acquisition = defineContract({
  name: 'contacts.acquisition',
  entity: 'contacts',
  version: 1,
  counter: 'acquisitionVersion',
  project: projectAcquisition,
  fields: acquisitionFields,
  apply: async (ctx, p, root, command) => {
    if (!root)
      throw rejected(
        'no_root',
        'contacts.acquisition targets an existing contact',
      )
    if (p.codeId !== null && p.codeId !== root.acquisitionCodeId) {
      const code = await describe(ctx.db, p.codeId)
      if (!code) {
        throw rejected(
          'unknown_source_code',
          'The source code must be a full code (category, detail and version)',
        )
      }
      if (command.source !== 'restore') {
        if (!code.isActive) {
          throw rejected(
            'archived_source_code',
            `${code.code} is archived: choose another`,
          )
        }
        await markUsed(ctx, p.codeId)
      }
    }
    await ctx.db.patch('contacts', root._id, {
      acquisitionCodeId: p.codeId ?? undefined,
    })
    return root._id
  },
})

/**
 * The contact's dropdown field values (plan: dropdown fields, g1q3): one
 * slice for every field, named by field id; apply writes each to its
 * field's current slot, and clears every slot the payload doesn't fill.
 *
 * The tier-1 checks are `resolveFieldValue`'s (step 2 owns them): the
 * option belongs to the field, and a value newly set suits the contact's
 * kind and, on a save, has an active field and option. A held value is
 * kept as it is, even once its option or field is archived. The first use
 * marks the option `used`. Restore re-applies history, so it may bring
 * back an archived option. What it can't write back, and the fields that
 * didn't exist yet, are settled before apply (`restorePayload`:
 * `planFieldRestore`), so the restore's revision records the state it
 * actually wrote.
 */
export const fieldValues = defineContract({
  name: 'contacts.fields',
  entity: 'contacts',
  version: 1,
  counter: 'fieldsVersion',
  project: projectFields,
  fields: fieldValuesFields,
  prepare: prepareFields,
  restorePayload: async (ctx, p, root, restored) =>
    root
      ? {
          values: (
            await planFieldRestore(
              ctx.db,
              root,
              p.values,
              restored._creationTime,
            )
          ).values,
        }
      : p,
  apply: async (ctx, p, root, command) => {
    if (!root)
      throw rejected('no_root', 'contacts.fields targets an existing contact')
    const checked = await checkFieldValues(
      ctx.db,
      root,
      p.values,
      command.source === 'restore',
    )
    if (checked.refused.length) {
      const { reason, message } = checked.refused[0]
      throw rejected(reason, message)
    }
    await Promise.all([
      ctx.db.patch('contacts', root._id, slotValues(checked.slots)),
      ...checked.toMark.map((optionId) => markOptionUsed(ctx, optionId)),
    ])
    return root._id
  },
})

/** A field value `contacts.fields` refuses, and why. */
export type FieldRefusal = {
  fieldId: Id<'contactFields'>
  reason: string
  message: string
}

/**
 * `contacts.fields`' checks on a payload's values against the contact as
 * it is (`resolveFieldValue`, per value). Shared by the contract (which
 * refuses the first) and the form save (which reports each on its field
 * and saves the other slices). `slots`: what each slot will hold;
 * `toMark`: options going on the contact for the first time; `skipped`:
 * values a restore leaves out (field retired, or no longer for the
 * contact's kind), by field label.
 */
export async function checkFieldValues(
  db: ScopedDatabaseReader,
  root: Doc<'contacts'>,
  values: Array<FieldValue>,
  restoring: boolean,
) {
  // An option belongs to one field, which holds one slot: held anywhere on
  // the contact is held in that field's slot.
  const held = new Set<string>(optionIdsOf(root))
  const results = await Promise.all(
    values.map(async (value) => {
      try {
        const resolved = await resolveFieldValue(
          db,
          value,
          root.kind,
          held.has(value.optionId) ? value.optionId : undefined,
          restoring ? 'restore' : 'save',
        )
        return { value, resolved }
      } catch (e) {
        const data = e instanceof ConvexError ? e.data : null
        if (data?.kind !== 'rejected') throw e
        return { value, refusal: data as { reason: string; message: string } }
      }
    }),
  )
  const slots: Partial<Record<SlotFieldName, Id<'contactFieldOptions'>>> = {}
  const toMark: Array<Id<'contactFieldOptions'>> = []
  const refused: Array<FieldRefusal> = []
  const skipped: Array<{
    fieldId: Id<'contactFields'>
    label: string
    reason: FieldValueSkip
  }> = []
  for (const { value, resolved, refusal } of results) {
    if (refusal) {
      refused.push({ fieldId: value.fieldId, ...refusal })
    } else if (resolved.outcome === 'skipped') {
      skipped.push({
        fieldId: value.fieldId,
        label: resolved.field.label,
        reason: resolved.reason,
      })
    } else {
      slots[slotFieldName(resolved.slot)] = resolved.option._id
      if (!held.has(resolved.option._id) && !resolved.option.used) {
        toMark.push(resolved.option._id)
      }
    }
  }
  return { slots, toMark, refused, skipped }
}

/** Why a restore didn't write a field's value from the revision. */
export type FieldRestoreNote = {
  label: string
  /**
   * `retired`: the field is gone, its value left out. `wrong_kind`: the
   * field no longer applies to the contact's kind, so the contact keeps
   * what it holds now. `added_after`: the field didn't exist at the
   * revision's time, so the contact keeps what it holds now.
   */
  reason: FieldValueSkip | 'added_after'
}

/**
 * What restoring `values` (a revision written at `restoredAt`) writes to
 * the contact as it is now, and what it leaves alone:
 *   - a retired field's value is left out;
 *   - a value whose field no longer suits the kind is not written, and the
 *     field keeps its current value;
 *   - a field created after the revision (a newer field, perhaps in a
 *     retired one's slot) is not the revision's to clear: it keeps its
 *     current value.
 * `values` is the payload to apply and record. `notes` lists every field
 * left as it is (an `added_after` one only if it holds a value).
 */
export async function planFieldRestore(
  db: ScopedDatabaseReader,
  root: Doc<'contacts'>,
  values: Array<FieldValue>,
  restoredAt: number,
): Promise<{ values: Array<FieldValue>; notes: Array<FieldRestoreNote> }> {
  const [checked, bySlot] = await Promise.all([
    checkFieldValues(db, root, values, true),
    fieldsBySlot(db),
  ])
  const skippedIds = new Set<string>(checked.skipped.map((x) => x.fieldId))
  const named = new Set<string>(values.map((x) => x.fieldId))
  const out = values.filter((x) => !skippedIds.has(x.fieldId))
  const notes: Array<FieldRestoreNote> = checked.skipped.map(
    ({ label, reason }) => ({ label, reason }),
  )
  for (const [slot, field] of bySlot) {
    const held = root[slotFieldName(slot)]
    const kept = { fieldId: field._id, optionId: held! }
    if (skippedIds.has(field._id)) {
      // wrong_kind: what the contact holds stays.
      if (held) out.push(kept)
    } else if (!named.has(field._id) && field._creationTime > restoredAt) {
      if (held) {
        out.push(kept)
        notes.push({ label: field.label, reason: 'added_after' })
      }
    }
  }
  return { values: sortValues(out), notes }
}

/** Another contact holding one of these (type, value) pairs. */
export type IdentifierClash = {
  key: string
  value: string
  contactId: Id<'contacts'>
  displayName: string
}

/**
 * For each row, the other contact (if any) already holding its (type,
 * value) pair in this tenant. Shared by the contract (which refuses) and
 * the form save (which reports it on the row and saves the other slices).
 */
export async function identifierClashes(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
  rows: Array<{ key?: string; typeId: Id<'identifierTypes'>; value: string }>,
): Promise<Array<IdentifierClash>> {
  const found = await Promise.all(
    rows.map(async (row) => {
      const held = await db
        .query('contactIdentifiers')
        .withIndex('by_tenant_valueNormalized_type', (q) =>
          q
            .eq('valueNormalized', normaliseIdentifier(row.value))
            .eq('typeId', row.typeId),
        )
        .first()
      if (!held || held.contactId === contactId) return null
      const other = await db.get(held.contactId)
      return {
        key: row.key!,
        value: row.value,
        contactId: held.contactId,
        displayName: other?.displayName ?? '?',
      }
    }),
  )
  return found.filter((c) => c !== null)
}

/**
 * The contact's external identifiers. A (type, value) pair belongs to at
 * most one contact. Only active types can be newly added; a kept row keeps
 * an archived type, and a restore may re-add one.
 */
export const identifiers = defineContract({
  name: 'contacts.identifiers',
  entity: 'contacts',
  version: 1,
  counter: 'identifiersVersion',
  project: projectContact,
  fields: identifiersFields,
  prepare: prepareIdentifiers,
  apply: async (ctx, p, root, command) => {
    if (!root)
      throw rejected(
        'no_root',
        'contacts.identifiers targets an existing contact',
      )
    const existing = await ctx.db
      .query('contactIdentifiers')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', root._id))
      .collect()
    const kept = new Set(existing.map((r) => r.key))
    const added = p.identifiers.filter((r) => !kept.has(r.key!))
    const [types, clashes] = await Promise.all([
      // Another tenant's id reads as null through the scoped db.
      Promise.all(added.map((r) => ctx.db.get(r.typeId))),
      identifierClashes(ctx.db, root._id, added),
    ])
    if (
      types.some((t) => !t || (!t.isActive && command.source !== 'restore'))
    ) {
      throw rejected(
        'unknown_identifier_type',
        'Identifier type must exist and be active',
      )
    }
    if (clashes.length) {
      const { value, displayName } = clashes[0]
      throw rejected(
        'duplicate_identifier',
        `${value} is already used by ${displayName}`,
      )
    }
    await reconcile(
      ctx,
      'contactIdentifiers',
      root._id,
      p.identifiers,
      ['typeId', 'value'],
      existing,
    )
    return root._id
  },
})

/**
 * An identifier type. Renaming keeps every row (they hold the id). A
 * tenant holds at most IDENTIFIER_TYPE_LIMIT, archived ones included.
 */
export const identifierType = defineContract({
  name: 'contacts.identifierType',
  entity: 'identifierTypes',
  version: 1,
  managesList: 'identifierTypes',
  counter: 'saveVersion',
  fields: identifierTypeFields,
  prepare: prepareIdentifierType,
  apply: async (ctx, p, root) => {
    const nameNormalized = normaliseListName(p.name)
    const clash = await ctx.db
      .query('identifierTypes')
      .withIndex('by_tenant_nameNormalized', (q) =>
        q.eq('nameNormalized', nameNormalized),
      )
      .first()
    if (clash && clash._id !== root?._id) {
      throw rejected(
        'duplicate_identifier_type_name',
        `An identifier type called ${clash.name} exists`,
      )
    }
    const fields = { name: p.name, nameNormalized, isActive: p.isActive }
    if (!root) {
      const held = await ctx.db
        .query('identifierTypes')
        .withIndex('by_tenant_nameNormalized')
        .take(IDENTIFIER_TYPE_LIMIT)
      if (held.length >= IDENTIFIER_TYPE_LIMIT) {
        throw rejected(
          'identifier_type_limit',
          `A group can have at most ${IDENTIFIER_TYPE_LIMIT} identifier types, archived ones included`,
        )
      }
      return ctx.db.insert('identifierTypes', { ...fields, saveVersion: 0 })
    }
    await ctx.db.patch('identifierTypes', root._id, fields)
    return root._id
  },
})

export const relationshipType = defineContract({
  name: 'contacts.relationshipType',
  entity: 'relationshipTypes',
  version: 1,
  counter: 'saveVersion',
  fields: relationshipTypeFields,
  prepare: prepareRelationshipType,
  apply: async (ctx, p, root) => {
    if (!root)
      return ctx.db.insert('relationshipTypes', { ...p, saveVersion: 0 })
    await ctx.db.patch('relationshipTypes', root._id, p)
    return root._id
  },
})

export const relationship = defineContract({
  name: 'contacts.relationship',
  entity: 'relationships',
  version: 1,
  counter: 'saveVersion',
  fields: relationshipFields,
  prepare: prepareRelationship,
  apply: async (ctx, p, root) => {
    const [a, b, type] = await Promise.all([
      ctx.db.get(p.contactA),
      ctx.db.get(p.contactB),
      ctx.db.get(p.typeId),
    ])
    if (!a || !b) throw rejected('unknown_contact', 'Both contacts must exist')
    if (!type || !type.isActive) {
      throw rejected(
        'unknown_type',
        'Relationship type must exist and be active',
      )
    }
    if (type.kindA && a.kind !== type.kindA) {
      throw rejected(
        'kind_mismatch',
        `${type.labelAB}: contact A must be ${type.kindA}`,
      )
    }
    if (type.kindB && b.kind !== type.kindB) {
      throw rejected(
        'kind_mismatch',
        `${type.labelAB}: contact B must be ${type.kindB}`,
      )
    }
    if (!root) return ctx.db.insert('relationships', { ...p, saveVersion: 0 })
    await ctx.db.patch('relationships', root._id, p)
    return root._id
  },
})

/**
 * The note's text. `contactId` is a create-only argument, not payload, so
 * any revision restores onto the note wherever it lives now.
 */
export const note = defineContract({
  name: 'contacts.note',
  entity: 'contactNotes',
  version: 1,
  counter: 'bodyVersion',
  fields: noteFields,
  prepare: prepareNote,
  apply: async (ctx, p, root, command) => {
    const edited = {
      editedBy: command.actor ?? undefined,
      editedAt: command.at,
    }
    if (!root) {
      validate(v.object(noteCreateFields), command.createWith, { throw: true })
      const { contactId } = command.createWith as { contactId: Id<'contacts'> }
      // Another tenant's id reads as null through the scoped db.
      const contact = await ctx.db.get(contactId)
      if (!contact) throw rejected('unknown_contact', 'Contact must exist')
      return ctx.db.insert('contactNotes', {
        contactId,
        body: p.body,
        pinned: false,
        archived: false,
        createdBy: command.actor ?? undefined,
        ...edited,
        bodyVersion: 0,
        flagsVersion: 0,
      })
    }
    if (root.archived) {
      throw rejected('archived', 'Restore the note before editing it')
    }
    await ctx.db.patch('contactNotes', root._id, { body: p.body, ...edited })
    return root._id
  },
})

/** Pin and archive: not edits, so they leave body and editedBy/At alone. */
export const noteFlags = defineContract({
  name: 'contacts.noteFlags',
  entity: 'contactNotes',
  version: 1,
  counter: 'flagsVersion',
  fields: noteFlagsFields,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected('no_root', 'contacts.noteFlags targets an existing note')
    // Archive and unarchive are always allowed; nothing else changes on an
    // archived note.
    if (root.archived && p.archived && root.pinned !== p.pinned) {
      throw rejected('archived', 'Restore the note before pinning it')
    }
    await ctx.db.patch('contactNotes', root._id, {
      pinned: p.pinned,
      archived: p.archived,
    })
    return root._id
  },
})

/** Everything restore needs to know about this module. */
export const contactContracts = registry(
  details,
  methods,
  addresses,
  archive,
  identifiers,
  acquisition,
  fieldValues,
  identifierType,
  relationshipType,
  relationship,
  note,
  noteFlags,
)

/** Slices of the Contact form, in the order the form shows them. */
export const contactSlices = {
  details,
  methods,
  addresses,
  identifiers,
  fields: fieldValues,
} as const
