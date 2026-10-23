import { describe, expect, test } from 'vitest'
import { answered } from './timing'
import type { WireEntry } from './timing'

// The held-result guard's rule (qc/timing.ts, `server: true`): did the
// server send the watched page a query result in the sample?

const transition = (
  t: number,
  querySet: number,
  result: boolean,
  ts: number | null = null,
): WireEntry => [t, 'in', 'Transition', null, ts, undefined, querySet, result]

describe('answered', () => {
  test('nothing from the server: held', () => {
    expect(answered([], null, 7)).toBe(false)
    expect(answered([], null, null)).toBe(false)
  })

  test('a Transition with the added query’s result answers it', () => {
    expect(answered([transition(30, 7, true)], null, 7)).toBe(true)
  })

  test('a Transition that only acknowledges a removal is no answer', () => {
    // Leaving a page removes its queries; the server's ack carries no
    // result, and the screen drew from what the client held.
    expect(answered([transition(30, 7, false)], null, 7)).toBe(false)
    expect(answered([transition(30, 7, false)], null, null)).toBe(false)
  })

  test('a result from before the server saw our change is no answer', () => {
    // Another query's update, at query-set version 6, while ours is 7.
    expect(answered([transition(20, 6, true)], null, 7)).toBe(false)
    expect(
      answered([transition(20, 6, true), transition(31, 7, true)], null, 7),
    ).toBe(true)
  })

  test('no add in the sample (a route preload sent it on hover): any result', () => {
    expect(answered([transition(25, 3, true)], null, null)).toBe(true)
  })

  test('after a mutation: the Transition that reaches its commit', () => {
    const commit = 1_000
    expect(answered([transition(40, 2, true, 999)], commit, null)).toBe(false)
    expect(answered([transition(41, 2, false, 1_000)], commit, null)).toBe(true)
  })

  test('frames other than Transitions never count', () => {
    const response: WireEntry = [12, 'in', 'MutationResponse', 4, 1_000]
    expect(answered([response], 1_000, null)).toBe(false)
  })
})
