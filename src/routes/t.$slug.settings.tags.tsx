import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Doc } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { StaffListSwitch } from '../components/staff-list-switch'
import { cachedTenant, useCanManageList, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/tags')({
  component: TagsPage,
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (!tenant) return
    convex.prewarmQuery({
      query: api.contacts.queries.tags,
      args: { tenantId: tenant._id, includeInactive: true },
    })
  },
})

/** A failed `saveTag` as one line for the user. */
function message(err: unknown): string {
  const data =
    err instanceof ConvexError
      ? (err.data as {
          kind?: string
          message?: string
          problems?: Array<{ message: string }>
        })
      : null
  if (data?.kind === 'invalid' && data.problems?.length)
    return data.problems.map((p) => p.message).join('; ')
  if (data?.kind === 'stale')
    return 'Someone else changed this tag just now; check it and try again'
  if (data?.kind === 'forbidden')
    return 'You can no longer manage tags in this group'
  return data?.message ?? data?.kind ?? 'Could not save'
}

/**
 * The tenant's tags: create, rename, archive / reactivate (admins, and
 * staff when the group allows it; everyone else reads), under the admins'
 * "staff can manage tags" switch. Archiving hides a tag from pickers and
 * keeps every assignment (contact-model plan).
 */
function TagsPage() {
  const tenant = useTenant()
  const canWrite = useCanManageList('tags')
  const tags = useQuery(api.contacts.queries.tags, {
    tenantId: tenant._id,
    includeInactive: true,
  })
  const saveTag = useMutation(api.contacts.mutations.saveTag)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await saveTag({ tenantId: tenant._id, name, isActive: true })
      setName('')
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const active = (tags ?? []).filter((t) => t.isActive)
  const archived = (tags ?? []).filter((t) => !t.isActive)

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">Tags</h2>
      <StaffListSwitch kind="tags" />
      {canWrite && (
        <form onSubmit={create} className="flex flex-col gap-1">
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New tag name"
              aria-label="New tag name"
              className="flex-1 rounded border border-neutral-300 px-3 py-1.5"
            />
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
            >
              Create tag
            </button>
          </div>
          {error && (
            <span role="alert" className="text-sm text-red-700">
              {error}
            </span>
          )}
        </form>
      )}
      {tags === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <TagList title="In use" tags={active} empty="No tags yet." />
          {archived.length > 0 && (
            <TagList
              title="Archived"
              tags={archived}
              empty=""
              note="Hidden from pickers; contacts keep them."
            />
          )}
        </>
      )}
    </div>
  )
}

function TagList({
  title,
  tags,
  empty,
  note,
}: {
  title: string
  tags: Array<Doc<'tags'>>
  empty: string
  note?: string
}) {
  return (
    <section>
      <h3 className="font-medium">{title}</h3>
      {note && <p className="text-sm text-neutral-500">{note}</p>}
      {tags.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
          {tags.map((t) => (
            <TagRow key={t._id} tag={t} />
          ))}
        </ul>
      )}
    </section>
  )
}

function TagRow({ tag }: { tag: Doc<'tags'> }) {
  const tenant = useTenant()
  const canWrite = useCanManageList('tags')
  const saveTag = useMutation(api.contacts.mutations.saveTag)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(fields: { name: string; isActive: boolean }) {
    setError(null)
    setBusy(true)
    try {
      await saveTag({
        tenantId: tenant._id,
        id: tag._id,
        expected: tag.saveVersion,
        ...fields,
      })
      return true
    } catch (err) {
      setError(message(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-1 px-4 py-2">
      <div className="flex items-center gap-3">
        {editing === null ? (
          <span className={`flex-1 ${tag.isActive ? '' : 'text-neutral-500'}`}>
            {tag.name}
          </span>
        ) : (
          <form
            className="flex flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void save({ name: editing, isActive: tag.isActive }).then(
                (ok) => ok && setEditing(null),
              )
            }}
          >
            <input
              type="text"
              value={editing}
              aria-label={`Rename ${tag.name}`}
              onChange={(e) => setEditing(e.target.value)}
              autoFocus
              className="flex-1 rounded border border-neutral-300 px-2 py-1"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-700"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null)
                setError(null)
              }}
              className="text-xs text-neutral-500 underline"
            >
              cancel
            </button>
          </form>
        )}
        {canWrite && editing === null && (
          <>
            <button
              type="button"
              onClick={() => setEditing(tag.name)}
              className="text-xs text-neutral-600 underline"
            >
              rename
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void save({ name: tag.name, isActive: !tag.isActive })
              }
              className="text-xs text-neutral-600 underline"
            >
              {tag.isActive ? 'archive' : 'reactivate'}
            </button>
          </>
        )}
      </div>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </li>
  )
}
