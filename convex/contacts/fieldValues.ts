/**
 * A contact's dropdown field values (plan: dropdown fields, step 4). The
 * contact holds them by slot (`field1` … `fieldN`); the `contacts.fields`
 * payload names them by field id, so its shape never depends on the slot
 * count. Pure: callers do the reads.
 */
import type { Id } from '../_generated/dataModel'
import { SLOT_FIELD_NAMES } from '../lib/fieldSlots'
import type { SlotFieldName } from '../lib/fieldSlots'
import type { FieldValue } from './fieldTypes'

/** A row holding slot values: a contact or its `contactSearch` row. */
export type SlotValues = Partial<
  Record<SlotFieldName, Id<'contactFieldOptions'>>
>

/** Every slot's value, absent ones as `undefined` (so a patch clears them). */
export function slotValues(
  row: SlotValues,
): Record<SlotFieldName, Id<'contactFieldOptions'> | undefined> {
  return Object.fromEntries(
    SLOT_FIELD_NAMES.map((name) => [name, row[name]]),
  ) as Record<SlotFieldName, Id<'contactFieldOptions'> | undefined>
}

export function sameSlots(a: SlotValues, b: SlotValues): boolean {
  return SLOT_FIELD_NAMES.every((name) => a[name] === b[name])
}

/** The option ids a row holds, in slot order. */
export function optionIdsOf(row: SlotValues): Array<Id<'contactFieldOptions'>> {
  return SLOT_FIELD_NAMES.flatMap((name) => {
    const optionId = row[name]
    return optionId ? [optionId] : []
  })
}

/** Values in one order (by field id), so equal states compare equal. */
export function sortValues(values: Array<FieldValue>): Array<FieldValue> {
  return [...values].sort((a, b) => a.fieldId.localeCompare(b.fieldId))
}

/** `values` with one field set to `optionId`, or cleared (`null`). */
export function withValue(
  values: Array<FieldValue>,
  fieldId: Id<'contactFields'>,
  optionId: Id<'contactFieldOptions'> | null,
): Array<FieldValue> {
  const rest = values.filter((v) => v.fieldId !== fieldId)
  return sortValues(optionId ? [...rest, { fieldId, optionId }] : rest)
}
