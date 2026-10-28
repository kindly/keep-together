/**
 * The contacts endpoints' JSON (the ts-rs types in `../rust-types/`)
 * adapted into the shapes the pages render (`../../domain/contacts`:
 * the view, `ListRow`, `FieldDefinition`, the search result). The API's
 * payloads are the form's slices (child rows by `key`), so this is mostly
 * ids: `id` → a branded `_id`, and the view's slices flattened.
 */
import type { Id } from '../../domain/ids'
import type { FieldDefinition } from '../../domain/contacts'
import type { ListFilters, ListRow } from '../../paged-list'
import type { ContactView, SearchArgs, SearchResult } from '../types'
import type { ContactRow } from '../rust-types/ContactRow'
import type { ContactView as WireContact } from '../rust-types/ContactView'
import type { FieldDefinition as WireField } from '../rust-types/FieldDefinition'
import type { SearchResult as WireSearch } from '../rust-types/SearchResult'

/**
 * The list's and search's filters as query parameters (`ListQuery`,
 * `SearchQuery`). `fields` is `fieldId:optionId|none`, comma-separated;
 * `source` is `level:id`.
 */
export function filterParams(
  f: Pick<ListFilters, 'includeArchived' | 'kind' | 'fields' | 'source'>,
): URLSearchParams {
  const q = new URLSearchParams()
  if (f.includeArchived) q.set('includeArchived', 'true')
  if (f.kind) q.set('kind', f.kind)
  if (f.source) q.set('source', `${f.source.level}:${f.source.id}`)
  if (f.fields?.length)
    q.set(
      'fields',
      f.fields.map((x) => `${x.fieldId}:${x.optionId ?? 'none'}`).join(','),
    )
  return q
}

export function searchParams(args: SearchArgs): URLSearchParams {
  const q = filterParams(args)
  q.set('q', args.search ?? '')
  return q
}

export function fieldsFromWire(
  fields: Array<WireField>,
): Array<FieldDefinition> {
  return fields.map((f, i) => ({
    _id: f.id as Id<'contactFields'>,
    label: f.label,
    appliesTo: f.appliesTo,
    isActive: f.isActive,
    retiring: f.retiring,
    // The API has no slots; the pages only order by it (filters, form).
    slot: i + 1,
    saveVersion: f.saveVersion,
    options: f.options.map((o) => ({
      _id: o.id as Id<'contactFieldOptions'>,
      fieldId: o.fieldId as Id<'contactFields'>,
      label: o.label,
      position: o.position,
      isActive: o.isActive,
      used: o.used,
      saveVersion: o.saveVersion,
    })),
    deletable: f.deletable,
  }))
}

export function rowFromWire(r: ContactRow): ListRow {
  return {
    _id: r.id as Id<'contacts'>,
    kind: r.kind,
    displayName: r.displayName,
    sortName: r.sortName,
    number: r.number,
    archived: r.archived,
    email: r.email,
    fieldOptionIds: r.fieldOptionIds as Array<Id<'contactFieldOptions'>>,
  }
}

export function searchFromWire(s: WireSearch): SearchResult {
  return {
    ...s,
    rows: s.rows.map(rowFromWire),
    numberMatch: s.numberMatch as Id<'contacts'> | null,
  }
}

/**
 * The contact as the page and form render it. The cast brands the ids
 * (and makes the saved rows' keys, always present on a read, required).
 */
export function contactFromWire(
  c: WireContact,
  definitions: Array<FieldDefinition>,
): ContactView {
  const field = new Map(definitions.map((f) => [f._id as string, f]))
  const { clientKey: _, ...details } = c.details
  const contact = {
    _id: c.id,
    ...details,
    displayName: c.displayName,
    sortName: c.sortName,
    number: c.number,
    archived: c.archived,
    detailsVersion: c.counters.details,
    methodsVersion: c.counters.methods,
    addressesVersion: c.counters.addresses,
    fieldsVersion: c.counters.fields,
    archiveVersion: c.counters.archive,
    identifiersVersion: c.counters.identifiers,
    acquisitionVersion: c.counters.acquisition,
    acquisitionCodeId: c.acquisition?.versionId,
  }
  return {
    contact,
    emails: c.methods.emails,
    phones: c.methods.phones,
    addresses: c.addresses.addresses,
    identifiers: c.identifiers,
    acquisition: c.acquisition,
    fields: c.fields.values.flatMap((v) => {
      const f = field.get(v.fieldId)
      if (!f) return []
      const o = f.options.find((x) => x._id === v.optionId)
      return [
        {
          fieldId: f._id,
          label: f.label,
          slot: f.slot,
          fieldActive: f.isActive,
          optionId: v.optionId,
          optionLabel: o?.label ?? '?',
          optionActive: o?.isActive ?? false,
        },
      ]
    }),
  } as unknown as ContactView
}
