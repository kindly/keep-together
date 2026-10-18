// @vitest-environment happy-dom
import { ConvexProvider } from 'convex/react'
import type { ConvexReactClient } from 'convex/react'
import { getFunctionName } from 'convex/server'
import { convexToJson } from 'convex/values'
import type { Value } from 'convex/values'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import { ContactQueryCache, useQuery } from './query-cache'

// DropOnUnmount reaches into convex-helpers' cache internals
// (its registry, entries and key format). These run convex-helpers' own
// hooks against a client that counts live subscriptions, so an upgrade
// that changes those internals fails here instead of silently leaving
// queries subscribed (re-running on every save) for their 2 minutes.

vi.mock('@convex-dev/auth/react', () => ({ useAuthToken: () => null }))

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const getRoot = api.contacts.queries.getRoot
type Args = Record<string, Value>
const A: Args = { page: 'a' }
const B: Args = { page: 'b' }

/** A client whose watches only count their live subscriptions per query. */
function countingClient() {
  const live = new Map<string, number>()
  const key = (query: unknown, args: Args) =>
    JSON.stringify([getFunctionName(query as never), convexToJson(args)])
  const client = {
    watchQuery: (query: unknown, args: Args) => ({
      onUpdate: () => {
        const k = key(query, args)
        live.set(k, (live.get(k) ?? 0) + 1)
        return () => live.set(k, (live.get(k) ?? 0) - 1)
      },
      localQueryResult: () => undefined,
      journal: () => undefined,
    }),
  }
  return {
    client: client as unknown as ConvexReactClient,
    live: (args: Args) => live.get(key(getRoot, args)) ?? 0,
  }
}

function Page({ args }: { args: Args }) {
  useQuery(getRoot, args as never)
  return null
}

let root: Root
beforeEach(() => {
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
})

describe('contact query cache internals', () => {
  test('ContactQueryCache releases its idle queries when it unmounts', () => {
    const { client, live } = countingClient()
    const tree = (args: Args) => (
      <ConvexProvider client={client}>
        <ContactQueryCache>
          <Page args={args} />
        </ContactQueryCache>
      </ConvexProvider>
    )
    act(() => root.render(tree(A)))
    act(() => root.render(tree(B)))
    expect(live(A)).toBe(1)
    act(() =>
      root.render(<ConvexProvider client={client}>{null}</ConvexProvider>),
    )
    expect(live(A)).toBe(0)
    expect(live(B)).toBe(0)
  })
})
