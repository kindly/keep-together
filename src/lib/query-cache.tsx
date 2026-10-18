import { useAuthToken } from '@convex-dev/auth/react'
import {
  ConvexQueryCacheContext,
  ConvexQueryCacheProvider,
} from 'convex-helpers/react/cache/provider'
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// The contact page's keep-alive cache (factory/plans/perf-storage.sv,
// step 2). Its queries stay subscribed for 2 minutes after the page
// unmounts, so coming back to a recent contact draws from the client's
// copy at once and stays live: it is a server subscription, not a stored
// result. Only the contact page's components import this `useQuery`; the
// list never does, because every contact save re-runs `list` and a held
// `list` would join every save's wait (lever C). src/lib/query-cache.test.ts
// holds the import list.
export { useQuery } from 'convex-helpers/react/cache/hooks'

/** How long an unmounted contact page's queries stay subscribed. */
export const CACHE_EXPIRATION_MS = 120_000
/**
 * Idle queries held at once. A contact page leaves 5 of its own behind
 * (`getRoot`, `getChannels`, `getTags`, `getIdentifiers`, `forContact`;
 * `members`, `tags` and identifier types are shared by every contact, and
 * history is fetched, not subscribed), so this is about 4 contacts (it was
 * about 6 with one `get`). convex-helpers drops the query that just went idle, not the
 * oldest, once the limit is reached. 20 as confirmed by the human
 * (2026-10-18); ~60 (about 20 contacts) is an open question for them.
 */
export const CACHE_MAX_IDLE = 20

/**
 * The cache, one per signed-in session. Keyed on the token's subject
 * (`<userId>|<sessionId>`, stable across refreshes), so a sign-in as
 * someone else remounts it with nothing in it, and sign-out (which
 * unmounts the tenant layout) drops it. The server re-checks membership on
 * every re-run anyway, and the tenant layout only renders a group that
 * `mine` (part of the same consistent query snapshot) says the new user
 * belongs to.
 */
export function ContactQueryCache({ children }: { children: ReactNode }) {
  const token = useAuthToken()
  return (
    <ConvexQueryCacheProvider
      key={tokenSubject(token) ?? 'signed-out'}
      expiration={CACHE_EXPIRATION_MS}
      maxIdleEntries={CACHE_MAX_IDLE}
    >
      <DropOnUnmount />
      <SessionStoreProvider>{children}</SessionStoreProvider>
    </ConvexQueryCacheProvider>
  )
}

/**
 * convex-helpers keeps an unmounted provider's idle queries subscribed
 * until their timers fire. Release them with the provider instead, so the
 * last session's queries stop at once rather than re-running for two
 * minutes. Whichever cleanup runs first, the page's own `end` calls then
 * find nothing to hold.
 */
function DropOnUnmount() {
  const { registry } = useContext(ConvexQueryCacheContext)
  useEffect(
    () => () => {
      if (!registry) return
      for (const entry of registry.queries.values()) {
        if (entry.evictTimer !== null) clearTimeout(entry.evictTimer)
        entry.unsub()
      }
      registry.queries.clear()
      registry.subs.clear()
      registry.idle = 0
    },
    [registry],
  )
  return null
}

/**
 * State the contact page keeps outside Convex's subscriptions (the history
 * panel's fetched pages), as long as the cache lives: a user switch drops
 * it with the cache.
 */
const SessionStore = createContext<Map<string, unknown> | null>(null)

function SessionStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new Map<string, unknown>())
  return <SessionStore.Provider value={store}>{children}</SessionStore.Provider>
}

export function useSessionStore(): Map<string, unknown> {
  const store = useContext(SessionStore)
  if (!store) throw new Error('useSessionStore outside ContactQueryCache')
  return store
}

/** A JWT's `sub` claim, unverified (only a cache key), or null. */
export function tokenSubject(token: string | null): string | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const sub: unknown = (JSON.parse(json) as { sub?: unknown }).sub
    return typeof sub === 'string' ? sub : null
  } catch {
    return null
  }
}
