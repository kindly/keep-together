import { useMutation, useQueries, useQuery } from 'convex/react'
import { useMemo, useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { joinMoments } from '../../convex/contacts/history'
import type { Moment } from '../../convex/contacts/history'
import { useCanWrite, useTenant } from '../lib/tenant'

/** Revisions per history page (the server caps it at HISTORY_PAGE_LIMIT). */
const PAGE = 10
const NO_CURSORS: Array<string> = []

/**
 * The newest page's args. The route prewarms exactly these, so they must
 * not vary per mount (which is why this isn't `usePaginatedQuery`: its
 * per-hook pagination id would miss the prewarmed subscription).
 */
export function historyFirstPage(tenantId: Id<'tenants'>, id: Id<'contacts'>) {
  return { tenantId, id, paginationOpts: { numItems: PAGE, cursor: null } }
}

/**
 * The newest page, live, plus the older pages "Load older" asked for. Each
 * older page starts at the previous page's end; the newest page keeps its
 * end on re-runs (Convex pins a page's range per subscription) and grows
 * as saves land, so pages never leave a gap. Only the newest page re-runs
 * on a save; older ones read ranges a save never touches.
 */
function useHistoryPages(id: Id<'contacts'>) {
  const tenant = useTenant()
  const first = useQuery(
    api.contacts.queries.history,
    historyFirstPage(tenant._id, id),
  )
  const [older, setOlder] = useState<{
    id: Id<'contacts'>
    cursors: Array<string>
  }>({ id, cursors: [] })
  const cursors = older.id === id ? older.cursors : NO_CURSORS
  // useQueries resubscribes whenever its argument's identity changes, so
  // the object must only change when the pages do.
  const queries = useMemo(
    () =>
      Object.fromEntries(
        cursors.map((cursor) => [
          cursor,
          {
            query: api.contacts.queries.history,
            args: {
              tenantId: tenant._id,
              id,
              paginationOpts: { numItems: PAGE, cursor },
            },
          },
        ]),
      ),
    [tenant._id, id, cursors],
  )
  const results = useQueries(queries)
  if (first === undefined) return { moments: undefined }
  const pages = [first]
  for (const cursor of cursors) {
    const page: unknown = results[cursor]
    if (page instanceof Error) throw page
    if (page === undefined) break
    pages.push(page as typeof first)
  }
  const last = pages[pages.length - 1]
  const loading = pages.length < cursors.length + 1
  return {
    moments: joinMoments(pages.flatMap((p) => p.page)),
    loading,
    loadOlder:
      loading || last.isDone
        ? undefined
        : () => setOlder({ id, cursors: [...cursors, last.continueCursor] }),
  }
}

/**
 * The timeline as moments, newest first, a page at a time; "Restore to
 * here" re-executes every slice's state at that time, from any page.
 */
export function ContactHistory({
  id,
  archived,
  archiveVersion,
}: {
  id: Id<'contacts'>
  archived: boolean
  archiveVersion: number
}) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const { moments, loading, loadOlder } = useHistoryPages(id)
  const members = useQuery(api.platform.tenants.members, {
    tenantId: tenant._id,
  })
  const restoreTo = useMutation(api.contacts.mutations.restoreTo)
  const setArchived = useMutation(api.contacts.mutations.setArchived)
  const name = (userId: Id<'users'> | null) =>
    members?.find((m) => m.userId === userId)?.name ?? 'system'
  return (
    <aside className="flex flex-col gap-4 text-sm">
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
                <time className="text-neutral-600">
                  {new Date(m.at).toLocaleString([], {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </time>
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
