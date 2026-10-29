import { Navigate, createFileRoute } from '@tanstack/react-router'
import { portedListTabs } from '../lib/settings-tabs'

export const Route = createFileRoute('/t/$slug/settings/')({
  component: FirstTab,
  // GoCardless's OAuth lands on Settings with how it went
  // (`GET /api/gocardless/callback`): passed on to its tab.
  validateSearch: (s: Record<string, unknown>): { gocardless?: string } =>
    typeof s.gocardless === 'string' ? { gocardless: s.gocardless } : {},
})

/**
 * Back from GoCardless's consent page: Settings › GoCardless. Else the
 * first tab every member may see: Fields (visible to all roles), or
 * the first list tab this build serves; with none, Members (every member
 * sees it).
 */
function FirstTab() {
  const { slug } = Route.useParams()
  const { gocardless } = Route.useSearch()
  if (gocardless !== undefined)
    return (
      <Navigate
        to="/t/$slug/settings/gocardless"
        params={{ slug }}
        search={{ gocardless } as never}
        replace
      />
    )
  const first = portedListTabs().at(0)
  if (first) return <Navigate to={first.to} params={{ slug }} replace />
  return <Navigate to="/t/$slug/settings/members" params={{ slug }} replace />
}
