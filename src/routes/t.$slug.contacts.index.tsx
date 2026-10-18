import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { cachedTenant, useCanWrite, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/contacts/')({
  component: ContactList,
  // Subscribe as the navigation starts, not once the list has mounted.
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (!tenant) return
    convex.prewarmQuery({
      query: api.contacts.queries.list,
      args: { tenantId: tenant._id, search: '', includeArchived: false },
    })
    convex.prewarmQuery({
      query: api.contacts.queries.tags,
      args: { tenantId: tenant._id, includeInactive: true },
    })
  },
})

/** BULK_TAG_LIMIT in convex/contacts/mutations.ts (a server module). */
const BULK_BATCH = 100

type Bulk =
  | { state: 'idle' }
  | { state: 'running'; op: 'add' | 'remove'; done: number; total: number }
  | { state: 'done'; message: string }
  | { state: 'failed'; message: string }

function ContactList() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const [search, setSearch] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [tagFilter, setTagFilter] = useState<Id<'tags'> | ''>('')
  const contacts = useQuery(api.contacts.queries.list, {
    tenantId: tenant._id,
    search,
    includeArchived,
    ...(tagFilter && { tagId: tagFilter }),
  })
  const tags = useQuery(api.contacts.queries.tags, {
    tenantId: tenant._id,
    includeInactive: true,
  })
  const tagName = new Map((tags ?? []).map((t) => [t._id as string, t]))

  const [selected, setSelected] = useState<ReadonlySet<Id<'contacts'>>>(
    new Set(),
  )
  // Only rows on screen count: a selection never acts on hidden contacts.
  const chosen = (contacts ?? []).filter((c) => selected.has(c._id))
  const allChosen =
    contacts !== undefined &&
    contacts.length > 0 &&
    chosen.length === contacts.length
  const toggle = (id: Id<'contacts'>) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold">Contacts</h1>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name"
          className="rounded border border-neutral-300 px-3 py-1.5"
        />
        <select
          aria-label="Filter by tag"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value as Id<'tags'> | '')}
          className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
        >
          <option value="">all tags</option>
          {(tags ?? []).map((t) => (
            <option key={t._id} value={t._id}>
              {t.isActive ? t.name : `${t.name} (archived)`}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          show archived
        </label>
        {canWrite && (
          <Link
            to="/t/$slug/contacts/new"
            params={{ slug: tenant.slug }}
            className="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            New contact
          </Link>
        )}
      </div>
      {canWrite && contacts !== undefined && contacts.length > 0 && (
        <BulkBar
          chosen={chosen.map((c) => c._id)}
          allChosen={allChosen}
          onAll={(all) =>
            setSelected(new Set(all ? contacts.map((c) => c._id) : []))
          }
          tags={(tags ?? []).filter((t) => t.isActive)}
          allTags={tags ?? []}
        />
      )}
      {contacts === undefined ? (
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No contacts yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
          {contacts.map((c) => (
            <li key={c._id} className="flex items-center">
              {canWrite && (
                <input
                  type="checkbox"
                  aria-label={`select ${c.displayName}`}
                  checked={selected.has(c._id)}
                  onChange={() => toggle(c._id)}
                  className="ml-4"
                />
              )}
              <Link
                to="/t/$slug/contacts/$contactId"
                params={{ slug: tenant.slug, contactId: c._id }}
                className="flex flex-1 items-baseline justify-between gap-4 px-4 py-2 hover:bg-neutral-50"
              >
                <span>
                  {c.displayName}
                  {c.archived && (
                    <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">
                      archived
                    </span>
                  )}
                  {c.tagIds.map((id) => {
                    const t = tagName.get(id)
                    return t ? (
                      <span
                        key={id}
                        className={`ml-2 rounded-full border px-2 text-xs ${t.isActive ? 'border-neutral-300' : 'border-dashed border-neutral-300 text-neutral-500'}`}
                      >
                        {t.name}
                      </span>
                    ) : null
                  })}
                </span>
                <span className="text-sm text-neutral-500">
                  {c.email ?? c.kind}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

/**
 * Add or remove one tag on the selected rows. Each batch is one
 * all-or-nothing `bulkTag` (one command group); the bar shows progress
 * while batches run and what changed when they finish.
 */
function BulkBar({
  chosen,
  allChosen,
  onAll,
  tags,
  allTags,
}: {
  chosen: Array<Id<'contacts'>>
  allChosen: boolean
  onAll: (all: boolean) => void
  tags: Array<{ _id: Id<'tags'>; name: string }>
  allTags: Array<{ _id: Id<'tags'>; name: string }>
}) {
  const tenant = useTenant()
  const bulkTag = useMutation(api.contacts.mutations.bulkTag)
  const [tagId, setTagId] = useState<Id<'tags'> | ''>('')
  const [bulk, setBulk] = useState<Bulk>({ state: 'idle' })
  const running = bulk.state === 'running'
  // Removing may name an archived tag; adding only an active one.
  const removable = tagId !== '' && allTags.some((t) => t._id === tagId)
  const addable = tags.some((t) => t._id === tagId)

  async function run(op: 'add' | 'remove') {
    if (!tagId) return
    const name = allTags.find((t) => t._id === tagId)?.name ?? 'tag'
    const ids = [...chosen]
    let changed = 0
    setBulk({ state: 'running', op, done: 0, total: ids.length })
    try {
      for (let i = 0; i < ids.length; i += BULK_BATCH) {
        const batch = ids.slice(i, i + BULK_BATCH)
        const result = await bulkTag({
          tenantId: tenant._id,
          contactIds: batch,
          tagId,
          op,
        })
        changed += result.changed
        setBulk({
          state: 'running',
          op,
          done: i + batch.length,
          total: ids.length,
        })
      }
      const n = `${changed} contact${changed === 1 ? '' : 's'}`
      setBulk({
        state: 'done',
        message:
          op === 'add'
            ? `Added “${name}” to ${n}`
            : `Removed “${name}” from ${n}`,
      })
    } catch (err) {
      const data =
        err instanceof ConvexError
          ? (err.data as { message?: string; kind?: string })
          : null
      const soFar =
        changed > 0 ? ` (${changed} changed before it stopped)` : ''
      setBulk({
        state: 'failed',
        message: `${data?.message ?? data?.kind ?? 'Could not change tags'}${soFar}`,
      })
    }
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2 text-neutral-600">
        <input
          type="checkbox"
          checked={allChosen}
          disabled={running}
          onChange={(e) => onAll(e.target.checked)}
        />
        select all shown
      </label>
      {chosen.length > 0 && (
        <>
          <span className="font-medium">{chosen.length} selected</span>
          <select
            aria-label="Tag to change"
            value={tagId}
            disabled={running}
            onChange={(e) => setTagId(e.target.value as Id<'tags'> | '')}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            <option value="">choose tag…</option>
            {allTags.map((t) => (
              <option key={t._id} value={t._id}>
                {tags.some((a) => a._id === t._id)
                  ? t.name
                  : `${t.name} (archived)`}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={running || !addable}
            onClick={() => void run('add')}
            className="rounded bg-neutral-900 px-2 py-1 text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            Add tag
          </button>
          <button
            type="button"
            disabled={running || !removable}
            onClick={() => void run('remove')}
            className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-50 disabled:opacity-40"
          >
            Remove tag
          </button>
        </>
      )}
      <span role="status" className="text-neutral-600">
        {bulk.state === 'running' &&
          `${bulk.op === 'add' ? 'Adding' : 'Removing'}… ${bulk.done} of ${bulk.total}`}
        {bulk.state === 'done' && bulk.message}
      </span>
      {bulk.state === 'failed' && (
        <span role="alert" className="text-red-700">
          {bulk.message}
        </span>
      )}
    </div>
  )
}
