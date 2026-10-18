// @vitest-environment node
import { describe, expect, test } from 'vitest'
import {
  aggregate,
  budgetMiss,
  checkBudgets,
  isPing,
  spikes,
} from './server-timings'
import type { LogEvent } from './server-timings'

const ev = (over: Partial<LogEvent> & { ms?: number }): LogEvent => ({
  kind: 'Completion',
  udfType: 'Query',
  identifier: 'contacts/queries:list',
  componentPath: null,
  executionTime: (over.ms ?? 10) / 1000,
  cachedResult: false,
  caller: 'Websocket',
  identityType: 'user',
  timestamp: 0,
  ...over,
})

const asserted = (events: Array<LogEvent>) =>
  aggregate(events).map((f) => [f.identifier, f.cached, f.asserted])

describe('aggregate', () => {
  test('asserts only uncached, user-called queries and mutations of our modules', () => {
    expect(
      asserted([
        ev({}),
        ev({ cachedResult: true }),
        ev({ identifier: 'contacts/mutations:saveForm', udfType: 'Mutation' }),
        ev({ identifier: 'auth:store', udfType: 'Mutation' }),
        ev({
          identityType: 'instance_admin',
          identifier: 'platform/qcSeed:world',
        }),
        ev({ componentPath: 'migrations', identifier: 'lib:run' }),
        ev({ identifier: 'nowhere/module:fn' }),
        ev({ udfType: 'Action', identifier: 'platform/qcSeed:fixture' }),
        ev({ udfType: 'HttpAction', identifier: 'GET /.well-known/jwks.json' }),
      ]),
    ).toEqual([
      ['auth:store', false, false],
      ['contacts/mutations:saveForm', false, true],
      ['contacts/queries:list', false, true],
      ['contacts/queries:list', true, false],
      ['GET /.well-known/jwks.json', false, false],
      ['lib:run', false, false],
      ['nowhere/module:fn', false, false],
      ['platform/qcSeed:fixture', false, false],
      ['platform/qcSeed:world [admin]', false, false],
    ])
  })

  test('nearest-rank p50/p95 in ms', () => {
    const events = Array.from({ length: 20 }, (_, i) => ev({ ms: i + 1 }))
    const [f] = aggregate(events)
    expect([f.n, f.p50, f.p95, f.max]).toEqual([20, 10, 19, 20])
  })
})

describe('budgets', () => {
  test('flags an asserted function with two calls ≥ 100 ms, and nothing else', () => {
    const functions = aggregate([
      ...Array.from({ length: 30 }, () => ev({ ms: 10 })),
      ev({ ms: 100 }),
      ev({ ms: 120 }),
      ev({ ms: 300, cachedResult: true, identifier: 'platform/tenants:mine' }),
      ev({ ms: 300, identifier: 'auth:store', udfType: 'Mutation' }),
      ev({
        ms: 300,
        identityType: 'instance_admin',
        udfType: 'Mutation',
        identifier: 'platform/qcSeed:world',
      }),
      ev({
        ms: 99.9,
        identifier: 'contacts/mutations:saveForm',
        udfType: 'Mutation',
      }),
    ])
    expect(checkBudgets({ functions })).toEqual([
      'Query contacts/queries:list: two calls ≥ 100 ms: 120 and 100 ms (n=32)',
    ])
  })

  test('every call < budget, bar one spike among other calls under it', () => {
    const [f] = aggregate([ev({ ms: 99.9 })])
    expect(budgetMiss(f, 100)).toBeNull()
    expect(budgetMiss(f, 99.9)).toMatch(/only call took 99.9 ms .*n=1/)

    const [spiked] = aggregate([
      ev({ ms: 140 }),
      ev({ ms: 20 }),
      ev({ ms: 30 }),
    ])
    expect(spiked.second).toBe(30)
    expect(budgetMiss(spiked, 100)).toBeNull()
    expect(spikes({ functions: [spiked] })).toEqual([
      'Query contacts/queries:list: one call 140 ms, the other 2 under (next slowest 30 ms)',
    ])

    const [twice] = aggregate([
      ev({ ms: 140 }),
      ev({ ms: 100 }),
      ev({ ms: 20 }),
    ])
    expect(budgetMiss(twice, 100)).toBe(
      'two calls ≥ 100 ms: 140 and 100 ms (n=3)',
    )
    expect(spikes({ functions: [twice] })).toEqual([])
  })
})

test('pings are anonymous HTTP-API calls of platform/tenants:mine', () => {
  expect(
    isPing(ev({ caller: 'HttpApi', identifier: 'platform/tenants:mine' })),
  ).toBe(true)
  expect(isPing(ev({ identifier: 'platform/tenants:mine' }))).toBe(false)
})
