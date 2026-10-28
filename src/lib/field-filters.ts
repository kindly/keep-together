/**
 * The contacts list's dropdown-field filters (plan: dropdown fields, step
 * 5): what the filter bar shows, and the `fields` argument `list` and
 * `search` take.
 */
import type { Id } from './domain/ids'
import type { ContactKind, FieldDefinition  } from './domain/contacts'

/** A field filter's choice: an option, or "not set" (`null`). */
export type FieldPick = {
  fieldId: Id<'contactFields'>
  optionId: Id<'contactFieldOptions'> | null
}

type Kind = ContactKind

/** A field gets a filter when it is active and applies to the kind shown. */
export function fieldShown(f: FieldDefinition, kind: Kind | '') {
  return f.isActive && (!kind || f.appliesTo.includes(kind))
}

/**
 * The field filters as `list` and `search` take them, for the fields the
 * filter bar shows (a pick on a field hidden since, by the kind filter or
 * an archive, no longer applies). Set values go first: the first filter is
 * the index range, and "not set" usually matches most contacts (queries.ts,
 * review L4). Otherwise in the order they were picked. Built afresh each
 * render; the args stay equal because their content does.
 */
export function fieldArgs(
  picks: Array<FieldPick>,
  fields: Array<FieldDefinition> | undefined,
  kind: Kind | '',
): Array<FieldPick> {
  const shown = new Set(
    (fields ?? []).filter((f) => fieldShown(f, kind)).map((f) => f._id),
  )
  const live = picks.filter((p) => shown.has(p.fieldId))
  return [
    ...live.filter((p) => p.optionId !== null),
    ...live.filter((p) => p.optionId === null),
  ].map((p) => ({ fieldId: p.fieldId, optionId: p.optionId }))
}
