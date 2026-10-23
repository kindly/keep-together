import { expect, test } from 'vitest'
import { landingTenant } from './tenant'

const g = (name: string, lastUsedAt: number | null = null) => ({
  name,
  lastUsedAt,
})

test('signing in lands in the group last used, else the first by name', () => {
  expect(landingTenant([])).toBeNull()
  expect(landingTenant([g('Only')])?.name).toBe('Only')
  expect(landingTenant([g('Zeta'), g('alpha'), g('Beta')])?.name).toBe('alpha')
  expect(landingTenant([g('Alpha'), g('Zeta', 2), g('Beta', 1)])?.name).toBe(
    'Zeta',
  )
})
