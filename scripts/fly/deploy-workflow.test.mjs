// @vitest-environment node
// .github/workflows/deploy.yml's deploy-qc job (plan
// gocardless-sandbox-qc.sv, A1): it skips green while the qc
// environment's QC_URL is unset, refuses any branch but main, and every
// step after the gate follows it. Read as text (no YAML parser in the
// repo's dependencies): the gate's shell is run as Actions would run it.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const yml = readFileSync(
  path.join(import.meta.dirname, '../../.github/workflows/deploy.yml'),
  'utf8',
)
const job = yml.slice(yml.indexOf('\n  deploy-qc:\n'))
// Steps as raw text, split at their `      - ` starts.
const steps = job
  .slice(job.indexOf('    steps:\n'))
  .split(/\n {6}- /)
  .slice(1)
const gate = steps.find((s) => s.includes('id: gate'))
// The `run: |` block, de-indented.
const gateScript = gate
  .slice(gate.indexOf('run: |\n') + 'run: |\n'.length, gate.indexOf('\n        env:'))
  .split('\n')
  .map((l) => l.replace(/^ {10}/, ''))
  .join('\n')

function runGate(env) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-gate-'))
  const out = path.join(dir, 'out')
  try {
    const r = spawnSync('bash', ['-e', '-c', gateScript], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
      encoding: 'utf8',
    })
    let outputs = ''
    try {
      outputs = readFileSync(out, 'utf8')
    } catch {}
    return { code: r.status, stdout: r.stdout, outputs }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('deploy_qc_skips_green_while_qc_url_is_unset', () => {
  const r = runGate({ QC_URL: '', GITHUB_REF: 'refs/heads/main' })
  expect(r.code).toBe(0)
  expect(r.outputs).toBe('go=false\n')
  expect(r.stdout).toContain('::notice::')
})

test('deploy_qc_deploys_main_once_qc_url_is_set_and_refuses_other_branches', () => {
  const env = { QC_URL: 'https://keep-qc.fly.dev' }
  expect(runGate({ ...env, GITHUB_REF: 'refs/heads/main' })).toMatchObject({
    code: 0,
    outputs: 'go=true\n',
  })
  const other = runGate({ ...env, GITHUB_REF: 'refs/heads/feat/x' })
  expect(other.code).not.toBe(0)
  expect(other.outputs).toBe('')
})

test('deploy_qc_every_step_after_the_gate_follows_it', () => {
  expect(steps[0]).toContain('id: gate')
  for (const s of steps.slice(1))
    expect(s, s.split('\n')[0]).toContain("if: ${{ steps.gate.outputs.go == 'true' }}")
})

test('deploy_qc_runs_in_the_qc_environment_and_shares_qcs_concurrency_group', () => {
  const head = job.slice(0, job.indexOf('    steps:\n'))
  expect(head).toMatch(/\n {4}environment: qc\n/)
  expect(head).toMatch(/\n {4}concurrency:\n {6}group: keep-qc\n {6}cancel-in-progress: false\n/)
  // keep-qc's own config, one machine, and the commit /healthz reports.
  const deploy = steps.find((s) => s.startsWith('name: Deploy keep-qc'))
  expect(deploy).toContain('-c fly.qc.toml')
  expect(deploy).toContain('--ha=false')
  expect(deploy).toContain('--build-arg KEEP_RELEASE="$GITHUB_SHA"')
  // Never on a pull request: the workflow has no such trigger.
  expect(yml).not.toMatch(/pull_request/)
})

test('every_deploy_builds_in_the_commit_healthz_reports', () => {
  const deploys = yml.match(/flyctl deploy[^\n]*(?:\n {10}--build-arg[^\n]*)*/g)
  expect(deploys).toHaveLength(2)
  for (const d of deploys) expect(d).toContain('--build-arg KEEP_RELEASE="$GITHUB_SHA"')
})
