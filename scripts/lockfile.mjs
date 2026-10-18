// Lock files in the main checkout shared by worktrees (.qc.lock,
// .rehearsal-<n>.lock). A lock is a JSON record with at least `pid` and
// `startedAt`; it is stale once that pid is dead or the lock is older
// than `maxAgeMs` (pid reuse, or another user's process answering EPERM),
// and a stale lock is taken over.
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

export function readLock(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// A lock's age is measured from `usedAt` when the holder refreshes it,
// else from `startedAt`.
export function isStale(lock, maxAgeMs) {
  const age = Date.now() - Date.parse(lock.usedAt ?? lock.startedAt)
  return !alive(lock.pid) || age > maxAgeMs
}

// Write `record` to `lockPath` unless a live lock is there. Returns null
// on success, else the holder's record. `label` names the lock in the
// takeover message.
export function tryLock(lockPath, record, { maxAgeMs, label }) {
  try {
    const fd = openSync(lockPath, 'wx')
    writeFileSync(fd, JSON.stringify(record) + '\n')
    closeSync(fd)
    return null
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw new Error(
        `cannot create ${lockPath} (${err.code}); run outside the Claude sandbox`,
      )
    }
  }
  const holder = readLock(lockPath)
  // A lock being written right now reads as empty: treat it as held.
  if (!holder) return { pid: '?' }
  if (!isStale(holder, maxAgeMs)) return holder
  // Stale: move it aside atomically, so only one waiter takes it over.
  const aside = `${lockPath}.stale-${process.pid}`
  try {
    renameSync(lockPath, aside)
  } catch {
    return holder
  }
  const moved = readLock(aside)
  if (moved && moved.pid !== holder.pid && alive(moved.pid)) {
    // Someone else's fresh lock landed between our read and rename: put
    // it back (link fails if yet another lock appeared, which is fine).
    try {
      linkSync(aside, lockPath)
    } catch {
      /* lockPath already taken */
    }
    unlinkSync(aside)
    return moved
  }
  unlinkSync(aside)
  console.log(
    `▸ taking over stale ${label} (pid ${holder.pid} from ${holder.worktree}, since ${holder.startedAt}, is gone or too old)`,
  )
  return tryLock(lockPath, record, { maxAgeMs, label })
}
