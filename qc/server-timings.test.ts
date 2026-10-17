// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { aggregate, budgetMiss, checkBudgets, isPing } from './server-timings'
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
  test('flags an asserted function with any call ≥ 100 ms, and nothing else', () => {
    const functions = aggregate([
      ...Array.from({ length: 30 }, () => ev({ ms: 10 })),
      ev({ ms: 100 }),
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
      'Query contacts/queries:list: max 100 ms ≥ 100 ms (n=31)',
    ])
  })

  test('the rule is every call < budget, at any n', () => {
    const [f] = aggregate([ev({ ms: 99.9 })])
    expect(budgetMiss(f, 100)).toBeNull()
    expect(budgetMiss(f, 99.9)).toMatch(/max 99.9 ms ≥ 99.9 ms \(n=1\)/)
  })
})

test('pings are anonymous HTTP-API calls of platform/tenants:mine', () => {
  expect(
    isPing(ev({ caller: 'HttpApi', identifier: 'platform/tenants:mine' })),
  ).toBe(true)
  expect(isPing(ev({ identifier: 'platform/tenants:mine' }))).toBe(false)
})
