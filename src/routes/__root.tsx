import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import type { Loaders } from '../lib/data'

import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import { MyTenantsProvider } from '../lib/data'
import '../styles.css'

/**
 * Route loaders' clients. Only the build's backend (`VITE_BACKEND`) is
 * constructed; on Rust, `convex` is absent and no route that reads it is
 * reachable from the navigation.
 */
export type RouterContext = Loaders

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
})

function RootComponent() {
  return (
    <>
      <MyTenantsProvider>
        <Outlet />
      </MyTenantsProvider>
      <TanStackDevtools
        config={{
          position: 'bottom-right',
        }}
        plugins={[
          {
            name: 'TanStack Router',
            render: <TanStackRouterDevtoolsPanel />,
          },
        ]}
      />
    </>
  )
}
