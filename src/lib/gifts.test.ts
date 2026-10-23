import { expect, test } from 'vitest'
import { formatDay, formatPence, parsePounds, penceToInput } from './gifts'

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

test('pounds typed parse to exact pence', () => {
  expect(parsePounds('20')).toBe(2000n)
  expect(parsePounds('20.5')).toBe(2050n)
  expect(parsePounds(' £1,250.05 ')).toBe(125005n)
  expect(parsePounds('.5')).toBe(50n)
  expect(parsePounds('0')).toBe(0n)
  expect(parsePounds('-3')).toBe(-300n)
  // Beyond a float's exact range: still exact.
  expect(parsePounds('90071992547409919.99')).toBe(9007199254740991999n)
  for (const bad of ['', '£', '20.505', '2o', '1,25', '20.', '1e3'])
    expect(parsePounds(bad)).toBeNull()
})

test('pence round-trip through the amount field', () => {
  expect(penceToInput(2000n)).toBe('20.00')
  expect(penceToInput(5n)).toBe('0.05')
  expect(penceToInput(123456n)).toBe('1234.56')
  for (const p of [1n, 99n, 100n, 2050n, 9007199254740991999n])
    expect(parsePounds(penceToInput(p))).toBe(p)
})
