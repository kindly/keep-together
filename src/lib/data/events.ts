/**
 * The tenant's change stream (migration-rust.sv, F3 step 3): one
 * `EventSource` on `GET /api/t/{slug}/events` per open tenant. Each event
 * names one committed contract, ids only (`OrgEvent`); the reads that show
 * its entity are invalidated, so whatever is on screen refetches. The open
 * contact's form gets the refetched view as a `server` update and merges
 * it under any typing (contact-form.tsx), as Convex's live query did.
 *
 * Nothing committed while the stream wasn't open is lost:
 * - Each tenant has a cursor (`cursors`): the last event id this tab has,
 *   seeded by a cold load's `/boot` (`Boot.seq`, from the same snapshot as
 *   what it answered) and moved by every event and every `reset`. A stream
 *   opens with `?after=<cursor>`, so the server replays what came since
 *   (or, too far behind, sends one `reset`: refetch everything).
 * - An open with no cursor (a tenant entered without a cold load) starts
 *   live from now, so it invalidates the whole tenant: what is shown
 *   refetches, and everything cached is marked so its next use does. The
 *   server subscribes before it answers, so a refetch begun on `open`
 *   can't miss a commit. The browser's reconnects of that stream do the
 *   same until its first event or reset gives the tenant a cursor.
 * - The browser reconnects by itself after a network error, sending
 *   `Last-Event-ID`. After a refused reconnect (a 502 while the api
 *   restarts, a 401) it gives up for good, so this reopens the stream
 *   itself, with backoff, from the cursor.
 * - Leaving a tenant closes its stream and keeps the cursor: coming back
 *   within the cache's lifetime replays the changes made meanwhile.
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
  // (its history with it) is handled below. A list refetches every page
  // it has loaded, in order (TanStack's infinite query): ten pages are ten
  // round trips per burst, in the background. A1: an email shared with
  // other contacts makes their "also used by" warnings stale too.
  contacts: (slug) => [keys.list(slug), keys.search(slug)],
  // Definitions: the filters, the form's dropdowns, every value's label.
  contact_fields: (slug) => [keys.fields(slug), keys.contacts(slug)],
  contact_field_options: (slug) => [keys.fields(slug), keys.contacts(slug)],
  // A2: a part's name is in every code under it, shown on contacts too.
  // A delete is its own entity (no part left to carry a counter).
  source_codes: (slug) => [keys.sources(slug), keys.contacts(slug)],
  source_code_deletions: (slug) => [keys.sources(slug)],
}

/**
 * Writes this tab made and has already refetched after (the save hooks
 * call `ownWrite` with each answer): their events change nothing here.
 * Only when the answer arrives first: the api publishes after commit,
 * before it writes the response, so the event can win the race. Then the
 * event refetches what the save's own invalidation refetches too, and
 * its key lapses unused. Extra requests, never a missed change.
 * (Registering the counters before the POST would be exact for the
 * slices that save, but wrong for a stale one: its next counter is the
 * other writer's.)
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
  // A code's first use marks it used: the tree offers archive, not delete.
  if (e.contract === 'contacts.acquisition') invalidate(qc, keys.sources(slug))
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

/** The last event id each tenant's stream got (see the top). */
const cursors = new Map<string, number>()

/** A cold load's `/boot`: the stream opens after its snapshot. */
export function setCursor(slug: string, seq: number) {
  cursors.set(slug, seq)
}

/** Waits before reopening a refused stream: 1 s, 2 s, 5 s, then 10 s. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]

/** Follow the tenant's events while mounted (the tenant layout). */
export function useOrgEvents(slug: string) {
  const qc = useQueryClient()
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let source: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    // Every event and reset carries an id: the cursor follows it.
    const seen = (m: MessageEvent) => {
      const id = Number(m.lastEventId)
      if (m.lastEventId !== '' && Number.isSafeInteger(id))
        cursors.set(slug, id)
    }
    const open = () => {
      const after = cursors.get(slug)
      const path = tenantPath(slug, 'events')
      const s = (source = new EventSource(
        apiUrl(after === undefined ? path : `${path}?after=${after}`),
        { withCredentials: true },
      ))
      s.onopen = () => {
        failures = 0
        // Live from now: whatever was read before may be behind. Not on
        // the browser's own reconnect once an event has come: that sends
        // its id as Last-Event-ID, and the server replays from it.
        if (!cursors.has(slug)) invalidate(qc, ['t', slug])
      }
      s.onmessage = (m: MessageEvent<string>) => {
        seen(m)
        let e: OrgEvent
        try {
          e = JSON.parse(m.data) as OrgEvent
        } catch {
          return
        }
        applyEvent(qc, slug, e)
      }
      s.addEventListener('reset', (m) => {
        seen(m)
        invalidate(qc, ['t', slug])
      })
      s.onerror = () => {
        // CONNECTING: the browser is retrying with Last-Event-ID itself.
        if (s.readyState !== EventSource.CLOSED) return
        s.close()
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
        failures += 1
        retry = setTimeout(open, wait)
      }
    }
    open()
    return () => {
      clearTimeout(retry)
      source?.close()
    }
  }, [qc, slug])
}
