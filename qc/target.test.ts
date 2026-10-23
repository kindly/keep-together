// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { budgets } from './budgets'
import type { Budget, FlowName } from './budgets'
import { DRIFT_MS, DRIFT_RUNS, checkTarget, targetReason } from './target'
import type { HistoryLine } from './reporter'

// Two-tier budgets (human, 2026-10-23): the line fails, the target is
// tracked (qc/target.ts).

describe('budgets: lines and targets', () => {
  const byKind = (kind: Budget['kind']) =>
    (Object.entries(budgets) as Array<[FlowName, Budget]>).filter(
      ([, b]) => b.kind === kind && !b.selfTest,
    )

  test('every repeatable, infrequent and rare flow: line and target by kind', () => {
    for (const [kind, maxMs, targetMs] of [
      ['repeatable', 150, 100],
      ['infrequent', 200, 150],
      ['rare', 250, 200],
    ] as const) {
      const flows = byKind(kind)
      expect(flows.length).toBeGreaterThan(0)
      for (const [, b] of flows) expect(b).toMatchObject({ maxMs, targetMs })
    }
  })

  test('oncePerSession and bulk keep their recorded budgets, with no target', () => {
    expect(budgets['auth.signIn']).toEqual({
      kind: 'oncePerSession',
      maxMs: 1000,
    })
    expect(budgets['contacts.coldLoad']).toEqual({
      kind: 'oncePerSession',
      maxMs: 410,
    })
    expect(budgets['contacts.bulkSetField']).toEqual({
      kind: 'bulk',
      maxMs: 500,
    })
  })

  test('no knownOver marks (contact.addEmail and gift.save lifted)', () => {
    const marked = (Object.entries(budgets) as Array<[FlowName, Budget]>)
      .filter(([, b]) => b.knownOver !== undefined)
      .map(([name]) => name)
    expect(marked).toEqual([])
    expect(budgets['contact.addEmail']).toEqual(budgets['contact.save'])
    expect(budgets['gift.save']).toEqual(budgets['contact.save'])
  })
})

const past = (
  p50s: Array<number>,
  over: Partial<HistoryLine> = {},
): Array<HistoryLine> =>
  p50s.map(
    (p50Ms, i) =>
      ({
        runId: `old${i}`,
        flow: 'contact.save',
        kind: 'repeatable',
        p50Ms,
        rttOver: false,
        ...over,
      }) as HistoryLine,
  )

const now = (
  p50Ms: number,
  over: Partial<Parameters<typeof checkTarget>[0]> = {},
) => ({
  runId: 'now',
  flow: 'contact.save' as const,
  kind: 'repeatable' as const,
  p50Ms,
  rttOver: false,
  targetMs: 100,
  ...over,
})

describe('checkTarget', () => {
  test('under target with no history: not flagged, no drift flag', () => {
    expect(checkTarget(now(99), [])).toEqual({
      overTarget: false,
      baselineMs: null,
      riseMs: null,
      flagged: false,
    })
  })

  test('a median at or over the target is flagged, history or not', () => {
    expect(checkTarget(now(100), [])).toMatchObject({
      overTarget: true,
      flagged: true,
    })
    expect(checkTarget(now(120), past([119, 121]))).toMatchObject({
      overTarget: true,
      riseMs: 0,
      flagged: true,
    })
  })

  test(`a rise of ${DRIFT_MS} ms or more on the median of the last runs is flagged`, () => {
    // Baseline: median of 60, 62, 64 = 62.
    expect(checkTarget(now(78), past([60, 62, 64]))).toEqual({
      overTarget: false,
      baselineMs: 62,
      riseMs: 16,
      flagged: true,
    })
    expect(checkTarget(now(77.9), past([60, 62, 64]))!.flagged).toBe(false)
    // Faster is never a drift.
    expect(checkTarget(now(30), past([60, 62, 64]))!.flagged).toBe(false)
  })

  test(`only the last ${DRIFT_RUNS} runs of the same flow and kind, RTT under the ceiling`, () => {
    const history = [
      ...past([90, 90, 90]), // older than the last DRIFT_RUNS
      ...past([200], { flow: 'contact.archive' }),
      ...past([200], { kind: 'infrequent' }),
      ...past([200], { rttOver: true }),
      ...past([60, 60, 61, 62, 62]),
    ]
    expect(checkTarget(now(70), history)).toMatchObject({
      baselineMs: 61,
      riseMs: 9,
      flagged: false,
    })
  })

  test('no target, or a slow link: not checked', () => {
    expect(checkTarget(now(500, { targetMs: undefined }), [])).toBeUndefined()
    expect(checkTarget(now(500, { rttOver: true }), [])).toBeUndefined()
  })

  test('the reason says which rule flagged it', () => {
    const l = { p50Ms: 120, targetMs: 100 }
    expect(
      targetReason({ ...l, target: checkTarget(now(120), past([100]))! }),
    ).toBe(
      `median 120 ≥ target 100; median 120 up 20 on 100 (last ${DRIFT_RUNS} runs)`,
    )
    expect(targetReason({ ...l, target: checkTarget(now(120), [])! })).toBe(
      'median 120 ≥ target 100',
    )
  })
})
