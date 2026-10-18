import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Doc } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { cachedTenant, useIsAdmin, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/identifiers')({
  component: IdentifierTypesPage,
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (tenant?.role !== 'admin') return
    convex.prewarmQuery({
      query: api.contacts.queries.listIdentifierTypes,
      args: { tenantId: tenant._id, includeInactive: true },
    })
  },
})

/** A failed `saveIdentifierType` as one line for the user. */
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
    return 'Someone else changed this type just now; check it and try again'
  if (data?.kind === 'forbidden') return 'Only admins can change settings'
  return data?.message ?? data?.kind ?? 'Could not save'
}

/**
 * The tenant's identifier types (external-ids plan): create, rename,
 * archive / reactivate, admins only. Archiving takes a type out of the
 * contact form's picker; contacts keep its identifiers and lookups still
 * find them. Types are never deleted.
 */
function IdentifierTypesPage() {
  const tenant = useTenant()
  const isAdmin = useIsAdmin()
  const types = useQuery(
    api.contacts.queries.listIdentifierTypes,
    isAdmin ? { tenantId: tenant._id, includeInactive: true } : 'skip',
  )
  const save = useMutation(api.contacts.mutations.saveIdentifierType)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!isAdmin) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p>Only admins of this group can change its settings.</p>
      </main>
    )
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await save({ tenantId: tenant._id, name, isActive: true })
      setName('')
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const active = (types ?? []).filter((t) => t.isActive)
  const archived = (types ?? []).filter((t) => !t.isActive)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <p className="text-sm text-neutral-500">Settings</p>
        <h1 className="text-xl font-semibold">Identifier types</h1>
        <p className="mt-1 text-sm text-neutral-600">
          The kinds of reference other systems use for a contact, such as an old
          CRM's id or a membership number. Contacts can then carry them in their
          Identifiers section.
        </p>
      </div>
      <form onSubmit={create} className="flex flex-col gap-1">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New identifier type"
            aria-label="New identifier type"
            className="flex-1 rounded border border-neutral-300 px-3 py-1.5"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            Create type
          </button>
        </div>
        {error && (
          <span role="alert" className="text-sm text-red-700">
            {error}
          </span>
        )}
      </form>
      {types === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <TypeList
            title="In use"
            types={active}
            empty="No identifier types yet."
          />
          {archived.length > 0 && (
            <TypeList
              title="Archived"
              types={archived}
              empty=""
              note="Not offered on the contact form; contacts keep these identifiers and lookups still find them."
            />
          )}
        </>
      )}
    </main>
  )
}

function TypeList({
  title,
  types,
  empty,
  note,
}: {
  title: string
  types: Array<Doc<'identifierTypes'>>
  empty: string
  note?: string
}) {
  return (
    <section>
      <h2 className="text-lg font-medium">{title}</h2>
      {note && <p className="text-sm text-neutral-500">{note}</p>}
      {types.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
          {types.map((t) => (
            <TypeRow key={t._id} type={t} />
          ))}
        </ul>
      )}
    </section>
  )
}

function TypeRow({ type }: { type: Doc<'identifierTypes'> }) {
  const tenant = useTenant()
  const saveType = useMutation(api.contacts.mutations.saveIdentifierType)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(fields: { name: string; isActive: boolean }) {
    setError(null)
    setBusy(true)
    try {
      await saveType({
        tenantId: tenant._id,
        id: type._id,
        expected: type.saveVersion,
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
          <span className={`flex-1 ${type.isActive ? '' : 'text-neutral-500'}`}>
            {type.name}
          </span>
        ) : (
          <form
            className="flex flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void save({ name: editing, isActive: type.isActive }).then(
                (ok) => ok && setEditing(null),
              )
            }}
          >
            <input
              type="text"
              value={editing}
              aria-label={`Rename ${type.name}`}
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
        {editing === null && (
          <>
            <button
              type="button"
              onClick={() => setEditing(type.name)}
              className="text-xs text-neutral-600 underline"
            >
              rename
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void save({ name: type.name, isActive: !type.isActive })
              }
              className="text-xs text-neutral-600 underline"
            >
              {type.isActive ? 'archive' : 'reactivate'}
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
