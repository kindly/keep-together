import { useConvex, useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { joinMoments } from '../../convex/contacts/history'
import type { Moment } from '../../convex/contacts/history'
import { useCanWrite, useTenant } from '../lib/tenant'
import { useQuery, useSessionStore } from '../lib/query-cache'

/** Revisions per history page (the server caps it at HISTORY_PAGE_LIMIT). */
const PAGE = 10
/**
 * Moments the newest page may grow to before it is fetched afresh (see
 * HistoryFeed.reanchor).
 */
export const REANCHOR_AT = 2 * PAGE
/** Contacts whose fetched history the session keeps for a revisit. */
const FEEDS_KEPT = 20
// One formatter for every moment: `toLocaleString` with options builds a
// new one per call, on every render of the page (each save re-renders it).
const AT = new Intl.DateTimeFormat([], {
  dateStyle: 'short',
  timeStyle: 'short',
})

type HistoryPage = FunctionReturnType<typeof api.contacts.queries.history>
type PageOpts = { numItems: number; cursor: string | null; endCursor?: string }

type FeedState = {
  /** The newest page, as last fetched. */
  first: HistoryPage | undefined
  /** Pages "Load older" fetched, each starting where the one above ends. */
  older: Array<HistoryPage>
  loadingOlder: boolean
  /** A fresh newest page is on its way (see `reanchor`). */
  anchoring: boolean
  error: Error | null
}

/**
 * One contact's history, fetched rather than subscribed. A subscribed
 * newest page re-runs on every save of the contact, and the client sees a
 * save only once every query it invalidated has re-run, so the history
 * would hold up "saved" on each one. Revisions never change once written,
 * so a fetched page stays true; what's new is a revision on top, and every
 * revision of a contact bumps a counter on its root. The page calls
 * `refresh` whenever the root changes (its own saves and everyone else's),
 * which costs the history one round trip after the save, off its path.
 *
 * The newest page keeps the end its first fetch found (`endCursor`), as a
 * live paginated subscription would, so it grows as saves land and the
 * older pages under it never leave a gap. `reanchor` fetches the newest
 * PAGE afresh, only while no older page hangs off its end.
 */
export class HistoryFeed {
  private state: FeedState = {
    first: undefined,
    older: [],
    loadingOlder: false,
    anchoring: false,
    error: null,
  }
  /** Where the newest page ends; null until a fetch has pinned it. */
  private end: { cursor: string; isDone: boolean } | null = null
  private newestCall = 0
  private olderCall = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly fetchPage: (opts: PageOpts) => Promise<HistoryPage>,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot = () => this.state

  private set(patch: Partial<FeedState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Fetch the newest page again, down to its pinned end. */
  refresh() {
    const call = ++this.newestCall
    const end = this.end
    this.fetchPage({
      numItems: PAGE,
      cursor: null,
      ...(end && { endCursor: end.cursor }),
    }).then(
      (page) => {
        if (call !== this.newestCall) return
        this.end ??= { cursor: page.continueCursor, isDone: page.isDone }
        // Its end is pinned, so whether more lie beyond it is what the
        // pinning fetch found.
        const first = { ...page, isDone: this.end.isDone }
        this.set({ first, anchoring: false, error: null })
      },
      (error: unknown) => {
        if (call !== this.newestCall) return
        this.set({ anchoring: false, error: asError(error) })
      },
    )
  }

  /**
   * The newest PAGE afresh, its end pinned anew, so a page grown by a long
   * session costs one page again. The grown page stays on screen until the
   * fresh one arrives. Not while older pages hang off its end.
   */
  reanchor() {
    if (this.state.older.length > 0 || this.state.loadingOlder) return
    this.end = null
    this.set({ anchoring: true })
    this.refresh()
  }

  loadOlder() {
    const { first, older, loadingOlder, anchoring } = this.state
    const last = older.at(-1) ?? first
    if (!last || !this.end || loadingOlder || anchoring || last.isDone) return
    const cursor = older.length > 0 ? last.continueCursor : this.end.cursor
    const call = ++this.olderCall
    this.set({ loadingOlder: true })
    this.fetchPage({ numItems: PAGE, cursor }).then(
      (page) => {
        if (call !== this.olderCall) return
        this.set({ older: [...this.state.older, page], loadingOlder: false })
      },
      (error: unknown) => {
        if (call !== this.olderCall) return
        this.set({ loadingOlder: false, error: asError(error) })
      },
    )
  }

  /** A new visit starts with the newest page only. */
  forgetOlder() {
    this.olderCall++
    if (this.state.older.length > 0 || this.state.loadingOlder)
      this.set({ older: [], loadingOlder: false })
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * The contact's feed, kept for the session so a revisit shows the last
 * history at once (then fetches it again). Bounded: least recently opened
 * first out.
 */
function useHistoryFeed(id: Id<'contacts'>): HistoryFeed {
  const tenant = useTenant()
  const convex = useConvex()
  const store = useSessionStore()
  return useMemo(() => {
    const key = `history:${tenant._id}:${id}`
    let feed = store.get(key) as HistoryFeed | undefined
    store.delete(key)
    feed ??= new HistoryFeed((paginationOpts) =>
      convex.query(api.contacts.queries.history, {
        tenantId: tenant._id,
        id,
        paginationOpts,
      }),
    )
    store.set(key, feed)
    const feeds = [...store.keys()].filter((k) => k.startsWith('history:'))
    for (const old of feeds.slice(0, -FEEDS_KEPT)) store.delete(old)
    return feed
  }, [store, convex, tenant._id, id])
}

/**
 * The newest page plus the older pages "Load older" asked for, fetched
 * again whenever `version` (the root's counters) changes. Past REANCHOR_AT
 * moments, and only while no older page hangs off its end, the newest page
 * is fetched afresh; that hides the older half of the moments, so it waits
 * while someone is reading the panel (`atRest`).
 */
function useHistoryPages(
  id: Id<'contacts'>,
  version: string,
  atRest: () => boolean,
) {
  const feed = useHistoryFeed(id)
  const state = useSyncExternalStore(feed.subscribe, feed.snapshot)
  useEffect(() => feed.forgetOlder(), [feed])
  useEffect(() => feed.refresh(), [feed, version])
  const { first, older, error } = state
  if (error) throw error
  const grown =
    first !== undefined &&
    older.length === 0 &&
    !state.loadingOlder &&
    !state.anchoring &&
    first.page.length > REANCHOR_AT
  useEffect(() => {
    if (!grown) return
    if (atRest()) return feed.reanchor()
    // Mid-read: try again whenever that might have ended.
    const retry = () => {
      if (atRest()) feed.reanchor()
    }
    const later = () => setTimeout(retry)
    const events = ['scroll', 'pointerover', 'focusout'] as const
    for (const e of events) window.addEventListener(e, later, { passive: true })
    return () => {
      for (const e of events) window.removeEventListener(e, later)
    }
  }, [grown, feed, atRest])
  if (first === undefined) return { moments: undefined }
  const pages = [first, ...older]
  const last = pages[pages.length - 1]
  return {
    moments: joinMoments(pages.flatMap((p) => p.page)),
    loading: state.loadingOlder,
    // Not while a fresh newest page loads: older pages start at its end.
    loadOlder:
      state.loadingOlder || state.anchoring || last.isDone
        ? undefined
        : () => feed.loadOlder(),
  }
}

/**
 * The timeline as moments, newest first, a page at a time; "Restore to
 * here" re-executes every slice's state at that time, from any page.
 */
export function ContactHistory({
  id,
  version,
  archived,
  archiveVersion,
}: {
  id: Id<'contacts'>
  /** Changes whenever the contact's root does: fetch the history again. */
  version: string
  archived: boolean
  archiveVersion: number
}) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const panel = useRef<HTMLElement>(null)
  const atRest = useCallback(() => {
    const el = panel.current
    if (!el) return true
    // Not scrolled past the panel's top, not under the pointer, no focus.
    return (
      el.getBoundingClientRect().top >= 0 &&
      !el.matches(':hover') &&
      !el.contains(document.activeElement)
    )
  }, [])
  const { moments, loading, loadOlder } = useHistoryPages(id, version, atRest)
  const members = useQuery(api.platform.tenants.members, {
    tenantId: tenant._id,
  })
  const restoreTo = useMutation(api.contacts.mutations.restoreTo)
  const setArchived = useMutation(api.contacts.mutations.setArchived)
  const name = (userId: Id<'users'> | null) =>
    members?.find((m) => m.userId === userId)?.name ?? 'system'
  return (
    <aside ref={panel} className="flex flex-col gap-4 text-sm">
      {canWrite && (
        <button
          type="button"
          onClick={() =>
            void setArchived({
              tenantId: tenant._id,
              id,
              expected: archiveVersion,
              archived: !archived,
            })
          }
          className="self-start rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
      )}
      <h2 className="text-lg font-medium">History</h2>
      {moments === undefined ? (
        <p className="text-neutral-500">Loading…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {moments.map((m: Moment, i) => (
            <li
              key={m.key}
              data-revision={m.revisionId}
              data-at={m.at}
              className="rounded border border-neutral-200 bg-white p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <time className="text-neutral-600">{AT.format(m.at)}</time>
                {i === 0 && (
                  <span className="rounded bg-neutral-200 px-1 text-xs">
                    current
                  </span>
                )}
                {m.restored && (
                  <span className="rounded bg-blue-100 px-1 text-xs text-blue-800">
                    restored
                  </span>
                )}
              </div>
              <div className="text-neutral-700">
                {m.groupName ?? m.slices.join(', ')} · {name(m.actor)} ·{' '}
                {m.source}
              </div>
              {m.groupName && (
                <div className="text-xs text-neutral-500">
                  {m.slices.join(', ')}
                </div>
              )}
              {i > 0 && canWrite && (
                <button
                  type="button"
                  onClick={() =>
                    void restoreTo({ tenantId: tenant._id, id, at: m.at })
                  }
                  className="mt-1 text-xs text-neutral-600 underline"
                >
                  Restore to here
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {loading && <p className="text-neutral-500">Loading…</p>}
      {loadOlder && (
        <button
          type="button"
          onClick={loadOlder}
          className="self-start text-xs text-neutral-600 underline"
        >
          Load older
        </button>
      )}
    </aside>
  )
}
