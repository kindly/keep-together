// @vitest-environment node
// scripts/fly/stripe-secrets.sh (plan stripe.sv, S0) on a terminal, with
// fly mocked: the restricted key and the webhook secret reach keep-<env>
// on stdin, staged, and no secret reaches any argv, the screen or a
// temporary file. A key of the wrong mode for the app is refused.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { assertNowhere, sandbox } from './testing/stubs.mjs'

const SCRIPT = 'scripts/fly/stripe-secrets.sh'
// Fake secrets, built at run time so no literal in the repo looks like a
// real Stripe key (GitHub push protection refuses those).
const fake = (...parts) => [...parts, 'FAKE0000'.repeat(4)].join('_')
const TEST_KEY = fake('rk', 'test')
const LIVE_KEY = fake('rk', 'live')
const WEBHOOK = fake('whsec')

let sb
beforeEach(() => {
  sb = sandbox(['fly'])
})
afterEach(() => sb.cleanup())

const run = (env, steps) => sb.runTty(SCRIPT, steps, { args: [env] })
const flyImports = () => sb.stdin().filter((r) => r.cmd.startsWith('fly secrets import'))
const flyCalls = () => sb.argv().filter(([n]) => n === 'fly')

test('stripe_secrets_stages_the_key_and_webhook_secret_on_stdin', async () => {
  const r = await run('staging', [TEST_KEY, WEBHOOK])
  expect(r.code, r.stderr).toBe(0)
  const imports = flyImports()
  expect(imports.map((i) => i.cmd)).toEqual(['fly secrets import -a keep-staging --stage'])
  expect(imports[0].body).toBe(
    `KEEP_STRIPE_API_KEY=${TEST_KEY}\nKEEP_STRIPE_WEBHOOK_SECRET=${WEBHOOK}\n`,
  )
  expect(r.stdout).toContain('staged on keep-staging')
  expect(r.stdout).toContain('KEEP_STRIPE = "test"')
  expect(r.stdout).toContain('/api/stripe/webhook')
})

test('stripe_secrets_names_each_environments_app_and_mode', async () => {
  for (const [env, app, key, mode] of [
    ['staging', 'keep-staging', TEST_KEY, 'test'],
    ['qc', 'keep-qc', TEST_KEY, 'test'],
    ['prod', 'keep-prod', LIVE_KEY, 'live'],
  ]) {
    sb.clearLogs()
    const r = await run(env, [key, WEBHOOK])
    expect(r.code, r.stderr).toBe(0)
    expect(flyImports().map((i) => i.cmd)).toEqual([`fly secrets import -a ${app} --stage`])
    expect(r.stdout).toContain(`KEEP_STRIPE = "${mode}"`)
  }
})

test('stripe_secrets_never_puts_a_secret_in_argv_on_screen_or_in_a_file', async () => {
  const r = await run('qc', [TEST_KEY, WEBHOOK])
  expect(r.code, r.stderr).toBe(0)
  assertNowhere([TEST_KEY, WEBHOOK], {
    argv: sb.argv(),
    texts: { stdout: r.stdout, stderr: r.stderr },
  })
  expect(sb.tmpFiles()).toEqual([])
})

test('stripe_secrets_keeps_what_an_empty_answer_leaves_alone', async () => {
  sb.set('fly-secrets.json', [{ name: 'KEEP_STRIPE_API_KEY' }])
  const r = await run('staging', ['', WEBHOOK])
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toContain('KEEP_STRIPE_API_KEY is already set on keep-staging')
  expect(r.stdout).toContain('KEEP_STRIPE_API_KEY unchanged')
  expect(r.stdout).toContain('KEEP_STRIPE_WEBHOOK_SECRET is not set on keep-staging')
  expect(flyImports().map((i) => i.body)).toEqual([`KEEP_STRIPE_WEBHOOK_SECRET=${WEBHOOK}\n`])
})

test('stripe_secrets_changes_nothing_when_nothing_is_typed', async () => {
  const r = await run('staging', ['', ''])
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toContain('nothing typed: keep-staging unchanged')
  expect(flyImports()).toEqual([])
})

test('stripe_secrets_refuses_a_live_key_on_staging_and_qc', async () => {
  for (const env of ['staging', 'qc']) {
    sb.clearLogs()
    const r = await run(env, [LIVE_KEY, WEBHOOK])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('starts with rk_test_ (nothing was set)')
    expect(flyImports()).toEqual([])
    assertNowhere([LIVE_KEY], { argv: sb.argv(), texts: { stdout: r.stdout, stderr: r.stderr } })
  }
})

test('stripe_secrets_refuses_a_sandbox_key_on_prod', async () => {
  const r = await run('prod', [TEST_KEY, WEBHOOK])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('starts with rk_live_ (nothing was set)')
  expect(flyImports()).toEqual([])
})

test('stripe_secrets_refuses_an_unrestricted_secret_key', async () => {
  const r = await run('staging', [fake('sk', 'test'), WEBHOOK])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('starts with rk_test_')
  expect(flyImports()).toEqual([])
})

test('stripe_secrets_refuses_a_webhook_secret_of_another_shape_and_sets_nothing', async () => {
  const r = await run('staging', [TEST_KEY, 'we_1QcEndpointId0123'])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('KEEP_STRIPE_WEBHOOK_SECRET for keep-staging starts with whsec_')
  expect(flyImports()).toEqual([])
})

test('stripe_secrets_refuses_a_value_with_spaces_or_shell_characters', async () => {
  const r = await run('staging', [`${TEST_KEY} $(id)`, WEBHOOK])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('has characters it never has')
  expect(flyImports()).toEqual([])
})

test('stripe_secrets_refuses_an_unknown_environment_before_calling_fly', () => {
  for (const args of [[], ['dev'], ['production']]) {
    const r = sb.run(SCRIPT, args)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('staging|qc|prod')
  }
  expect(flyCalls()).toEqual([])
})

test('stripe_secrets_refuses_to_run_without_a_terminal', () => {
  const r = sb.run(SCRIPT, ['staging'], { input: `${TEST_KEY}\n${WEBHOOK}\n` })
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('run it in a terminal')
  expect(flyCalls()).toEqual([])
})
