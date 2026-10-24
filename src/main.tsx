import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConvexReactClient } from 'convex/react'
import type { ReactNode } from 'react'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { routeTree } from './routeTree.gen'
import { BACKEND } from './lib/data'
import type { Loaders } from './lib/data'
import { queryClient } from './lib/data/rust/hooks'

/** The Convex client, or null on the Rust backend (never connected). */
function convexClient(): ConvexReactClient | null {
  if (BACKEND === 'rust') return null
  // Written by `pnpm convex` into .env.local; CI/Pages supply it as a variable.
  const convexUrl = import.meta.env.VITE_CONVEX_URL
  if (!convexUrl) {
    throw new Error('VITE_CONVEX_URL is not set — run `pnpm convex` first')
  }
  return new ConvexReactClient(convexUrl, {
    // Keep the cached JWT on page load (a refresh is still scheduled before
    // it expires). Without it the client fetches a fresh token right after
    // connecting, and the second Authenticate makes the server re-run every
    // subscription: a refresh round trip plus a full re-run on every load,
    // landing on whatever the user does first. Experimental in convex 1.47:
    // re-check on upgrades.
    // Security: the skipped refresh was also a revocation check, so a session
    // revoked elsewhere (sign-out everywhere, password reset) survives a
    // reload until its JWT expires (Convex Auth default 1 h), as an open tab
    // already does. Membership and role are still checked on every call. R4's
    // admin step-up must check the session's sign-in time on the server, not
    // the token's age.
    initialAuthTokenReuse: true,
  })
}

const convex = convexClient()

const router = createRouter({
  routeTree,
  // Vite's `base` (BASE_PATH at build time) so the SPA works under
  // /<repo>/ on GitHub Pages as well as at /.
  basepath: import.meta.env.BASE_URL,
  defaultPreload: 'intent',
  // Route loaders start the reads their page makes (lib/data). On Rust no
  // loader reads `convex`.
  context: { convex, queryClient } as Loaders,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

function Backend({ children }: { children: ReactNode }) {
  return convex ? (
    <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>
  ) : (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <Backend>
      <RouterProvider router={router} />
    </Backend>,
  )
}
