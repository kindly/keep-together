/**
 * Dropdown field definitions (plan: dropdown fields, step 2). STUB: the
 * signatures step 4 builds against; the bodies land with step 2.
 */
import type { Doc, Id } from '../_generated/dataModel'
import type { FieldSlot } from '../lib/fieldSlots'
import type { ScopedDatabaseReader, ScopedDatabaseWriter } from '../lib/tenancy'
import type {
  ContactKind,
  FieldDefinition,
  FieldValue,
  FieldValueMode,
  ResolvedFieldValue,
} from './fieldTypes'

const notBuilt = () => new Error('dropdown fields step 2: not built yet')

/** The live field in each slot. Retired fields (no slot) are absent. One read. */
export async function fieldsBySlot(
  _db: ScopedDatabaseReader,
): Promise<Map<FieldSlot, Doc<'contactFields'>>> {
  throw notBuilt()
}

/** The live field in `slot`, or null if the slot is free. */
export async function fieldInSlot(
  _db: ScopedDatabaseReader,
  _slot: FieldSlot,
): Promise<Doc<'contactFields'> | null> {
  throw notBuilt()
}

/**
 * The tier-1 checks for one value on a contact of `kind`
 * (`fieldValueVerdict` in fieldTypes.ts; `current` is the option already
 * in the field's slot on the contact). Throws `rejected(...)` on a failed
 * check. Returns null when the field is retired (no slot): a save rejects
 * that, a restore skips the value and says so. Does not mark the option
 * used: the apply calls `markOptionUsed` for each value it newly sets.
 */
export async function resolveFieldValue(
  _db: ScopedDatabaseReader,
  _value: FieldValue,
  _kind: ContactKind,
  _current: Id<'contactFieldOptions'> | undefined,
  _mode: FieldValueMode = 'save',
): Promise<ResolvedFieldValue | null> {
  throw notBuilt()
}

/**
 * Set the option's `used` marker if not yet set (after that, a read-only
 * check, so a popular option is no write hot spot). Never cleared; no
 * contract, no revision, no list-manager check. Idempotent. Runs in the
 * caller's transaction: call it from the `contacts.fields` apply for each
 * option newly put on the contact.
 */
export async function markOptionUsed(
  _ctx: { db: ScopedDatabaseWriter },
  _optionId: Id<'contactFieldOptions'>,
): Promise<void> {
  throw notBuilt()
}

/** A contact's current values as a `contacts.fields` payload's `values`. Pure. */
export function fieldValuesOf(
  _contact: Doc<'contacts'>,
  _bySlot: Map<FieldSlot, Doc<'contactFields'>>,
): Array<FieldValue> {
  throw notBuilt()
}

/**
 * The live fields in slot order, each with its options in the admin's
 * order (archived ones included). Also served as `api.contacts.fields.list`
 * (tenantQuery, viewer, no args).
 */
export async function fieldDefinitions(
  _db: ScopedDatabaseReader,
): Promise<Array<FieldDefinition>> {
  throw notBuilt()
}
