// @vitest-environment node
// scripts/fly/staging-kept.sh against mocked fly, gh and curl: it stages
// the first generation (stdin, never argv) and the QC token's removal
// before any deploy, deploys only from main through Actions, waits for
// /healthz to report the generation, refuses what would wipe a kept or
// unwell staging, and changes nothing once staging is kept.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { sandbox } from './testing/stubs.mjs'

const SCRIPT = 'scripts/fly/staging-kept.sh'
const MAIN_DEMAND = '[env]\n  KEEP_ENV = "staging"\n  KEEP_RESET_ON = "demand"\n'
const MAIN_DEPLOY = '[env]\n  KEEP_ENV = "staging"\n'
const RESETS = { ok: true, resetGeneration: null }
const STAGING_SECRETS = [{ name: 'KEEP_QC_TOKEN' }, { name: 'LITESTREAM_BUCKET' }]
let sb
beforeEach(() => {
  sb = sandbox(['fly', 'gh', 'curl'])
  sb.set('curl-answer', RESETS)
  sb.set('fly-secrets.json', STAGING_SECRETS)
  sb.set('gh-repo-secrets.json', [{ name: 'KEEP_QC_TOKEN' }, { name: 'FLY_API_TOKEN' }])
  sb.set('gh-runs-deploy.yml.json', [{ databaseId: 1, status: 'completed' }])
})
afterEach(() => sb.cleanup())

const cmds = () => sb.argv().filter(([n]) => n === 'fly' || n === 'gh')
const ran = (...prefix) => cmds().some((a) => prefix.every((p, i) => a[i] === p))
// Everything that changes Fly or GitHub, in order.
const changes = () =>
  cmds()
    .filter(
      (a) =>
        (a[0] === 'fly' && a[1] === 'secrets' && ['import', 'unset', 'set'].includes(a[2])) ||
        (a[0] === 'fly' && a[1] === 'deploy') ||
        (a[0] === 'gh' && a[1] === 'workflow') ||
        (a[0] === 'gh' && a[1] === 'secret' && a[2] === 'delete'),
    )
    .map((a) => a.slice(0, 4).join(' '))
const run = (env = {}) =>
  sb.run(SCRIPT, [], { extraEnv: { KEEP_KEPT_POLL: '0', KEEP_KEPT_WAIT: '5', ...env } })
const staged = () => sb.read('staged-KEEP_RESET_GENERATION').trim()

test('staging_kept_stages_generation_and_token_removal_then_deploys_main', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEMAND)
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  expect(changes()).toEqual([
    'fly secrets import -a',
    'fly secrets unset --stage',
    'gh secret delete KEEP_QC_TOKEN',
    'gh workflow run deploy.yml',
  ])
  // Staged, so nothing restarts before the deploy applies it.
  expect(ran('fly', 'secrets', 'import', '-a', 'keep-staging', '--stage')).toBe(true)
  expect(ran('fly', 'secrets', 'unset', '--stage', 'KEEP_QC_TOKEN', '-a', 'keep-staging')).toBe(true)
  expect(ran('gh', 'workflow', 'run', 'deploy.yml', '--ref', 'main', '-f', 'env=staging')).toBe(true)
  expect(ran('gh', 'run', 'watch', '4343', '--exit-status')).toBe(true)
  // The generation went on stdin, never argv, and only the repo-wide
  // GitHub secret was deleted (keep-qc's is the environment's).
  expect(staged()).toMatch(/^\d{8}T\d{6}Z$/)
  expect(sb.stdin()).toEqual([
    { cmd: 'fly secrets import -a keep-staging --stage', body: `KEEP_RESET_GENERATION=${staged()}\n` },
  ])
  expect(cmds().some((a) => a.some((x) => x.includes(`=${staged()}`)))).toBe(false)
  expect(ran('gh', 'secret', 'delete', 'KEEP_QC_TOKEN', '--env')).toBe(false)
  expect(sb.json('fly-secrets.json').map((s) => s.name).sort()).toEqual([
    'KEEP_RESET_GENERATION',
    'LITESTREAM_BUCKET',
  ])
  expect(r.stdout).toContain(`generation ${staged()}`)
  expect(r.stdout).toContain('keep-staging is kept')
  // Built by Actions from main: never flyctl deploy from here.
  expect(ran('fly', 'deploy')).toBe(false)
})

test('staging_kept_before_the_merge_stages_then_waits_for_the_push', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEPLOY)
  // The human merges and pushes while it waits: that push's Deploy run
  // (not this script) brings demand and the staged secrets.
  sb.set('main-at-push', MAIN_DEMAND)
  sb.set('push-after', '3')
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toContain('Merge the')
  expect(changes()).toEqual([
    'fly secrets import -a',
    'fly secrets unset --stage',
    'gh secret delete KEEP_QC_TOKEN',
  ])
  expect(r.stdout).toContain(`generation ${staged()}`)
  expect(r.stdout).toContain('keep-staging is kept')
})

test('staging_kept_no_push_gives_up_and_a_rerun_is_safe', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEPLOY)
  const r = run({ KEEP_KEPT_WAIT: '1' })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("reports generation 'none'")
  const first = staged()
  // Still resetting on deploy: a re-run stages a new generation (the
  // unapplied one never reached the machine) and waits again.
  sb.clearLogs()
  sb.set('main-at-push', MAIN_DEMAND)
  sb.set('push-after', '2')
  const again = run()
  expect(again.code, again.stderr).toBe(0)
  expect(changes()).toEqual(['fly secrets import -a'])
  expect(staged()).toMatch(/^\d{8}T\d{6}Z$/)
  expect(first).toMatch(/^\d{8}T\d{6}Z$/)
})

test('staging_kept_already_kept_changes_nothing', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEMAND)
  sb.set('curl-answer', { ok: true, resetGeneration: '20261102T120000Z' })
  sb.set('fly-secrets.json', [{ name: 'KEEP_RESET_GENERATION' }])
  sb.set('gh-repo-secrets.json', [{ name: 'FLY_API_TOKEN' }])
  sb.set('gh-runs-deploy.yml.json', [{ databaseId: 9, status: 'in_progress' }])
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  expect(changes()).toEqual([])
  expect(r.stdout).toContain('kept: generation 20261102T120000Z')
  expect(r.stdout).toContain('nothing staged: no deploy needed')
})

test('staging_kept_kept_but_token_left_unsets_it_and_keeps_the_generation', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEMAND)
  sb.set('curl-answer', { ok: true, resetGeneration: 'g1' })
  sb.set('fly-secrets.json', [{ name: 'KEEP_RESET_GENERATION' }, { name: 'KEEP_QC_TOKEN' }])
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  // No new generation: that would wipe staging.
  expect(changes()).toEqual([
    'fly secrets unset --stage',
    'gh secret delete KEEP_QC_TOKEN',
    'gh workflow run deploy.yml',
  ])
  expect(staged()).toBe('')
  expect(r.stdout).toContain('generation g1')
})

test('staging_kept_refuses_with_a_deploy_in_flight_before_changing_anything', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEMAND)
  sb.set('gh-runs-deploy.yml.json', [{ databaseId: 77, status: 'in_progress' }])
  const r = run()
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('deploy.yml has runs in flight (77)')
  expect(changes()).toEqual([])
})

test('staging_kept_down_with_a_generation_set_refuses: it may be kept', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEMAND)
  sb.set('fail-curl', 'curl: (7) Failed to connect')
  sb.set('fly-secrets.json', [{ name: 'KEEP_RESET_GENERATION' }])
  const r = run()
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("doesn't answer and KEEP_RESET_GENERATION is set")
  expect(changes()).toEqual([])
})

test('staging_kept_mends_a_switch_that_deployed_demand_without_a_generation', () => {
  // main has demand, the deploy ran first: the entrypoint refused to boot.
  sb.set('gh-main-fly-staging-toml', MAIN_DEMAND)
  sb.set('fail-curl', 'curl: (7) Failed to connect')
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  expect(changes()).toContain('gh workflow run deploy.yml')
  expect(r.stdout).toContain(`generation ${staged()}`)
})

test('staging_kept_refuses_when_main_disagrees_with_staging', () => {
  for (const curl of [{ fail: true }, { answer: { ok: true, resetGeneration: 'g1' } }]) {
    sb.clearLogs()
    sb.set('gh-main-fly-staging-toml', MAIN_DEPLOY)
    if (curl.fail) sb.set('fail-curl', 'down')
    else sb.set('curl-answer', curl.answer)
    sb.set('fly-secrets.json', [])
    const r = run()
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("main's fly.staging.toml doesn't say demand")
    expect(r.stderr).toContain('nothing was changed')
    expect(changes()).toEqual([])
  }
})

test('staging_kept_refuses_a_generation_in_mains_toml', () => {
  sb.set('gh-main-fly-staging-toml', `${MAIN_DEMAND}  KEEP_RESET_GENERATION = "g1"\n`)
  const r = run()
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('must be a Fly secret only')
  expect(changes()).toEqual([])
})

test('staging_kept_a_failed_deploy_run_says_so', () => {
  sb.set('gh-main-fly-staging-toml', MAIN_DEMAND)
  sb.set('fail-gh-run-watch', 'run failed')
  const r = run()
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('run 4343 failed')
})
