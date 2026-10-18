import { useAuthToken } from '@convex-dev/auth/react'
import {
  ConvexQueryCacheContext,
  ConvexQueryCacheProvider,
} from 'convex-helpers/react/cache/provider'
import { getFunctionName } from 'convex/server'
import type { FunctionReference } from 'convex/server'
import { convexToJson } from 'convex/values'
import type { Value } from 'convex/values'
import { useCallback, useContext, useEffect } from 'react'
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
 * Idle queries held at once. A contact page leaves 3 of its own behind
 * (`get`, newest `history` page, `forContact`; `members`, `tags` and
 * identifier types are shared by every contact), so this is about 6
 * contacts. convex-helpers drops the query that just went idle, not the
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
      {children}
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
 * Release one query the cache holds idle (nothing renders it) at once,
 * instead of after its 2 minutes: for a subscription its component has
 * replaced and that would otherwise keep re-running on every save. A query
 * something still renders is left alone. The key is convex-helpers'
 * (`createQueryKey` in its hooks).
 */
export function useDropIdle() {
  const { registry } = useContext(ConvexQueryCacheContext)
  return useCallback(
    (query: FunctionReference<'query'>, args: Record<string, Value>) => {
      const key = JSON.stringify([getFunctionName(query), convexToJson(args)])
      const entry = registry?.queries.get(key)
      if (!registry || !entry || entry.refs.size > 0) return
      if (entry.evictTimer !== null) {
        clearTimeout(entry.evictTimer)
        registry.idle -= 1
      }
      entry.unsub()
      registry.queries.delete(key)
    },
    [registry],
  )
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
