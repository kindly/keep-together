// @vitest-environment node
import { describe, expect, test } from 'vitest'
import {
  aggregate,
  budgetMiss,
  checkBudgets,
  exceptionOf,
  exceptions,
  isPing,
  spikes,
} from './server-timings'
import type { LogEvent } from './server-timings'
import { BULK_FUNCTIONS, SERVER_EXCEPTIONS } from './budgets'
import { GROWN_PAGE_LOG } from '../convex/contacts/queries'

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
        ev({
          identifier: 'contacts/mutations:bulkSetField',
          udfType: 'Mutation',
        }),
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
      ['contacts/mutations:bulkSetField', false, true],
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

  test('a bulk function is judged against its own limit, not 100 ms', () => {
    const bulk = (ms: number) =>
      ev({
        ms,
        identifier: 'contacts/mutations:bulkSetField',
        udfType: 'Mutation',
      })
    const under = aggregate([bulk(136), bulk(133), bulk(90)])
    expect(under[0].budgetMs).toBe(
      BULK_FUNCTIONS['contacts/mutations:bulkSetField'],
    )
    expect(checkBudgets({ functions: under })).toEqual([])
    expect(spikes({ functions: under })).toEqual([])
    const over = aggregate([bulk(1100), bulk(1050), bulk(90)])
    expect(checkBudgets({ functions: over })).toEqual([
      `Mutation contacts/mutations:bulkSetField: two calls ≥ ${BULK_FUNCTIONS['contacts/mutations:bulkSetField']} ms: 1100 and 1050 ms (n=3)`,
    ])
    // Anything else keeps the 100 ms rule.
    expect(aggregate([ev({})])[0].budgetMs).toBe(100)
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

describe('server exceptions', () => {
  const grown = (ms: number) =>
    ev({
      ms,
      logLines: [`[LOG] '${GROWN_PAGE_LOG}: 212 rows'`],
    })

  test("the exception's line is the one `list` logs", () => {
    expect(SERVER_EXCEPTIONS.map((x) => x.logLine)).toContain(GROWN_PAGE_LOG)
    // Structured log lines match too.
    expect(
      exceptionOf(
        ev({ logLines: [{ level: 'LOG', messages: [`'${GROWN_PAGE_LOG}'`] }] }),
      ),
    ).toBe(SERVER_EXCEPTIONS[0].reason)
  })

  test('a grown-page list call is recorded in its own row, exempt from 100 ms', () => {
    const fns = aggregate([grown(154), grown(125), ev({ ms: 40 })])
    expect(
      fns.map((f) => [f.identifier, f.asserted, f.n, f.max, f.exception]),
    ).toEqual([
      ['contacts/queries:list', true, 1, 40, undefined],
      [
        'contacts/queries:list [excepted]',
        false,
        2,
        154,
        SERVER_EXCEPTIONS[0].reason,
      ],
    ])
    expect(checkBudgets({ functions: fns })).toEqual([])
    expect(exceptions({ functions: fns })).toEqual([
      `contacts/queries:list: EXCEPTED from the 100 ms rule: ${SERVER_EXCEPTIONS[0].reason} · ceiling < 250 ms · 2 calls this run, p50 125 ms, max 154 ms`,
    ])
  })

  test('an excepted call under the 250 ms ceiling passes', () => {
    expect(SERVER_EXCEPTIONS[0].ceilingMs).toBe(250)
    const fns = aggregate([grown(249.9), grown(120), ev({ ms: 40 })])
    expect(fns[1]).toMatchObject({ max: 249.9, ceilingMs: 250 })
    expect(checkBudgets({ functions: fns })).toEqual([])
  })

  test('an excepted call at or over the ceiling fails the run, even as the only slow one', () => {
    // No spike allowance: the other excepted call is far under.
    for (const ms of [250, 251]) {
      const fns = aggregate([grown(ms), grown(120), ev({ ms: 40 })])
      expect(checkBudgets({ functions: fns })).toEqual([
        `Query contacts/queries:list [excepted]: an excepted call took ${ms} ms ≥ its ceiling 250 ms (n=2)`,
      ])
    }
    // Alone, too.
    expect(checkBudgets({ functions: aggregate([grown(300)]) })).toHaveLength(1)
  })

  test('an ordinary slow list call still fails, beside excepted ones', () => {
    const fns = aggregate([grown(154), ev({ ms: 120 }), ev({ ms: 110 })])
    expect(checkBudgets({ functions: fns })).toEqual([
      'Query contacts/queries:list: two calls ≥ 100 ms: 120 and 110 ms (n=2)',
    ])
    // And a single slow one is still only a spike when others are under.
    const spiked = aggregate([grown(154), ev({ ms: 120 }), ev({ ms: 30 })])
    expect(checkBudgets({ functions: spiked })).toEqual([])
    expect(spikes({ functions: spiked })).toHaveLength(1)
  })

  test("the line excepts only its own function's calls", () => {
    const other = ev({
      ms: 300,
      identifier: 'contacts/queries:search',
      logLines: [GROWN_PAGE_LOG],
    })
    const fns = aggregate([other, { ...other }])
    expect(fns[0].asserted).toBe(true)
    expect(checkBudgets({ functions: fns })).toHaveLength(1)
    expect(exceptions({ functions: fns })).toEqual([
      `contacts/queries:list: EXCEPTED from the 100 ms rule: ${SERVER_EXCEPTIONS[0].reason} · ceiling < 250 ms · no call this run`,
    ])
  })
})
