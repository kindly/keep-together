import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import { api } from '../../convex/_generated/api'
import { useCanManageLists, useIsAdmin, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings')({
  component: SettingsLayout,
})

const tab =
  'shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-neutral-600 hover:text-neutral-900'
const activeTab = 'border-neutral-900 font-medium text-neutral-900'

/**
 * Settings: the admins' switches, then one tab per child route. Every
 * member sees Tags (editable by whoever may manage lists, read-only for
 * the rest); Identifier types shows to those who may manage lists, and
 * its page says "admins only" to anyone else who opens its URL. The
 * backend enforces both.
 */
function SettingsLayout() {
  const { slug } = Route.useParams()
  const isAdmin = useIsAdmin()
  const canManageLists = useCanManageLists()
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      {isAdmin && <StaffListsSwitch />}
      {/* Links, not role=tablist: each tab is a URL. The active one gets
          aria-current="page" from Link. */}
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
        {canManageLists && (
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
      <Outlet />
    </main>
  )
}

/** The admin-only "staff can manage tags and identifier types" switch. */
function StaffListsSwitch() {
  const tenant = useTenant()
  const [error, setError] = useState<string | null>(null)
  // No optimistic update: the switch moves when the server's answer
  // arrives through `mine`, with the counter the next save needs.
  const save = useMutation(api.platform.preferences.setStaffCanManageLists)

  async function toggle(on: boolean) {
    setError(null)
    try {
      await save({
        tenantId: tenant._id,
        expected: tenant.listsVersion ?? undefined,
        staffCanManageLists: on,
      })
    } catch (err) {
      const kind =
        err instanceof ConvexError
          ? (err.data as { kind?: string }).kind
          : undefined
      setError(
        kind === 'stale'
          ? 'Another admin changed this just now; check it and try again'
          : 'Could not save',
      )
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded border border-neutral-200 bg-white px-4 py-3">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={tenant.staffCanManageLists}
          onChange={(e) => void toggle(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className="relative h-5 w-9 shrink-0 rounded-full bg-neutral-300 transition-colors peer-checked:bg-neutral-900 peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-500 peer-focus-visible:ring-offset-2 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
        />
        <span className="text-sm font-medium">
          Staff can manage tags and identifier types
        </span>
      </label>
      <p className="text-sm text-neutral-600">
        When off, only admins create, rename and archive them. Staff can always
        put tags and identifiers on contacts.
      </p>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </div>
  )
}
