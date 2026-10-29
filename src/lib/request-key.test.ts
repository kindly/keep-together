// GoCardless UI review H1: a retry keeps its key only if it asks the same.
import { expect, test } from 'vitest'
import { keyFor } from './request-key'

test('an identical retry keeps the key; any change to what is asked mints a new one', () => {
  const first = keyFor(null, { amount: 10_000n, sourceCodeId: 'v1' })
  expect(first.key).toMatch(/^[0-9a-f]{32}$/)
  expect(keyFor(first, { amount: 10_000n, sourceCodeId: 'v1' }).key).toBe(
    first.key,
  )
  const cheaper = keyFor(first, { amount: 5_000n, sourceCodeId: 'v1' })
  expect(cheaper.key).not.toBe(first.key)
  expect(keyFor(cheaper, { amount: 5_000n, sourceCodeId: 'v2' }).key).not.toBe(
    cheaper.key,
  )
  // Back to the first request: a new key all the same (the first was
  // never answered, or was another attempt).
  expect(keyFor(cheaper, { amount: 10_000n, sourceCodeId: 'v1' }).key).not.toBe(
    first.key,
  )
})
