// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { blame } from './blame'
import type { Blame, BlameContext, BlameSample, Verdict } from './blame'
import {
  RETRIES_PER_SAMPLE,
  RETRY_CAP_PER_RUN,
  SHARE_MARGIN_MS,
  judgeSlowSample,
} from './judge'
import type { JudgeDeps, Measured } from './judge'
import { takeRetry } from './timing'
import { budgetFor } from './budgets'
import { cases } from './blame.fixture'

type Fixture = { sample: BlameSample } & BlameContext

// A blame with only what the judge reads.
const verdict = (v: Verdict, ourShareMs: number | null = 40): Blame =>
  ({ verdict: v, why: v, ourShareMs }) as Blame

/**
 * Deps scripted per attempt: blames[k] is the k-th attempt's blame,
 * retries[k] the k-th retry's ms. Counts what was called.
 */
function script(
  blames: Array<Blame>,
  retries: Array<number> = [],
  retriesLeft = Infinity,
) {
  const calls = { blame: 0, measure: 0, take: 0 }
  const deps: JudgeDeps<null> = {
    blame: () =>
      Promise.resolve({ blame: blames[calls.blame++], caughtUp: true }),
    measure: () =>
      Promise.resolve({ ms: retries[calls.measure++], detail: null }),
    takeRetry: () => {
      calls.take++
      return retriesLeft-- > 0
    },
  }
  return { deps, calls }
}
const first: Measured<null> = { ms: 130, detail: null }

describe('judgeSlowSample', () => {
  test('ours fails at once, no retry', async () => {
    const { deps, calls } = script([verdict('ours')])
    const j = await judgeSlowSample(first, 100, deps)
    expect(j).toMatchObject({ pass: false, rule: 'failed: ours' })
    expect(calls.measure).toBe(0)
  })

  test('unclear counts as ours: fails, no retry', async () => {
    const { deps, calls } = script([verdict('unclear')])
    const j = await judgeSlowSample(first, 100, deps)
    expect(j).toMatchObject({ pass: false, rule: 'failed: unclear' })
    expect(calls.measure).toBe(0)
  })

  test('link: retried, and a retry under budget passes', async () => {
    const { deps, calls } = script([verdict('link')], [80])
    const j = await judgeSlowSample(first, 100, deps)
    expect(j).toMatchObject({ pass: true, rule: 'passed on retry' })
    expect(j.attempts.map((a) => [a.ms, a.verdict])).toEqual([
      [130, 'link'],
      [80, null],
    ])
    expect(calls.measure).toBe(1)
  })

  test('a spell on every attempt: judged on our share, under budget − 50 passes', async () => {
    const spell = verdict('convex/network', 45)
    const { deps, calls } = script([spell, spell, spell], [120, 125])
    const j = await judgeSlowSample(first, 100, deps)
    expect(j).toMatchObject({
      pass: true,
      rule: 'passed on our share',
      shareBudgetMs: 100 - SHARE_MARGIN_MS,
    })
    expect(j.attempts).toHaveLength(1 + RETRIES_PER_SAMPLE)
    expect(calls.measure).toBe(RETRIES_PER_SAMPLE)
  })

  test('our share at or over budget − 50 fails', async () => {
    const spell = verdict('convex/network', 50)
    const { deps } = script([spell, spell, spell], [120, 125])
    const j = await judgeSlowSample(first, 100, deps)
    expect(j).toMatchObject({ pass: false, rule: 'failed: our share over' })
  })

  test('no our share (re-runs unknown) fails', async () => {
    const spell = verdict('convex/network', null)
    const { deps } = script([spell, spell, spell], [120, 125])
    expect((await judgeSlowSample(first, 100, deps)).rule).toBe(
      'failed: our share over',
    )
  })

  test('our share is judged against the failing line − 50, per kind (human, 2026-10-23)', async () => {
    for (const [flow, shareBudgetMs] of [
      ['contact.save', 100],
      ['contacts.create', 150],
      ['contact.restore', 200],
    ] as const) {
      const line = budgetFor(flow).maxMs
      expect(line - SHARE_MARGIN_MS).toBe(shareBudgetMs)
      const over = line + 30
      const under = verdict('convex/network', shareBudgetMs - 1)
      const pass = script([under, under, under], [over, over])
      expect(
        await judgeSlowSample({ ms: over, detail: null }, line, pass.deps),
      ).toMatchObject({ pass: true, shareBudgetMs })
      const at = verdict('convex/network', shareBudgetMs)
      const fail = script([at, at, at], [over, over])
      expect(
        await judgeSlowSample({ ms: over, detail: null }, line, fail.deps),
      ).toMatchObject({ pass: false, rule: 'failed: our share over' })
    }
  })

  test('a retry that comes back ours fails', async () => {
    const { deps } = script([verdict('link'), verdict('ours')], [140])
    const j = await judgeSlowSample(first, 100, deps)
    expect(j).toMatchObject({ pass: false, rule: 'failed: ours' })
    expect(j.attempts.map((a) => a.verdict)).toEqual(['link', 'ours'])
  })

  test('logs behind: unclear, so ours, whatever the verdict was (review M2)', async () => {
    const calls = { measure: 0 }
    const j = await judgeSlowSample(first, 100, {
      blame: () =>
        Promise.resolve({ blame: verdict('link', 10), caughtUp: false }),
      measure: () => {
        calls.measure++
        return Promise.resolve({ ms: 80, detail: null })
      },
      takeRetry: () => true,
    })
    expect(j).toMatchObject({ pass: false, rule: 'failed: unclear' })
    expect(j.attempts[0]).toMatchObject({
      verdict: 'unclear',
      why: 'logs behind (was link)',
      caughtUp: false,
    })
    expect(calls.measure).toBe(0)
  })

  test('logs behind on the last attempt: never judged on its share', async () => {
    const spell = verdict('convex/network', 10)
    let n = 0
    const j = await judgeSlowSample(first, 100, {
      blame: () => Promise.resolve({ blame: spell, caughtUp: n++ < 2 }),
      measure: () => Promise.resolve({ ms: 120, detail: null }),
      takeRetry: () => true,
    })
    expect(j).toMatchObject({ pass: false, rule: 'failed: unclear' })
    expect(j.attempts).toHaveLength(3)
  })

  test('past the run cap: judged as today, and the rule says so', async () => {
    const { deps, calls } = script([verdict('link')], [], 0)
    const j = await judgeSlowSample(first, 100, deps)
    expect(j).toMatchObject({ pass: false, rule: 'failed: retry cap' })
    expect(calls.measure).toBe(0)
  })
})

describe('judgeSlowSample with real blame on recorded samples', () => {
  // Blames with the real rules over the fixture's recorded calls and
  // probes; a retry comes back at 90 ms.
  const real = (c: Fixture, ctx: BlameContext = c): JudgeDeps<BlameSample> => ({
    blame: (m) =>
      Promise.resolve({ blame: blame(m.detail, ctx), caughtUp: true }),
    measure: () => Promise.resolve({ ms: 90, detail: c.sample }),
    takeRetry: () => true,
  })

  test('a link stall is retried; the retry under budget passes', async () => {
    const c = cases.linkStall
    const j = await judgeSlowSample(
      { ms: c.sample.endMs, detail: c.sample },
      100,
      real(c),
    )
    expect(j.attempts[0].verdict).toBe('link')
    expect(j).toMatchObject({ pass: true, rule: 'passed on retry' })
  })

  test('a slow function is ours and fails', async () => {
    const c = cases.slowFunction
    const j = await judgeSlowSample(
      { ms: c.sample.endMs, detail: c.sample },
      100,
      real(c),
    )
    expect(j).toMatchObject({ pass: false, rule: 'failed: ours' })
  })

  test('without any blame data a slow sample fails exactly as before', async () => {
    // No calls, probes or link: unmatched, unclear, ours. No retry taken.
    for (const c of Object.values(cases)) {
      const s = { ...c.sample, linkMs: null }
      const j = await judgeSlowSample({ ms: s.endMs, detail: s }, 100, {
        ...real(c, { calls: [], probes: [] }),
        takeRetry: () => {
          throw new Error('no retry without evidence')
        },
      })
      expect(j.pass).toBe(false)
      expect(j.rule).toBe('failed: unclear')
    }
  })
})

test('the run cap: RETRY_CAP_PER_RUN retries, then none', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qc-retries-'))
  try {
    const got = Array.from({ length: RETRY_CAP_PER_RUN + 2 }, () =>
      takeRetry(dir),
    )
    expect(got.filter(Boolean)).toHaveLength(RETRY_CAP_PER_RUN)
    expect(got.slice(-2)).toEqual([false, false])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
