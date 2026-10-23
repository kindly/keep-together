// @vitest-environment node
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  FullConfig,
  FullResult,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import QcReporter, { serverExceptionBanner, summarise } from './reporter'
import type { HistoryLine } from './reporter'
import { readBlameContext } from './blame'
import type { BlameContext } from './blame'
import { readRoutes } from './coverage'
import type { FlowRecord, SampleDetail } from './timing'
import recorded from './blame.fixture.json'

// Blame explains; it must never judge (qc/README.md "Blame"). These run
// the reporter on the same records with and without the run's server
// calls and probes, and with torn files, and check that nothing a run is
// judged on changes.

type Fixture = {
  sample: SampleDetail & { worker: number; instance: string }
  calls: BlameContext['calls']
  probes: BlameContext['probes']
}
const cases = recorded as unknown as Record<string, Fixture>
const slow = cases.slowFunction
const ctx: BlameContext = {
  calls: Object.values(cases).flatMap((c) => c.calls),
  probes: Object.values(cases).flatMap((c) => c.probes),
}

const detail = (endMs: number): SampleDetail => {
  const { worker: _w, instance: _i, ...d } = slow.sample
  return { ...d, endMs }
}

// contact.addEmail failed twice (a slow first set, re-measured over
// budget again); contact.save passed.
const records = (runId: string): Array<FlowRecord> => [
  {
    runId,
    flow: 'contact.addEmail',
    worker: 0,
    instance: 'qc-1',
    where: 'contact › add email',
    kind: 'repeatable',
    samplesMs: [159.9, 95],
    firstSamplesMs: [165, 90],
    detail: [detail(159.9), detail(95)],
    firstDetail: [detail(165), detail(90)],
    rttMs: 30,
    rttOver: false,
    budgetMs: 100,
    medianMs: 127.45,
    maxMs: 159.9,
    pass: false,
  },
  {
    runId,
    flow: 'contact.save',
    worker: 0,
    instance: 'qc-1',
    where: 'worker setup',
    kind: 'repeatable',
    samplesMs: [80, 82],
    detail: [detail(80), detail(82)],
    rttMs: 30,
    rttOver: false,
    budgetMs: 100,
    medianMs: 81,
    maxMs: 82,
    pass: true,
  },
]

const base = {
  runId: 'r1',
  at: '2026-10-21T00:00:00.000Z',
  sha: 'abc',
  dirty: false,
  mode: 'assert' as const,
  server: null,
}

const stripBlame = (lines: Array<HistoryLine>) =>
  lines.map((l) => ({
    ...l,
    detail: l.detail?.map(({ blame: _, ...d }) => d),
    firstDetail: l.firstDetail?.map(({ blame: _, ...d }) => d),
  }))

describe('summarise: blame changes no judgement', () => {
  test('the same lines with and without blame context, blame aside', () => {
    const withBlame = summarise(records('r1'), base, null, ctx)
    const without = summarise(records('r1'), base, null, {
      calls: [],
      probes: [],
    })
    expect(stripBlame(withBlame)).toEqual(stripBlame(without))
    expect(withBlame.map((l) => [l.flow, l.pass, l.overBudget])).toEqual([
      ['contact.addEmail', false, 1],
      ['contact.save', true, 0],
    ])
  })

  test('blame goes on samples at or over budget only, in both sets', () => {
    const [email, save] = summarise(records('r1'), base, null, ctx)
    expect(email.detail!.map((d) => d.blame?.verdict)).toEqual([
      'ours',
      undefined,
    ])
    expect(email.firstDetail!.map((d) => d.blame?.verdict)).toEqual([
      'ours',
      undefined,
    ])
    expect(save.detail!.every((d) => d.blame === undefined)).toBe(true)
    // Without calls the function is unmatched: unclear, still attached.
    const [bare] = summarise(records('r1'), base, null, {
      calls: [],
      probes: [],
    })
    expect(bare.detail![0].blame?.verdict).toBe('unclear')
  })
})

describe('summarise: judgements and signals (qc/judge.ts)', () => {
  test("counts each flow's judged samples by rule and keeps the signals", () => {
    const recs = records('r1')
    const email = recs[0]
    email.pass = true
    email.detail[0] = {
      ...email.detail[0],
      bytesIn: 2000,
      requests: 2,
      judge: {
        pass: true,
        rule: 'passed on our share',
        shareBudgetMs: 50,
        attempts: [
          { ms: 159.9, verdict: 'convex/network', ourShareMs: 44 },
          { ms: 130, verdict: 'convex/network', ourShareMs: 45 },
          { ms: 128, verdict: 'convex/network', ourShareMs: 41 },
        ],
      },
    }
    email.detail[1] = { ...email.detail[1], bytesIn: 3000, requests: 4 }
    const [line] = summarise(recs, base, null, ctx)
    expect(line.pass).toBe(true)
    expect(line.judged).toEqual({ 'passed on our share': 1 })
    expect(line.signals).toMatchObject({ bytesInP50: 2500, requestsP50: 3 })
    expect(line.signals!.commitLatencyP50).toEqual(expect.any(Number))
  })

  test('no signals on history from before them', () => {
    const [line] = summarise(records('r1'), base, null, ctx)
    expect(line.signals).toBeUndefined()
    expect(line.judged).toBeUndefined()
  })
})

describe('readBlameContext', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qc-blame-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a torn line is skipped and counted, the rest read', () => {
    const [a, b] = slow.calls
    writeFileSync(
      path.join(dir, 'server-calls.jsonl'),
      `${JSON.stringify(a)}\n${JSON.stringify(b)}\n{"instance":"qc-1","at":17`,
    )
    writeFileSync(
      path.join(dir, 'rtt-1.jsonl'),
      `${JSON.stringify(slow.probes[0])}\n{"at":`,
    )
    const got = readBlameContext(dir)
    expect(got.calls).toEqual([a, b])
    expect(got.probes).toEqual([slow.probes[0]])
    expect(got.skipped).toBe(2)
  })

  test('an unreadable file is skipped and counted', () => {
    mkdirSync(path.join(dir, 'rtt-2.jsonl'))
    expect(readBlameContext(dir)).toEqual({ calls: [], probes: [], skipped: 1 })
  })

  test('no run directory: empty', () => {
    expect(readBlameContext(path.join(dir, 'nope'))).toEqual({
      calls: [],
      probes: [],
      skipped: 0,
    })
  })
})

describe('onEnd: the same status and gates with and without blame input', () => {
  const routes = readRoutes()
  const repo = process.cwd()
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qc-reporter-'))
    mkdirSync(path.join(dir, 'src'))
    copyFileSync(
      path.join(repo, 'src/routeTree.gen.ts'),
      path.join(dir, 'src/routeTree.gen.ts'),
    )
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(repo)
    rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // One run of the reporter over `recs`: every route covered, a filtered
  // run (so untimed flows only warn). Returns the status and the gates.
  const runReporter = async (
    id: string,
    recs: Array<FlowRecord>,
    blameFiles: 'none' | 'good' | 'torn',
  ) => {
    vi.stubEnv('QC_RUN_ID', id)
    const run = path.join(dir, 'qc-results', 'runs', id)
    mkdirSync(run, { recursive: true })
    writeFileSync(
      path.join(run, 'pid-1.jsonl'),
      recs.map((r) => JSON.stringify(r) + '\n').join(''),
    )
    if (blameFiles !== 'none') {
      const calls = ctx.calls.map((c) => JSON.stringify(c)).join('\n')
      const probes = ctx.probes.map((p) => JSON.stringify(p)).join('\n')
      const tear = blameFiles === 'torn' ? '\n{"at":1792' : ''
      writeFileSync(path.join(run, 'server-calls.jsonl'), calls + tear)
      writeFileSync(path.join(run, 'rtt-1.jsonl'), probes + tear)
    }
    const logged: Array<string> = []
    vi.spyOn(console, 'log').mockImplementation((m: string) => {
      logged.push(m)
    })
    const reporter = new QcReporter()
    reporter.onBegin({
      argv: ['node', 'playwright', 'test', 'qc/flows/contact.spec.ts'],
    } as unknown as FullConfig)
    reporter.onTestEnd(
      {
        annotations: routes.map((r) => ({ type: 'route', description: r })),
      } as unknown as TestCase,
      { status: 'passed', annotations: [] } as unknown as TestResult,
    )
    const res = await reporter.onEnd({ status: 'passed' } as FullResult)
    vi.restoreAllMocks()
    const out = logged.join('\n')
    const gates = out
      .split('\n')
      .filter((l) => /QC RUN FAILED|over budget twice|coverage:/.test(l))
    const history = readFileSync(
      path.join(dir, 'qc-results', 'history.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryLine)
      .filter((l) => l.runId === id)
    return { status: res?.status, gates, history, out }
  }

  test('a passing run passes whatever the blame input', async () => {
    const results = []
    for (const [id, files] of [
      ['ra', 'none'],
      ['rb', 'good'],
      ['rc', 'torn'],
    ] as const) {
      results.push(await runReporter(id, records(id), files))
    }
    for (const r of results) {
      expect(r.status).toBeUndefined()
      expect(r.gates).toEqual([])
      expect(r.history.map((l) => [l.flow, l.pass])).toEqual([
        ['contact.addEmail', false],
        ['contact.save', true],
      ])
    }
    expect(results[1].out).toMatch(/blame: 2 samples at or over budget: ours 2/)
    expect(results[0].out).toMatch(/unclear 2/)
    expect(results[2].out).toMatch(/blame: 2 unreadable lines/)
  })

  test('a failing worker-setup flow fails the run whatever the blame input', async () => {
    const failing = (id: string) =>
      records(id).map((r) =>
        r.flow === 'contact.save'
          ? {
              ...r,
              samplesMs: [130, 82],
              firstSamplesMs: [140, 90],
              detail: [detail(130), detail(82)],
              firstDetail: [detail(140), detail(90)],
              pass: false,
            }
          : r,
      )
    const a = await runReporter('rd', failing('rd'), 'none')
    const b = await runReporter('re', failing('re'), 'good')
    const c = await runReporter('rf', failing('rf'), 'torn')
    for (const r of [a, b, c]) expect(r.status).toBe('failed')
    expect(b.gates).toEqual(a.gates)
    expect(c.gates).toEqual(a.gates)
    expect(a.gates.join('\n')).toMatch(
      /contact.save over budget twice in worker 0 setup/,
    )
  })
})

test('the server exceptions banner lists every exception, with or without server data', () => {
  const none = serverExceptionBanner(null).join('\n')
  // Exceptions counted as exceptions; no server data, no call count.
  expect(none).toContain(
    '1 server exception (approved, qc/budgets.ts SERVER_EXCEPTIONS): timed, held only to their ceilings.',
  )
  expect(none).toContain(
    'contacts/queries:list: EXCEPTED from the 100 ms rule: list re-run after a bulk write into an open page: ~150 ms reading the grown range (human 2026-10-23) · ceiling < 250 ms · no server data',
  )
  const some = serverExceptionBanner({
    exceptions: [
      'contacts/queries:list: EXCEPTED from the 100 ms rule: … · 4 calls',
    ],
    exceptedCalls: 4,
  }).join('\n')
  expect(some).toContain(
    '1 server exception (approved, qc/budgets.ts SERVER_EXCEPTIONS), 4 calls EXCEPTED this run',
  )
  expect(some).toContain('· 4 calls')
  expect(
    serverExceptionBanner({ exceptions: [], exceptedCalls: 1 }).join('\n'),
  ).toContain(', 1 call EXCEPTED this run')
})
