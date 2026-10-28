import { describe, expect, test } from 'vitest'
import { judge, parseServerTiming } from './timing'

// The pure parts of qc/timing.ts: the pass rule and the server time each
// sample's calls carry (the api's `Server-Timing`, server/README.md "Timing").

describe('parseServerTiming', () => {
  test('total and db from the api’s header', () => {
    expect(
      parseServerTiming('platform;dur=0.4, db;dur=3.2, total;dur=4.1'),
    ).toEqual({ serverMs: 4.1, dbMs: 3.2 })
  })

  test('order and spacing don’t matter; a description is skipped', () => {
    expect(
      parseServerTiming('total;desc="all";dur=12,db;dur=7.5,platform;dur=1'),
    ).toEqual({ serverMs: 12, dbMs: 7.5 })
  })

  test('no header, or no such metric: null, never zero', () => {
    expect(parseServerTiming(null)).toEqual({ serverMs: null, dbMs: null })
    expect(parseServerTiming('platform;dur=1')).toEqual({
      serverMs: null,
      dbMs: null,
    })
  })

  test('a metric whose name only ends in "total" is not total', () => {
    expect(parseServerTiming('subtotal;dur=9, total;dur=10')).toEqual({
      serverMs: 10,
      dbMs: null,
    })
  })
})

describe('judge', () => {
  test('every sample under the line passes; one at it fails', () => {
    expect(judge([10, 20, 149.9], 150)).toEqual({
      medianMs: 20,
      maxMs: 149.9,
      pass: true,
    })
    expect(judge([10, 150, 20], 150).pass).toBe(false)
  })
})
