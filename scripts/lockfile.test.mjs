// @vitest-environment node
// Races real processes for one lock file: exactly one may win, however
// the contest starts (no lock, stale by age with the racers' own pid,
// dead pid, empty file).
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  newToken,
  readLock,
  refreshLock,
  releaseLock,
  tryLock,
} from './lockfile.mjs'

const lockfile = path.join(import.meta.dirname, 'lockfile.mjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'lockfile-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const HOUR = 60 * 60 * 1000
// RACERS=24 ROUNDS=40 for a soak; 16 racers already caught the old
// pid-based takeover double-winning.
const ROUNDS = Number(process.env.ROUNDS ?? 3)
const RACERS = Number(process.env.RACERS ?? 16)

// Each racer waits for `startAt`, then tries once with this test's pid as
// the owner (as rehearsal claims from one session do) and prints its
// token if it won.
const racer = `
  const { tryLock, newToken } = await import(process.env.LOCKFILE)
  const token = newToken()
  while (Date.now() < Number(process.env.START_AT)) {}
  const now = new Date().toISOString()
  const held = tryLock(process.env.LOCK, {
    pid: Number(process.env.OWNER), startedAt: now, token,
  }, { maxAgeMs: ${HOUR}, label: 'test lock' })
  if (!held) console.log('WON ' + token)
`

function race(lock) {
  const env = {
    ...process.env,
    LOCKFILE: lockfile,
    LOCK: lock,
    OWNER: String(process.pid),
    START_AT: String(Date.now() + 400),
  }
  return Promise.all(
    Array.from(
      { length: RACERS },
      () =>
        new Promise((resolve, reject) =>
          execFile(
            process.execPath,
            ['--input-type=module', '-e', racer],
            { env },
            (err, stdout) =>
              err ? reject(err) : resolve(stdout.match(/WON (\S+)/)?.[1]),
          ),
        ),
    ),
  ).then((tokens) => tokens.filter(Boolean))
}

describe('tryLock under contention', () => {
  const starts = {
    'no lock': () => null,
    'stale by age, same owner pid': () =>
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
        token: 'old',
      }),
    'dead pid': () =>
      JSON.stringify({
        pid: 2 ** 22 + 12345,
        startedAt: new Date().toISOString(),
        token: 'old',
      }),
    'empty file': () => '',
    'corrupt file': () => '{"pid":',
  }
  for (const [name, initial] of Object.entries(starts)) {
    test(`${name}: exactly one of ${RACERS} wins, ${ROUNDS} rounds`, async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const lock = path.join(dir, `${name.replace(/\W+/g, '-')}-${round}`)
        const text = initial()
        if (text !== null) writeFileSync(lock, text)
        const winners = await race(lock)
        expect(winners).toHaveLength(1)
        expect(readLock(lock).token).toBe(winners[0])
      }
    }, 30_000)
  }
})

describe('refresh and release check the token', () => {
  const opts = { maxAgeMs: HOUR, label: 'test lock' }
  const record = (token) => ({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  })

  test('refresh by a former holder fails and leaves the new lock', () => {
    const lock = path.join(dir, 'refresh')
    const mine = newToken()
    expect(tryLock(lock, record(mine), opts)).toBeNull()
    expect(refreshLock(lock, mine, { usedAt: 'x' })).toBe(true)
    expect(readLock(lock).usedAt).toBe('x')
    releaseLock(lock, () => true)
    const theirs = newToken()
    expect(tryLock(lock, record(theirs), opts)).toBeNull()
    const before = readFileSync(lock, 'utf8')
    expect(refreshLock(lock, mine, { usedAt: 'y' })).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe(before)
  })

  test('release obeys its check; an unreadable lock is stale and released', () => {
    const lock = path.join(dir, 'release')
    const token = newToken()
    expect(tryLock(lock, record(token), opts)).toBeNull()
    expect(releaseLock(lock, (l) => l?.token === 'other')).toBe('refused')
    expect(releaseLock(lock, (l) => l?.token === token)).toBe('released')
    expect(releaseLock(lock, () => true)).toBe('absent')
    writeFileSync(lock, '')
    expect(tryLock(lock, record(newToken()), opts)).toBeNull()
  })
})
