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
import QcReporter, { pendingBanner, summarise } from './reporter'
import type { HistoryLine } from './reporter'
import { readRoutes } from './coverage'
import { isPorted } from '../src/lib/data/ported'
import type { ApiCall, FlowRecord, SampleDetail } from './timing'

// The reporter's gates over the workers' records: the flow table and
// history, the server rule over each sample's Server-Timing (qc/server.ts),
// and what isn't on the Rust backend yet (pendingPort).

const ID = '0190f1d23c4b7a008000000000000001'

const call = (serverMs: number): ApiCall => ({
  method: 'POST',
  url: `/api/t/r1w0-a/contacts/${ID}/save`,
  startMs: 2,
  endMs: 40,
  status: 200,
  serverMs,
  dbMs: serverMs / 2,
})

const detail = (endMs: number, serverMs = 5): SampleDetail => ({
  at: 1_792_000_000_000,
  calls: [call(serverMs)],
  eventMs: null,
  endMs,
  answered: true,
  longTaskMs: 0,
  hidden: false,
  hostCpu: null,
  load1: 0.5,
})

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
    budgetMs: 150,
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
    budgetMs: 150,
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
  env: 'local' as const,
  server: null,
}

describe('summarise', () => {
  test('one line per flow, both sets of a re-measure kept with their calls', () => {
    const lines = summarise(records('r1'), base, null)
    expect(lines.map((l) => [l.flow, l.pass, l.n, l.overBudget])).toEqual([
      ['contact.addEmail', false, 2, 1],
      ['contact.save', true, 2, 0],
    ])
    const [add] = lines
    expect(add.remeasured).toBe(true)
    expect(add.firstSamplesMs).toEqual([165, 90])
    expect(add.detail?.[0]).toMatchObject({
      worker: 0,
      instance: 'qc-1',
      calls: [{ method: 'POST', serverMs: 5 }],
    })
    expect(add.firstDetail).toHaveLength(2)
    expect(add.env).toBe('local')
  })
})

describe('pendingBanner', () => {
  test('lists each step with its skipped tests, flows and the unported routes', () => {
    const out = pendingBanner(new Map([['B2', 3]]), [
      '/t/$slug/contacts/',
      '/t/$slug/gifts/new',
    ]).join('\n')
    expect(out).toMatch(/B2: 3 tests skipped · flows .*gift\.record/)
    expect(out).toContain(
      'routes being ported (exempt from coverage): /t/$slug/gifts/new',
    )
    expect(out).not.toContain('/t/$slug/contacts/,')
  })
})

describe('onEnd: the server rule, pending ports and coverage', () => {
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

  // One run of the reporter over `recs`, as a full run (not filtered)
  // unless `filtered`; `covered` are the route annotations of the tests
  // that ran, and `skipped` the pendingPort tests skipped.
  const runReporter = async (
    id: string,
    recs: Array<FlowRecord>,
    opts: {
      covered?: Array<string>
      skipped?: Array<string>
      filtered?: boolean
    } = {},
  ) => {
    vi.stubEnv('QC_RUN_ID', id)
    const run = path.join(dir, 'qc-results', 'runs', id)
    mkdirSync(run, { recursive: true })
    writeFileSync(
      path.join(run, 'pid-1.jsonl'),
      recs.map((r) => JSON.stringify(r) + '\n').join(''),
    )
    const logged: Array<string> = []
    vi.spyOn(console, 'log').mockImplementation((m: string) => {
      logged.push(m)
    })
    const reporter = new QcReporter()
    reporter.onBegin({
      argv: [
        'node',
        'playwright',
        'test',
        ...((opts.filtered ?? true) ? ['qc/flows/contact.spec.ts'] : []),
      ],
    } as unknown as FullConfig)
    reporter.onTestEnd(
      {
        annotations: (opts.covered ?? routes).map((r) => ({
          type: 'route',
          description: r,
        })),
      } as unknown as TestCase,
      { status: 'passed', annotations: [] } as unknown as TestResult,
    )
    for (const step of opts.skipped ?? [])
      reporter.onTestEnd(
        {
          annotations: [{ type: 'pendingPort', description: step }],
        } as unknown as TestCase,
        { status: 'skipped', annotations: [] } as unknown as TestResult,
      )
    const res = await reporter.onEnd({ status: 'passed' } as FullResult)
    vi.restoreAllMocks()
    const out = logged.join('\n')
    const gates = out
      .split('\n')
      .filter((l) =>
        /QC RUN FAILED|over budget twice|coverage:|^!! server/.test(l),
      )
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

  const withServer = (id: string, ms: Array<number>) =>
    records(id).map((r) =>
      r.flow === 'contact.save'
        ? { ...r, detail: ms.map((x) => detail(80, x)) }
        : r,
    )

  test('every call under 100 ms: a table per route, in history too', async () => {
    const r = await runReporter('s1', withServer('s1', [12, 30]))
    expect(r.status).toBeUndefined()
    expect(r.gates).toEqual([])
    expect(r.out).toMatch(/POST \/t\/:slug\/contacts\/:id\/save\s+6\s/)
    expect(r.history[0].server).toMatchObject({
      pass: true,
      functions: [
        { fn: 'POST /t/:slug/contacts/:id/save', type: 'route', n: 6 },
      ],
    })
  })

  test('one slow call is a spike; two fail the run', async () => {
    const spike = await runReporter('s2', withServer('s2', [140, 30]))
    expect(spike.status).toBeUndefined()
    expect(spike.out).toMatch(/SPIKES[\s\S]*server POST \/t\/:slug/)
    const two = await runReporter('s3', withServer('s3', [140, 120]))
    expect(two.status).toBe('failed')
    expect(two.gates.join('\n')).toMatch(
      /server POST \/t\/:slug\/contacts\/:id\/save: 2 of 6 calls at or over 100 ms/,
    )
  })

  test('record mode lists a server miss, never fails on it', async () => {
    vi.stubEnv('QC_MODE', 'record')
    vi.resetModules()
    const { default: Recording } = await import('./reporter')
    expect(Recording).toBeDefined()
    // RECORD is read at import: the module above is a fresh one.
    vi.stubEnv('QC_RUN_ID', 's4')
    const run = path.join(dir, 'qc-results', 'runs', 's4')
    mkdirSync(run, { recursive: true })
    writeFileSync(
      path.join(run, 'pid-1.jsonl'),
      withServer('s4', [140, 120])
        .map((r) => JSON.stringify({ ...r, pass: null }) + '\n')
        .join(''),
    )
    const logged: Array<string> = []
    vi.spyOn(console, 'log').mockImplementation((m: string) => {
      logged.push(m)
    })
    const reporter = new Recording()
    reporter.onBegin({
      argv: ['node', 'playwright', 'test', 'qc/flows/contact.spec.ts'],
    } as unknown as FullConfig)
    const res = await reporter.onEnd({ status: 'passed' } as FullResult)
    expect(res?.status).toBeUndefined()
    expect(logged.join('\n')).toMatch(/not judged: server POST/)
  })

  test('pendingPort tests are counted, and unported routes need no flow', async () => {
    const ported = routes.filter((r) => isPorted(r))
    const r = await runReporter('p1', records('p1'), {
      covered: ported,
      skipped: ['B2', 'B2', 'A9'],
      filtered: false,
    })
    expect(r.gates.filter((g) => g.includes('coverage:'))).toEqual([])
    expect(r.out).toMatch(/B2: 2 tests skipped/)
    expect(r.out).toMatch(/A9: 1 tests skipped/)
    // A ported route left uncovered still fails a full run.
    const gap = await runReporter('p2', records('p2'), {
      covered: ported.filter((x) => x !== '/t/$slug/contacts/new'),
      filtered: false,
    })
    expect(gap.status).toBe('failed')
    expect(gap.gates.join('\n')).toMatch(
      /coverage: no test that ran covers \/t\/\$slug\/contacts\/new/,
    )
    // pendingPort flows aren't "not timed" failures; others are.
    expect(gap.out).not.toMatch(/not timed: [^\n]*gift\.record/)
    expect(gap.out).toMatch(/not timed: [^\n]*contacts\.search\.phone/)
  })
})

describe('onEnd: two-tier budgets, the line alone decides (human, 2026-10-23)', () => {
  const routes = readRoutes()
  const repo = process.cwd()
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qc-target-'))
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

  // contact.save timed in worker setup, so the reporter itself judges it:
  // line 150, target 100 unless `targetMs` is null.
  const save = (
    runId: string,
    samplesMs: Array<number>,
    pass: boolean,
    targetMs: number | null = 100,
  ): FlowRecord => ({
    runId,
    flow: 'contact.save',
    worker: 0,
    instance: 'qc-1',
    where: 'worker setup',
    kind: 'repeatable',
    samplesMs,
    detail: samplesMs.map(detail),
    ...(!pass && {
      firstSamplesMs: samplesMs.map((x) => x + 5),
      firstDetail: samplesMs.map((x) => detail(x + 5)),
    }),
    rttMs: 30,
    rttOver: false,
    budgetMs: 150,
    ...(targetMs !== null && { targetMs }),
    medianMs: samplesMs[0],
    maxMs: Math.max(...samplesMs),
    pass,
  })

  const seedHistory = (p50s: Array<number>) => {
    mkdirSync(path.join(dir, 'qc-results'), { recursive: true })
    writeFileSync(
      path.join(dir, 'qc-results', 'history.jsonl'),
      p50s
        .map(
          (p50Ms, i) =>
            JSON.stringify({
              runId: `old${i}`,
              at: `2026-10-2${i}T00:00:00.000Z`,
              flow: 'contact.save',
              kind: 'repeatable',
              p50Ms,
              rttOver: false,
              // From before targets: no targetMs, no target.
              budgetMs: 100,
            }) + '\n',
        )
        .join(''),
    )
  }

  const run = async (id: string, recs: Array<FlowRecord>) => {
    vi.stubEnv('QC_RUN_ID', id)
    const runPath = path.join(dir, 'qc-results', 'runs', id)
    mkdirSync(runPath, { recursive: true })
    writeFileSync(
      path.join(runPath, 'pid-1.jsonl'),
      recs.map((r) => JSON.stringify(r) + '\n').join(''),
    )
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
    const history = readFileSync(
      path.join(dir, 'qc-results', 'history.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryLine)
      .filter((l) => l.runId === id)
    return {
      status: res?.status,
      gates: out
        .split('\n')
        .filter((l) => /QC RUN FAILED|over budget twice|coverage:/.test(l)),
      history,
      out,
    }
  }

  test('over target and drifting up: flagged, never failing; history records target and line', async () => {
    seedHistory([60, 61, 62, 60, 61])
    const r = await run('t1', [save('t1', [125, 120, 130], true)])
    expect(r.status).toBeUndefined()
    expect(r.gates).toEqual([])
    expect(r.out).toContain('1 flow over TARGET or drifting up')
    expect(r.out).toContain(
      'contact.save: TARGET: median 125 ≥ target 100; median 125 up 64 on 61 (last 5 runs) · target < 100, line < 150, max 130',
    )
    expect(r.out).toMatch(/contact\.save .*<100\s+<150 .* ok · TARGET/)
    expect(r.history).toHaveLength(1)
    expect(r.history[0]).toMatchObject({
      flow: 'contact.save',
      budgetMs: 150,
      targetMs: 100,
      pass: true,
      target: { overTarget: true, baselineMs: 61, riseMs: 64, flagged: true },
    })
  })

  test('under target, no history: no drift flag, a one-line all-clear', async () => {
    const r = await run('t2', [save('t2', [80, 85, 82], true)])
    expect(r.status).toBeUndefined()
    expect(r.out).toContain(
      'target: all 1 flows with a target are under it, none up 16 ms or more on their last 5 runs',
    )
    expect(r.history[0].target).toEqual({
      overTarget: false,
      baselineMs: null,
      riseMs: null,
      flagged: false,
    })
  })

  test('the same samples with or without a target and its flag: the same status and gates', async () => {
    seedHistory([60, 60, 60, 60, 60])
    // Under the line but over target and drifting: passes either way.
    const a = await run('t3', [save('t3', [140, 149, 145], true)])
    const b = await run('t4', [save('t4', [140, 149, 145], true, null)])
    expect(a.out).toContain('TARGET: median 145')
    expect(b.out).not.toContain('TARGET')
    expect(b.history[0].targetMs).toBeUndefined()
    expect([a.status, b.status]).toEqual([undefined, undefined])
    expect(a.gates).toEqual([])
    expect(b.gates).toEqual([])
    // At the line twice: fails either way, with the same gates.
    const c = await run('t5', [save('t5', [150, 90, 95], false)])
    const d = await run('t6', [save('t6', [150, 90, 95], false, null)])
    expect([c.status, d.status]).toEqual(['failed', 'failed'])
    expect(c.gates).toEqual(d.gates)
    expect(c.gates.join('\n')).toMatch(
      /contact.save over budget twice in worker 0 setup: 150, 90, 95 ms, .* budget < 150/,
    )
  })
})
