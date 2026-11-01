// @vitest-environment node
// scripts/fly/qc.sh (plan gocardless-sandbox-qc.sv, A1) against mocked
// fly and gh: what it creates, that a re-run changes nothing, that the QC
// token is the same on Fly and in the GitHub environment, that only main
// may deploy to it, and that no secret it handles reaches argv or the
// screen.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { assertNowhere, sandbox } from './testing/stubs.mjs'

const SCRIPT = 'scripts/fly/qc.sh'
let sb
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())
const rmFile = (name) =>
  rmSync(path.join(sb.dir, 'state', name), { force: true })

const cmds = () => sb.argv().filter(([n]) => n === 'fly' || n === 'gh')
const ran = (...prefix) =>
  cmds().some((a) => prefix.every((p, i) => a[i] === p))
// NAME=value lines fly read on stdin.
const flyImported = () =>
  Object.fromEntries(
    sb
      .stdin()
      .filter((r) => r.cmd.startsWith('fly secrets import -a keep-qc --stage'))
      .flatMap((r) => r.body.split('\n').filter(Boolean))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
const ghSet = (name) =>
  sb
    .stdin()
    .filter((r) => r.cmd === `gh secret set ${name} --env qc`)
    .map((r) => r.body)

test('qc_sh_creates_keep_qc_its_volume_and_secrets_once', () => {
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code, r.stderr).toBe(0)
  expect(ran('fly', 'apps', 'create', 'keep-qc')).toBe(true)
  expect(
    ran(
      'fly',
      'volumes',
      'create',
      'keep_data',
      '-a',
      'keep-qc',
      '--region',
      'iad',
      '--size',
      '3',
    ),
  ).toBe(true)
  const secrets = flyImported()
  expect(Object.keys(secrets).sort()).toEqual(
    [
      'KEEP_AUTH_PEPPER',
      'KEEP_QC_TOKEN',
      'KEEP_RIVERSIDE_ADMIN_PASSWORD',
      'KEEP_RIVERSIDE_ADMIN_TOTP',
      'KEEP_RIVERSIDE_STAFF_PASSWORD',
      'KEEP_RIVERSIDE_STAFF_TOTP',
      'KEEP_RIVERSIDE_VIEWER_PASSWORD',
      'KEEP_RIVERSIDE_VIEWER_TOTP',
      'KEEP_SETTINGS_KEY',
    ].sort(),
  )
  expect(secrets.KEEP_QC_TOKEN).toMatch(/^[0-9a-f]{64}$/)
  // No backups on keep-qc: it is thrown away on every deploy.
  expect(Object.keys(secrets).some((k) => /LITESTREAM|SNAPSHOT/.test(k))).toBe(
    false,
  )
  // A blank SENTRY_DSN is skipped, not set empty.
  expect(secrets.SENTRY_DSN).toBeUndefined()

  // Re-run: everything exists, nothing is created or replaced.
  sb.clearLogs()
  const again = sb.run(SCRIPT, [], { input: '\n' })
  expect(again.code, again.stderr).toBe(0)
  expect(ran('fly', 'apps', 'create')).toBe(false)
  expect(ran('fly', 'volumes', 'create')).toBe(false)
  expect(ran('fly', 'secrets', 'import')).toBe(false)
  expect(ran('gh', 'secret', 'set')).toBe(false)
  expect(ran('fly', 'tokens', 'create')).toBe(false)
  expect(again.stdout).toContain('generated ones: all set')
})

test('qc_sh_puts_the_same_qc_token_on_fly_and_in_the_github_environment', () => {
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code, r.stderr).toBe(0)
  const onFly = flyImported().KEEP_QC_TOKEN
  expect(ghSet('KEEP_QC_TOKEN')).toEqual([onFly])

  // GitHub lost it (or never got it): a new token goes to both.
  sb.set('gh-secrets.json', [{ name: 'FLY_API_TOKEN' }])
  sb.clearLogs()
  const again = sb.run(SCRIPT, [], { input: '\n' })
  expect(again.code, again.stderr).toBe(0)
  const rotated = flyImported()
  expect(Object.keys(rotated)).toEqual(['KEEP_QC_TOKEN'])
  expect(rotated.KEEP_QC_TOKEN).not.toBe(onFly)
  expect(ghSet('KEEP_QC_TOKEN')).toEqual([rotated.KEEP_QC_TOKEN])
})

test('qc_sh_makes_the_qc_environment_deployable_from_main_only', () => {
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code, r.stderr).toBe(0)
  const put = sb.stdin().find((x) => x.cmd.startsWith('gh api -X PUT'))
  expect(JSON.parse(put.body)).toEqual({
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  })
  const post = sb.stdin().filter((x) => x.cmd.startsWith('gh api -X POST'))
  expect(post.map((x) => JSON.parse(x.body))).toEqual([
    { name: 'main', type: 'branch' },
  ])
  // The environment's deploy token: piped from flyctl to gh.
  expect(ghSet('FLY_API_TOKEN')).toEqual([
    'FlyV1 fm2_mockdeploytoken_0123456789abcdef',
  ])
})

test('qc_sh_refuses_an_empty_or_failed_deploy_token_and_stores_nothing', () => {
  sb.set('fly-deploy-token', '')
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('fly tokens create gave nothing')
  expect(ghSet('FLY_API_TOKEN')).toEqual([])

  rmFile('fly-deploy-token')
  sb.set('fail-fly-token', 'Error: not authorized')
  const failed = sb.run(SCRIPT, [], { input: '\n' })
  expect(failed.code).not.toBe(0)
  expect(failed.stderr).toContain('fly tokens create failed')
  expect(ghSet('FLY_API_TOKEN')).toEqual([])
})

test('qc_sh_refuses_an_environment_another_branch_or_any_tag_may_deploy_from', () => {
  for (const other of ['branch:feat/*', 'tag:v*', 'tag:main']) {
    sb.set('gh-policies', `branch:main\n${other}\n`)
    sb.clearLogs()
    const r = sb.run(SCRIPT, [], { input: '\n' })
    expect(r.code, other).not.toBe(0)
    expect(r.stderr).toContain(other)
    expect(ran('fly', 'secrets', 'import')).toBe(false)
    expect(ran('gh', 'secret', 'set')).toBe(false)
  }
})

test('qc_sh_leaves_the_first_deploy_to_actions_from_main', () => {
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code, r.stderr).toBe(0)
  // Nothing deployed or switched on from here: the human sets QC_URL,
  // then dispatches Deploy on main, so no working tree is ever deployed.
  expect(ran('gh', 'variable')).toBe(false)
  expect(ran('gh', 'workflow')).toBe(false)
  const setUrl = r.stdout.indexOf(
    'gh variable set QC_URL --env qc --body https://keep-qc.fly.dev',
  )
  const dispatch = r.stdout.indexOf(
    'gh workflow run deploy.yml --ref main -f env=qc',
  )
  expect(setUrl).toBeGreaterThan(-1)
  expect(dispatch).toBeGreaterThan(setUrl)
  expect(r.stdout).not.toContain('fly deploy')
})

test('qc_sh_never_sets_sentry_and_warns_if_keep_qc_has_it', () => {
  const r = sb.run(SCRIPT, [], {
    input: 'https://0123abcd@o1.ingest.de.sentry.io/42\n',
  })
  expect(r.code, r.stderr).toBe(0)
  expect(flyImported().SENTRY_DSN).toBeUndefined()
  expect(r.stderr).not.toContain('SENTRY_DSN (not shown)')
  sb.set('fly-secrets.json', [{ name: 'SENTRY_DSN' }])
  const again = sb.run(SCRIPT, [], { input: '\n' })
  expect(again.stdout).toContain(
    'fly secrets unset SENTRY_DSN -a keep-qc --stage',
  )
})

test('qc_sh_refuses_a_second_machine', () => {
  sb.set('fly-apps.json', [{ Name: 'keep-qc' }])
  sb.set('fly-machines.json', [{ id: 'a' }, { id: 'b' }])
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('2 machines')
  expect(ran('fly', 'secrets', 'import')).toBe(false)
})

test('qc_sh_without_a_terminal_names_gocardless_secrets_sh_instead_of_running_it', () => {
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toContain('missing: KEEP_GOCARDLESS_CLIENT_ID')
  expect(r.stdout).toContain(
    'run scripts/fly/gocardless-secrets.sh qc in a terminal',
  )
  sb.set('fly-secrets.json', [
    { name: 'KEEP_GOCARDLESS_CLIENT_ID' },
    { name: 'KEEP_GOCARDLESS_CLIENT_SECRET' },
    { name: 'KEEP_GOCARDLESS_WEBHOOK_SECRET' },
  ])
  const again = sb.run(SCRIPT, [], { input: '\n' })
  expect(again.stdout).toMatch(
    /GoCardless partner app secrets[^\n]*\n(?:[^\n]*\n)?all set/,
  )
})

test('qc_sh_never_puts_a_secret_in_argv_or_on_screen', () => {
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code, r.stderr).toBe(0)
  const secrets = flyImported()
  const values = [
    ...Object.values(secrets),
    'fm2_mockdeploytoken_0123456789abcdef',
  ]
  expect(values.length).toBe(10)
  assertNowhere(values, {
    argv: sb.argv(),
    texts: { stdout: r.stdout, stderr: r.stderr },
  })
  // And no secret was written to a temporary file on the way.
  expect(sb.tmpFiles()).toEqual([])
})

// fly/{qc,staging,prod}.sh, 2026-11-01: `fly apps list | names | grep -qx`
// under pipefail. grep -q quits at its match; with names still to write,
// jq died of SIGPIPE and pipefail read the match as a miss, so a re-run
// tried `apps create` on an app that exists. keep-qc first in a long list
// leaves jq mid-output every time: deterministic.
test('qc_sh_finds_keep_qc_at_the_top_of_a_long_app_list', () => {
  sb.set('fly-apps.json', [
    { Name: 'keep-qc' },
    ...Array.from({ length: 20000 }, (_, i) => ({ Name: `other-app-${i}` })),
  ])
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toMatch(/== App keep-qc\nexists/)
  expect(ran('fly', 'apps', 'create')).toBe(false)
})

test('qc_sh_stops_when_fly_cannot_list_apps_never_creates_one', () => {
  sb.set('fail-fly-apps', 'Error: not authorized')
  const r = sb.run(SCRIPT, [], { input: '\n' })
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('fly apps list failed')
  expect(ran('fly', 'apps', 'create')).toBe(false)
})
