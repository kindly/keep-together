import { describe, expect, test } from 'vitest'
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
