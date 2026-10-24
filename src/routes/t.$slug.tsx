import {
  Link,
  Outlet,
  createFileRoute,
  useMatches,
  useNavigate,
} from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { useEffect, useRef } from 'react'
import { api } from '../../convex/_generated/api'
import { TenantContext } from '../lib/tenant'
import type { Tenant } from '../lib/tenant'
import {
  FEATURES,
  SignedIn,
  SignedOut,
  isPorted,
  useMyTenants,
  useOrgEvents,
  useSignOut,
} from '../lib/data'
import { DonationsMenu } from '../components/gift-nav'

export const Route = createFileRoute('/t/$slug')({ component: TenantLayout })

function TenantLayout() {
  const { slug } = Route.useParams()
  return (
    <>
      <SignedOut>
        <main className="mx-auto max-w-lg p-6">
          <p>
            <Link to="/" className="underline">
              Sign in
            </Link>{' '}
            to open this group.
          </p>
        </main>
      </SignedOut>
      <SignedIn>
        <Resolved slug={slug} />
      </SignedIn>
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
      <Events slug={slug} />
      {/* Not ported yet (A3): the "last used" group. */}
      {FEATURES.settings && (
        <RememberOpened tenant={tenant} tenants={tenants} />
      )}
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
            {FEATURES.gifts && <DonationsMenu tenantId={tenant._id} />}
            {FEATURES.settings ? (
              <Link
                to="/t/$slug/settings"
                params={{ slug }}
                className="text-sm hover:underline"
                activeProps={{ className: 'text-sm font-medium underline' }}
              >
                Settings
              </Link>
            ) : (
              // Settings holds Sign out; until it is ported, the header does.
              <SignOut />
            )}
          </nav>
        </header>
        <PortedOutlet />
      </div>
    </TenantContext.Provider>
  )
}

/** The tenant's change stream, while one of its pages is open. */
function Events({ slug }: { slug: string }) {
  useOrgEvents(slug)
  return null
}

/**
 * The page, or "being ported" for a route the Rust backend doesn't serve
 * yet (`lib/data/ported.ts`): its links are hidden, but a bookmark or a
 * typed URL still lands here.
 */
function PortedOutlet() {
  const leaf = useMatches({ select: (m) => m.at(-1)?.routeId })
  if (leaf === undefined || isPorted(leaf)) return <Outlet />
  return (
    <main className="mx-auto max-w-lg p-6">
      <p>This page is being ported to the new backend.</p>
    </main>
  )
}

/** As Settings' Sign out: back to the sign-in form. */
function SignOut() {
  const signOut = useSignOut()
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => void signOut().then(() => navigate({ to: '/' }))}
      className="ml-auto text-sm text-neutral-600 hover:underline"
    >
      Sign out
    </button>
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
