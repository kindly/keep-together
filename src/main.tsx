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
const convex = new ConvexReactClient(convexUrl)

const router = createRouter({
  routeTree,
  // Vite's `base` (BASE_PATH at build time) so the SPA works under
  // /<repo>/ on GitHub Pages as well as at /.
  basepath: import.meta.env.BASE_URL,
  defaultPreload: 'intent',
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
