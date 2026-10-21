/**
 * Dropdown-field slots (plan: dropdown fields). An organisation's fields
 * live in numbered slots, and a contact's value for the field in slot N is
 * the plain optional `fieldN` on `contacts` and on its `contactSearch` row
 * (an option id; absent = not set). Only `contactSearch` is indexed: each
 * slot adds the pair `(tenantId, fieldN, sortName)` and `(tenantId, fieldN,
 * archived, sortName)` and one filter field on `search_text`.
 *
 * `FIELD_SLOTS` is the one place the count lives; the schema's fields,
 * indexes and filter fields are generated from it here. Raising it is a
 * loosen-only change (optional fields, new indexes, absent = not set):
 * no backfill, no tighten. The ceiling is the search index's 16 filter
 * fields (6 are taken, so 10 slots at most) and then the table's 32
 * indexes; about 8 is the practical limit once write cost is counted.
 * Past that, values move to a join table, `contactFieldValues` (the plan's
 * "slot ceiling"; ADR 0023 once written).
 *
 * Limits checked against https://docs.convex.dev/production/state/limits
 * (convex 1.47.0, 2026-10-21): indexes per table 32, fields per index 16,
 * filters per search index 16, filters per search query 8. The package
 * itself doesn't enforce them; the deployment does on push.
 */
import type {
  GenericTableIndexes,
  GenericTableSearchIndexes,
  GenericTableVectorIndexes,
  TableDefinition,
} from 'convex/server'
import type { Validator } from 'convex/values'

export const FIELD_SLOTS = 5

/** 1 … N as a union, for `N = FIELD_SLOTS`. */
type SlotNumbers<
  TCount extends number,
  TAcc extends Array<number> = [],
> = TAcc['length'] extends TCount
  ? TAcc[number]
  : SlotNumbers<TCount, [...TAcc, [...TAcc, 0]['length']]>

export type FieldSlot = SlotNumbers<typeof FIELD_SLOTS>
export type SlotFieldName = `field${FieldSlot}`

/** `[1, 2, …, FIELD_SLOTS]`. */
export const FIELD_SLOT_NUMBERS = Array.from(
  { length: FIELD_SLOTS },
  (_, i) => i + 1,
) as Array<FieldSlot>

export const slotFieldName = (slot: FieldSlot): SlotFieldName => `field${slot}`

/** `field1` … `fieldN`: the search index's filter fields, one per slot. */
export const SLOT_FIELD_NAMES = FIELD_SLOT_NUMBERS.map(slotFieldName)

/** One `fieldN: validator` per slot, for a table's document shape. */
export function slotFields<TValidator extends Validator<any, 'optional', any>>(
  validator: TValidator,
): Record<SlotFieldName, TValidator> {
  return Object.fromEntries(
    SLOT_FIELD_NAMES.map((name) => [name, validator]),
  ) as Record<SlotFieldName, TValidator>
}

export type SlotIndexes = {
  [S in FieldSlot as `by_tenant_field${S}_sort`]: [
    'tenantId',
    `field${S}`,
    'sortName',
    '_creationTime',
  ]
} & {
  [S in FieldSlot as `by_tenant_field${S}_archived_sort`]: [
    'tenantId',
    `field${S}`,
    'archived',
    'sortName',
    '_creationTime',
  ]
}

/**
 * Adds each slot's index pair to a table that has `tenantId`, `fieldN`,
 * `archived` and `sortName` (`contactSearch`): the field filter without
 * search text, with and without archived contacts, by name.
 */
export function withSlotIndexes<
  TDocument extends Validator<any, any, any>,
  TIndexes extends GenericTableIndexes,
  TSearch extends GenericTableSearchIndexes,
  TVector extends GenericTableVectorIndexes,
>(
  table: TableDefinition<TDocument, TIndexes, TSearch, TVector>,
): TableDefinition<TDocument, TIndexes & SlotIndexes, TSearch, TVector> {
  // The index field names are checked against the document by the types
  // above (and by fieldSlots.test.ts against the built schema), not here.
  let t = table as unknown as TableDefinition
  for (const slot of FIELD_SLOT_NUMBERS) {
    const field = slotFieldName(slot)
    t = t
      .index(`by_tenant_${field}_sort`, ['tenantId', field, 'sortName'])
      .index(`by_tenant_${field}_archived_sort`, [
        'tenantId',
        field,
        'archived',
        'sortName',
      ])
  }
  return t as unknown as TableDefinition<
    TDocument,
    TIndexes & SlotIndexes,
    TSearch,
    TVector
  >
}
