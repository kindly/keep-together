import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { hostedPool, parseArgs } from './qc.mjs'

// scripts/qc.mjs takes its own options from anywhere in the command line,
// so `pnpm qc --target staging` works though pnpm appends it after
// `-- playwright test`; everything else goes to the wrapped command.
describe('parseArgs', () => {
  test('pnpm qc: the wrapped command, a local pool of 3', () => {
    expect(parseArgs(['--', 'playwright', 'test'], {})).toEqual({
      instances: 3,
      target: 'local',
      wait: true,
      build: true,
      command: ['playwright', 'test'],
    })
  })

  test('--target after the command is ours, the rest is playwright’s', () => {
    const o = parseArgs(
      ['--', 'playwright', 'test', '--target', 'staging', 'qc/flows/x.spec.ts'],
      {},
    )
    expect(o.target).toBe('staging')
    expect(o.command).toEqual(['playwright', 'test', 'qc/flows/x.spec.ts'])
    expect(parseArgs(['--target=staging'], {}).target).toBe('staging')
  })

  test('env and flags', () => {
    const o = parseArgs(['--instances', '2', '--no-build'], {
      QC_NO_WAIT: '1',
    })
    expect(o).toMatchObject({ instances: 2, build: false, wait: false })
    expect(parseArgs([], { QC_INSTANCES: '5' }).instances).toBe(5)
  })

  test('refuses what it doesn’t know', () => {
    expect(() => parseArgs(['--bogus'], {})).toThrow(/unknown argument/)
    expect(() => parseArgs(['--instances', '0'], {})).toThrow(/positive/)
    expect(() => parseArgs(['--target', 'prod'], {})).toThrow(
      /local, staging, qc/,
    )
  })

  test('--target qc: keep-qc from Actions (plan gocardless-sandbox-qc.sv, A2)', () => {
    expect(parseArgs(['--target', 'qc'], {}).target).toBe('qc')
  })
})

describe('hostedPool', () => {
  test('qc: one instance at QC_TARGET_URL on the token surface; the token never in the pool', () => {
    const env = {
      KEEP_QC_TOKEN: 'a'.repeat(64),
      QC_TARGET_URL: 'https://keep-qc.fly.dev/',
    }
    const pool = hostedPool('qc', env)
    expect(pool).toEqual([
      {
        name: 'qc',
        api: 'https://keep-qc.fly.dev',
        baseURL: 'https://keep-qc.fly.dev',
        surface: 'qc',
      },
    ])
    expect(JSON.stringify(pool)).not.toContain(env.KEEP_QC_TOKEN)
  })

  test('staging keeps its default; no token, no run', () => {
    expect(hostedPool('staging', { KEEP_QC_TOKEN: 'x' })[0].api).toBe(
      'https://staging.keep-together.org.uk',
    )
    expect(() => hostedPool('qc', {})).toThrow(/needs KEEP_QC_TOKEN/)
  })
})

// Node itself (type stripping, not Vite) loads qc/trend.ts, qc/budgets.ts
// and qc/target.ts for `pnpm qc:report` and scripts/qc.mjs: their runtime
// imports need the `.ts` extension.
test('node loads the harness modules qc:report and qc.mjs import', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qc-report-'))
  try {
    const r = spawnSync(
      process.execPath,
      [
        'scripts/qc-report.mjs',
        '--history',
        '/dev/null',
        '--out',
        path.join(dir, 'trend.html'),
      ],
      { encoding: 'utf8' },
    )
    expect(r.status, r.stderr).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
