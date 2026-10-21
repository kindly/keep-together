// @vitest-environment node
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { LiveRun } from './live'
import { LIVE_LINK_FILE } from './link.setup'
import { LIVE_CALLS_FILE } from './server-timings'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'qc-live-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const calls = (lines: Array<object | string>) =>
  appendFileSync(
    path.join(dir, LIVE_CALLS_FILE),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(''),
  )
const call = (instance: string, at: number, fn = 'a:b', mark = false) =>
  JSON.stringify({
    instance,
    at,
    fn,
    type: 'Query',
    ms: 5,
    ...(mark && { mark: true }),
  }) + '\n'
// Unreachable: a ping fails fast and the stream decides.
const pool = [
  { name: 'qc-1', url: 'http://127.0.0.1:9' },
  { name: 'qc-2', url: 'http://127.0.0.1:9' },
]

describe('LiveRun', () => {
  test('reads what was appended since, holds a line still being written', () => {
    const live = new LiveRun(dir, pool)
    calls([call('qc-1', 100), call('qc-1', 110).slice(0, 20)])
    expect(live.context().calls.map((c) => c.at)).toEqual([100])
    calls([call('qc-1', 110).slice(20), call('qc-2', 120)])
    expect(live.context().calls.map((c) => c.at)).toEqual([100, 110, 120])
  })

  test('marks (pings, probes) show progress but are no calls', () => {
    const live = new LiveRun(dir, pool)
    calls([call('qc-1', 100), call('qc-1', 200, 'platform/qcProbe:rtt', true)])
    expect(live.context().calls.map((c) => c.at)).toEqual([100])
  })

  test('a torn line in the middle is skipped and counted', () => {
    const live = new LiveRun(dir, pool)
    calls([call('qc-1', 100), '{"instance":\n', call('qc-1', 120)])
    const ctx = live.context()
    expect(ctx.calls.map((c) => c.at)).toEqual([100, 120])
    expect(ctx.skipped).toBe(1)
  })

  test('catchUp waits until every instance has passed the time', async () => {
    const live = new LiveRun(dir, pool)
    calls([call('qc-1', 1_000), call('qc-2', 500)])
    const done = live.catchUp(900, 2_000)
    setTimeout(() => calls([call('qc-2', 950, 'p', true)]), 150)
    await expect(done).resolves.toBe(true)
  })

  test('catchUp gives up after the timeout', async () => {
    const live = new LiveRun(dir, pool)
    calls([call('qc-1', 1_000)])
    await expect(live.catchUp(900, 300)).resolves.toBe(false)
  })

  test('probes come from every rtt file in the run', () => {
    writeFileSync(
      path.join(dir, 'rtt-1.jsonl'),
      JSON.stringify({ at: 1, ms: 30, lagMs: 0, worker: 0, instance: 'qc-1' }) +
        '\n',
    )
    expect(new LiveRun(dir, pool).context().probes).toHaveLength(1)
  })
})

describe('LiveRun.linkMs', () => {
  const link = (lines: Array<[number, number, number | null]>) =>
    appendFileSync(
      path.join(dir, LIVE_LINK_FILE),
      lines.map((l) => JSON.stringify(l) + '\n').join(''),
    )

  test('null without a monitor', () => {
    expect(new LiveRun(dir, pool).linkMs(0, 100)).toBeNull()
  })

  test('the worst reply in flight', () => {
    link([
      [1, 1000, 2],
      [2, 1100, 250],
      [3, 1200, 3],
    ])
    expect(new LiveRun(dir, pool).linkMs(1300, 1340)).toBe(250)
  })

  test('an echo unanswered until the link came back counts from its send', () => {
    // seq 2 never answered; seq 3 sent at 1400 came back at 1402.
    link([
      [1, 1000, 2],
      [2, 1100, null],
      [3, 1400, 2],
    ])
    expect(new LiveRun(dir, pool).linkMs(1200, 1250)).toBe(302)
  })

  test('an echo reported unanswered then answered late is a reply', () => {
    link([
      [2, 1100, null],
      [2, 1100, 180],
    ])
    expect(new LiveRun(dir, pool).linkMs(1150, 1200)).toBe(180)
  })
})
