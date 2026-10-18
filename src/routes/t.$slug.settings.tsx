import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/t/$slug/settings')({
  component: SettingsLayout,
})

// A vertical column on the left from md up; a horizontal, scrollable row
// above the content on a phone. The active tab's rule sits on the column's
// right edge (or the row's bottom edge), over the nav's own border.
const tab =
  'shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-neutral-600 hover:text-neutral-900 md:-mr-px md:border-b-0 md:border-r-2'
const activeTab = 'border-neutral-900 font-medium text-neutral-900'

/**
 * Settings: one tab per child route, every one visible to every member.
 * Each tab opens with its admin-only switch, and is editable by whoever
 * may manage that list (read-only for the rest). The backend enforces it.
 */
function SettingsLayout() {
  const { slug } = Route.useParams()
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="flex flex-col gap-6 md:flex-row">
        {/* Links, not role=tablist: each tab is a URL. The active one gets
            aria-current="page" from Link. */}
        <nav
          aria-label="Settings sections"
          className="-mx-3 flex shrink-0 overflow-x-auto border-b border-neutral-200 md:mx-0 md:w-44 md:flex-col md:self-start md:overflow-visible md:border-r md:border-b-0"
        >
          <Link
            to="/t/$slug/settings/tags"
            params={{ slug }}
            className={tab}
            activeProps={{ className: activeTab }}
          >
            Tags
          </Link>
          <Link
            to="/t/$slug/settings/identifiers"
            params={{ slug }}
            className={tab}
            activeProps={{ className: activeTab }}
          >
            Identifier types
          </Link>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </main>
  )
}
