import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import { queryClient } from './lib/data'
import type { Loaders } from './lib/data'
import { boot } from './lib/data/rust/hooks'

// A cold load of a tenant page: one request for its first reads.
const tenantPage = new RegExp(
  `^${import.meta.env.BASE_URL.replace(/\/$/, '')}/t/([^/]+)`,
).exec(window.location.pathname)
if (tenantPage) boot(queryClient, decodeURIComponent(tenantPage[1]))

const router = createRouter({
  routeTree,
  // Vite's `base` (BASE_PATH at build time), so the SPA works under a
  // path prefix as well as at /.
  basepath: import.meta.env.BASE_URL,
  defaultPreload: 'intent',
  // Route loaders start the reads their page makes (lib/data).
  context: { queryClient } satisfies Loaders,
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
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}
