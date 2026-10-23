import { useConvex, useMutation } from 'convex/react'
import type { ConvexReactClient } from 'convex/react'
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  PaginationOptions,
} from 'convex/server'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { joinMoments } from '../../convex/contacts/history'
import type { Moment } from '../../convex/contacts/history'
import type { FieldRestoreNote } from '../../convex/contacts/contracts'
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
/** One fetch of a page; `cancel` drops it, and its result never arrives. */
export type PageFetch = { result: Promise<HistoryPage>; cancel: () => void }

export type FeedState = {
  /** The newest page, as last fetched. */
  first: HistoryPage | undefined
  /** Pages "Load older" fetched, each starting where the one above ends. */
  older: Array<HistoryPage>
  loadingOlder: boolean
  /** A fresh newest page is on its way (see `reanchor`). */
  anchoring: boolean
  /** The newest page's last fetch failed (the panel offers a retry). */
  error: Error | null
  /** The last "Load older" failed. */
  olderError: Error | null
}

/**
 * One contact's history, fetched rather than subscribed. A subscribed
 * newest page re-runs on every save of the contact, and the client sees a
 * save only once every query it invalidated has re-run, so the history
 * would hold up "saved" on each one. Revisions never change once written,
 * so a fetched page stays true; what's new is a revision on top, and every
 * revision of a contact bumps a counter on its root (`executeContract` is
 * the only writer of revisions; one written any other way would not show
 * until the next root change). The page calls `refresh` whenever the root
 * changes (its own saves and everyone else's), which costs the history one
 * round trip after the save, off its path.
 *
 * A fetch is a subscription until its answer, so one still out when a
 * save commits would join that save's wait after all: the form `hold`s the
 * feed while it saves, which cancels any fetch in flight and defers new
 * ones to `release`.
 *
 * The newest page keeps the end its first fetch found (`endCursor`), as a
 * live paginated subscription would, so it grows as saves land and the
 * older pages under it never leave a gap. `reanchor` fetches the newest
 * PAGE afresh, only while no older page hangs off its end.
 *
 * A failed fetch is state, never thrown: the panel says so and offers a
 * retry, and the next root change retries too.
 */
export class HistoryFeed {
  private state: FeedState = {
    first: undefined,
    older: [],
    loadingOlder: false,
    anchoring: false,
    error: null,
    olderError: null,
  }
  /** Where the newest page ends; null until a fetch has pinned it. */
  private end: { cursor: string; isDone: boolean } | null = null
  private newestCall = 0
  private olderCall = 0
  private newest: PageFetch | null = null
  private olderFetch: PageFetch | null = null
  /** Saves in flight; fetches wait for them. */
  private holds = 0
  private deferred = { newest: false, older: false }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly fetchPage: (opts: PageOpts) => PageFetch) {}

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
    this.newest?.cancel()
    this.newest = null
    const call = ++this.newestCall
    if (this.holds > 0) {
      this.deferred.newest = true
      return
    }
    const end = this.end
    const fetch = this.fetchPage({
      numItems: PAGE,
      cursor: null,
      ...(end && { endCursor: end.cursor }),
    })
    this.newest = fetch
    fetch.result.then(
      (page) => {
        if (call !== this.newestCall) return
        this.newest = null
        this.end ??= { cursor: page.continueCursor, isDone: page.isDone }
        // Its end is pinned, so whether more lie beyond it is what the
        // pinning fetch found.
        const first = { ...page, isDone: this.end.isDone }
        this.set({ first, anchoring: false, error: null })
      },
      (error: unknown) => {
        if (call !== this.newestCall) return
        this.newest = null
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
    const call = ++this.olderCall
    this.set({ loadingOlder: true, olderError: null })
    if (this.holds > 0) {
      this.deferred.older = true
      return
    }
    const cursor = older.length > 0 ? last.continueCursor : this.end.cursor
    const fetch = this.fetchPage({ numItems: PAGE, cursor })
    this.olderFetch = fetch
    fetch.result.then(
      (page) => {
        if (call !== this.olderCall) return
        this.olderFetch = null
        this.set({ older: [...this.state.older, page], loadingOlder: false })
      },
      (error: unknown) => {
        if (call !== this.olderCall) return
        this.olderFetch = null
        this.set({ loadingOlder: false, olderError: asError(error) })
      },
    )
  }

  /** A new visit starts with the newest page only. */
  forgetOlder() {
    this.olderCall++
    this.olderFetch?.cancel()
    this.olderFetch = null
    this.deferred.older = false
    if (this.state.older.length > 0 || this.state.loadingOlder)
      this.set({ older: [], loadingOlder: false, olderError: null })
  }

  /** A save is about to go: nothing of ours may be subscribed when it commits. */
  hold() {
    this.holds++
    if (this.newest) {
      this.newest.cancel()
      this.newest = null
      this.newestCall++
      this.deferred.newest = true
    }
    if (this.olderFetch) {
      this.olderFetch.cancel()
      this.olderFetch = null
      this.olderCall++
      this.deferred.older = true
    }
  }

  /** The save has settled: send whatever waited for it. */
  release() {
    this.holds = Math.max(0, this.holds - 1)
    if (this.holds > 0) return
    const { newest, older } = this.deferred
    this.deferred = { newest: false, older: false }
    if (newest) this.refresh()
    if (older) {
      // Asked for while held: ask again now (loadOlder skips while loading).
      this.set({ loadingOlder: false })
      this.loadOlder()
    }
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/** A query answering history pages as moments (a contact's, a gift's). */
type MomentsQuery = FunctionReference<
  'query',
  'public',
  { paginationOpts: PaginationOptions },
  HistoryPage
>

/**
 * One fetch of a history page: subscribed until its first answer, as
 * `ConvexReactClient.query` does, but cancellable (unsubscribed at once).
 */
export function fetchHistoryPage<TQuery extends MomentsQuery>(
  convex: ConvexReactClient,
  query: TQuery,
  args: FunctionArgs<TQuery>,
): PageFetch {
  const watch = convex.watchQuery<MomentsQuery>(query, args)
  let stop: (() => void) | null = null
  let cancelled = false
  const cancel = () => {
    cancelled = true
    stop?.()
    stop = null
  }
  const result = new Promise<HistoryPage>((resolve, reject) => {
    const answer = () => {
      try {
        const page = watch.localQueryResult()
        if (page === undefined) return
        cancel()
        resolve(page)
      } catch (error) {
        cancel()
        reject(asError(error))
      }
    }
    stop = watch.onUpdate(answer)
    // Already held by another subscription: no update may come.
    if (!cancelled) answer()
  })
  return { result, cancel }
}

/** The contact's feed in the session store, made on first use. */
function historyFeed(
  store: Map<string, unknown>,
  convex: ConvexReactClient,
  tenantId: Id<'tenants'>,
  id: Id<'contacts'>,
): { key: string; feed: HistoryFeed } {
  const key = `history:${tenantId}:${id}`
  let feed = store.get(key) as HistoryFeed | undefined
  if (!feed) {
    feed = new HistoryFeed((paginationOpts) =>
      fetchHistoryPage(convex, api.contacts.queries.history, {
        tenantId,
        id,
        paginationOpts,
      }),
    )
    store.set(key, feed)
  }
  return { key, feed }
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
    const { key, feed } = historyFeed(store, convex, tenant._id, id)
    // Most recently opened last.
    store.delete(key)
    store.set(key, feed)
    const feeds = [...store.keys()].filter((k) => k.startsWith('history:'))
    for (const old of feeds.slice(0, -FEEDS_KEPT)) store.delete(old)
    return feed
  }, [store, convex, tenant._id, id])
}

/**
 * For the contact form: hold the contact's history while a save is out
 * (`HistoryFeed.hold`), so no history fetch joins the save's wait.
 */
export function useHistoryHold(id: Id<'contacts'>) {
  const tenant = useTenant()
  const convex = useConvex()
  const store = useSessionStore()
  return useMemo(() => {
    const feed = () => historyFeed(store, convex, tenant._id, id).feed
    return { hold: () => feed().hold(), release: () => feed().release() }
  }, [store, convex, tenant._id, id])
}

/**
 * The newest page plus the older pages "Load older" asked for, fetched
 * again whenever `version` (the root's counters) changes. Past REANCHOR_AT
 * moments, and only while no older page hangs off its end, the newest page
 * is fetched afresh; that hides the older half of the moments, so it waits
 * while someone is reading the panel (`atRest`). Failures come back as
 * `error` / `olderError` with a retry, never thrown.
 */
export function useHistoryPages(
  feed: HistoryFeed,
  version: string,
  atRest: () => boolean,
) {
  const state = useSyncExternalStore(feed.subscribe, feed.snapshot)
  useEffect(() => feed.forgetOlder(), [feed])
  useEffect(() => feed.refresh(), [feed, version])
  const { first, older } = state
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
  const failed = {
    error: state.error,
    retry: () => feed.refresh(),
    olderError: state.olderError,
    retryOlder: () => feed.loadOlder(),
  }
  if (first === undefined)
    return {
      moments: undefined,
      loading: false,
      loadOlder: undefined,
      ...failed,
    }
  const pages = [first, ...older]
  const last = pages[pages.length - 1]
  return {
    moments: joinMoments(pages.flatMap((p) => p.page)),
    loading: state.loadingOlder,
    // Not while a fresh newest page loads: older pages start at its end.
    loadOlder:
      state.loadingOlder ||
      state.anchoring ||
      state.olderError !== null ||
      last.isDone
        ? undefined
        : () => feed.loadOlder(),
    ...failed,
  }
}

const SKIP_REASONS: Record<FieldRestoreNote['reason'], string> = {
  retired: 'the field has been retired',
  wrong_kind: 'the field no longer applies to this kind of contact',
  added_after: 'the field was added after this point; its value is kept',
}

/**
 * What a restore's `skippedFields` say, as one line, or null when it left
 * no field value out.
 */
export function skippedFieldsNote(
  skipped: Array<FieldRestoreNote>,
): string | null {
  if (skipped.length === 0) return null
  const parts = skipped.map((s) => `${s.label} (${SKIP_REASONS[s.reason]})`)
  return `Restored, except: ${parts.join('; ')}.`
}

/**
 * The timeline as moments, newest first, a page at a time; "Restore to
 * here" re-executes every slice's state at that time, from any page. A
 * moment of retired contracts only (tags) is read-only: no restore.
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
  const feed = useHistoryFeed(id)
  const { moments, loading, loadOlder, error, retry, olderError, retryOlder } =
    useHistoryPages(feed, version, atRest)
  const members = useQuery(api.platform.tenants.members, {
    tenantId: tenant._id,
  })
  const restoreMutation = useMutation(api.contacts.mutations.restoreTo)
  const archiveMutation = useMutation(api.contacts.mutations.setArchived)
  // As the form's saves do: no history fetch joins the mutation's wait.
  const held =
    <TArgs,>(run: (args: TArgs) => Promise<unknown>) =>
    async (args: TArgs) => {
      feed.hold()
      try {
        await run(args)
      } finally {
        feed.release()
      }
    }
  // What the last restore left as it was (field values it skipped).
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  const restoreTo = held(
    async (args: FunctionArgs<typeof api.contacts.mutations.restoreTo>) => {
      setRestoreNote(null)
      const result = await restoreMutation(args)
      setRestoreNote(skippedFieldsNote(result.skippedFields))
    },
  )
  const setArchived = held(archiveMutation)
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
      {restoreNote && (
        <p
          role="status"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800"
        >
          {restoreNote}{' '}
          <button
            type="button"
            onClick={() => setRestoreNote(null)}
            className="underline"
          >
            Dismiss
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          History couldn’t load.{' '}
          <button type="button" onClick={retry} className="underline">
            Retry
          </button>
        </p>
      )}
      {moments === undefined ? (
        !error && <p className="text-neutral-500">Loading…</p>
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
                {m.retired && (
                  <span
                    title="Tags have been removed: this stays in history but can’t be restored"
                    className="rounded bg-neutral-100 px-1 text-xs text-neutral-600"
                  >
                    read-only
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
              {i > 0 && canWrite && !m.retired && (
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
      {olderError && (
        <p role="alert" className="text-red-700">
          Older history couldn’t load.{' '}
          <button type="button" onClick={retryOlder} className="underline">
            Retry
          </button>
        </p>
      )}
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
