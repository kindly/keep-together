import { describe, expect, it } from 'vitest'
import { Outbox } from './queue'
import type { OutboxDeps } from './queue'
import type { Outcome } from './api'
import type { ScanUploaded } from '#/lib/data/rust-types/ScanUploaded'

type Sent = Parameters<OutboxDeps['send']>[0]

/**
 * An outbox whose server answers from `script` in turn (then `ok`), with
 * sleeps that return at once but are recorded.
 */
function harness(
  script: Array<
    Outcome<ScanUploaded>['kind'] | Outcome<ScanUploaded> | 'hang'
  > = [],
) {
  const sent: Array<Sent> = []
  const slept: Array<number> = []
  const ended: Array<string> = []
  /** What the outbox keeps on the phone: page id → its scan and opening. */
  const kept = new Map<string, { scanId: string; opens: boolean }>()
  let left = 300
  const outbox = new Outbox({
    send: (page) => {
      sent.push({ ...page })
      const next = script.shift() ?? 'ok'
      if (typeof next !== 'string') return Promise.resolve(next)
      // A request still out: what is kept can be looked at meanwhile.
      if (next === 'hang') return new Promise<never>(() => {})
      if (next === 'ok') {
        return Promise.resolve({
          kind: 'ok',
          value: { scanId: page.scanId, pages: 1, uploadsLeft: --left },
        })
      }
      if (next === 'retry')
        return Promise.resolve({ kind: 'retry', why: 'offline' })
      if (next === 'refused')
        return Promise.resolve({ kind: 'refused', reason: 'invalid' })
      return Promise.resolve({ kind: next } as Outcome<ScanUploaded>)
    },
    sleep: (ms) => {
      slept.push(ms)
      return Promise.resolve()
    },
    changed: () => {},
    ended: (why) => ended.push(why),
    keep: {
      put: (p) => kept.set(p.pageId, { scanId: p.scanId, opens: p.opens }),
      drop: (p) => kept.delete(p.pageId),
    },
  })
  /** Until the outbox has nothing left to send. */
  const drained = async () => {
    for (let i = 0; i < 100 && !outbox.idle; i++)
      await new Promise((r) => setTimeout(r, 0))
  }
  return { outbox, sent, slept, ended, kept, drained }
}

const blob = new Blob(['x'])
const SCAN = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

describe('Outbox', () => {
  it("sends a scan's first page as a new scan and the rest as its pages, in order", async () => {
    const { outbox, sent, drained } = harness()
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    outbox.add(OTHER, blob)
    await drained()
    expect(sent.map((s) => [s.scanId, s.first])).toEqual([
      [SCAN, true],
      [SCAN, false],
      [OTHER, true],
    ])
    expect(outbox.pages.every((p) => p.state === 'sent')).toBe(true)
    expect(outbox.uploadsLeft).toBe(297)
  })

  it('sends a page again with the same ids after a network loss, backing off', async () => {
    const { outbox, sent, slept, drained } = harness([
      'retry',
      'retry',
      'retry',
      'ok',
    ])
    outbox.add(SCAN, blob)
    await drained()
    expect(sent).toHaveLength(4)
    expect(
      new Set(sent.map((s) => `${s.scanId}/${s.pageId}/${s.first}`)).size,
    ).toBe(1)
    expect(slept).toEqual([1000, 2000, 4000])
    expect(outbox.retrying).toBeNull()
    expect(outbox.pages[0].state).toBe('sent')
  })

  it("holds a scan's next page until its first has landed", async () => {
    const { outbox, sent, drained } = harness(['retry', 'ok'])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    expect(sent.map((s) => s.first)).toEqual([true, true, false])
  })

  it('stops when the link ends, keeping what was not sent', async () => {
    const { outbox, sent, ended, drained } = harness(['ok', 'gone'])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    expect(ended).toEqual(['gone'])
    expect(sent).toHaveLength(2)
    expect(outbox.pages.map((p) => p.state)).toEqual([
      'sent',
      'waiting',
      'waiting',
    ])
  })

  it('reports another phone holding the link', async () => {
    const { outbox, ended } = harness(['forbidden'])
    outbox.add(SCAN, blob)
    await new Promise((r) => setTimeout(r, 0))
    expect(ended).toEqual(['forbidden'])
  })

  it("a refused first page leaves the scan's next page to start it", async () => {
    const { outbox, sent, drained } = harness(['refused', 'ok'])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    expect(sent.map((s) => s.first)).toEqual([true, true])
    expect(outbox.pages.map((p) => [p.state, p.problem])).toEqual([
      ['failed', 'invalid'],
      ['sent', undefined],
    ])
  })

  it('the upload limit fails every page still waiting', async () => {
    const { outbox, sent, drained } = harness([
      { kind: 'refused', reason: 'upload_limit' },
    ])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    expect(sent).toHaveLength(1)
    expect(outbox.pages.map((p) => p.problem)).toEqual([
      'upload_limit',
      'upload_limit',
    ])
  })

  it('moves the rest of a scan to a new one when the laptop took it meanwhile', async () => {
    const { outbox, sent, drained } = harness(['ok', 'not_found', 'ok', 'ok'])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    const fresh = outbox.current(SCAN)
    expect(fresh).not.toBe(SCAN)
    expect(fresh).toMatch(/^[0-9a-f]{32}$/)
    expect(
      sent.map((s) => [s.scanId === SCAN ? 'old' : 'new', s.first]),
    ).toEqual([
      ['old', true],
      ['old', false],
      ['new', true],
      ['new', false],
    ])
    expect(outbox.pages.every((p) => p.state === 'sent')).toBe(true)
  })

  it('a missing scan on a first page is a refusal, not a loop', async () => {
    const { outbox, sent, drained } = harness(['not_found'])
    outbox.add(SCAN, blob)
    await drained()
    expect(sent).toHaveLength(1)
    expect(outbox.pages[0]).toMatchObject({ state: 'failed', problem: 'other' })
  })

  it('wakes from a back-off at once when asked', async () => {
    const sent: Array<Sent> = []
    let answers = 0
    const outbox = new Outbox({
      send: (page) => {
        sent.push(page)
        return Promise.resolve(
          answers++ === 0
            ? { kind: 'retry', why: 'offline' }
            : {
                kind: 'ok',
                value: { scanId: page.scanId, pages: 1, uploadsLeft: 1 },
              },
        )
      },
      // A back-off that would last forever without a wake.
      sleep: (_ms, wake) => wake,
      changed: () => {},
      ended: () => {},
    })
    outbox.add(SCAN, blob)
    await new Promise((r) => setTimeout(r, 0))
    expect(outbox.retrying).toEqual({ why: 'offline', attempt: 0 })
    outbox.wake()
    for (let i = 0; i < 10 && !outbox.idle; i++)
      await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(2)
    expect(outbox.idle).toBe(true)
  })

  it('counts as idle once the link has ended, so leaving asks nothing', async () => {
    const { outbox, drained } = harness(['gone'])
    outbox.add(SCAN, blob)
    await drained()
    expect(outbox.pages[0].state).toBe('waiting')
    expect(outbox.idle).toBe(true)
  })

  it('a page unanswered, then refused as the laptop took its scan, may be there twice', async () => {
    const { outbox, drained } = harness(['ok', 'retry', 'not_found'])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    expect(outbox.pages[1]).toMatchObject({ state: 'sent', maybeTwice: true })
    expect(outbox.pages[0].maybeTwice).toBeUndefined()
  })

  it('a page unanswered, then answered as landed after the laptop took its scan, is sent once', async () => {
    // The server answers a known page id on an accepted or discarded
    // scan as landed (L2), so only its next page moves to a new scan.
    const { outbox, sent, drained } = harness([
      'ok',
      'retry',
      'ok',
      'not_found',
      'ok',
    ])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    expect(outbox.pages[1]).toMatchObject({ state: 'sent', retried: true })
    expect(outbox.pages.some((p) => p.maybeTwice)).toBe(false)
    expect(sent.map((s) => [s.scanId === SCAN, s.first])).toEqual([
      [true, true],
      [true, false],
      [true, false],
      [true, false],
      [false, true],
    ])
    expect(sent[2].pageId).toBe(sent[1].pageId)
  })

  it('a page refused at once as its scan was taken is not there twice', async () => {
    const { outbox, drained } = harness(['ok', 'not_found'])
    outbox.add(SCAN, blob)
    outbox.add(SCAN, blob)
    await drained()
    expect(outbox.pages[1].maybeTwice).toBeUndefined()
  })
})

describe('Outbox keeping pages on the phone', () => {
  it('keeps each page from when it is taken until it lands', async () => {
    const { outbox, kept, drained } = harness(['retry'])
    const first = outbox.add(SCAN, blob)
    const next = outbox.add(SCAN, blob)
    expect([...kept.keys()]).toEqual([first.pageId, next.pageId])
    expect(kept.get(first.pageId)).toEqual({ scanId: SCAN, opens: true })
    expect(kept.get(next.pageId)).toEqual({ scanId: SCAN, opens: false })
    await drained()
    expect(kept.size).toBe(0)
  })

  it('stops keeping a refused page', async () => {
    const { outbox, kept, drained } = harness(['refused'])
    outbox.add(SCAN, blob)
    await drained()
    expect(kept.size).toBe(0)
  })

  const ticks = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('keeps the new scan of pages moved off a taken one', async () => {
    const { outbox, kept } = harness(['ok', 'not_found', 'hang'])
    outbox.add(SCAN, blob)
    const moved = outbox.add(SCAN, blob)
    await ticks()
    expect(outbox.current(SCAN)).not.toBe(SCAN)
    expect(kept.get(moved.pageId)).toEqual({
      scanId: outbox.current(SCAN),
      opens: true,
    })
  })

  it('a page opening its scan after the earlier ones were refused is kept as opening it', async () => {
    const { outbox, kept, sent } = harness(['refused', 'hang'])
    outbox.add(SCAN, blob)
    const next = outbox.add(SCAN, blob)
    await ticks()
    expect(sent.slice(0, 2).map((s) => s.first)).toEqual([true, true])
    expect(next.opens).toBe(true)
    expect(kept.get(next.pageId)?.opens).toBe(true)
  })

  it('restores kept pages with their own ids, into the scans the server holds', async () => {
    const { outbox, sent, drained } = harness()
    outbox.restore(
      [
        { scanId: SCAN, pageId: 'c'.repeat(32), blob, opens: false },
        { scanId: OTHER, pageId: 'd'.repeat(32), blob, opens: true },
      ],
      [SCAN],
    )
    await drained()
    expect(sent.map((s) => [s.scanId, s.pageId, s.first])).toEqual([
      [SCAN, 'c'.repeat(32), false],
      [OTHER, 'd'.repeat(32), true],
    ])
  })
})
