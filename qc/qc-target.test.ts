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
import { BULK_ROUTES, budgetFor, budgets, targetBudgets } from './budgets'
import type { Budget, FlowName } from './budgets'
import { HOSTED, hostedUrl, qcTarget } from './target'
import { RTT_CEILING_MS, rttCeilingMs } from './timing'
import QcReporter, { summarise, unbudgetedBanner } from './reporter'
import type { HistoryLine } from './reporter'
import { LINK_FILE, LINK_OFF_ACTIONS, linkHook } from './link.setup'
import type { LinkFile } from './link.setup'
import { readRoutes } from './coverage'
import type { FlowRecord } from './timing'

// QC on GitHub Actions against keep-qc (plan gocardless-sandbox-qc.sv,
// A2): the `qc` target, its own budgets (g2q6, recorded by A3), and the
// first-hop watch off on the runner (g2q10).

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the qc target', () => {
  test('QC_TARGET names it; unset is local; anything else is refused', () => {
    expect(qcTarget({})).toBe('local')
    expect(qcTarget({ QC_TARGET: 'staging' })).toBe('staging')
    expect(qcTarget({ QC_TARGET: 'qc' })).toBe('qc')
    expect(() => qcTarget({ QC_TARGET: 'prod' })).toThrow(/not prod/)
  })

  test('its origin is QC_TARGET_URL (keep-qc.fly.dev by default), an origin only', () => {
    expect(HOSTED.qc.urlEnv).toBe('QC_TARGET_URL')
    expect(hostedUrl('qc', {})).toBe('https://keep-qc.fly.dev')
    expect(hostedUrl('qc', { QC_TARGET_URL: 'https://x.example/' })).toBe(
      'https://x.example',
    )
    expect(hostedUrl('staging', {})).toBe(
      'https://staging.keep-together.org.uk',
    )
    expect(() =>
      hostedUrl('qc', { QC_TARGET_URL: 'https://x.example/api' }),
    ).toThrow(/an origin/)
  })
})

describe('per-target budgets (human, g2q6)', () => {
  const real = (Object.entries(budgets) as Array<[FlowName, Budget]>).filter(
    ([, b]) => !b.selfTest,
  )
  const pageUpload: Array<FlowName> = ['scan.sendPage', 'scans.uploadToLaptop']

  test('the house set is unchanged for local and staging', () => {
    for (const t of ['local', 'staging'] as const) {
      expect(targetBudgets[t]).toBeUndefined()
      for (const [name, b] of real) expect(budgetFor(name, t)).toBe(b)
    }
    expect(rttCeilingMs('local')).toBe(RTT_CEILING_MS)
    expect(rttCeilingMs('staging')).toBe(RTT_CEILING_MS)
  })

  test('qc (A3, recorded): its own lines and ceiling; same kinds; bulk at the fixed 500 ms but the page upload; no targets', () => {
    expect(rttCeilingMs('qc')).toBe(90)
    const own = targetBudgets.qc!.flows
    expect(Object.keys(own).length).toBeGreaterThan(0)
    for (const [name, b] of real) {
      const q = budgetFor(name, 'qc')
      expect(q.kind).toBe(b.kind)
      expect(q.targetMs).toBeUndefined()
      if (own[name]) {
        expect(q.unbudgeted).toBeUndefined()
        expect(q.maxMs % 10).toBe(0)
        // The human's fixed lines: bulk is 500, never raised, but the
        // phone's page upload gets 1,500 on keep-qc only (2026-11-01).
        if (b.kind === 'bulk') {
          expect(b.maxMs).toBe(500)
          expect(q.maxMs).toBe(pageUpload.includes(name) ? 1500 : 500)
        }
      } else {
        // Not timed on keep-qc (the GoCardless fake's flows): unbudgeted,
        // the house line kept for the timeout only.
        expect(b.fakeGoCardless).toBe(true)
        expect(q.unbudgeted).toBe(true)
        expect(q.maxMs).toBe(b.maxMs)
      }
    }
  })

  test("the phone's page upload is a bulk route at 500 ms, like Accept ticked", () => {
    expect(BULK_ROUTES['POST /scan/:token/scans']).toBe(500)
    expect(BULK_ROUTES['POST /t/:slug/bank/accept']).toBe(500)
  })

  test('the harness self-tests keep their budgets on every target', () => {
    for (const name of ['harness.impossible', 'harness.generous'] as const)
      expect(budgetFor(name, 'qc')).toBe(budgets[name])
  })

  test('the process target comes from QC_TARGET', () => {
    vi.stubEnv('QC_TARGET', 'qc')
    expect(budgetFor('contact.save')).toBe(
      targetBudgets.qc!.flows['contact.save'],
    )
    expect(budgetFor('gocardless.setUp').unbudgeted).toBe(true)
    expect(rttCeilingMs()).toBe(90)
    vi.stubEnv('QC_TARGET', 'staging')
    expect(budgetFor('contact.save')).toBe(budgets['contact.save'])
  })
})

const rec = (over: Partial<FlowRecord> = {}): FlowRecord => ({
  runId: 'q1',
  flow: 'contact.save',
  worker: 0,
  instance: 'qc',
  where: 'contact › save',
  kind: 'repeatable',
  samplesMs: [180, 190],
  detail: [],
  rttMs: 85,
  rttOver: false,
  budgetMs: 150,
  medianMs: 185,
  maxMs: 190,
  pass: null,
  skipped: 'unbudgeted',
  ...over,
})

describe('unbudgeted flows: recorded, never judged', () => {
  const base = {
    runId: 'q1',
    at: '2026-11-01T03:00:00.000Z',
    sha: 'abc',
    dirty: false,
    mode: 'assert' as const,
    env: 'qc' as const,
    server: null,
  }

  test('the history line says unbudgeted, counts nothing over, and passes nothing', () => {
    const [l] = summarise([rec()], base, null)
    expect(l).toMatchObject({
      flow: 'contact.save',
      env: 'qc',
      unbudgeted: true,
      overBudget: 0,
      pass: null,
      samplesMs: [180, 190],
    })
    expect(l.target).toBeUndefined()
  })

  test('a banner names them on every run', () => {
    const lines = summarise(
      [rec(), rec({ flow: 'contact.archive' })],
      base,
      null,
    )
    const b = unbudgetedBanner(lines, 'qc')
    expect(b.join('\n')).toMatch(
      /NO BUDGETS on target qc for 2 flows: timed and recorded, latency NOT judged/,
    )
    expect(b.join('\n')).toContain('contact.archive, contact.save')
    const judged = summarise(
      [rec({ skipped: undefined, pass: true, samplesMs: [80, 82] })],
      base,
      null,
    )
    expect(unbudgetedBanner(judged, 'local')).toEqual([])
  })
})

describe('the run on Actions', () => {
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
    vi.restoreAllMocks()
  })

  test('the link hook watches nothing on the runner, and says why', async () => {
    vi.stubEnv('QC_RUN_ID', 'l1')
    vi.stubEnv('QC_TARGET', 'qc')
    const teardown = await linkHook.setup([])
    await teardown!()
    const link = JSON.parse(
      readFileSync(
        path.join(dir, 'qc-results', 'runs', 'l1', LINK_FILE),
        'utf8',
      ),
    ) as LinkFile
    expect(link).toEqual({
      gateway: null,
      watched: false,
      why: LINK_OFF_ACTIONS,
      pings: [],
      lost: [],
    })
  })

  test('the header names the target and the link off; the run stays green with nothing judged', async () => {
    vi.stubEnv('QC_RUN_ID', 'q1')
    vi.stubEnv('QC_TARGET', 'qc')
    const run = path.join(dir, 'qc-results', 'runs', 'q1')
    mkdirSync(run, { recursive: true })
    writeFileSync(path.join(run, 'pid-1.jsonl'), JSON.stringify(rec()) + '\n')
    writeFileSync(
      path.join(run, LINK_FILE),
      JSON.stringify({
        gateway: null,
        watched: false,
        why: LINK_OFF_ACTIONS,
        pings: [],
        lost: [],
      }),
    )
    const logged: Array<string> = []
    vi.spyOn(console, 'log').mockImplementation((m: string) => {
      logged.push(m)
    })
    const reporter = new QcReporter()
    // A filtered run: the untimed and coverage gates only warn.
    reporter.onBegin({
      argv: ['node', 'playwright', 'test', 'qc/flows/contact.spec.ts'],
    } as unknown as FullConfig)
    reporter.onTestEnd(
      {
        annotations: readRoutes().map((r) => ({
          type: 'route',
          description: r,
        })),
      } as unknown as TestCase,
      { status: 'passed', annotations: [] } as unknown as TestResult,
    )
    const res = await reporter.onEnd({ status: 'passed' } as FullResult)
    vi.restoreAllMocks()
    const out = logged.join('\n')
    expect(res?.status).toBeUndefined()
    expect(out).toMatch(/^qc q1 · target qc · asserting/m)
    // A3 set a ceiling: the header no longer says there is none.
    expect(out).not.toContain('no RTT ceiling on this target yet')
    expect(out).toContain(`· link: not watched (${LINK_OFF_ACTIONS})`)
    // Not the "absence of a LINK banner says nothing" line: it's off by design.
    expect(out).not.toContain('first hop not watched')
    expect(out).toMatch(/contact\.save .* none .* not judged \(no budget\)/)
    expect(out).toContain('NO BUDGETS on target qc')
    const [line] = readFileSync(
      path.join(dir, 'qc-results', 'history.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryLine)
    expect(line).toMatchObject({ env: 'qc', unbudgeted: true, pass: null })
  })
})
