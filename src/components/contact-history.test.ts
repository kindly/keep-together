import { describe, expect, test } from 'vitest'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import { HistoryFeed } from './contact-history'

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
  const calls: Array<{ opts: Opts; answer: (p: Page) => Promise<void> }> = []
  const fetchPage = (opts: Opts) =>
    new Promise<Page>((resolve) => {
      calls.push({
        opts,
        answer: async (p) => {
          resolve(p)
          await Promise.resolve()
        },
      })
    })
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

  test('an answer to a superseded fetch is dropped', async () => {
    const { calls, feed } = fetcher()
    feed.refresh()
    feed.refresh()
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

  test('a failed fetch is kept to throw; the next good one clears it', async () => {
    const answers: Array<(p: Page | Error) => void> = []
    const feed = new HistoryFeed(
      () =>
        new Promise<Page>((resolve, reject) =>
          answers.push((p) => (p instanceof Error ? reject(p) : resolve(p))),
        ),
    )
    feed.refresh()
    answers[0](new Error('forbidden'))
    await new Promise((r) => setTimeout(r))
    expect(feed.snapshot().error?.message).toBe('forbidden')
    feed.refresh()
    answers[1](page(['a'], 'end-1'))
    await new Promise((r) => setTimeout(r))
    expect(feed.snapshot().error).toBeNull()
  })
})
