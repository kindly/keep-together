import { describe, expect, test } from 'vitest'
import { routeOf, serverSummary } from './server'
import type { ApiCall, FlowRecord, SampleDetail } from './timing'

// The server rule over Server-Timing (qc/server.ts): under 100 ms per
// call, one spike per route.

const ID = '0190f1d23c4b7a008000000000000001'

const call = (
  url: string,
  serverMs: number | null,
  method = 'GET',
): ApiCall => ({
  method,
  url,
  startMs: 0,
  endMs: 10,
  status: 200,
  serverMs,
  dbMs: null,
})

const sample = (calls: Array<ApiCall>): SampleDetail => ({
  at: 0,
  calls,
  eventMs: null,
  endMs: 20,
  answered: true,
  longTaskMs: 0,
  hidden: false,
  hostCpu: null,
  load1: 0,
})

const record = (calls: Array<Array<ApiCall>>, over: Partial<FlowRecord> = {}) =>
  ({
    flow: 'contact.save',
    detail: calls.map(sample),
    ...over,
  }) as FlowRecord

describe('routeOf', () => {
  test('slug and ids become placeholders; the query goes', () => {
    expect(routeOf(call(`/api/t/r1w0-a/contacts/${ID}/save`, 1, 'POST'))).toBe(
      'POST /t/:slug/contacts/:id/save',
    )
    expect(routeOf(call('/api/t/r1w0-a/contacts/search?q=ada', 1))).toBe(
      'GET /t/:slug/contacts/search',
    )
    expect(routeOf(call('/api/me', 1))).toBe('GET /me')
  })
})

describe('serverSummary', () => {
  const contact = `/api/t/a/contacts/${ID}`

  test('every call under 100 ms passes', () => {
    const s = serverSummary([
      record([[call(contact, 5)], [call(contact, 99.9)]]),
    ])
    expect(s.pass).toBe(true)
    expect(s.routes).toMatchObject([
      { route: 'GET /t/:slug/contacts/:id', n: 2, maxMs: 99.9, over: 0 },
    ])
  })

  test('one slow call among others is a spike, two fail', () => {
    const one = serverSummary([
      record([[call(contact, 150)], [call(contact, 5)]]),
    ])
    expect(one.pass).toBe(true)
    expect(one.spikes).toHaveLength(1)
    const two = serverSummary([
      record([[call(contact, 150)], [call(contact, 120)], [call(contact, 5)]]),
    ])
    expect(two.pass).toBe(false)
    expect(two.failures[0]).toMatch(/2 of 3 calls/)
  })

  test('a route whose only call was slow fails: nothing re-measured it', () => {
    expect(serverSummary([record([[call(contact, 100)]])]).pass).toBe(false)
  })

  test('the first set of a re-measure counts too', () => {
    const s = serverSummary([
      record([[call(contact, 5)]], {
        firstDetail: [
          sample([call(contact, 130)]),
          sample([call(contact, 140)]),
        ],
      }),
    ])
    expect(s.pass).toBe(false)
  })

  test('dev routes and self-tests are not asserted', () => {
    expect(
      serverSummary([record([[call('/api/dev/login', 500, 'POST')]])]).pass,
    ).toBe(true)
    expect(
      serverSummary([record([[call(contact, 500)]], { selfTest: true })])
        .routes,
    ).toEqual([])
  })

  test('an answered call without Server-Timing fails; one in flight is skipped', () => {
    const s = serverSummary([record([[call(contact, null)]])])
    expect(s.pass).toBe(false)
    expect(s.untimed).toEqual(['GET /t/:slug/contacts/:id'])
    const inFlight = { ...call(contact, null), endMs: null }
    expect(serverSummary([record([[inFlight]])]).pass).toBe(true)
  })

  test('auth calls answer untimed on purpose (S1 review C7)', () => {
    const s = serverSummary([
      record([[call('/api/auth/second-factor', null, 'POST')]]),
    ])
    expect(s.pass).toBe(true)
    expect(s.untimed).toEqual([])
  })
})
