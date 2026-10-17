import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { ConvexReactClient } from 'convex/react'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { routeTree } from './routeTree.gen'

// Written by `pnpm convex` into .env.local; CI/Pages supply it as a variable.
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined
if (!convexUrl) {
  throw new Error('VITE_CONVEX_URL is not set — run `pnpm convex` first')
}
const convex = new ConvexReactClient(convexUrl, {
  // Keep the cached JWT on page load (a refresh is still scheduled before
  // it expires). Without it the client fetches a fresh token right after
  // connecting, and the second Authenticate makes the server re-run every
  // subscription: a refresh round trip plus a full re-run on every load,
  // landing on whatever the user does first. Experimental in convex 1.47.
  initialAuthTokenReuse: true,
})

const router = createRouter({
  routeTree,
  // Vite's `base` (BASE_PATH at build time) so the SPA works under
  // /<repo>/ on GitHub Pages as well as at /.
  basepath: import.meta.env.BASE_URL,
  defaultPreload: 'intent',
  // Route loaders prewarm the Convex queries their page subscribes to.
  context: { convex },
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <ConvexAuthProvider client={convex}>
      <RouterProvider router={router} />
    </ConvexAuthProvider>,
  )
}
