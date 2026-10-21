import { describe, expect, test } from 'vitest'
import schema from '../schema'
import {
  DOMAIN_TABLES,
  PLATFORM_TABLES,
  ALL_TABLES,
  hasTenantId,
  unscopedIndexes,
} from './tables'

// Rule 6 (CLAUDE.md): tenancy is structural. A new table that forgets
// tenantId, or an index that doesn't lead with it, fails here.
describe('schema tenancy invariants', () => {
  test('every platform table named in PLATFORM_TABLES exists', () => {
    for (const t of PLATFORM_TABLES) {
      expect(ALL_TABLES, `unknown platform table ${t}`).toContain(t)
    }
  })

  test.each(DOMAIN_TABLES)('%s has a tenantId field', (name) => {
    expect(hasTenantId(name)).toBe(true)
  })

  test.each(DOMAIN_TABLES)('%s indexes lead with tenantId', (name) => {
    expect(unscopedIndexes(name)).toEqual([])
  })
})

// ALL_TABLES is built without importing the auth library: it must still
// name every table the deployed schema has, or the tenancy rules would
// leave one out (an id of an unlisted table bypasses them).
test('ALL_TABLES is exactly the schema', () => {
  expect([...ALL_TABLES].sort()).toEqual(Object.keys(schema.tables).sort())
})
