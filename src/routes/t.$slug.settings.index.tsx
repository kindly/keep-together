import { createFileRoute, redirect } from '@tanstack/react-router'

// The first tab every member may see; Tags is visible to all roles.
export const Route = createFileRoute('/t/$slug/settings/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/t/$slug/settings/tags', params, replace: true })
  },
})
