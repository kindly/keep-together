// @vitest-environment node
import { describe, expect, test } from 'vitest'
import type { TestCase, TestResult } from '@playwright/test/reporter'
import QcReporter, { goCardlessQcBanner } from './reporter'

// The GoCardless sandbox spec's banners (qc/flows/gocardless-sandbox.spec.ts,
// plan gocardless-sandbox-qc.sv G3): a late webhook passes with a
// banner (g1q3), an unreachable sandbox skips with one (g1q4), and so does
// a target without the QC GoCardless surface.

const none = () => ({
  late: new Map<string, Array<string>>(),
  unreachable: new Map<string, string>(),
  noQc: new Map<string, string>(),
})

describe('goCardlessQcBanner', () => {
  test('nothing to say: no banner', () => {
    expect(goCardlessQcBanner(none())).toEqual([])
  })

  test('late webhooks: every wait listed, by test', () => {
    const notes = none()
    notes.late.set('GoCardless sandbox › set up', [
      'the mandate (92 s; the catch-up found it)',
    ])
    notes.late.set('GoCardless sandbox › catch-up', [
      'the catch-up found 2 missed events',
    ])
    const out = goCardlessQcBanner(notes).join('\n')
    expect(out).toContain('GOCARDLESS LATE WEBHOOK: 2 waits passed only after')
    expect(out).toContain(
      'GoCardless sandbox › catch-up: the catch-up found 2 missed events',
    )
    expect(out).toContain(
      'GoCardless sandbox › set up: the mandate (92 s; the catch-up found it)',
    )
    expect(out).not.toContain('UNREACHABLE')
  })

  test('unreachable and no surface: each its own banner, saying nothing was tested', () => {
    const notes = none()
    notes.unreachable.set(
      'GoCardless sandbox › failed',
      '/api/qc/gocardless/sign: 503',
    )
    notes.noQc.set('GoCardless sandbox › set up', 'connect: 404')
    const out = goCardlessQcBanner(notes)
    const text = out.join('\n')
    expect(text).toContain('GOCARDLESS SANDBOX UNREACHABLE: 1 test skipped')
    expect(text).toContain(
      'GoCardless sandbox › failed: /api/qc/gocardless/sign: 503',
    )
    expect(text).toContain(
      'GOCARDLESS QC SURFACE OFF on the target: 1 test skipped',
    )
    expect(text).toContain('NOT tested')
    // Two banners, each between its bars.
    expect(out.filter((l) => l.startsWith('!!!!')).length).toBe(4)
  })
})

describe('the reporter collects the spec’s annotations', () => {
  const testCase = (title: string) =>
    ({
      titlePath: () => ['', 'chromium', 'gocardless-sandbox.spec.ts', title],
      annotations: [],
    }) as unknown as TestCase
  const result = (
    status: TestResult['status'],
    annotations: Array<{ type: string; description?: string }>,
  ) =>
    ({
      status,
      annotations,
      startTime: new Date(),
      duration: 1,
    }) as unknown as TestResult

  test('late notes from passing tests; skips only from skipped ones', () => {
    const r = new QcReporter()
    r.onTestEnd(
      testCase('set up'),
      result('passed', [
        { type: 'gocardlessLateWebhook', description: 'the mandate' },
      ]),
    )
    r.onTestEnd(
      testCase('failed'),
      result('skipped', [
        { type: 'gocardlessUnreachable', description: '503' },
      ]),
    )
    // An annotation on a test that still ran isn't a skip.
    r.onTestEnd(
      testCase('charged back'),
      result('passed', [{ type: 'gocardlessNoQc', description: 'x' }]),
    )
    const notes = (
      r as unknown as { gcQc: Parameters<typeof goCardlessQcBanner>[0] }
    ).gcQc
    expect([...notes.late]).toEqual([
      ['gocardless-sandbox.spec.ts › set up', ['the mandate']],
    ])
    expect([...notes.unreachable]).toEqual([
      ['gocardless-sandbox.spec.ts › failed', '503'],
    ])
    expect(notes.noQc.size).toBe(0)
  })
})
