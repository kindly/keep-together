// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { flowMark, parseHistory, renderTrend, shapeTrend, yMax } from './trend'
import type { HistoryLine, ServerSummary } from './reporter'

const server = (
  fns: Array<[string, boolean, number, number]>,
): ServerSummary => ({
  pass: true,
  functions: fns.map(([fn, asserted, p95Ms, maxMs]) => ({
    fn,
    type: 'Query',
    asserted,
    n: 3,
    p50Ms: p95Ms / 2,
    p95Ms,
    maxMs,
  })),
})

const line = (over: Partial<HistoryLine>): HistoryLine => ({
  runId: 'r1',
  at: '2026-10-17T10:00:00.000Z',
  sha: 'abcdef0123456789',
  dirty: false,
  mode: 'assert',
  flow: 'contact.save',
  kind: 'repeatable',
  n: 5,
  samplesMs: [80],
  p50Ms: 80,
  p95Ms: 90,
  maxMs: 90,
  overBudget: 0,
  rttMs: 30,
  rttOver: false,
  budgetMs: 100,
  pass: true,
  server: null,
  ...over,
})

describe('parseHistory', () => {
  test('skips blank lines and counts unreadable ones', () => {
    const text = [
      JSON.stringify(line({})),
      '',
      '{not json',
      JSON.stringify({ hello: 1 }),
      JSON.stringify(line({ runId: 'r2' })),
    ].join('\n')
    const { lines, skipped } = parseHistory(text)
    expect(lines.map((l) => l.runId)).toEqual(['r1', 'r2'])
    expect(skipped).toBe(2)
  })
})

describe('shapeTrend', () => {
  // Three runs, appended out of time order; r2 skipped contact.save.
  const history = [
    line({ runId: 'r3', at: '2026-10-17T12:00:00.000Z', maxMs: 95 }),
    line({
      runId: 'r3',
      at: '2026-10-17T12:00:01.000Z',
      flow: 'auth.signIn',
      kind: 'oncePerSession',
      maxMs: 500,
      p50Ms: 450,
      budgetMs: 2000,
    }),
    line({
      runId: 'r3',
      at: '2026-10-17T12:00:02.000Z',
      flow: 'groups.open',
      maxMs: 120,
      pass: false,
      knownOver: 'perf task pending',
      server: server([
        ['contacts/queries:list', true, 20, 30],
        ['auth:signIn', false, 180, 190],
      ]),
    }),
    line({ runId: 'r1', at: '2026-10-17T10:00:00.000Z', maxMs: 70 }),
    line({
      runId: 'r2',
      at: '2026-10-17T11:00:00.000Z',
      flow: 'groups.open',
      maxMs: 300,
      rttOver: true,
      server: server([['contacts/queries:list', true, 40, 120]]),
    }),
  ]

  test('orders runs by time and keeps the last N', () => {
    expect(
      shapeTrend(history, { lastRuns: 30 }).runs.map((r) => r.runId),
    ).toEqual(['r1', 'r2', 'r3'])
    expect(
      shapeTrend(history, { lastRuns: 2 }).runs.map((r) => r.runId),
    ).toEqual(['r2', 'r3'])
  })

  test('one point per run per flow, null where a run skipped it', () => {
    const t = shapeTrend(history, { lastRuns: 30 })
    const save = t.flows.find((f) => f.flow === 'contact.save')!
    expect(save.points.map((p) => p?.maxMs ?? null)).toEqual([70, null, 95])
    const groups = t.flows.find((f) => f.flow === 'groups.open')!
    expect(groups.points.map((p) => p && flowMark(p))).toEqual([
      null,
      'rtt',
      'known',
    ])
  })

  test('latest table: least headroom first, as a share of the budget', () => {
    const t = shapeTrend(history, { lastRuns: 30 })
    expect(t.latest.map((r) => [r.flow, r.headroomMs, r.current])).toEqual([
      ['groups.open', -20, true],
      ['contact.save', 5, true],
      // 1500 ms of headroom is 75%: sorts after 5 ms of 100.
      ['auth.signIn', 1500, true],
    ])
  })

  test('latest row falls back to the last run that timed the flow', () => {
    const t = shapeTrend(
      [
        ...history,
        line({
          runId: 'r4',
          at: '2026-10-17T13:00:00.000Z',
          flow: 'contacts.nav',
          maxMs: 50,
        }),
      ],
      { lastRuns: 30 },
    )
    const save = t.latest.find((r) => r.flow === 'contact.save')!
    expect([save.run.runId, save.current]).toEqual(['r3', false])
  })

  test('server functions: asserted first, worst first, by run', () => {
    const t = shapeTrend(history, { lastRuns: 30 })
    expect(t.server.map((s) => [s.fn, s.asserted])).toEqual([
      ['contacts/queries:list', true],
      ['auth:signIn', false],
    ])
    expect(t.server[0].points.map((p) => p?.maxMs ?? null)).toEqual([
      null,
      120,
      30,
    ])
  })

  test('empty history', () => {
    const t = shapeTrend([], { lastRuns: 30 })
    expect([t.runs, t.flows, t.server, t.latest]).toEqual([[], [], [], []])
    expect(renderTrend(t, 'now')).toContain('No runs in the history yet')
  })
})

describe('flowMark', () => {
  const p = { maxMs: 90, budgetMs: 100, pass: true, rttOver: false }
  test('rtt outranks known over, which outranks over', () => {
    expect(flowMark(p)).toBe('ok')
    expect(flowMark({ ...p, maxMs: 100, pass: false })).toBe('over')
    expect(flowMark({ ...p, maxMs: 120, knownOver: 'x' })).toBe('known')
    expect(flowMark({ ...p, knownOver: 'x', rttOver: true })).toBe('rtt')
  })
})

describe('renderTrend', () => {
  test('self-contained: no scripts or external URLs; escapes names', () => {
    const t = shapeTrend(
      [line({ flow: 'a<b>' as HistoryLine['flow'], knownOver: '"x" & y' })],
      { lastRuns: 30 },
    )
    const html = renderTrend(t, 'now')
    expect(html).not.toMatch(/<script|<link|https?:\/\/|@import|src=/i)
    expect(html).toContain('a&lt;b&gt;')
    expect(html).not.toContain('a<b>')
  })

  test('y axis leaves room above the budget and covers the data', () => {
    expect(yMax([50], 100)).toBe(150)
    expect(yMax([300], 100)).toBe(400)
    expect(yMax([500], 2000)).toBe(2500)
  })
})
