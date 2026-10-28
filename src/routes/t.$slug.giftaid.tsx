import { Outlet, createFileRoute } from '@tanstack/react-router'
import { useIsAdmin } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/giftaid')({
  component: GiftAidLayout,
})

/**
 * Gift Aid claims (G3): admin only, as every claims route is. The header
 * shows the link only to admins; a staff member or viewer who follows a
 * bookmark here is told, not shown a refusal per read.
 */
function GiftAidLayout() {
  const admin = useIsAdmin()
  if (!admin)
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>Gift Aid claims are for the group’s admins.</p>
      </main>
    )
  return <Outlet />
}
