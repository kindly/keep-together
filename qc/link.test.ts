import { describe, expect, test } from 'vitest'
import { linkDuring } from './link.setup'

describe('linkDuring', () => {
  // Pings every 100 ms; the one sent at 1200 waited out a 250 ms freeze.
  const link = {
    pings: [
      [1000, 2],
      [1100, 3],
      [1200, 250],
      [1300, 150],
      [1400, 50],
      [1500, 2],
    ] as Array<[number, number]>,
  }

  test('the worst ping in flight during the window', () => {
    // 1200's reply came back at 1450, inside the window.
    expect(linkDuring(link, 1420, 1480)).toBe(250)
  })

  test('a ping answered before the window began is not in flight', () => {
    expect(linkDuring(link, 1490, 1510)).toBe(2)
  })

  test('a ping sent after the window ended is not in flight', () => {
    expect(linkDuring(link, 1000, 1050)).toBe(2)
  })

  test('null when no ping covers the window', () => {
    expect(linkDuring(link, 2000, 2100)).toBeNull()
    expect(linkDuring({ pings: [] }, 1000, 1100)).toBeNull()
  })
})

describe('linkDuring with unanswered echoes', () => {
  // The echo sent at 1200 was never answered; the link was back at 1450.
  const link = {
    pings: [
      [1100, 2],
      [1500, 2],
    ] as Array<[number, number]>,
    lost: [[1200, 1450]] as Array<[number, number]>,
  }

  test('counts from its send until the link answered again', () => {
    expect(linkDuring(link, 1300, 1320)).toBe(250)
  })

  test('outside that span it changes nothing', () => {
    expect(linkDuring(link, 1490, 1510)).toBe(2)
  })

  test('replies out of send order are still all seen', () => {
    const shuffled = { pings: [...link.pings].reverse(), lost: link.lost }
    expect(linkDuring(shuffled, 1490, 1510)).toBe(2)
  })
})

test('a reply reports its own round trip exactly', () => {
  const link = { pings: [[1792573184487, 69.2]] as Array<[number, number]> }
  expect(linkDuring(link, 1792573184500, 1792573184510)).toBe(69.2)
})
