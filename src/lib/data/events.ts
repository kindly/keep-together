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
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { ContactView as WireContact } from './rust-types/ContactView'
import type { OrgEvent } from './rust-types/OrgEvent'
import { apiUrl, tenantPath } from './rust/client'
import type { Written } from './rust/client'
import { keys } from './rust/keys'

/**
 * What each entity's change invalidates. An entity not listed (a module
 * ported later that forgot to add itself) invalidates the whole tenant:
 * too much, never too little.
 */
/** What an email context shows of a sharer: its emails, name, archived. */
const SHARER_CONTRACTS = new Set([
  'contacts.methods',
  'contacts.details',
  'contacts.archive',
])

const INVALIDATES: Partial<
  Record<string, (slug: string, e: OrgEvent) => Array<QueryKey>>
> = {
  // The list and search show the contact's row; the contact's own view
  // (its history with it) is handled below. A list refetches every page
  // it has loaded, in order (TanStack's infinite query): ten pages are ten
  // round trips per burst, in the background. Other contacts' "also used
  // by" names a sharer and says if it is archived, and follows its emails:
  // a methods, details or archive save anywhere can change it.
  contacts: (slug, e) =>
    SHARER_CONTRACTS.has(e.contract)
      ? [keys.list(slug), keys.search(slug), keys.emailContext(slug)]
      : [keys.list(slug), keys.search(slug)],
  // Definitions: the filters, the form's dropdowns, every value's label.
  contact_fields: (slug) => [keys.fields(slug), keys.contacts(slug)],
  contact_field_options: (slug) => [keys.fields(slug), keys.contacts(slug)],
  // B1: a delete is its own entity (no row left to carry a counter). A
  // retire's start and end are `contacts.fieldRetire` on contact_fields.
  contact_field_deletions: (slug) => [keys.fields(slug)],
  contact_field_option_deletions: (slug) => [keys.fields(slug)],
  // A Settings switch: the groups carry it (and what it means for whom);
  // the source tree carries canManage (A2).
  tenant_preferences: (slug) => [keys.groups, keys.sources(slug)],
  // Secrets: nothing on screen shows them.
  tenant_settings: () => [],
  // A1. A type's name shows on every contact holding one.
  identifier_types: (slug) => [keys.identifierTypes(slug), keys.contacts(slug)],
  // The event names the note, not its contact: every notes list.
  contact_notes: (slug) => [keys.notes(slug)],
  // A hold belongs to the address: every contact's email context.
  email_suppressions: (slug) => [keys.emailContext(slug)],
  // No page shows relationships yet.
  relationship_types: () => [],
  relationships: () => [],
  // A2: a part's name is in every code under it, shown on contacts too.
  // A delete is its own entity (no part left to carry a counter).
  source_codes: (slug) => [keys.sources(slug), keys.contacts(slug)],
  source_code_deletions: (slug) => [keys.sources(slug)],
  // B2: a gift shows on its page, its contact's panel and my recent gifts;
  // a declaration changes coverage there and on the Gift Aid panel. The
  // record-gift save's contact writes come as `contacts` events.
  // A regular gift's card lists its payments' gifts (GoCardless D3):
  // the contacts' lists only, which never call GoCardless.
  // A batch's page lists its gifts and their total (bank transfers 6b);
  // a line's suggestions and the transfers it could match read gifts too:
  // a transfer recorded by hand elsewhere drops a stale pre-tick.
  gifts: (slug) => [
    keys.gifts(slug),
    keys.regularGiftLists(slug),
    keys.batches(slug),
    keys.bank(slug),
    // A standing order's expected vs actual reads its instalments.
    keys.standing(slug),
  ],
  gift_aid_declarations: (slug) => [keys.declarations(slug), keys.gifts(slug)],
  // G3: a claim shows in the list, on its page and in every preview
  // (its gifts are no longer eligible). Its gifts' locks come as `gifts`
  // events (`giving.claimLock`).
  gift_aid_claims: (slug) => [keys.giftaid(slug)],
  gift_aid_hmrc_details: (slug) => [keys.hmrcDetails(slug)],
  // Declaration scans: the inbox, a scan, a sitting's stack (its pairing
  // state rides along: claimed, uploads), a declaration's "scan held",
  // the report and the files usage. An accept that records a declaration
  // comes as a `gift_aid_declarations` event too.
  declaration_scans: (slug) => [keys.scans(slug)],
  // GoCardless D3: a regular gift (its set-up, mandate, terms), a
  // payment, a staff request for one: the cards, the unmatched list.
  // A payment's gift comes as a `gifts` event too.
  // A standing order's expected payment is a suggestion (step 5).
  regular_gifts: (slug) => [
    keys.gocardless(slug),
    keys.bank(slug),
    keys.standing(slug),
  ],
  // A standing order's terms give its expected payments: suggestions.
  regular_gift_terms: (slug) => [
    keys.gocardless(slug),
    keys.bank(slug),
    keys.standing(slug),
  ],
  direct_debit_payments: (slug) => [keys.gocardless(slug)],
  provider_requests: (slug) => [keys.gocardless(slug)],
  // Bank transfers 6a: an account (its name and layout show on every
  // import page) and an import (its account's list, its own page).
  bank_accounts: (slug) => [keys.bank(slug), keys.batches(slug)],
  bank_imports: (slug) => [keys.bank(slug)],
  // A batch, and its line once matched; a bank account's name shows on it.
  paying_in_batches: (slug) => [keys.batches(slug)],
  // Bank transfers 4: a line's match (its gifts come as `gifts` events),
  // a not-a-donation rule (it changes every line's suggestions), a
  // contact's payers forgotten (likewise).
  bank_lines: (slug) => [keys.bank(slug)],
  bank_rules: (slug) => [keys.bank(slug)],
  bank_payer_forgets: (slug) => [keys.bank(slug)],
}

/**
 * Writes this tab made and has already refetched after (the save hooks
 * call `ownWrite` with each answer): their events refetch only what
 * shows the entity elsewhere (gifts showing a donor or code; see
 * `applyEvent`), not the entity's own reads.
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
 *
 * A fetch already in flight is cancelled first: it may have read before
 * the change, and TanStack Query's refetch joins an in-flight fetch of a
 * query that has no data yet instead of restarting it, so the event would
 * be lost (the contact-hold QC flake: a new address's email context,
 * fetched as the hold committed, never showed the hold).
 */
const running = new Set<string>()
/** A burst's events waiting for the running refetch: their latest seq. */
const dirty = new Map<string, number | undefined>()
function invalidate(
  qc: QueryClient,
  queryKey: QueryKey,
  refetchType: 'active' | 'all' = 'active',
  seq?: number,
) {
  const k = JSON.stringify(queryKey)
  if (running.has(k)) {
    // No seq (a reset, a stream opened live) outranks any.
    const was = dirty.has(k) ? dirty.get(k) : seq
    dirty.set(
      k,
      was === undefined || seq === undefined ? undefined : Math.max(was, seq),
    )
    return
  }
  running.add(k)
  // A read a write's answer showed (`showAnswer`) is current through its
  // seq: only a later event refetches it.
  const predicate = (q: Query) => !isFresh(q.queryHash, seq)
  const refetch = () =>
    qc.invalidateQueries({ queryKey, refetchType, predicate })
  const done =
    qc.isFetching({ queryKey, predicate }) > 0
      ? qc.cancelQueries({ queryKey, predicate }).then(refetch)
      : refetch()
  void done.finally(() => {
    running.delete(k)
    if (dirty.has(k)) {
      const next = dirty.get(k)
      dirty.delete(k)
      invalidate(qc, queryKey, refetchType, next)
    }
  })
}

// ── a write's own answer ───────────────────────────────────────────────────

/**
 * Query hash → the seq its cached data is known current through: set by
 * `showAnswer` from the write's `keep-seq`. Every event up to that seq
 * committed before the answer was read, so the answer shows it already.
 */
const fresh = new Map<string, number>()
function isFresh(hash: string, seq: number | undefined) {
  const through = fresh.get(hash)
  return seq !== undefined && through !== undefined && seq <= through
}
function markFresh(hash: string, seq: number) {
  fresh.set(hash, Math.max(seq, fresh.get(hash) ?? seq))
  // Its events come within moments; a mark must not outlive them.
  setTimeout(() => {
    if (fresh.get(hash) === seq) fresh.delete(hash)
  }, 60_000)
}

/**
 * Per tenant: `showAnswer` writes in flight, and the events that came
 * meanwhile. The api publishes a commit's events before it answers, so
 * the echo of a write usually arrives first; held until the answer is
 * shown, it then refetches nothing the answer showed. Someone else's
 * events wait at most one round trip, and HOLD_MAX_MS if an answer hangs.
 */
const writing = new Map<string, number>()
const waiting = new Map<string, Array<() => void>>()
const HOLD_MAX_MS = 10_000

function hold(slug: string) {
  writing.set(slug, (writing.get(slug) ?? 0) + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    clearTimeout(timer)
    const left = (writing.get(slug) ?? 1) - 1
    if (left > 0) {
      writing.set(slug, left)
      return
    }
    writing.delete(slug)
    const queued = waiting.get(slug) ?? []
    waiting.delete(slug)
    for (const apply of queued) apply()
  }
  const timer = setTimeout(release, HOLD_MAX_MS)
  return release
}

/** One event from the stream: applied now, or after this tab's writes. */
export function deliver(qc: QueryClient, slug: string, e: OrgEvent) {
  if (writing.has(slug)) {
    const queued = waiting.get(slug) ?? []
    queued.push(() => applyEvent(qc, slug, e))
    waiting.set(slug, queued)
    return
  }
  applyEvent(qc, slug, e)
}

/** What a write's answer shows: each query key and its new data. */
export type Shown = ReadonlyArray<readonly [QueryKey, unknown]>

/**
 * Run one write and put what its answer shows straight into the cache:
 * one round trip, no refetch after it. Never optimistic: nothing changes
 * before the server answers, and a refused write changes nothing (it
 * throws, as `write` did). The write's own events then skip what it
 * showed; anyone else's still refetch it.
 *
 * A read that a fetch refreshed while the write was in flight may show a
 * commit later than the answer: that one is fetched again instead of
 * being overwritten (never an older state, not even for a moment). A
 * fetch still in flight is cancelled: whatever it might show beyond the
 * answer comes as an event, which refetches.
 */
export async function showAnswer<T>(
  qc: QueryClient,
  slug: string,
  write: () => Promise<Written<T>>,
  show: (answer: T) => Shown,
): Promise<T> {
  const release = hold(slug)
  const sent = Date.now()
  try {
    const { answer, seq } = await write()
    for (const [queryKey, data] of show(answer)) {
      const state = qc.getQueryState(queryKey)
      if (state && state.dataUpdatedAt > sent) {
        void qc.invalidateQueries({ queryKey, exact: true })
        continue
      }
      await qc.cancelQueries({ queryKey, exact: true })
      qc.setQueryData(queryKey, data)
      const q = qc.getQueryCache().find({ queryKey, exact: true })
      if (q && seq !== null) markFresh(q.queryHash, seq)
    }
    return answer
  } finally {
    release()
  }
}

/** Apply one event to the cache. Exported for the tests. */
export function applyEvent(qc: QueryClient, slug: string, e: OrgEvent) {
  // Other entities' reads that show this one. Run for our own writes
  // too: a save hook refreshes its own entity's reads, not these (a
  // donor renamed here still shows its old name on gifts otherwise).
  // A code's first use marks it used: the tree offers archive, not delete.
  if (e.contract === 'contacts.acquisition')
    invalidate(qc, keys.sources(slug), 'active', e.seq)
  // B2: gifts show their donor's name and address and their codes' names.
  if (e.entity === 'contacts' || e.entity === 'source_codes')
    invalidate(qc, keys.gifts(slug), 'active', e.seq)
  const key = ownKey(slug, e.id, e.contract, e.counter)
  // Our own write's echo: its hook has refetched the entity's reads.
  if (own.delete(key)) return
  const invalidates = INVALIDATES[e.entity]
  if (!invalidates) {
    invalidate(qc, ['t', slug], 'active', e.seq)
    return
  }
  for (const queryKey of invalidates(slug, e))
    invalidate(qc, queryKey, 'active', e.seq)
  if (e.entity === 'contacts') {
    // The view only if this is newer than the counter it holds (an echo
    // of a refetch already made changes nothing); its history always. A
    // view kept for a contact not on screen is fetched too (until its
    // gcTime lapses): coming back to it shows the change from the first
    // frame, as Convex's keep-alive cache did.
    const view = qc.getQueryData<WireContact | null>(keys.contact(slug, e.id))
    const slice = e.contract.split('.')[1] as keyof WireContact['counters']
    const shown = view?.counters[slice]
    if (shown === undefined || shown < e.counter)
      invalidate(qc, keys.contact(slug, e.id), view ? 'all' : 'active', e.seq)
    else invalidate(qc, keys.history(slug, e.id), 'active', e.seq)
  }
}

/**
 * The last event id each tenant's stream got (see the top). Opaque:
 * `<generation>.<seq>`, the generation telling a file put back from a
 * backup from the history this tab saw (the server resets a cursor of
 * another generation).
 */
const cursors = new Map<string, string>()

/** A cold load's `/boot`: the stream opens after its snapshot. */
export function setCursor(slug: string, cursor: string) {
  cursors.set(slug, cursor)
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
      if (m.lastEventId !== '') cursors.set(slug, m.lastEventId)
    }
    const open = () => {
      const after = cursors.get(slug)
      const path = tenantPath(slug, 'events')
      const s = (source = new EventSource(
        apiUrl(
          after === undefined
            ? path
            : `${path}?after=${encodeURIComponent(after)}`,
        ),
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
        deliver(qc, slug, e)
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
