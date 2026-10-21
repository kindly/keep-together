/**
 * Dropdown fields (plan: dropdown fields): the payloads, types, limits and
 * pure rules shared by the field definitions (`fields.ts`, step 2) and the
 * contact values (`contracts.ts` and friends, step 4). No Convex imports
 * except validators and types: the portability boundary.
 *
 * What step 4 uses from `fields.ts`:
 *   - `fieldsBySlot(db)` / `fieldInSlot(db, slot)`: the live field in each
 *     slot (a retired field has no slot and is in neither);
 *   - `resolveFieldValue(db, value, kind, current)`: the tier-1 checks for
 *     one `{ fieldId, optionId }` and the slot it goes in;
 *   - `markOptionUsed(ctx, optionId)`: called by the `contacts.fields`
 *     apply for each option newly put on the contact (idempotent);
 *   - `fieldValuesOf(contact, bySlot)`: a contact's current values as a
 *     `contacts.fields` payload;
 *   - `fieldDefinitions(db)` and the public query `api.contacts.fields.list`.
 *
 * What `fields.ts` needs from step 4: the `contacts.fields` contract in
 * `contactContracts` under that name, payload `fieldValuesFields`, counter
 * `fieldsVersion`. The retire action runs it, by name, on every contact
 * carrying the field.
 */
import { v } from 'convex/values'
import type { ObjectType } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { contactKind } from '../lib/appSchema'
import type { Problem } from '../lib/contracts'
import { invalid } from '../lib/contracts'
import type { FieldSlot } from '../lib/fieldSlots'

export type ContactKind = Doc<'contacts'>['kind']

/** Every kind, in the order the form lists them: a new field's default. */
export const CONTACT_KINDS: ReadonlyArray<ContactKind> = [
  'individual',
  'organization',
  'household',
]

/** The longest a field's or an option's label can be. */
export const FIELD_LABEL_MAX = 60

/**
 * The most options a field can hold, archived ones included. A dropdown
 * longer than this isn't one, and the definitions query reads them all.
 */
export const FIELD_OPTION_LIMIT = 100

// ── payloads ───────────────────────────────────────────────────────────────

/**
 * The `contacts.field` slice: what an editor can change about a field.
 * `slot` is system-owned (assigned on create, cleared by retire).
 */
export const fieldFields = {
  label: v.string(),
  appliesTo: v.array(contactKind),
  isActive: v.boolean(),
}

export type FieldPayload = ObjectType<typeof fieldFields>

/**
 * The `contacts.fieldOption` slice. The field is fixed at create
 * (`fieldOptionCreateFields`) and `used` is system-owned.
 */
export const fieldOptionFields = {
  label: v.string(),
  position: v.number(),
  isActive: v.boolean(),
}

export type FieldOptionPayload = ObjectType<typeof fieldOptionFields>

/** Create-only: the field an option belongs to, for good. */
export const fieldOptionCreateFields = { fieldId: v.id('contactFields') }

/** One field's value on a contact. */
export const fieldValue = v.object({
  fieldId: v.id('contactFields'),
  optionId: v.id('contactFieldOptions'),
})

export type FieldValue = ObjectType<{ value: typeof fieldValue }>['value']

/**
 * The `contacts.fields` slice (step 4's contract): every field that has a
 * value on the contact, named by field id, at most one value per field. A
 * field left out is not set. Here so retire can build the payload.
 */
export const fieldValuesFields = { values: v.array(fieldValue) }

export type FieldValuesPayload = ObjectType<typeof fieldValuesFields>

// ── reads ──────────────────────────────────────────────────────────────────

export type FieldOptionView = {
  _id: Id<'contactFieldOptions'>
  fieldId: Id<'contactFields'>
  label: string
  position: number
  isActive: boolean
  /** Has been on a contact: archive only, never delete. */
  used: boolean
  saveVersion: number
}

/** A live field (one with a slot) and its options in the admin's order. */
export type FieldDefinition = {
  _id: Id<'contactFields'>
  label: string
  appliesTo: Array<ContactKind>
  /** False: archived, hidden from the form and filters; values kept. */
  isActive: boolean
  slot: FieldSlot
  saveVersion: number
  /** Archived ones included. */
  options: Array<FieldOptionView>
  /** No option was ever used: the whole field can be deleted. */
  deletable: boolean
}

/** What `resolveFieldValue` found: the slot a value goes in. */
export type ResolvedFieldValue = {
  slot: FieldSlot
  field: Doc<'contactFields'>
  option: Doc<'contactFieldOptions'>
}

// ── pure rules ─────────────────────────────────────────────────────────────

/** Labels are unique case-insensitively (fields per tenant, options per field). */
export function normaliseFieldLabel(label: string): string {
  return label.toLowerCase()
}

const tidy = (label: string) => label.trim().replace(/\s+/g, ' ')

function labelProblem(label: string, what: string): Problem | null {
  if (!label) return { field: 'label', message: `${what} needs a label` }
  if (label.length > FIELD_LABEL_MAX) {
    return { field: 'label', message: `At most ${FIELD_LABEL_MAX} characters` }
  }
  return null
}

/**
 * Label tidied (trimmed, inner whitespace collapsed) and required;
 * `appliesTo` de-duplicated into the form's order and never empty.
 */
export function prepareField(p: FieldPayload): FieldPayload {
  const out = {
    ...p,
    label: tidy(p.label),
    appliesTo: CONTACT_KINDS.filter((k) => p.appliesTo.includes(k)),
  }
  const problems: Array<Problem> = []
  const label = labelProblem(out.label, 'A field')
  if (label) problems.push(label)
  if (out.appliesTo.length === 0) {
    problems.push({
      field: 'appliesTo',
      message: 'A field applies to at least one kind of contact',
    })
  }
  if (problems.length) throw invalid(problems)
  return out
}

/** Label tidied and required; position a whole number. */
export function prepareFieldOption(p: FieldOptionPayload): FieldOptionPayload {
  const out = { ...p, label: tidy(p.label) }
  const problems: Array<Problem> = []
  const label = labelProblem(out.label, 'An option')
  if (label) problems.push(label)
  if (!Number.isInteger(out.position) || out.position < 0) {
    problems.push({ field: 'position', message: 'Not a valid position' })
  }
  if (problems.length) throw invalid(problems)
  return out
}

/** The command group a retire batch runs under. */
export function retireGroupName(label: string): string {
  return `Retire field ${label}`
}

/**
 * How a `contacts.fields` value is being written: a live save, or a
 * restore re-applying history, which may put back an archived option or a
 * value on an archived field (as restore may re-add an archived tag).
 */
export type FieldValueMode = 'save' | 'restore'

export type FieldValueVerdict =
  | { ok: true }
  | { ok: false; retired: true }
  | { ok: false; retired: false; reason: string; message: string }

/**
 * The tier-1 rule for one value, given the field and option it names (null:
 * missing or another tenant's) and the option already in the field's slot
 * on the contact (`current`). Always: both exist and the option is the
 * field's. A retired field (no slot) is its own verdict: a save refuses
 * it, a restore skips the value and says so. Only for a value newly set
 * (not `current`): the field applies to `kind` (narrowing a field's kinds
 * never blocks a contact that already has a value) and, on a save, the
 * field and the option are both active.
 */
export function fieldValueVerdict(
  field: Pick<
    Doc<'contactFields'>,
    '_id' | 'label' | 'appliesTo' | 'isActive' | 'slot'
  > | null,
  option: Pick<
    Doc<'contactFieldOptions'>,
    '_id' | 'fieldId' | 'label' | 'isActive'
  > | null,
  kind: ContactKind,
  current: Id<'contactFieldOptions'> | undefined,
  mode: FieldValueMode,
): FieldValueVerdict {
  const no = (reason: string, message: string): FieldValueVerdict => ({
    ok: false,
    retired: false,
    reason,
    message,
  })
  if (!field || !option) {
    return no('unknown_field', 'The field and its option must exist')
  }
  if (option.fieldId !== field._id) {
    return no(
      'option_not_in_field',
      `${option.label} is not an option of ${field.label}`,
    )
  }
  if (field.slot === undefined) return { ok: false, retired: true }
  if (option._id === current) return { ok: true }
  if (!field.appliesTo.includes(kind)) {
    return no(
      'field_kind',
      `${field.label} doesn’t apply to this kind of contact`,
    )
  }
  if (mode === 'save' && !field.isActive) {
    return no('archived_field', `${field.label} is archived`)
  }
  if (mode === 'save' && !option.isActive) {
    return no('archived_option', `${option.label} is archived: choose another`)
  }
  return { ok: true }
}
