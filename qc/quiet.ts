import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { runDir } from './timing'

// Instance holds. A spec that writes in bulk (the paged list's crowd: 100
// contacts a commit) holds its instance quiet while it does, so no timed
// sample on the same deployment waits behind that commit. Convex commits
// one at a time per deployment, so a sample that commits meanwhile pays
// the bulk commit as its own commit → response leg (factory/out/
// builder-fieldperf-report.md). Interference the suite makes is removed,
// not excused.
//
// Files in runs/<id>/quiet/, shared by every worker on this machine:
//   hold-<instance>.json       one holder at a time ('wx' create)
//   busy-<instance>-<pid>.json a worker is timing a sample there
// A sampler marks itself busy and then looks for a hold; a holder takes
// the hold and then waits for the busy marks to go. Either order, one of
// them sees the other. A sampler that finds a hold drops its mark before
// waiting, so a hold never waits on a sampler that waits on it. Every wait
// is bounded, and a mark whose process is gone (or older than any hold or
// sample can last) is ignored and removed.

export interface QuietOptions {
  /** Where the marks live (default runs/<id>/quiet). */
  dir?: string
  /** This process (default process.pid). */
  pid?: number
  /** Longest any one wait lasts before it throws. */
  waitMs?: number
  pollMs?: number
  /** A mark older than this is a crashed worker's, whatever its pid says. */
  staleMs?: number
  now?: () => number
}

/** Longest wait: a crowd call (npx start-up + its commits) is a few s. */
export const QUIET_WAIT_MS = 120_000
/** No hold or sample lasts this long; a mark that has is left over. */
export const QUIET_STALE_MS = 300_000

interface Mark {
  pid: number
  /** What holds, for the error a waiter throws. */
  who: string
  at: number
}

export class QuietTimeoutError extends Error {}

function settings(o: QuietOptions) {
  return {
    dir: o.dir ?? path.join(runDir(), 'quiet'),
    pid: o.pid ?? process.pid,
    waitMs: o.waitMs ?? QUIET_WAIT_MS,
    pollMs: o.pollMs ?? 25,
    staleMs: o.staleMs ?? QUIET_STALE_MS,
    now: o.now ?? Date.now,
  }
}

const holdFile = (dir: string, instance: string) =>
  path.join(dir, `hold-${instance}.json`)
const busyPrefix = (instance: string) => `busy-${instance}-`

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function read(file: string): Mark | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Mark
  } catch {
    // Gone, or caught mid-write: absent either way (a writer's mark is
    // complete before it acts on it).
    return null
  }
}

function stale(m: Mark, s: ReturnType<typeof settings>): boolean {
  return !alive(m.pid) || s.now() - m.at > s.staleMs
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The live hold on `instance` that isn't ours, clearing a stale one. */
function otherHold(instance: string, s: ReturnType<typeof settings>) {
  const file = holdFile(s.dir, instance)
  const hold = read(file)
  if (!hold || hold.pid === s.pid) return null
  if (stale(hold, s)) {
    console.warn(
      `qc: ignoring a stale hold on ${instance} (${hold.who}, pid ${hold.pid})`,
    )
    rmSync(file, { force: true })
    return null
  }
  return hold
}

/** Other workers timing a sample on `instance`, clearing stale marks. */
function busyOthers(instance: string, s: ReturnType<typeof settings>) {
  const prefix = busyPrefix(instance)
  const out: Array<Mark> = []
  for (const name of readdirSync(s.dir)) {
    if (!name.startsWith(prefix)) continue
    const file = path.join(s.dir, name)
    const m = read(file)
    if (!m || m.pid === s.pid) continue
    if (stale(m, s)) {
      console.warn(
        `qc: ignoring a stale busy mark on ${instance} (pid ${m.pid})`,
      )
      rmSync(file, { force: true })
      continue
    }
    out.push(m)
  }
  return out
}

/**
 * Run `fn` (a bulk write) with `instance` held quiet: no other worker
 * times a sample there until it returns. Waits (bounded) for another hold
 * and for samples already under way.
 */
export async function holdQuiet<T>(
  instance: string,
  who: string,
  fn: () => Promise<T>,
  opts: QuietOptions = {},
): Promise<T> {
  const s = settings(opts)
  mkdirSync(s.dir, { recursive: true })
  const file = holdFile(s.dir, instance)
  const mark = (): Mark => ({ pid: s.pid, who, at: s.now() })
  const since = s.now()
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify(mark()), { flag: 'wx' })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const mine = read(file)
    if (mine?.pid === s.pid) {
      throw new Error(
        `qc: ${who}: this worker already holds ${instance} (${mine.who})`,
      )
    }
    // Gone, or stale and cleared: try again at once.
    const other = otherHold(instance, s)
    if (!other) continue
    if (s.now() - since > s.waitMs) {
      throw new QuietTimeoutError(
        `qc: ${who} waited ${s.now() - since} ms for ${instance}, held by ${other.who} (pid ${other.pid})`,
      )
    }
    await sleep(s.pollMs)
  }
  try {
    const waitFrom = s.now()
    for (;;) {
      const busy = busyOthers(instance, s)
      if (!busy.length) break
      if (s.now() - waitFrom > s.waitMs) {
        throw new QuietTimeoutError(
          `qc: ${who} waited ${s.now() - waitFrom} ms for samples on ${instance} to finish (pids ${busy.map((b) => b.pid).join(', ')})`,
        )
      }
      await sleep(s.pollMs)
    }
    return await fn()
  } finally {
    if (read(file)?.pid === s.pid) rmSync(file, { force: true })
  }
}

/**
 * Run `fn` (one timed sample) marked busy on `instance`, once no other
 * worker holds it. The wait comes first, unmarked, so it is never inside
 * the sample's window and never blocks a holder. Returns what `fn` does,
 * and how long the sample waited for a hold (0 if it met none).
 */
export async function sampling<T>(
  instance: string,
  fn: () => Promise<T>,
  opts: QuietOptions = {},
): Promise<{ value: T; waitedMs: number }> {
  const s = settings(opts)
  mkdirSync(s.dir, { recursive: true })
  const file = path.join(s.dir, `${busyPrefix(instance)}${s.pid}.json`)
  const since = s.now()
  let met = false
  for (;;) {
    writeFileSync(
      file,
      JSON.stringify({ pid: s.pid, who: 'sample', at: s.now() }),
    )
    const hold = otherHold(instance, s)
    if (!hold) break
    met = true
    rmSync(file, { force: true })
    while (otherHold(instance, s)) {
      if (s.now() - since > s.waitMs) {
        throw new QuietTimeoutError(
          `qc: a sample waited ${s.now() - since} ms for ${instance}, held by ${hold.who} (pid ${hold.pid})`,
        )
      }
      await sleep(s.pollMs)
    }
  }
  const waitedMs = met ? s.now() - since : 0
  try {
    return { value: await fn(), waitedMs }
  } finally {
    rmSync(file, { force: true })
  }
}
