/**
 * Pure state for the Settings "Fields" tab (dropdown fields plan, step 3):
 * which fields and options show, how an open editor follows a save someone
 * else makes meanwhile (the usual three-way merge, ADR 0017), reordering,
 * and failures as one line for the user.
 */
import { ConvexError } from 'convex/values'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import { CONTACT_KINDS } from '../../convex/contacts/fieldTypes'
import type { ContactKind } from '../../convex/contacts/fieldTypes'
import { threeWayMerge } from './merge'

/** One row of `contacts.fields.list`. */
export type Field = FunctionReturnType<typeof api.contacts.fields.list>[number]
export type Option = Field['options'][number]

export const KIND_LABEL: Record<ContactKind, string> = {
  individual: 'Individuals',
  organization: 'Organisations',
  household: 'Households',
}

/** "Individuals and Organisations", "all contacts". */
export function kindsText(kinds: ReadonlyArray<ContactKind>): string {
  if (CONTACT_KINDS.every((k) => kinds.includes(k))) return 'all contacts'
  const names = CONTACT_KINDS.filter((k) => kinds.includes(k)).map(
    (k) => KIND_LABEL[k],
  )
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The fields shown. Without "show archived", an archived field is left
 * out unless it is being retired (its progress shows) or in `open` (a row
 * with an editor open stays until it closes, so an archive made elsewhere
 * never silently discards what someone is typing).
 */
export function shownFields(
  fields: ReadonlyArray<Field>,
  showArchived: boolean,
  open: ReadonlySet<string> = new Set(),
): Array<Field> {
  return showArchived
    ? [...fields]
    : fields.filter((f) => f.isActive || f.retiring || open.has(f._id))
}

/** The same for one field's options. */
export function shownOptions(
  options: ReadonlyArray<Option>,
  showArchived: boolean,
  open: ReadonlySet<string> = new Set(),
): Array<Option> {
  return showArchived
    ? [...options]
    : options.filter((o) => o.isActive || open.has(o._id))
}

/** Why an option can't be deleted, or null if it can. */
export function optionDeleteBlocked(
  option: Pick<Option, 'used'>,
): string | null {
  return option.used ? 'Used on a contact, so it can only be archived' : null
}

/** Why a field can't be deleted, or null if it can. */
export function fieldDeleteBlocked(
  field: Pick<Field, 'deletable'>,
): string | null {
  return field.deletable
    ? null
    : 'An option has been used on a contact: archive or retire the field instead'
}

/**
 * The full option order after moving `id` one place `by` (-1 up, +1 down)
 * among `shown`, the options on screen. Hidden (archived) options keep
 * their places relative to the others; the server wants every option
 * named. Null when the move goes nowhere.
 */
export function moveOption(
  all: ReadonlyArray<Pick<Option, '_id'>>,
  shown: ReadonlyArray<Pick<Option, '_id'>>,
  id: Option['_id'],
  by: -1 | 1,
): Array<Option['_id']> | null {
  const at = shown.findIndex((o) => o._id === id)
  const to = at + by
  if (at < 0 || to < 0 || to >= shown.length) return null
  const swapWith = shown[to]
  const order = all.map((o) => o._id)
  const i = order.indexOf(id)
  const j = order.indexOf(swapWith._id)
  order[i] = swapWith._id
  order[j] = id
  return order
}

// ── open editors ───────────────────────────────────────────────────────────

/** A field's editable slice as its editor holds it. */
export type FieldFields = { label: string; appliesTo: Array<ContactKind> }

/** An option's editable slice. */
export type OptionFields = { label: string }

export function fieldFieldsOf(f: Field): FieldFields {
  return { label: f.label, appliesTo: [...f.appliesTo] }
}

export function optionFieldsOf(o: Option): OptionFields {
  return { label: o.label }
}

/**
 * An open editor. `base` and `baseVersion` are the row as last seen from
 * the server; `fields` is what the form holds; `conflicts` lists fields
 * someone else changed to something other than what this editor typed.
 */
export type Draft<T extends Record<string, unknown>> = {
  base: T
  baseVersion: number
  fields: T
  conflicts: Array<keyof T & string>
}

export function openDraft<T extends Record<string, unknown>>(
  fields: T,
  version: number,
): Draft<T> {
  return { base: fields, baseVersion: version, fields, conflicts: [] }
}

/**
 * Follow a newer save from the live query. Fields changed only there take
 * theirs, fields changed only here keep ours, and fields changed on both
 * sides keep ours and are flagged. The next save goes against their
 * counter, so a stale save is a merge, then a retry.
 */
export function rebase<T extends Record<string, unknown>>(
  draft: Draft<T>,
  remote: T,
  version: number,
): Draft<T> {
  if (version <= draft.baseVersion) return draft
  const { value, conflicts } = threeWayMerge(draft.base, draft.fields, remote)
  return conflictsOf({
    base: remote,
    baseVersion: version,
    fields: value,
    conflicts: [...new Set([...draft.conflicts, ...conflicts])],
  })
}

/**
 * The draft with only its live conflicts: a flagged field whose value
 * matches theirs again is no longer one.
 */
export function conflictsOf<T extends Record<string, unknown>>(
  draft: Draft<T>,
): Draft<T> {
  const conflicts = draft.conflicts.filter(
    (f) => JSON.stringify(draft.fields[f]) !== JSON.stringify(draft.base[f]),
  )
  return conflicts.length === draft.conflicts.length
    ? draft
    : { ...draft, conflicts }
}

/** `appliesTo` with `kind` switched on or off, in the form's order. */
export function toggleKind(
  kinds: ReadonlyArray<ContactKind>,
  kind: ContactKind,
  on: boolean,
): Array<ContactKind> {
  return CONTACT_KINDS.filter((k) => (k === kind ? on : kinds.includes(k)))
}

// ── messages ───────────────────────────────────────────────────────────────

/**
 * A failed field or option mutation as one line for the user. `from` is
 * where it was sent: an edit form (a stale save there has been merged, so
 * the user checks and saves again) or a row action (nothing to merge: the
 * user tries again).
 */
export function failureMessage(
  err: unknown,
  from: 'form' | 'row' = 'form',
): string {
  const data =
    err instanceof ConvexError
      ? (err.data as {
          kind?: string
          message?: string
          problems?: Array<{ message: string }>
        })
      : null
  if (data?.kind === 'invalid' && data.problems?.length)
    return data.problems.map((p) => p.message).join('; ')
  if (data?.kind === 'stale')
    return from === 'form'
      ? 'Someone else changed this just now. Their changes are merged in: check, then save again.'
      : 'Someone else changed this just now; check it and try again.'
  if (data?.kind === 'forbidden')
    return 'You can no longer manage fields in this group'
  if (data?.kind === 'not_found') return 'This no longer exists'
  return data?.message ?? data?.kind ?? 'Could not save'
}
