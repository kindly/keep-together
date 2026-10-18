/**
 * Pieces of the contact view shared by `get` (which builds it in one query)
 * and the SPA (which assembles it from the per-slice queries). Pure: the
 * queries do the reads.
 */
import type { Id } from '../_generated/dataModel'
import { normaliseTagName } from './rules'

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
      normaliseTagName(a.typeName).localeCompare(
        normaliseTagName(b.typeName),
      ) || a.value.localeCompare(b.value),
  )
}

/**
 * `get`'s view from the contact page's per-slice queries (`getRoot`,
 * `getChannels`, `getTags`, `getIdentifiers`), naming identifier rows from
 * the tenant's identifier types, archived ones included.
 */
export function assembleView<TRoot, TChannels extends object, TTag>(parts: {
  root: TRoot
  channels: TChannels
  tags: Array<TTag>
  identifiers: Array<IdentifierRow>
  types: Array<{ _id: Id<'identifierTypes'>; name: string; isActive: boolean }>
}) {
  const types = new Map(parts.types.map((t) => [t._id, t]))
  return {
    contact: parts.root,
    ...parts.channels,
    tags: parts.tags,
    identifiers: nameIdentifiers(parts.identifiers, (id) => types.get(id)),
  }
}
