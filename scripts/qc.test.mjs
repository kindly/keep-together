import { describe, expect, test } from 'vitest'
import { parseArgs } from './qc.mjs'

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
      /local or staging/,
    )
  })
})
