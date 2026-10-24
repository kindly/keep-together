// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { FunctionReturnType } from 'convex/server'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { api } from '../../convex/_generated/api'
import { HistoryFeed, useHistoryPages } from './convex-history-feed'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Page = FunctionReturnType<typeof api.contacts.queries.history>

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
})

function Panel({ feed, version }: { feed: HistoryFeed; version: string }) {
  const { moments, error } = useHistoryPages(feed, version, () => true)
  return (
    <p>
      {error ? `failed: ${error.message}` : ''}
      {moments?.map((m) => m.key).join(',') ?? 'loading'}
    </p>
  )
}

test('a failed fetch renders as an error, never throws, and the next root change retries', async () => {
  const answers: Array<Page | Error> = [
    new Error('transient'),
    { page: [{ key: 'a' }], continueCursor: 'end', isDone: true } as never,
  ]
  const feed = new HistoryFeed(() => {
    const answer = answers.shift()!
    return {
      result:
        answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer),
      cancel: () => {},
    }
  })
  await act(async () => root.render(<Panel feed={feed} version="1" />))
  expect(el.textContent).toBe('failed: transientloading')
  // A revisit with the failed feed renders too (no throw), and so does a
  // save's root change, which fetches again.
  await act(async () => root.render(<Panel feed={feed} version="2" />))
  expect(el.textContent).toBe('a')
})
