import { expect, test } from 'vitest'
import { formatDay, formatPence } from './gifts'

test('pence format as pounds, exactly, whatever the size', () => {
  expect(formatPence(0n)).toBe('£0.00')
  expect(formatPence(5n)).toBe('£0.05')
  expect(formatPence(2000n)).toBe('£20.00')
  expect(formatPence(123456n)).toBe('£1,234.56')
  expect(formatPence(-150n)).toBe('-£1.50')
  // Beyond a float's exact range: no rounding in the pence.
  expect(formatPence(900719925474099199n)).toBe('£9,007,199,254,740,991.99')
})

test('an ISO date reads as a day, whatever the time zone', () => {
  expect(formatDay('2026-10-23')).toBe('23 Oct 2026')
  expect(formatDay('2026-01-01')).toBe('1 Jan 2026')
})
