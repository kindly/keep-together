// @vitest-environment node
// scripts/fly/gocardless-qc-token.sh (plan gocardless-sandbox-qc.sv, G1)
// on a terminal, with fly, curl and date mocked: the exchange's form goes
// on stdin, only the organisation id is printed, the token and
// organisation reach keep-qc on stdin, and no secret reaches any argv,
// the screen or a temporary file.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { assertNowhere, sandbox } from './testing/stubs.mjs'

const SCRIPT = 'scripts/fly/gocardless-qc-token.sh'
const CLIENT_ID = 'qc_partner_client_id_0123'
const CLIENT_SECRET = 'qc-partner-client-secret-ZXY987+/='
const CODE = 'AuThCoDe0123456789'
const TOKEN = 'sandbox_QcAccessToken-abcdef0123456789'
const ORG = 'OR000QC0123ABC'
const ANSWER = {
  access_token: TOKEN,
  scope: 'read_write',
  token_type: 'bearer',
  email: 'qc@example.com',
  organisation_id: ORG,
}

let sb
beforeEach(() => {
  sb = sandbox(['fly', 'curl', 'date'])
  sb.set('curl-answer', ANSWER)
})
afterEach(() => sb.cleanup())

// The printed authorize link's state, once it is on screen.
const stateFrom = (out) => out.match(/[?&]state=(cli-[0-9a-f]{32})\b/)?.[1] ?? null
// The line keep-qc's callback shows for the script's state.
const landed = (state) => `code=${CODE}&state=${state}`
const pasteLanded = (out) => {
  const s = stateFrom(out)
  return s && landed(s)
}
const curlCalls = () => sb.argv().filter(([n]) => n === 'curl')
const flyImports = () => sb.stdin().filter((r) => r.cmd.startsWith('fly secrets import'))

test('gocardless_qc_token_stages_the_token_and_organisation_on_keep_qc', async () => {
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, pasteLanded])
  expect(r.code, r.stderr).toBe(0)
  const imports = flyImports()
  expect(imports.map((i) => i.cmd)).toEqual(['fly secrets import -a keep-qc --stage'])
  expect(imports[0].body).toBe(
    `KEEP_QC_GOCARDLESS_TOKEN=${TOKEN}\nKEEP_QC_GOCARDLESS_ORGANISATION=${ORG}\n`,
  )
  expect(r.stdout).toContain(`QC sandbox account: ${ORG}`)
})

test('gocardless_qc_token_prints_the_sandbox_authorize_link_for_keep_qc', async () => {
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, pasteLanded])
  expect(r.code, r.stderr).toBe(0)
  const link = new URL(r.stdout.match(/https:\/\/connect-sandbox\.gocardless\.com\/oauth\/authorize\S+/)[0])
  expect(Object.fromEntries(link.searchParams)).toEqual({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: 'read_write',
    redirect_uri: 'https://keep-qc.fly.dev/api/gocardless/callback',
    initial_view: 'login',
    state: stateFrom(r.stdout),
  })
})

test('gocardless_qc_token_sends_the_exchange_form_on_stdin', async () => {
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, pasteLanded])
  expect(r.code, r.stderr).toBe(0)
  const calls = curlCalls()
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('https://connect-sandbox.gocardless.com/oauth/access_token')
  expect(calls[0]).toContain('@-')
  const sent = sb.stdin().filter((x) => x.cmd.startsWith('curl'))
  expect(sent).toHaveLength(1)
  expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({
    grant_type: 'authorization_code',
    code: CODE,
    redirect_uri: 'https://keep-qc.fly.dev/api/gocardless/callback',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })
})

test('gocardless_qc_token_never_puts_a_secret_in_argv_on_screen_or_in_a_file', async () => {
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, pasteLanded])
  expect(r.code, r.stderr).toBe(0)
  // The client id is in the authorize link by design; the rest never shows.
  assertNowhere([CLIENT_SECRET, encodeURIComponent(CLIENT_SECRET), TOKEN, CODE], {
    argv: sb.argv(),
    texts: { stdout: r.stdout, stderr: r.stderr },
  })
  expect(sb.tmpFiles()).toEqual([])
})

test('gocardless_qc_token_takes_the_whole_callback_address_too', async () => {
  const r = await sb.runTty(SCRIPT, [
    CLIENT_ID,
    CLIENT_SECRET,
    (out) => stateFrom(out) && `https://keep-qc.fly.dev/api/gocardless/callback?${landed(stateFrom(out))}`,
  ])
  expect(r.code, r.stderr).toBe(0)
  expect(flyImports()).toHaveLength(1)
})

test('gocardless_qc_token_takes_a_code_with_every_character_keep_qcs_page_shows', async () => {
  const code = 'Ab.c~D-e_F0.9~z'
  const r = await sb.runTty(SCRIPT, [
    CLIENT_ID,
    CLIENT_SECRET,
    (out) => stateFrom(out) && `code=${code}&state=${stateFrom(out)}`,
  ])
  expect(r.code, r.stderr).toBe(0)
  const sent = sb.stdin().find((x) => x.cmd.startsWith('curl'))
  expect(new URLSearchParams(sent.body).get('code')).toBe(code)
  expect(flyImports()).toHaveLength(1)
})

test('gocardless_qc_token_refuses_a_bare_code_the_state_is_always_checked', async () => {
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, (out) => stateFrom(out) && CODE])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('no state=')
  expect(curlCalls()).toEqual([])
  expect(flyImports()).toEqual([])
})

test('gocardless_qc_token_refuses_an_address_from_another_link', async () => {
  const r = await sb.runTty(SCRIPT, [
    CLIENT_ID,
    CLIENT_SECRET,
    (out) => stateFrom(out) && landed(`cli-${'f'.repeat(32)}`),
  ])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('different link')
  expect(curlCalls()).toEqual([])
  expect(flyImports()).toEqual([])
})

test('gocardless_qc_token_stops_on_a_refusal_in_the_address', async () => {
  const r = await sb.runTty(SCRIPT, [
    CLIENT_ID,
    CLIENT_SECRET,
    (out) => stateFrom(out) && `error=access_denied&state=${stateFrom(out)}`,
  ])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('access_denied')
  expect(curlCalls()).toEqual([])
})

test('gocardless_qc_token_refuses_a_code_older_than_five_minutes', async () => {
  sb.set('date-step', '301')
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, pasteLanded])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('more than 5 minutes')
  expect(curlCalls()).toEqual([])
  expect(flyImports()).toEqual([])
})

test('gocardless_qc_token_prints_only_gocardlesss_error_code_on_a_failed_exchange', async () => {
  sb.set('curl-answer', {
    error: 'invalid_grant',
    error_description: `code ${CODE} for client ${CLIENT_SECRET} is no good`,
  })
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, pasteLanded])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('the exchange failed: invalid_grant (nothing was set)')
  expect(r.stderr + r.stdout).not.toContain('no good')
  expect(flyImports()).toEqual([])
})

test('gocardless_qc_token_refuses_an_answer_without_an_organisation', async () => {
  sb.set('curl-answer', { access_token: TOKEN })
  const r = await sb.runTty(SCRIPT, [CLIENT_ID, CLIENT_SECRET, pasteLanded])
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('no organisation id')
  expect(r.stderr + r.stdout).not.toContain(TOKEN)
  expect(flyImports()).toEqual([])
})

test('gocardless_qc_token_refuses_to_run_without_a_terminal', () => {
  const r = sb.run(SCRIPT, [], { input: `${CLIENT_ID}\n${CLIENT_SECRET}\n${CODE}\n` })
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('run it in a terminal')
  expect(sb.argv().filter(([n]) => n === 'fly' || n === 'curl')).toEqual([])
})
