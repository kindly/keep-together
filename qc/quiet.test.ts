// @vitest-environment node
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { QuietTimeoutError, alive, holdQuiet, sampling } from './quiet'
import type { QuietOptions } from './quiet'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'qc-quiet-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// Two workers in one process: the holder is this process, the sampler our
// parent (alive, so its marks count, and not ours, so they aren't skipped).
const holder = (o: QuietOptions = {}): QuietOptions => ({
  dir,
  pollMs: 5,
  ...o,
})
const sampler = (o: QuietOptions = {}): QuietOptions => ({
  dir,
  pid: process.ppid,
  pollMs: 5,
  ...o,
})

/** A process that has exited: its pid is no one's. */
function deadPid(): number {
  const pid = spawnSync('true').pid
  expect(alive(pid)).toBe(false)
  return pid
}

function deferred() {
  let open!: () => void
  const done = new Promise<void>((r) => (open = r))
  return { open, done }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const marks = () => readdirSync(dir)

describe('holdQuiet and sampling', () => {
  test('a sample waits for the hold, unmarked, and runs once it is released', async () => {
    const events: Array<string> = []
    const release = deferred()
    const held = holdQuiet(
      'qc-1',
      'crowd',
      async () => {
        events.push('hold')
        await release.done
        events.push('release')
      },
      holder(),
    )
    await tick()
    const sample = sampling(
      'qc-1',
      async () => {
        events.push('sample')
        return 7
      },
      sampler(),
    )
    await tick()
    // Waiting: no busy mark, so the holder never waits on it.
    expect(marks()).toEqual(['hold-qc-1.json'])
    expect(events).toEqual(['hold'])
    release.open()
    await held
    const { value, waitedMs } = await sample
    expect(value).toBe(7)
    expect(events).toEqual(['hold', 'release', 'sample'])
    expect(waitedMs).toBeGreaterThanOrEqual(20)
    expect(marks()).toEqual([])
  })

  test('the hold waits for a sample under way', async () => {
    const events: Array<string> = []
    const finish = deferred()
    const sample = sampling(
      'qc-1',
      async () => {
        events.push('sample')
        await finish.done
        events.push('sample done')
      },
      sampler(),
    )
    await tick()
    const held = holdQuiet(
      'qc-1',
      'crowd',
      async () => {
        events.push('hold')
      },
      holder(),
    )
    await tick()
    expect(events).toEqual(['sample'])
    finish.open()
    await Promise.all([sample, held])
    expect(events).toEqual(['sample', 'sample done', 'hold'])
    expect(marks()).toEqual([])
  })

  test('another instance is not held', async () => {
    const release = deferred()
    const held = holdQuiet('qc-1', 'crowd', () => release.done, holder())
    await tick()
    const { waitedMs } = await sampling('qc-2', async () => {}, sampler())
    expect(waitedMs).toBe(0)
    release.open()
    await held
  })

  test("a worker's own hold doesn't hold its samples, and can't nest", async () => {
    await holdQuiet(
      'qc-1',
      'crowd',
      async () => {
        const { waitedMs } = await sampling('qc-1', async () => {}, holder())
        expect(waitedMs).toBe(0)
        await expect(
          holdQuiet('qc-1', 'again', async () => {}, holder()),
        ).rejects.toThrow(/already holds qc-1 \(crowd\)/)
      },
      holder(),
    )
    expect(marks()).toEqual([])
  })

  test('the hold is released when the bulk write throws', async () => {
    await expect(
      holdQuiet(
        'qc-1',
        'crowd',
        () => Promise.reject(new Error('seed failed')),
        holder(),
      ),
    ).rejects.toThrow('seed failed')
    expect(marks()).toEqual([])
  })
})

describe('left over by a crashed worker', () => {
  const mark = (name: string, pid: number, at = Date.now()) =>
    writeFileSync(
      path.join(dir, name),
      JSON.stringify({ pid, who: 'crashed', at }),
    )

  test('a hold whose process is gone is ignored and removed', async () => {
    mark('hold-qc-1.json', deadPid())
    const { waitedMs } = await sampling('qc-1', async () => {}, sampler())
    expect(waitedMs).toBe(0)
    expect(existsSync(path.join(dir, 'hold-qc-1.json'))).toBe(false)
  })

  test('a hold older than any can last is ignored, even with a live pid', async () => {
    mark('hold-qc-1.json', process.pid, 0)
    const { waitedMs } = await sampling(
      'qc-1',
      async () => {},
      sampler({ staleMs: 1000 }),
    )
    expect(waitedMs).toBe(0)
  })

  test("a holder takes over a dead holder's hold", async () => {
    mark('hold-qc-1.json', deadPid())
    let ran = false
    await holdQuiet('qc-1', 'crowd', async () => void (ran = true), holder())
    expect(ran).toBe(true)
    expect(marks()).toEqual([])
  })

  test('a busy mark whose process is gone holds no one up', async () => {
    mark(`busy-qc-1-${process.ppid}.json`, deadPid())
    let ran = false
    await holdQuiet(
      'qc-1',
      'crowd',
      async () => void (ran = true),
      holder({ waitMs: 200 }),
    )
    expect(ran).toBe(true)
  })
})

describe('every wait is bounded', () => {
  test('a sample gives up on a hold that stays, naming the holder', async () => {
    const release = deferred()
    const held = holdQuiet(
      'qc-1',
      'contacts.loadMore crowd 250',
      () => release.done,
      holder(),
    )
    await tick()
    const err = await sampling(
      'qc-1',
      async () => {},
      sampler({ waitMs: 50 }),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(QuietTimeoutError)
    expect(String(err)).toMatch(
      new RegExp(
        `held by contacts.loadMore crowd 250 \\(pid ${process.pid}\\)`,
      ),
    )
    // It left no busy mark behind.
    expect(marks()).toEqual(['hold-qc-1.json'])
    release.open()
    await held
  })

  test('a holder gives up on a sample that never ends, and drops its hold', async () => {
    const finish = deferred()
    const sample = sampling('qc-1', () => finish.done, sampler())
    await tick()
    let ran = false
    const err = await holdQuiet(
      'qc-1',
      'crowd',
      async () => void (ran = true),
      holder({ waitMs: 50 }),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(QuietTimeoutError)
    expect(String(err)).toMatch(new RegExp(`pids ${process.ppid}`))
    expect(ran).toBe(false)
    expect(existsSync(path.join(dir, 'hold-qc-1.json'))).toBe(false)
    finish.open()
    await sample
  })

  test("a holder gives up on another's hold, naming it", async () => {
    // The other holder: a live process that isn't this one.
    writeFileSync(
      path.join(dir, 'hold-qc-1.json'),
      JSON.stringify({ pid: process.ppid, who: 'other crowd', at: Date.now() }),
    )
    await expect(
      holdQuiet('qc-1', 'crowd', async () => {}, holder({ waitMs: 50 })),
    ).rejects.toThrow(/held by other crowd/)
  })
})
