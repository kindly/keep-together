import { Navigate, createFileRoute } from '@tanstack/react-router'
import { portedListTabs } from '../lib/settings-tabs'

export const Route = createFileRoute('/t/$slug/settings/')({
  component: FirstTab,
  // GoCardless's OAuth lands on Settings with how it went
  // (`GET /api/gocardless/callback`): passed on to its tab.
  // Stripe's hosted form does the same (`?stripe=return|refresh`).
  validateSearch: (
    s: Record<string, unknown>,
  ): { gocardless?: string; stripe?: string } => ({
    ...(typeof s.gocardless === 'string' && { gocardless: s.gocardless }),
    ...(typeof s.stripe === 'string' && { stripe: s.stripe }),
  }),
})

/**
 * Back from GoCardless's consent page: Settings › GoCardless; from
 * Stripe's form: Settings › Card donations. Else the
 * first tab every member may see: Fields (visible to all roles), or
 * the first list tab this build serves; with none, Members (every member
 * sees it).
 */
function FirstTab() {
  const { slug } = Route.useParams()
  const { gocardless, stripe } = Route.useSearch()
  if (stripe !== undefined)
    return (
      <Navigate
        to="/t/$slug/settings/stripe"
        params={{ slug }}
        search={{ stripe } as never}
        replace
      />
    )
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
