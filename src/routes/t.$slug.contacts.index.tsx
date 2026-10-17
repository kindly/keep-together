import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useState } from 'react'
import { api } from '../../convex/_generated/api'
import { useCanWrite, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/contacts/')({
  component: ContactList,
})

function ContactList() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const [search, setSearch] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const contacts = useQuery(api.contacts.queries.list, {
    tenantId: tenant._id,
    search,
    includeArchived,
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
      {contacts === undefined ? (
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No contacts yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
          {contacts.map((c) => (
            <li key={c._id}>
              <Link
                to="/t/$slug/contacts/$contactId"
                params={{ slug: tenant.slug, contactId: c._id }}
                className="flex items-baseline justify-between px-4 py-2 hover:bg-neutral-50"
              >
                <span>
                  {c.displayName}
                  {c.archived && (
                    <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">
                      archived
                    </span>
                  )}
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
