// @vitest-environment node
// scripts/preview/lib.sh's relaxed_settings: converting an install from
// before KEEP_AUTH_POLICY=relaxed moves only the riverside sign-ins
// install.sh generated out of secrets.env, once, keeping a backup; what
// the human set stays, then and on every later update.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, test } from 'vitest'

const lib = path.join(import.meta.dirname, 'lib.sh')
const dirs = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function preview(env, secrets) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'preview-lib-test-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'preview.env'), env)
  writeFileSync(path.join(dir, 'secrets.env'), secrets, { mode: 0o600 })
  return dir
}

const run = (dir) =>
  execFileSync('bash', ['-c', `. "${lib}"; relaxed_settings`], {
    env: { ...process.env, KEEP_PREVIEW_HOME: dir },
    encoding: 'utf8',
  })
const read = (dir, name) => readFileSync(path.join(dir, name), 'utf8')

// As install.sh makes them: openssl rand -base64 18 | tr '+/' '-_', and
// 20 random bytes in base32.
const generated = [
  'KEEP_RIVERSIDE_ADMIN_PASSWORD=Ab3-_xYz0123456789AbCdEf',
  'KEEP_RIVERSIDE_ADMIN_TOTP=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  'KEEP_RIVERSIDE_VIEWER_TOTP=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
]
const keys = ['KEEP_SETTINGS_KEY=a2V5', 'KEEP_AUTH_PEPPER=cGVwcGVy']

test('an old install: policy added, generated sign-ins moved to a backup, the human’s kept', () => {
  const human = 'KEEP_RIVERSIDE_STAFF_PASSWORD=hunter2'
  const dir = preview(
    'KEEP_ENV=dev\n',
    [keys[0], ...generated, human, keys[1]].join('\n') + '\n',
  )
  const out = run(dir)
  expect(out).toContain('added KEEP_AUTH_POLICY=relaxed')
  expect(read(dir, 'preview.env')).toBe('KEEP_ENV=dev\nKEEP_AUTH_POLICY=relaxed\n')
  expect(read(dir, 'secrets.env')).toBe([keys[0], human, keys[1]].join('\n') + '\n')
  expect(read(dir, 'secrets.env.pre-relaxed')).toBe(generated.join('\n') + '\n')
  for (const f of ['secrets.env', 'secrets.env.pre-relaxed'])
    expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600)

  // Later updates: nothing changes, even a sign-in of install.sh's shape
  // the human sets after the conversion.
  const later = 'KEEP_RIVERSIDE_ADMIN_PASSWORD=Zz9-_xYz0123456789AbCdEf'
  writeFileSync(path.join(dir, 'secrets.env'), read(dir, 'secrets.env') + later + '\n')
  const before = read(dir, 'secrets.env')
  expect(run(dir)).toBe('')
  expect(read(dir, 'secrets.env')).toBe(before)
  expect(read(dir, 'secrets.env.pre-relaxed')).toBe(generated.join('\n') + '\n')
})

test('a policy the human set is kept; strict never touches secrets.env', () => {
  const secrets = [...keys, ...generated].join('\n') + '\n'
  const dir = preview('KEEP_AUTH_POLICY=strict\n', secrets)
  expect(run(dir)).toBe('')
  expect(read(dir, 'preview.env')).toBe('KEEP_AUTH_POLICY=strict\n')
  expect(read(dir, 'secrets.env')).toBe(secrets)
  expect(existsSync(path.join(dir, 'secrets.env.pre-relaxed'))).toBe(false)
  expect(existsSync(path.join(dir, 'relaxed-converted'))).toBe(false)
})

test('a fresh relaxed install has nothing to move and is marked converted', () => {
  const dir = preview('KEEP_AUTH_POLICY=relaxed\n', keys.join('\n') + '\n')
  expect(run(dir)).toBe('')
  expect(existsSync(path.join(dir, 'relaxed-converted'))).toBe(true)
  expect(existsSync(path.join(dir, 'secrets.env.pre-relaxed'))).toBe(false)
})

const lookup = (dir) =>
  execFileSync('bash', ['-c', `. "${lib}"; lookup_settings`], {
    env: { ...process.env, KEEP_PREVIEW_HOME: dir },
    encoding: 'utf8',
  })

test('an install from before the address lookup gains the fake one, once', () => {
  const dir = preview('KEEP_ENV=dev\n', '')
  expect(lookup(dir)).toContain('added KEEP_ADDRESS_LOOKUP=fake')
  expect(lookup(dir)).toBe('')
  expect(read(dir, 'preview.env')).toBe('KEEP_ENV=dev\nKEEP_ADDRESS_LOOKUP=fake\n')
})

test('a lookup setting the human chose is kept', () => {
  const dir = preview('KEEP_ADDRESS_LOOKUP=off\n', '')
  expect(lookup(dir)).toBe('')
  expect(read(dir, 'preview.env')).toBe('KEEP_ADDRESS_LOOKUP=off\n')
})
