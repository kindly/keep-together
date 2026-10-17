import { useMutation, useQuery } from 'convex/react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { useCanWrite, useTenant } from '../lib/tenant'

/** The timeline as moments; "Restore to here" re-executes every slice's state at that time. */
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
  const moments = useQuery(api.contacts.queries.history, {
    tenantId: tenant._id,
    id,
  })
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
          {moments.map((m, i) => (
            <li
              key={m.revisionId}
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
    </aside>
  )
}
