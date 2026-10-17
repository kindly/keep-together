import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { Authenticated, Unauthenticated, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { TenantContext } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug')({ component: TenantLayout })

function TenantLayout() {
  const { slug } = Route.useParams()
  return (
    <>
      <Unauthenticated>
        <main className="mx-auto max-w-lg p-6">
          <p>
            <Link to="/" className="underline">
              Sign in
            </Link>{' '}
            to open this group.
          </p>
        </main>
      </Unauthenticated>
      <Authenticated>
        <Resolved slug={slug} />
      </Authenticated>
    </>
  )
}

function Resolved({ slug }: { slug: string }) {
  const tenant = useQuery(api.platform.tenants.bySlug, { slug })
  if (tenant === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (tenant === null) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>No group called “{slug}” that you belong to.</p>
        <Link to="/" className="underline">
          Your groups
        </Link>
      </main>
    )
  }
  return (
    <TenantContext.Provider value={tenant}>
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <header className="border-b border-neutral-200 bg-white">
          <nav className="mx-auto flex max-w-5xl items-baseline gap-6 px-6 py-3">
            <Link to="/" className="text-sm text-neutral-500 hover:underline">
              keep-together
            </Link>
            <span className="font-medium">{tenant.name}</span>
            <Link
              to="/t/$slug/contacts"
              params={{ slug }}
              className="text-sm hover:underline"
              activeProps={{ className: 'text-sm font-medium underline' }}
            >
              Contacts
            </Link>
          </nav>
        </header>
        <Outlet />
      </div>
    </TenantContext.Provider>
  )
}
