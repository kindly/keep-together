import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import type { ConvexReactClient } from 'convex/react'

import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import { MyTenantsProvider } from '../lib/tenant'
import '../styles.css'

export interface RouterContext {
  convex: ConvexReactClient
}

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
