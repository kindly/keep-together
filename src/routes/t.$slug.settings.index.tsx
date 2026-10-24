import { Navigate, createFileRoute } from '@tanstack/react-router'
import { useMyTenants } from '../lib/data'
import { portedListTabs } from '../lib/settings-tabs'

export const Route = createFileRoute('/t/$slug/settings/')({
  component: FirstTab,
})

/**
 * The first tab every member may see: Fields (visible to all roles), or
 * the first list tab this build serves; with none, Switch group for
 * people in several groups; else only the account's own actions remain.
 */
function FirstTab() {
  const { slug } = Route.useParams()
  const several = (useMyTenants()?.length ?? 0) > 1
  const first = portedListTabs().at(0)
  if (first) return <Navigate to={first.to} params={{ slug }} replace />
  if (several)
    return <Navigate to="/t/$slug/settings/groups" params={{ slug }} replace />
  return <p className="text-sm text-neutral-500">Nothing to set up here yet.</p>
}
