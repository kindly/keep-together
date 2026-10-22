/**
 * The field-definitions API step 4 (the contact values) uses, in one
 * place. The signatures are step 2's (`./fields`, commit 4c1ccfd), whose
 * bodies were still stubs when step 4 was built; these are local bodies
 * written to its doc comments. Once step 2's bodies land, this file
 * becomes `export { … } from './fields'` and nothing else changes.
 */
import type { Doc, Id } from '../_generated/dataModel'
import { rejected } from '../lib/contracts'
import { FIELD_SLOTS, FIELD_SLOT_NUMBERS } from '../lib/fieldSlots'
import type { FieldSlot } from '../lib/fieldSlots'
import type { ScopedDatabaseReader, ScopedDatabaseWriter } from '../lib/tenancy'
import { fieldValueVerdict } from './fieldTypes'
import type {
  ContactKind,
  FieldValue,
  FieldValueMode,
  ResolvedFieldValue,
} from './fieldTypes'

/** The live field in each slot. Retired fields (no slot) are absent. One read. */
export async function fieldsBySlot(
  db: ScopedDatabaseReader,
): Promise<Map<FieldSlot, Doc<'contactFields'>>> {
  const rows = await db
    .query('contactFields')
    .withIndex('by_tenant_slot', (q) => q.gte('slot', 1))
    .take(FIELD_SLOTS)
  return new Map(rows.map((f) => [f.slot as FieldSlot, f]))
}

/**
 * The tier-1 checks for one value (`fieldValueVerdict`, step 2's pure
 * rule). Throws `rejected(...)` on a refusal. A save gets `set`; a restore
 * may also get `skipped` (the field was retired, or no longer applies to
 * the kind), to leave the value out and report it.
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

/** Set the option's `used` marker if not yet set. Idempotent. */
export async function markOptionUsed(
  ctx: { db: ScopedDatabaseWriter },
  optionId: Id<'contactFieldOptions'>,
): Promise<void> {
  const option = await ctx.db.get(optionId)
  if (option && !option.used) {
    await ctx.db.patch('contactFieldOptions', optionId, { used: true })
  }
}

/** A contact's current values as a `contacts.fields` payload's `values`. Pure. */
export function fieldValuesOf(
  contact: Doc<'contacts'>,
  bySlot: Map<FieldSlot, Doc<'contactFields'>>,
): Array<FieldValue> {
  return FIELD_SLOT_NUMBERS.flatMap((slot) => {
    const field = bySlot.get(slot)
    const optionId = contact[`field${slot}`]
    return field && optionId ? [{ fieldId: field._id, optionId }] : []
  })
}
