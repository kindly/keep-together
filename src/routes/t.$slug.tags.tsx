import { createFileRoute, redirect } from '@tanstack/react-router'

// Tags moved under Settings; old links and bookmarks still land there.
export const Route = createFileRoute('/t/$slug/tags')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/t/$slug/settings/tags', params, replace: true })
  },
})
