import { describe, expect, test } from 'vitest'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import { HistoryFeed, skippedFieldsNote } from './contact-history'

type Page = FunctionReturnType<typeof api.contacts.queries.history>
type Opts = { numItems: number; cursor: string | null; endCursor?: string }

/** A page of moments named by `keys`, ending at cursor `end`. */
const page = (keys: Array<string>, end: string, isDone = false): Page =>
  ({
    page: keys.map((key) => ({ key })),
    continueCursor: end,
    isDone,
  }) as unknown as Page

/** A fetcher whose calls the test answers by hand, in any order. */
function fetcher() {
  const calls: Array<{
    opts: Opts
    cancelled: boolean
    answer: (p: Page | Error) => Promise<void>
  }> = []
  const fetchPage = (opts: Opts) => {
    const call = {
      opts,
      cancelled: false,
      answer: async (_: Page | Error) => {},
    }
    const result = new Promise<Page>((resolve, reject) => {
      call.answer = async (p) => {
        if (p instanceof Error) reject(p)
        else resolve(p)
        await new Promise((r) => setTimeout(r))
      }
    })
    calls.push(call)
    return {
      result,
      cancel: () => {
        call.cancelled = true
      },
    }
  }
  return { calls, feed: new HistoryFeed(fetchPage) }
}

const keys = (p: Page | undefined) => p?.page.map((m) => m.key)

describe('HistoryFeed', () => {
  test('the first fetch pins the newest page’s end; later ones keep it', async () => {
    const { calls, feed } = fetcher()
    feed.refresh()
    expect(calls[0].opts).toEqual({ numItems: 10, cursor: null })
    await calls[0].answer(page(['b', 'a'], 'end-1'))
    expect(keys(feed.snapshot().first)).toEqual(['b', 'a'])

    feed.refresh()
    expect(calls[1].opts).toEqual({
      numItems: 10,
      cursor: null,
      endCursor: 'end-1',
    })
    // Whether more lie past the end is what the pinning fetch found.
    await calls[1].answer(page(['c', 'b', 'a'], 'end-1', true))
    expect(keys(feed.snapshot().first)).toEqual(['c', 'b', 'a'])
    expect(feed.snapshot().first?.isDone).toBe(false)
  })

  test('a superseded fetch is cancelled, and its answer dropped', async () => {
    const { calls, feed } = fetcher()
    feed.refresh()
    feed.refresh()
    expect(calls[0].cancelled).toBe(true)
    await calls[1].answer(page(['new'], 'end-new'))
    await calls[0].answer(page(['old'], 'end-old'))
    expect(keys(feed.snapshot().first)).toEqual(['new'])
    feed.refresh()
    expect(calls[2].opts.endCursor).toBe('end-new')
  })

  test('Load older starts at the pinned end, and the newest page keeps it', async () => {
    const { calls, feed } = fetcher()
    feed.refresh()
    await calls[0].answer(page(['d', 'c'], 'end-1'))
    feed.loadOlder()
    expect(calls[1].opts).toEqual({ numItems: 10, cursor: 'end-1' })
    expect(feed.snapshot().loadingOlder).toBe(true)
    await calls[1].answer(page(['b', 'a'], 'end-2', true))
    expect(feed.snapshot().older.map(keys)).toEqual([['b', 'a']])
    // Done: nothing older to ask for.
    feed.loadOlder()
    expect(calls).toHaveLength(2)

    // A save lands: the newest page grows down to the same end.
    feed.refresh()
    expect(calls[2].opts.endCursor).toBe('end-1')
    await calls[2].answer(page(['e', 'd', 'c'], 'end-1'))
    expect(keys(feed.snapshot().first)).toEqual(['e', 'd', 'c'])
    expect(feed.snapshot().older.map(keys)).toEqual([['b', 'a']])
  })

  test('re-anchoring fetches the newest page afresh, never under older pages', async () => {
    const { calls, feed } = fetcher()
    feed.refresh()
    await calls[0].answer(page(['c', 'b', 'a'], 'end-1'))
    feed.reanchor()
    expect(feed.snapshot().anchoring).toBe(true)
    expect(calls[1].opts).toEqual({ numItems: 10, cursor: null })
    // Older pages wait for the fresh page's end.
    feed.loadOlder()
    expect(calls).toHaveLength(2)
    // The grown page stays on screen meanwhile.
    expect(keys(feed.snapshot().first)).toEqual(['c', 'b', 'a'])
    await calls[1].answer(page(['c', 'b'], 'end-2'))
    expect(feed.snapshot().anchoring).toBe(false)
    feed.refresh()
    expect(calls[2].opts.endCursor).toBe('end-2')
    await calls[2].answer(page(['c', 'b'], 'end-2'))

    feed.loadOlder()
    await calls[3].answer(page(['a'], 'end-3', true))
    feed.reanchor()
    expect(calls).toHaveLength(4)
    // A new visit drops the older pages; then it may re-anchor again.
    feed.forgetOlder()
    expect(feed.snapshot().older).toEqual([])
    feed.reanchor()
    expect(calls[4].opts).toEqual({ numItems: 10, cursor: null })
  })

  test('a failed fetch is state, kept with the last page; a retry clears it', async () => {
    const { calls, feed } = fetcher()
    feed.refresh()
    await calls[0].answer(new Error('forbidden'))
    expect(feed.snapshot().error?.message).toBe('forbidden')
    expect(feed.snapshot().first).toBeUndefined()
    feed.refresh()
    await calls[1].answer(page(['a'], 'end-1'))
    expect(feed.snapshot().error).toBeNull()
    expect(keys(feed.snapshot().first)).toEqual(['a'])

    // A later failure keeps the moments on screen.
    feed.refresh()
    await calls[2].answer(new Error('read limit'))
    expect(feed.snapshot().error?.message).toBe('read limit')
    expect(keys(feed.snapshot().first)).toEqual(['a'])

    // Load older fails on its own, and retries.
    feed.loadOlder()
    await calls[3].answer(new Error('transient'))
    expect(feed.snapshot()).toMatchObject({ loadingOlder: false })
    expect(feed.snapshot().olderError?.message).toBe('transient')
    feed.loadOlder()
    expect(feed.snapshot().olderError).toBeNull()
    await calls[4].answer(page(['older'], 'end-2', true))
    expect(feed.snapshot().older.map(keys)).toEqual([['older']])
  })

  test('held while a save is out: a fetch in flight is cancelled and sent again on release', async () => {
    const { calls, feed } = fetcher()
    feed.refresh()
    await calls[0].answer(page(['b', 'a'], 'end-1'))
    feed.refresh()
    feed.loadOlder()
    feed.hold()
    expect(calls[1].cancelled).toBe(true)
    expect(calls[2].cancelled).toBe(true)
    // Asked again while held (the save's own root change): nothing sent.
    feed.refresh()
    expect(calls).toHaveLength(3)
    // A cancelled fetch's late answer changes nothing.
    await calls[1].answer(page(['stale'], 'end-1'))
    expect(keys(feed.snapshot().first)).toEqual(['b', 'a'])

    feed.release()
    expect(calls.slice(3).map((c) => c.opts)).toEqual([
      { numItems: 10, cursor: null, endCursor: 'end-1' },
      { numItems: 10, cursor: 'end-1' },
    ])
    await calls[3].answer(page(['c', 'b', 'a'], 'end-1'))
    await calls[4].answer(page(['z'], 'end-2', true))
    expect(keys(feed.snapshot().first)).toEqual(['c', 'b', 'a'])
    expect(feed.snapshot().older.map(keys)).toEqual([['z']])
  })

  test('holds nest; nothing is sent until the last save settles', async () => {
    const { calls, feed } = fetcher()
    feed.hold()
    feed.hold()
    feed.refresh()
    feed.release()
    expect(calls).toHaveLength(0)
    feed.release()
    expect(calls).toHaveLength(1)
    await calls[0].answer(page(['a'], 'end-1'))
    // Nothing waited: a release sends nothing.
    feed.hold()
    feed.release()
    expect(calls).toHaveLength(1)
  })
})

describe('skippedFieldsNote', () => {
  test('nothing skipped says nothing', () => {
    expect(skippedFieldsNote([])).toBeNull()
  })

  test('names each skipped field with its reason', () => {
    expect(
      skippedFieldsNote([
        { label: 'Region', reason: 'retired' },
        { label: 'Type', reason: 'wrong_kind' },
        { label: 'Status', reason: 'added_after' },
      ]),
    ).toBe(
      'Restored, except: Region (the field has been retired); ' +
        'Type (the field no longer applies to this kind of contact); ' +
        'Status (the field was added after this point; its value is kept).',
    )
  })
})
