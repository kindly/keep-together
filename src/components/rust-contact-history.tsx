import { useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { useContactHistory } from '../lib/data/rust/hooks'
import { useCanWrite } from '../lib/tenant'

const AT = new Intl.DateTimeFormat([], {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/**
 * The history panel on the Rust backend: the contact's revisions, newest
 * first, each restorable, and the archive switch. Plainer than Convex's
 * (no moments grouping, no paging): the spike measures the seam, not the
 * panel. Fetched, and fetched again after every write from this tab.
 */
export function RustContactHistory({
  id,
  archived,
  archiveVersion,
}: {
  id: Id<'contacts'>
  archived: boolean
  archiveVersion: number
}) {
  const canWrite = useCanWrite()
  const { revisions, restore, setArchived } = useContactHistory(id)
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<void>) => {
    setError(null)
    action().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : 'Could not save'),
    )
  }
  return (
    <aside className="flex flex-col gap-4 text-sm">
      {canWrite && (
        <button
          type="button"
          onClick={() => run(() => setArchived(!archived, archiveVersion))}
          className="self-start rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
      )}
      <h2 className="text-lg font-medium">History</h2>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {revisions === undefined ? (
        <p className="text-neutral-500">Loading…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {[...revisions].reverse().map((r, i) => (
            <li
              key={r.id}
              data-revision={r.id}
              data-at={r.at}
              className="rounded border border-neutral-200 bg-white p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <time className="text-neutral-600">{AT.format(r.at)}</time>
                {i === 0 && (
                  <span className="rounded bg-neutral-200 px-1 text-xs">
                    current
                  </span>
                )}
                {r.restoredFrom !== null && (
                  <span className="rounded bg-blue-100 px-1 text-xs text-blue-800">
                    restored
                  </span>
                )}
              </div>
              <p>
                {r.contract.replace(/^contacts\./, '')}{' '}
                <span className="text-neutral-500">({r.source})</span>
              </p>
              {canWrite && i > 0 && (
                <button
                  type="button"
                  onClick={() => run(() => restore(r.id))}
                  className="mt-1 text-xs underline"
                >
                  Restore this
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
