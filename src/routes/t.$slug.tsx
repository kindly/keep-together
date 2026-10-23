import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { Authenticated, Unauthenticated, useMutation } from 'convex/react'
import { useEffect, useRef } from 'react'
import { api } from '../../convex/_generated/api'
import { TenantContext, useMyTenants } from '../lib/tenant'
import type { Tenant } from '../lib/tenant'
import { ContactQueryCache } from '../lib/query-cache'
import { DonationsMenu } from '../components/gift-nav'

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
  // From `mine`, which the root keeps live: no round trip of our own.
  const tenants = useMyTenants()
  if (tenants === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  const tenant = tenants.find((t) => t.slug === slug)
  if (!tenant) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>No group called “{slug}” that you belong to.</p>
        <Link to="/" className="underline">
          Go to your group
        </Link>
      </main>
    )
  }
  return (
    <TenantContext.Provider value={tenant}>
      <RememberOpened tenant={tenant} tenants={tenants} />
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <header className="border-b border-neutral-200 bg-white">
          <nav
            aria-label="Main"
            className="mx-auto flex max-w-5xl items-baseline gap-4 px-4 py-3 sm:gap-6 sm:px-6"
          >
            <Link
              to="/t/$slug"
              params={{ slug }}
              activeOptions={{ exact: true }}
              className="font-medium hover:underline"
            >
              {tenant.name}
            </Link>
            <Link
              to="/t/$slug/contacts"
              params={{ slug }}
              className="text-sm hover:underline"
              activeProps={{ className: 'text-sm font-medium underline' }}
            >
              Contacts
            </Link>
            <DonationsMenu tenantId={tenant._id} />
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

/**
 * Tells the server which group this is, so signing in lands here next
 * time (cash-gifts g3q1). Once per entry into a group, judged by `mine`
 * as it stood then: only for people in several groups, and only when this
 * one isn't already their last used. Never again while staying in it, so
 * two tabs on different groups can't keep taking the "last used" mark
 * from each other as `mine` updates.
 */
function RememberOpened({
  tenant,
  tenants,
}: {
  tenant: Tenant
  tenants: Array<Tenant>
}) {
  const opened = useMutation(api.platform.tenants.opened)
  const several = tenants.length > 1
  const latest = Math.max(...tenants.map((t) => t.lastUsedAt ?? 0))
  const isLatest = tenant.lastUsedAt !== null && tenant.lastUsedAt === latest
  // The group this entry was judged for; isLatest changing later is
  // another tab's doing, not a new entry.
  const judged = useRef<Tenant['_id'] | null>(null)
  useEffect(() => {
    if (judged.current === tenant._id) return
    judged.current = tenant._id
    if (!several || isLatest) return
    opened({ tenantId: tenant._id }).catch(console.error)
  }, [opened, several, isLatest, tenant._id])
  return null
}
