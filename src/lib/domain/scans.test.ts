import { expect, test } from 'vitest'
import {
  canMerge,
  describeUsage,
  endsIn,
  formatBytes,
  linkState,
  matchable,
  movePage,
} from './scans'

// Declaration scans' rules on the laptop (step 4): what they say before
// the server decides.

test('bytes read decimal, as the 2 GB cap is', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(999)).toBe('999 B')
  expect(formatBytes(1_000)).toBe('1 KB')
  expect(formatBytes(245_300)).toBe('245 KB')
  expect(formatBytes(1_250_000)).toBe('1.3 MB')
  expect(formatBytes(2_000_000_000)).toBe('2 GB')
})

test('the usage warns from 90% and is full at the cap', () => {
  const cap = 2_000_000_000
  expect(describeUsage({ bytes: 120_000_000, capBytes: cap })).toEqual({
    text: '120 MB of 2 GB (6%)',
    share: 0.06,
    level: 'ok',
  })
  expect(describeUsage({ bytes: 1_800_000_000, capBytes: cap }).level).toBe(
    'warn',
  )
  const full = describeUsage({ bytes: 2_100_000_000, capBytes: cap })
  expect(full.level).toBe('full')
  expect(full.text).toBe('2.1 GB of 2 GB (100%)')
})

test('with no cap, the usage is the bytes alone, never nearly full', () => {
  expect(describeUsage({ bytes: 5_300_000_000, capBytes: null })).toEqual({
    text: '5.3 GB',
    share: null,
    level: 'ok',
  })
})

test('a link waits for a phone, is held by one, then ends at the sooner limit', () => {
  const p = {
    claimed: false,
    endedAt: null,
    expiresAt: 10_000_000,
    idleExpiresAt: 900_000,
  }
  expect(linkState(p, 0)).toEqual({ kind: 'waiting', endsAt: 900_000 })
  expect(linkState({ ...p, claimed: true }, 0)).toEqual({
    kind: 'connected',
    endsAt: 900_000,
  })
  // Past the idle limit before the server has said so.
  expect(linkState(p, 900_000)).toEqual({ kind: 'ended' })
  expect(linkState({ ...p, endedAt: 5 }, 0)).toEqual({ kind: 'ended' })
  expect(endsIn(900_000, 0)).toBe('in 15 min')
  expect(endsIn(900_000, 870_000)).toBe('in under a minute')
})

test('a scan matches only a paper form, not made in error, holding no scan', () => {
  expect(matchable({ method: 'paperForm' }, 0)).toBe(true)
  expect(matchable({ method: 'paperForm' }, 1)).toBe(false)
  // Unknown yet: not offered until the server says.
  expect(matchable({ method: 'paperForm' }, undefined)).toBe(false)
  expect(matchable({ method: 'paperForm', voidedAt: 1 }, 0)).toBe(false)
  expect(matchable({ method: 'oral' }, 0)).toBe(false)
  expect(matchable({ method: 'staffTickedNoEvidence' }, 0)).toBe(false)
})

test('pages move one place at a time, never off either end', () => {
  expect(movePage(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
  expect(movePage(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
  expect(movePage(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
  expect(movePage(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
})

test('a merge fits six pages in all', () => {
  expect(canMerge(4, 2)).toBe(true)
  expect(canMerge(5, 2)).toBe(false)
})
