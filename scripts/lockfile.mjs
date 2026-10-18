// Lock files in the main checkout shared by worktrees (.qc.lock,
// .rehearsal-<n>.lock). A lock is a JSON record with `pid`, `startedAt`
// and a `token` unique to the attempt that wrote it; the pid can repeat
// (a rehearsal lock's pid is the claiming session, which claims many
// times), the token never does. It is stale once that pid is dead, once
// it is older than `maxAgeMs` (pid reuse, or another user's process
// answering EPERM), or when it is empty or unreadable; a stale lock is
// taken over.
//
// Races: a lock file appears whole (written aside, then hard-linked into
// place, which fails if one exists), so only one creator wins and nobody
// reads a half-written lock. Every change to an existing lock (takeover,
// release, refresh) runs under `<lock>.guard`, re-reads the lock and
// acts only if it is still the one judged (same bytes, or the caller's
// token), so it can never remove or overwrite a lock that replaced it.
// The one gap: a process that dies holding the guard leaves it for the
// next comer to clear, and two processes clearing the same dead guard at
// once could both enter. That takes a crash inside a millisecond window.
import { randomUUID } from 'node:crypto'
import {
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

export const newToken = () => randomUUID()

function readRaw(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function parse(raw) {
  try {
    const lock = JSON.parse(raw)
    return lock && typeof lock === 'object' ? lock : null
  } catch {
    return null
  }
}

// The lock's record; null when there is none or it is unreadable.
export const readLock = (file) => parse(readRaw(file))

export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// A lock's age is measured from `usedAt` when the holder refreshes it,
// else from `startedAt`. An unreadable lock (null) is stale.
export function isStale(lock, maxAgeMs) {
  if (!lock) return true
  const age = Date.now() - Date.parse(lock.usedAt ?? lock.startedAt)
  return !alive(lock.pid) || age > maxAgeMs
}

const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Write `text` to a private file beside `file`, for linking or renaming
// into place whole.
function writeAside(file, text) {
  const tmp = `${file}.${process.pid}.${newToken()}.tmp`
  writeFileSync(tmp, text)
  return tmp
}

// Create `file` holding `text` if it doesn't exist. True if we made it.
function createWhole(file, text) {
  const tmp = writeAside(file, text)
  try {
    linkSync(tmp, file)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw new Error(
      `cannot create ${file} (${err.code}); run outside the Claude sandbox`,
    )
  } finally {
    unlinkSync(tmp)
  }
}

// Run `fn` holding `<lockPath>.guard`. A guard whose pid is dead is
// cleared (moved aside, and put back if it turns out to be a newer one).
function withGuard(lockPath, fn) {
  const guard = `${lockPath}.guard`
  const mine = JSON.stringify({ pid: process.pid, token: newToken() })
  for (let tries = 0; !createWhole(guard, mine); tries++) {
    const raw = readRaw(guard)
    if (raw !== null && !alive(parse(raw)?.pid)) {
      const aside = `${guard}.dead-${process.pid}`
      try {
        renameSync(guard, aside)
        if (readRaw(aside) !== raw) {
          try {
            linkSync(aside, guard)
          } catch {
            /* a newer guard is already there */
          }
        }
        unlinkSync(aside)
      } catch {
        /* someone else cleared it */
      }
      continue
    }
    if (tries > 500) throw new Error(`${guard} is held; try again`)
    sleepSync(10)
  }
  try {
    return fn()
  } finally {
    if (readRaw(guard) === mine) unlinkSync(guard)
  }
}

// Write `record` (which carries a fresh `token`) to `lockPath` unless a
// live lock is there. Returns null on success, else the holder's record
// ({} when it is unreadable). `label` names the lock in the takeover
// message.
export function tryLock(lockPath, record, { maxAgeMs, label }) {
  const text = JSON.stringify(record) + '\n'
  for (;;) {
    if (createWhole(lockPath, text)) return null
    const raw = readRaw(lockPath)
    if (raw === null) continue
    const holder = parse(raw)
    if (!isStale(holder, maxAgeMs)) return holder
    const outcome = withGuard(lockPath, () => {
      // Still the lock we judged stale? Anything else is re-judged.
      if (readRaw(lockPath) !== raw) return 'changed'
      unlinkSync(lockPath)
      console.log(
        holder
          ? `▸ taking over stale ${label} (pid ${holder.pid} from ${holder.worktree}, since ${holder.startedAt}, is gone or too old)`
          : `▸ taking over unreadable ${label}`,
      )
      return createWhole(lockPath, text) ? 'won' : 'changed'
    })
    if (outcome === 'won') return null
  }
}

// Rewrite the lock with `patch` merged in, only if it still carries
// `token`. False if someone else holds it now.
export function refreshLock(lockPath, token, patch) {
  return withGuard(lockPath, () => {
    const lock = readLock(lockPath)
    if (lock?.token !== token) return false
    const tmp = writeAside(
      lockPath,
      JSON.stringify({ ...lock, ...patch }) + '\n',
    )
    renameSync(tmp, lockPath)
    return true
  })
}

// Remove the lock if `allow(lock)` says so (lock is null when unreadable).
// Returns 'released', 'absent' or 'refused'.
export function releaseLock(lockPath, allow) {
  return withGuard(lockPath, () => {
    const raw = readRaw(lockPath)
    if (raw === null) return 'absent'
    if (!allow(parse(raw))) return 'refused'
    unlinkSync(lockPath)
    return 'released'
  })
}
