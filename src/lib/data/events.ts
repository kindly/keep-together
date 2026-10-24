/**
 * The tenant's change stream (migration-rust.sv, F3 step 3): one
 * `EventSource` on `GET /api/t/{slug}/events` per open tenant. Each event
 * names one committed contract, ids only (`OrgEvent`); the reads that show
 * its entity are invalidated, so whatever is on screen refetches. The open
 * contact's form gets the refetched view as a `server` update and merges
 * it under any typing (contact-form.tsx), as Convex's live query did.
 *
 * The browser reconnects by itself and sends `Last-Event-ID`, so the
 * server replays what was missed; a client too far behind gets one
 * `reset` event and refetches everything.
 */
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { ContactView as WireContact } from './rust-types/ContactView'
import type { OrgEvent } from './rust-types/OrgEvent'
import { apiUrl, tenantPath } from './rust/client'
import { keys } from './rust/keys'

/**
 * What each entity's change invalidates. An entity not listed (a module
 * ported later that forgot to add itself) invalidates the whole tenant:
 * too much, never too little.
 */
const INVALIDATES: Partial<
  Record<string, (slug: string, e: OrgEvent) => Array<QueryKey>>
> = {
  // The list and search show the contact's row; the contact's own view
  // (its history with it) is handled below.
  contacts: (slug) => [keys.list(slug), keys.search(slug)],
  // Definitions: the filters, the form's dropdowns, every value's label.
  contact_fields: (slug) => [keys.fields(slug), keys.contacts(slug)],
  contact_field_options: (slug) => [keys.fields(slug), keys.contacts(slug)],
}

/**
 * Writes this tab made and has already refetched after (the save hooks
 * call `ownWrite` with each answer): their events change nothing here.
 */
const own = new Set<string>()
const ownKey = (slug: string, id: string, contract: string, counter: number) =>
  `${slug}/${id}/${contract}/${counter}`

export function ownWrite(
  slug: string,
  id: string,
  contract: string,
  counter: number,
) {
  const key = ownKey(slug, id, contract, counter)
  own.add(key)
  // An event comes within moments; one that never does (the stream down,
  // and replayed past) mustn't keep the key forever.
  setTimeout(() => own.delete(key), 60_000)
}

/**
 * Invalidate `queryKey`, coalescing a burst: the first event refetches at
 * once; events while that refetch runs mark it dirty, and one more
 * refetch follows it. A bulk write (hundreds of contracts, one event
 * each) costs two refetches, not hundreds cancelled one after another.
 */
const running = new Set<string>()
const dirty = new Set<string>()
function invalidate(
  qc: QueryClient,
  queryKey: QueryKey,
  refetchType: 'active' | 'all' = 'active',
) {
  const k = JSON.stringify(queryKey)
  if (running.has(k)) {
    dirty.add(k)
    return
  }
  running.add(k)
  void qc.invalidateQueries({ queryKey, refetchType }).finally(() => {
    running.delete(k)
    if (dirty.delete(k)) invalidate(qc, queryKey, refetchType)
  })
}

/** Apply one event to the cache. Exported for the tests. */
export function applyEvent(qc: QueryClient, slug: string, e: OrgEvent) {
  const key = ownKey(slug, e.id, e.contract, e.counter)
  if (own.delete(key)) return
  const invalidates = INVALIDATES[e.entity]
  if (!invalidates) {
    invalidate(qc, ['t', slug])
    return
  }
  for (const queryKey of invalidates(slug, e)) invalidate(qc, queryKey)
  if (e.entity === 'contacts') {
    // The view only if this is newer than the counter it holds (an echo
    // of a refetch already made changes nothing); its history always. A
    // view kept for a contact not on screen is fetched too (until its
    // gcTime lapses): coming back to it shows the change from the first
    // frame, as Convex's keep-alive cache did.
    const view = qc.getQueryData<WireContact | null>(keys.contact(slug, e.id))
    const slice = e.contract.split('.')[1] as keyof WireContact['counters']
    const held = view?.counters[slice]
    if (held === undefined || held < e.counter)
      invalidate(qc, keys.contact(slug, e.id), view ? 'all' : 'active')
    else invalidate(qc, keys.history(slug, e.id))
  }
}

/** Follow the tenant's events while mounted (the tenant layout). */
export function useOrgEvents(slug: string) {
  const qc = useQueryClient()
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource(apiUrl(tenantPath(slug, 'events')), {
      withCredentials: true,
    })
    source.onmessage = (m: MessageEvent<string>) => {
      let e: OrgEvent
      try {
        e = JSON.parse(m.data) as OrgEvent
      } catch {
        return
      }
      applyEvent(qc, slug, e)
    }
    source.addEventListener('reset', () => invalidate(qc, ['t', slug]))
    return () => source.close()
  }, [qc, slug])
}
