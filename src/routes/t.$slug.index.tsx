import { Link, createFileRoute } from '@tanstack/react-router'
import { RecentGifts, RecordGiftAction } from '../components/gift-nav'
import { useCanWrite, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/')({ component: GroupHome })

const action =
  'rounded border border-neutral-200 bg-white px-4 py-3 text-sm font-medium hover:border-neutral-400'

/**
 * The group's home (cash-gifts g1q9): where signing in lands, and where
 * the group name in the header leads. Viewers get only what they can do.
 */
function GroupHome() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-xl font-semibold">{tenant.name}</h1>
      <nav aria-label="Actions" className="grid gap-3 sm:grid-cols-3">
        {canWrite && (
          <RecordGiftAction
            className={`${action} cursor-not-allowed text-neutral-400 hover:border-neutral-200`}
          />
        )}
        <Link
          to="/t/$slug/contacts"
          params={{ slug: tenant.slug }}
          className={action}
        >
          Find a contact
        </Link>
        {canWrite && (
          <Link
            to="/t/$slug/contacts/new"
            params={{ slug: tenant.slug }}
            className={action}
          >
            New contact
          </Link>
        )}
      </nav>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">My recent gifts</h2>
        <RecentGifts tenantId={tenant._id} />
      </section>
    </main>
  )
}
