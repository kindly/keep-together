import { Navigate, createFileRoute } from '@tanstack/react-router'
import { portedListTabs } from '../lib/settings-tabs'

export const Route = createFileRoute('/t/$slug/settings/')({
  component: FirstTab,
})

/**
 * The first tab every member may see: Fields (visible to all roles), or
 * the first list tab this build serves; with none, Members (every member
 * sees it).
 */
function FirstTab() {
  const { slug } = Route.useParams()
  const first = portedListTabs().at(0)
  if (first) return <Navigate to={first.to} params={{ slug }} replace />
  return <Navigate to="/t/$slug/settings/members" params={{ slug }} replace />
}
