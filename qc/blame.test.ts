import { describe, expect, test } from 'vitest'
import {
  blame,
  countVerdicts,
  formatBlame,
  formatCounts,
  probeElevated,
} from './blame'
import type { BlameSample, Probe, ServerCall } from './blame'
import recorded from './blame.fixture.json'

const r1 = (x: number) => Math.round(x * 10) / 10

// Recorded slow samples (qc-results of runs tn9ttz4a, tn9g1x25 and
// tn9vwfeq), each with every Convex call on the pool within 600 ms of it
// and every RTT probe of its worker in that run. The first four predate
// `fns`, so their fixtures add the function the flow calls (the one call
// of it in the window); tn9vwfeq recorded its own.
interface Case {
  run: string
  flow: string
  budgetMs: number
  sample: BlameSample
  calls: Array<ServerCall>
  probes: Array<Probe>
}
const cases = recorded as unknown as Record<
  'normal' | 'slowFunction' | 'linkStall' | 'slowSpell' | 'stallElsewhere',
  Case
>
const run = (c: Case, s: Partial<BlameSample> = {}) =>
  blame({ ...c.sample, ...s }, { calls: c.calls, probes: c.probes })

const legsSum = (b: ReturnType<typeof blame>) =>
  b.pageMs! + b.toConvexMs! + b.fnMs! + b.backMs! + b.transitionMs!

describe('blame on recorded samples', () => {
  test('function and page normal, no evidence elsewhere: unclear, which counts as ours', () => {
    const c = cases.normal
    const b = run(c)
    expect(b).toMatchObject({
      verdict: 'unclear',
      fnMs: 30.3,
      fnMatch: 'contacts/mutations:setAcquisition',
      pageMs: 17.6,
      toConvexMs: 21,
      backMs: 46.1,
      transitionMs: 12.7,
      approx: true,
      probeMs: [30.4],
    })
    // The legs partition the sample.
    expect(legsSum(b)).toBeCloseTo(c.sample.endMs, 5)
    expect(formatBlame(c.sample.endMs, b)).toBe(
      '128 = page 18 · to Convex ≈21 · our function 30 (contacts/mutations:setAcquisition) · back ≈46 · Transition 13 · overhead beyond the probe 49 · probe 30 ms @ that moment (run median 33) · link 1 ms → unclear (function 30.3 ms and page 17.6 ms normal, no evidence elsewhere)',
    )
  })

  test('a slow function is ours', () => {
    const c = cases.slowFunction
    const b = run(c)
    expect(b.verdict).toBe('ours')
    expect(b.fnMs).toBe(50.5)
    expect(b.why).toMatch(/function 50.5 ms/)
    // Nothing else on the pool was slow then.
    expect(b.slowElsewhere).toEqual([])
    expect(legsSum(b)).toBeCloseTo(c.sample.endMs, 5)
  })

  test('a first-hop stall is the link, whatever else was slow', () => {
    const c = cases.linkStall
    expect(c.sample.linkMs).toBe(192)
    const b = run(c)
    expect(b.verdict).toBe('link')
    // Still split: the stall sits before the commit.
    expect(b.fnMs).toBe(14.7)
    expect(b.toConvexMs).toBeGreaterThan(150)
  })

  test('a Convex-wide slow spell: the probe was elevated, convex/network', () => {
    const c = cases.slowSpell
    const b = run(c)
    expect(b.verdict).toBe('convex/network')
    expect(b.probeMs).toContain(83.7)
    expect(b.why).toMatch(/^probe 83.7 ms/)
    // The first hop was slowish (43.7 ms), under the stall line.
    expect(b.linkMs).toBeLessThan(50)
  })

  test('a stall the probe missed: Convex slow on the other instances too, convex/network', () => {
    const c = cases.stallElsewhere
    const b = run(c)
    expect(c.sample.fns).toEqual(['contacts/mutations:saveIdentifierType'])
    expect(b.fnMs).toBe(141.9)
    expect(b.probeMs).toEqual([40.2])
    expect(b.slowElsewhere).toEqual(['qc-2', 'qc-3'])
    expect(b.verdict).toBe('convex/network')
    expect(b.why).toBe('Convex slow on qc-2, qc-3 at that moment too')
  })

  test('seeds, bulk functions and auth are slow by design: no spell', () => {
    const c = cases.slowFunction
    const at = c.sample.at + 50
    const calls: Array<ServerCall> = [
      ...c.calls,
      {
        instance: 'qc-2',
        at,
        fn: 'platform/qcSeed:fixture',
        type: 'Mutation',
        ms: 990,
      },
      {
        instance: 'qc-3',
        at,
        fn: 'contacts/mutations:bulkTag',
        type: 'Mutation',
        ms: 250,
      },
      {
        instance: 'qc-3',
        at,
        fn: 'contacts/queries:list',
        type: 'Query',
        ms: 0,
        cached: true,
      },
      { instance: 'qc-3', at, fn: 'auth:store', type: 'Mutation', ms: 185 },
    ]
    const b = blame(c.sample, { calls, probes: c.probes })
    expect(b.slowElsewhere).toEqual([])
    expect(b.verdict).toBe('ours')
    // One other instance slow is not yet a spell.
    calls.push({
      instance: 'qc-2',
      at,
      fn: 'contacts/queries:list',
      type: 'Query',
      ms: 120,
    })
    expect(blame(c.sample, { calls, probes: c.probes }).verdict).toBe('ours')
    // Two instances, one function: a regression of that function, no spell.
    calls.push({
      instance: 'qc-3',
      at,
      fn: 'contacts/queries:list',
      type: 'Query',
      ms: 120,
    })
    expect(blame(c.sample, { calls, probes: c.probes }).verdict).toBe('ours')
    calls.push({
      instance: 'qc-3',
      at,
      fn: 'contacts/queries:byClientKey',
      type: 'Query',
      ms: 120,
    })
    expect(blame(c.sample, { calls, probes: c.probes }).verdict).toBe(
      'convex/network',
    )
  })

  test('our own function slow on every instance is ours, not a spell (review M1)', () => {
    const c = cases.slowFunction
    // A regressed saveForm: 150 ms on qc-1 (this sample) and on qc-2 and
    // qc-3, plus an unrelated slow query on qc-2.
    const calls: Array<ServerCall> = [
      ...c.calls.map((x) =>
        x.fn === 'contacts/mutations:saveForm' && x.instance === 'qc-1'
          ? { ...x, ms: 150 }
          : x,
      ),
      ...['qc-2', 'qc-3'].map((instance) => ({
        instance,
        at: c.sample.at + 80,
        fn: 'contacts/mutations:saveForm',
        type: 'Mutation',
        ms: 150,
      })),
    ]
    const b = blame(c.sample, { calls, probes: c.probes })
    expect(b.fnMs).toBe(150)
    expect(b.slowElsewhere).toEqual([])
    expect(b.verdict).toBe('ours')
    expect(b.why).toBe('function 150 ms (≥ 50)')
  })

  test('the elevated probe wins over a slow function at that moment', () => {
    const c = cases.slowSpell
    const calls = c.calls.map((x) =>
      x.fn === 'sources/mutations:create' ? { ...x, ms: 90 } : x,
    )
    const b = blame(c.sample, { calls, probes: c.probes })
    expect(b.fnMs).toBe(90)
    expect(b.verdict).toBe('convex/network')
  })
})

describe('matching the function', () => {
  test('two candidate calls (two workers on one instance) is unmatched, unclear', () => {
    const c = cases.normal
    // The setAcquisition call this sample made.
    const mine = c.calls.find((x) => x.at === 1792608853027)!
    const calls = [...c.calls, { ...mine, at: mine.at + 5, ms: 12 }]
    const b = blame(c.sample, { calls, probes: c.probes })
    expect(b.fnMs).toBeNull()
    expect(b.fnMatch).toBe(
      'unmatched: 2 contacts/mutations:setAcquisition calls in the window',
    )
    expect(b.verdict).toBe('unclear')
  })

  test('a mutation matches on the server clock: skew moves the commit and the call together (review L1)', () => {
    // The server clock 40 ms ahead of the page's: the commit timestamp
    // and every log time shift; the page's own legs don't.
    const c = cases.normal
    const skew = 40
    const calls = c.calls.map((x) => ({ ...x, at: x.at + skew }))
    const b = blame(
      { ...c.sample, commitMs: c.sample.commitMs! + skew },
      { calls, probes: c.probes },
    )
    expect(b.fnMs).toBe(30.3)
    expect(b.fnMatch).toBe('contacts/mutations:setAcquisition')
  })

  test('history from before `fns` is unmatched, never guessed', () => {
    const b = run(cases.normal, { fns: undefined })
    expect(b.fnMatch).toBe('unmatched: sample has no function name')
    expect(b.verdict).toBe('unclear')
  })

  test('a call outside the window is not matched', () => {
    const c = cases.normal
    const calls = c.calls.map((x) =>
      x.fn === 'contacts/mutations:setAcquisition'
        ? { ...x, at: x.at + 500 }
        : x,
    )
    const b = blame(c.sample, { calls, probes: c.probes })
    expect(b.fnMatch).toMatch(/^unmatched: 0 /)
  })

  test('a call on another instance is not matched', () => {
    const b = run(cases.normal, { instance: 'qc-9' })
    expect(b.fnMatch).toMatch(/^unmatched: 0 /)
  })

  test('a query change takes the slowest of the queries it adds', () => {
    const s: BlameSample = {
      worker: 0,
      instance: 'qc-1',
      at: 10_000,
      sendMs: 2,
      sent: 'ModifyQuerySet',
      fns: ['a:list', 'a:count'],
      commitMs: null,
      responseMs: null,
      transitionMs: 95,
      lastInMs: 96,
      endMs: 105,
      longTaskMs: 0,
      connects: 0,
      hidden: false,
      hostCpu: null,
      load1: 1,
      linkMs: 2,
    }
    const calls: Array<ServerCall> = [
      { instance: 'qc-1', at: 10_060, fn: 'a:list', type: 'Query', ms: 62 },
      { instance: 'qc-1', at: 10_040, fn: 'a:count', type: 'Query', ms: 8 },
    ]
    const b = blame(s, { calls, probes: [] })
    expect(b).toMatchObject({
      fnMs: 62,
      convexNetworkMs: 31,
      toConvexMs: null,
      pageMs: 12,
      verdict: 'ours',
    })
  })
})

describe('our share: page + function + the re-runs the sample waited for', () => {
  // The recorded setAcquisition save: commit at +53, Transition at +111.8.
  // On its instance getRoot re-ran in between (9.9 ms); history completed
  // after the Transition; the rest of the window is other instances.
  const c = cases.normal
  const subs = [
    'contacts/queries:getRoot',
    'contacts/queries:history',
    'contacts/queries:getIdentifiers',
    'sources/queries:picker',
  ]

  test("the page's re-run queries are attributed and the slowest counts", () => {
    const b = run(c, { subs })
    expect(b.reruns).toEqual([{ fn: 'contacts/queries:getRoot', ms: 9.9 }])
    expect(b.rerunCriticalMs).toBe(9.9)
    expect(b.ourShareMs).toBe(57.8) // 17.6 page + 30.3 mutation + 9.9
  })

  test("a query the page isn't subscribed to is not ours to wait for", () => {
    const b = run(c, { subs: ['contacts/queries:history'] })
    expect(b.reruns).toEqual([])
    expect(b.ourShareMs).toBe(47.9)
  })

  test('no subscriptions recorded: no re-runs and no share, never understated', () => {
    const b = run(c)
    expect(b.reruns).toBeNull()
    expect(b.ourShareMs).toBeNull()
  })

  test('critical path: the slowest of each overlapping group, groups summed', () => {
    const commit = c.sample.at + c.sample.commitMs!
    const q = (fn: string, start: number, ms: number): ServerCall => ({
      instance: 'qc-2',
      at: commit + start + ms,
      fn,
      type: 'Query',
      ms,
    })
    const calls = [
      ...c.calls.filter((x) => x.type !== 'Query'),
      q('a:one', 5, 12), // [5, 17]
      q('a:two', 8, 10), // [8, 18], overlaps one
      q('a:three', 30, 6), // [30, 36]
      q('a:early', -40, 30), // started before the commit: not a re-run
      q('a:other', 5, 20), // not subscribed
    ]
    const b = blame(
      { ...c.sample, subs: ['a:one', 'a:two', 'a:three', 'a:early'] },
      { calls, probes: c.probes },
    )
    expect(b.reruns!.map((r) => r.fn)).toEqual(['a:one', 'a:two', 'a:three'])
    // one and two overlap (12 and 10 → 12); three runs after them (6).
    expect(b.rerunCriticalMs).toBe(18)
    expect(b.rerunMaxMs).toBe(12)
    expect(b.rerunUnionMs).toBe(19) // 13 + 6
    expect(b.rerunSumMs).toBe(28)
    expect(b.ourShareMs).toBe(r1(17.6 + 30.3 + 18))
  })

  test('the mutation itself is never a re-run', () => {
    const b = run(c, { subs: [...subs, 'contacts/mutations:setAcquisition'] })
    expect(b.reruns!.map((r) => r.fn)).not.toContain(
      'contacts/mutations:setAcquisition',
    )
  })
})

describe('verdict rules', () => {
  test('a slow page is ours, even with the probe elevated', () => {
    const c = cases.slowSpell
    // The result reached the screen 60 ms after its Transition.
    const b = run(c, { endMs: c.sample.transitionMs! + 60 })
    expect(b.pageMs).toBeGreaterThanOrEqual(40)
    expect(b.verdict).toBe('ours')
  })

  test('no legs (QC_LEGS=0, or nothing sent) is unclear', () => {
    const b = run(cases.normal, {
      sendMs: null,
      sent: null,
      commitMs: null,
      responseMs: null,
      transitionMs: null,
      lastInMs: null,
    })
    expect(b.verdict).toBe('unclear')
    expect(b.why).toBe('no legs (nothing sent)')
  })

  test('a probe is elevated at 1.5× and 20 ms over the median', () => {
    expect(probeElevated(50, 30)).toBe(true)
    expect(probeElevated(49, 30)).toBe(false)
    // 1.5× of a 10 ms median is only 5 ms over: not enough.
    expect(probeElevated(15, 10)).toBe(false)
  })
})

test('counts by verdict', () => {
  const c = countVerdicts([
    { verdict: 'ours' },
    { verdict: 'link' },
    { verdict: 'ours' },
  ])
  expect(formatCounts(c)).toBe('ours 2, link 1')
  expect(formatCounts({})).toBe('none')
})
