/**
 * The contacts endpoints' JSON (step 2a's ts-rs types in `../rust-types/`)
 * adapted into the shapes the pages already render (the Convex view,
 * `ListRow`, `FieldDefinition`, `search`'s result), so both backends feed
 * the same components. The API keeps Convex's payload shapes (child rows
 * by `key`, slices named as the form names them), so this is mostly ids:
 * `id` → `_id`, and the view's slices flattened as Convex's `get` has them.
 */
import type { Id } from '../../../../convex/_generated/dataModel'
import type { FieldDefinition } from '../../../../convex/contacts/fieldTypes'
import type { FieldSlot } from '../../../../convex/lib/fieldSlots'
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
    retiring: false,
    // The API has no slots; the pages only order by it (filters, form).
    slot: (i + 1) as FieldSlot,
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
    deletable: false,
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
 * The contact in the Convex view's shape (what the form renders), with
 * what Rust doesn't have yet left empty. The
 * root carries the fields the pages read; the cast covers the rest of
 * `Doc<'contacts'>` (tenantId, field slots), which no page reads.
 */
export function contactFromWire(
  c: WireContact,
  definitions: Array<FieldDefinition>,
): ContactView {
  const field = new Map(definitions.map((f) => [f._id as string, f]))
  const { clientKey: _, ...details } = c.details
  const contact = {
    _id: c.id,
    _creationTime: 0,
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
