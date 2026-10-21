import { describe, expect, test } from 'vitest'
import schema from '../schema'
import { FIELD_SLOTS, FIELD_SLOT_NUMBERS, SLOT_FIELD_NAMES } from './fieldSlots'

// Raising FIELD_SLOTS must bring every slot's fields, index pair and
// filter field with it, and stay inside Convex's limits
// (https://docs.convex.dev/production/state/limits).
const MAX_INDEXES_PER_TABLE = 32
const MAX_SEARCH_FILTER_FIELDS = 16

const exported = (table: 'contacts' | 'contactSearch') =>
  (schema.tables[table] as unknown as { export: () => unknown }).export() as {
    indexes: Array<{ indexDescriptor: string; fields: Array<string> }>
    searchIndexes: Array<{
      indexDescriptor: string
      filterFields: Array<string>
    }>
  }

const fieldsOf = (table: 'contacts' | 'contactSearch') =>
  Object.keys(
    (schema.tables[table].validator as { fields: Record<string, unknown> })
      .fields,
  )

const slotIndexes = () =>
  exported('contactSearch').indexes.filter((i) =>
    i.fields.some((f) => /^field\d+$/.test(f)),
  )

describe('FIELD_SLOTS generator', () => {
  test('slots are 1…FIELD_SLOTS', () => {
    expect(FIELD_SLOT_NUMBERS).toEqual(
      Array.from({ length: FIELD_SLOTS }, (_, i) => i + 1),
    )
    expect(SLOT_FIELD_NAMES).toEqual(FIELD_SLOT_NUMBERS.map((n) => `field${n}`))
  })

  test.each(['contacts', 'contactSearch'] as const)(
    '%s has exactly one optional fieldN per slot',
    (table) => {
      expect(fieldsOf(table).filter((f) => /^field\d+$/.test(f))).toEqual(
        SLOT_FIELD_NAMES,
      )
      const validators = (
        schema.tables[table].validator as {
          fields: Record<string, { isOptional: string; tableName?: string }>
        }
      ).fields
      for (const name of SLOT_FIELD_NAMES) {
        expect(validators[name]).toMatchObject({
          isOptional: 'optional',
          tableName: 'contactFieldOptions',
        })
      }
    },
  )

  test('contactSearch has exactly 2 indexes per slot, the plan’s pair', () => {
    expect(slotIndexes()).toHaveLength(2 * FIELD_SLOTS)
    for (const field of SLOT_FIELD_NAMES) {
      expect(
        slotIndexes()
          .filter((i) => i.fields.includes(field))
          .map((i) => [i.indexDescriptor, i.fields]),
      ).toEqual([
        [`by_tenant_${field}_sort`, ['tenantId', field, 'sortName']],
        [
          `by_tenant_${field}_archived_sort`,
          ['tenantId', field, 'archived', 'sortName'],
        ],
      ])
    }
  })

  test('contacts itself has no slot index (values are filtered on contactSearch)', () => {
    expect(
      exported('contacts').indexes.filter((i) =>
        i.fields.some((f) => /^field\d+$/.test(f)),
      ),
    ).toEqual([])
  })

  test('search_text has exactly 1 filter field per slot', () => {
    const [search] = exported('contactSearch').searchIndexes
    expect(search.indexDescriptor).toBe('search_text')
    expect(search.filterFields.filter((f) => /^field\d+$/.test(f))).toEqual(
      SLOT_FIELD_NAMES,
    )
  })

  test('contactSearch stays inside Convex’s index and filter-field limits', () => {
    const { indexes, searchIndexes } = exported('contactSearch')
    expect(indexes.length).toBeLessThanOrEqual(MAX_INDEXES_PER_TABLE)
    for (const s of searchIndexes) {
      expect(s.filterFields.length).toBeLessThanOrEqual(
        MAX_SEARCH_FILTER_FIELDS,
      )
    }
  })
})
