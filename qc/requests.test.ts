import { describe, expect, test } from 'vitest'
import { requestLines } from './requests'
import type { SeenRequest } from './requests'

const at = Date.parse('2026-11-02T01:48:01.564Z')
const req = (over: Partial<SeenRequest>): SeenRequest => ({
  method: 'GET',
  url: 'https://keep-qc.fly.dev/assets/t._slug-C5yz_0-y.js',
  sentAt: at,
  doc: 2,
  docNow: 2,
  ...over,
})

describe('requestLines', () => {
  test('nothing to say: no lines', () => {
    expect(requestLines([req({ end: 12 })], at + 100)).toEqual([])
  })

  test('pending from the page still showing: NO ANSWER', () => {
    const [, line] = requestLines([req({})], at + 5921)
    expect(line).toBe(
      '01:48:01.564 NO ANSWER after 5921 ms · GET https://keep-qc.fly.dev/assets/t._slug-C5yz_0-y.js',
    )
  })

  // mobile-nav.spec.ts:101 on keep-qc: the first goto's lazy chunks, still
  // in flight when the second goto replaced the page.
  test('pending from a page a navigation replaced: DROPPED, not NO ANSWER', () => {
    const [head, line] = requestLines([req({ doc: 1, docNow: 2 })], at + 5921)
    expect(line).toBe(
      '01:48:01.564 DROPPED (its page was replaced) after 5921 ms · GET https://keep-qc.fly.dev/assets/t._slug-C5yz_0-y.js',
    )
    expect(head).toMatch(/DROPPED: .* not a hang/)
  })

  test('failed and slow answers are listed with their outcome', () => {
    const lines = requestLines(
      [
        req({ url: 'https://h/api/a', end: 'failed after 3 ms: net::ERR_FAILED' }),
        req({ url: 'https://h/api/b', end: 1500 }),
        req({ url: 'https://h/api/c', end: 999 }),
      ],
      at + 2000,
    )
    expect(lines.slice(1)).toEqual([
      '01:48:01.564 failed after 3 ms: net::ERR_FAILED · GET https://h/api/a',
      '01:48:01.564 1500 ms · GET https://h/api/b',
    ])
  })

  test('a failure is a failure even from a replaced page', () => {
    const [, line] = requestLines(
      [req({ doc: 1, docNow: 2, end: 'failed after 9 ms: net::ERR_ABORTED' })],
      at + 100,
    )
    expect(line).toContain('failed after 9 ms: net::ERR_ABORTED')
  })

  test('the event stream is never listed', () => {
    expect(
      requestLines([req({ url: 'https://h/api/t/x/events?after=1' })], at + 9000),
    ).toEqual([])
  })
})
