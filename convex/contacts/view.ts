/**
 * Pieces of the contact view shared by `get` (which builds it in one query)
 * and the SPA (which assembles it from the per-slice queries). Pure: the
 * queries do the reads.
 */
import type { Id } from '../_generated/dataModel'
import type { SourceCodeDescription } from '../sources/code'
import { FIELD_SLOT_NUMBERS, slotFieldName } from '../lib/fieldSlots'
import type { FieldSlot } from '../lib/fieldSlots'
import { normaliseListName } from './rules'
import type { FieldDefinition } from './fieldTypes'
import type { SlotValues } from './fieldValues'

export type IdentifierRow = {
  key: string
  typeId: Id<'identifierTypes'>
  value: string
}

/**
 * Identifier rows with their type names, by type name then value. A row
 * of an archived type says so (`typeActive: false`); one whose type can't
 * be found reads '?'.
 */
export function nameIdentifiers(
  rows: Array<IdentifierRow>,
  typeOf: (
    id: Id<'identifierTypes'>,
  ) => { name: string; isActive: boolean } | null | undefined,
) {
  const out = rows.map((r) => {
    const type = typeOf(r.typeId)
    return {
      key: r.key,
      typeId: r.typeId,
      value: r.value,
      typeName: type?.name ?? '?',
      typeActive: type?.isActive ?? false,
    }
  })
  return out.sort(
    (a, b) =>
      normaliseListName(a.typeName).localeCompare(
        normaliseListName(b.typeName),
      ) || a.value.localeCompare(b.value),
  )
}

/** One of a contact's dropdown field values, named. */
export type FieldValueView = {
  fieldId: Id<'contactFields'>
  label: string
  slot: FieldSlot
  /** False: the field is archived (the value is kept and still shown). */
  fieldActive: boolean
  optionId: Id<'contactFieldOptions'>
  /** '?' when the option can't be found. */
  optionLabel: string
  /** False: the option is archived (kept on contacts that have it). */
  optionActive: boolean
}

/**
 * A contact's field values named by their fields and options, in slot
 * order. Labels are read live, so a rename shows without a write to the
 * contact. A value in a slot no field holds isn't shown.
 */
export function nameFieldValues(
  contact: SlotValues,
  fieldInSlot: (
    slot: FieldSlot,
  ) =>
    | { _id: Id<'contactFields'>; label: string; isActive: boolean }
    | null
    | undefined,
  optionOf: (
    id: Id<'contactFieldOptions'>,
  ) => { label: string; isActive: boolean } | null | undefined,
): Array<FieldValueView> {
  return FIELD_SLOT_NUMBERS.flatMap((slot) => {
    const optionId = contact[slotFieldName(slot)]
    const field = fieldInSlot(slot)
    if (!optionId || !field) return []
    const option = optionOf(optionId)
    return [
      {
        fieldId: field._id,
        label: field.label,
        slot,
        fieldActive: field.isActive,
        optionId,
        optionLabel: option?.label ?? '?',
        optionActive: option?.isActive ?? false,
      },
    ]
  })
}

/**
 * `get`'s view from the contact page's per-slice queries (`getRoot`,
 * `getChannels`, `getIdentifiers`, `getAcquisition`), naming
 * identifier rows from the tenant's identifier types, archived ones
 * included, and field values from the field definitions
 * (`api.contacts.fields.list`; none named until the page passes them).
 */
export function assembleView<
  TRoot extends SlotValues,
  TChannels extends object,
>(parts: {
  root: TRoot
  channels: TChannels
  identifiers: Array<IdentifierRow>
  types: Array<{ _id: Id<'identifierTypes'>; name: string; isActive: boolean }>
  acquisition: SourceCodeDescription | null
  fields?: Array<FieldDefinition>
}) {
  const types = new Map(parts.types.map((t) => [t._id, t]))
  const definitions = parts.fields ?? []
  const bySlot = new Map(definitions.map((f) => [f.slot, f]))
  const options = new Map(
    definitions.flatMap((f) => f.options.map((o) => [o._id, o] as const)),
  )
  return {
    contact: parts.root,
    ...parts.channels,
    identifiers: nameIdentifiers(parts.identifiers, (id) => types.get(id)),
    acquisition: parts.acquisition,
    fields: nameFieldValues(
      parts.root,
      (slot) => bySlot.get(slot),
      (id) => options.get(id),
    ),
  }
}
