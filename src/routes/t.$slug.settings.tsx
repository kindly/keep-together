import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { useIsAdmin } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings')({
  component: SettingsLayout,
})

const tab =
  'shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-neutral-600 hover:text-neutral-900'
const activeTab = 'border-neutral-900 font-medium text-neutral-900'

/**
 * Settings: one tab per child route. Every member sees Tags (viewers
 * read only); Identifier types is admin only, and its page says so to
 * anyone else who opens its URL. The backend enforces both.
 */
function SettingsLayout() {
  const { slug } = Route.useParams()
  const isAdmin = useIsAdmin()
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Settings</h1>
        {/* Links, not role=tablist: each tab is a URL. The active one
            gets aria-current="page" from Link. */}
        <nav
          aria-label="Settings sections"
          className="-mx-3 flex overflow-x-auto border-b border-neutral-200"
        >
          <Link
            to="/t/$slug/settings/tags"
            params={{ slug }}
            className={tab}
            activeProps={{ className: activeTab }}
          >
            Tags
          </Link>
          {isAdmin && (
            <Link
              to="/t/$slug/settings/identifiers"
              params={{ slug }}
              className={tab}
              activeProps={{ className: activeTab }}
            >
              Identifier types
            </Link>
          )}
        </nav>
      </div>
      <Outlet />
    </main>
  )
}
