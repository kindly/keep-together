import { createFileRoute, redirect } from '@tanstack/react-router'

// Tags are gone (dropdown fields replace them); old links and bookmarks
// land on Settings › Fields.
export const Route = createFileRoute('/t/$slug/tags')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/t/$slug/settings/fields', params, replace: true })
  },
})
