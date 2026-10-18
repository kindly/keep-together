import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { Authenticated, Unauthenticated } from 'convex/react'
import { TenantContext, useMyTenants } from '../lib/tenant'
import { ContactQueryCache } from '../lib/query-cache'

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
  // From the groups list the root keeps live: no round trip of our own.
  const tenants = useMyTenants()
  const tenant = tenants && (tenants.find((t) => t.slug === slug) ?? null)
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
            <Link
              to="/t/$slug/settings"
              params={{ slug }}
              className="text-sm hover:underline"
              activeProps={{ className: 'text-sm font-medium underline' }}
            >
              Settings
            </Link>
          </nav>
        </header>
        <ContactQueryCache>
          <Outlet />
        </ContactQueryCache>
      </div>
    </TenantContext.Provider>
  )
}
