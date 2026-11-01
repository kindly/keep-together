// @vitest-environment node
// scripts/fly/staging-reset.sh with fly and curl stubbed on PATH: it
// changes nothing without the typed phrase, sets a new generation, and
// waits for /healthz to report that generation. Never run against Fly.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

const SCRIPT = path.join(import.meta.dirname, 'staging-reset.sh')

// fly: `auth whoami` answers per STUB_WHOAMI; `secrets set` records its
// args and, unless STUB_STUCK, makes /healthz report the generation after
// STUB_LAG more polls.
const FLY = `#!/bin/sh
echo "fly $*" >>"$STUB_DIR/calls"
case "$1 $2" in
"auth whoami") exit "\${STUB_WHOAMI:-0}" ;;
"secrets set")
  [ -n "\${STUB_STUCK:-}" ] && exit 0
  for arg; do
    case $arg in KEEP_RESET_GENERATION=*) echo "\${arg#*=}" >"$STUB_DIR/generation" ;; esac
  done
  echo "\${STUB_LAG:-0}" >"$STUB_DIR/lag"
  ;;
esac
`
// curl: the old generation (or a failure) until the lag runs out.
const CURL = `#!/bin/sh
echo "curl $*" >>"$STUB_DIR/calls"
lag=$(cat "$STUB_DIR/lag" 2>/dev/null || echo 0)
if [ ! -e "$STUB_DIR/generation" ] || [ "$lag" -gt 0 ]; then
  echo $((lag - 1)) >"$STUB_DIR/lag"
  [ "$lag" = 2 ] && exit 7 # mid-restart: no answer
  echo '{"ok":true,"resetGeneration":"old"}'
  exit 0
fi
printf '{"ok":true,"resetGeneration":"%s"}\\n' "$(cat "$STUB_DIR/generation")"
`

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-reset-'))
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'fly'), FLY, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'bin', 'curl'), CURL, { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(input, env = {}) {
  const res = spawnSync('bash', [SCRIPT], {
    input,
    encoding: 'utf8',
    env: {
      PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
      STUB_DIR: dir,
      KEEP_RESET_POLL: '0',
      KEEP_RESET_WAIT: '10',
      ...env,
    },
    timeout: 20_000,
  })
  const file = path.join(dir, 'calls')
  const calls = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
  return { ...res, calls }
}

const sets = (calls) => calls.filter((c) => c.startsWith('fly secrets'))

test('anything but the typed phrase changes nothing', () => {
  for (const input of ['', 'yes\n', 'reset keep-prod\n', 'reset keep-staging \n']) {
    const res = run(input)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('nothing was changed')
    expect(sets(res.calls)).toEqual([])
  }
})

test('not signed in to Fly: stops before asking', () => {
  const res = run('reset keep-staging\n', { STUB_WHOAMI: '1' })
  expect(res.status).toBe(1)
  expect(res.stderr).toContain('fly auth login')
  expect(sets(res.calls)).toEqual([])
})

test('sets a UTC-timestamp generation on keep-staging and waits for /healthz to report it', () => {
  const res = run('reset keep-staging\n', { STUB_LAG: '3' })
  expect(res.status, res.stderr).toBe(0)
  const [set] = sets(res.calls)
  expect(set).toMatch(/^fly secrets set -a keep-staging KEEP_RESET_GENERATION=\d{8}T\d{6}Z$/)
  const generation = set.split('=')[1]
  expect(res.stdout).toContain(`keep-staging reset: generation ${generation}`)
  // Polled through the old generation and a failed request.
  const polls = res.calls.filter((c) => c.startsWith('curl'))
  expect(polls.length).toBe(4)
  expect(polls[0]).toContain('https://staging.keep-together.org.uk/healthz')
})

test('gives up when /healthz never reports the new generation, and says why', () => {
  const res = run('reset keep-staging\n', { STUB_STUCK: '1', KEEP_RESET_WAIT: '1' })
  expect(res.status).toBe(1)
  expect(res.stderr).toContain("reports generation 'old'")
  expect(res.stderr).toContain('KEEP_RESET_ON = "demand"')
})
