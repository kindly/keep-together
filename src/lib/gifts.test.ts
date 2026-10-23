import type { OptimisticLocalStore } from 'convex/browser'
import { expect, test } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import {
  formatDay,
  formatPence,
  parsePounds,
  penceToInput,
  setStatusLocally,
} from './gifts'

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

test('a status change shows in the cached gift, counter untouched', () => {
  const key = (args: unknown) => JSON.stringify(args)
  const cache = new Map<string, unknown>()
  const store = {
    getQuery: (_q: unknown, args: unknown) => cache.get(key(args)),
    setQuery: (_q: unknown, args: unknown, value: unknown) =>
      cache.set(key(args), value),
    getAllQueries: () => [],
  } as unknown as OptimisticLocalStore
  const args = {
    tenantId: 't1' as Id<'tenants'>,
    id: 'g1' as Id<'contributions'>,
  }
  cache.set(key(args), { _id: 'g1', status: 'completed', statusVersion: 4 })
  setStatusLocally(store, { ...args, expected: 4, status: 'void' })
  expect(cache.get(key(args))).toEqual({
    _id: 'g1',
    status: 'void',
    statusVersion: 4,
  })
  // A gift not loaded is left alone.
  const other = {
    tenantId: 't1' as Id<'tenants'>,
    id: 'g2' as Id<'contributions'>,
  }
  setStatusLocally(store, { ...other, expected: 0, status: 'void' })
  expect(cache.has(key(other))).toBe(false)
})
