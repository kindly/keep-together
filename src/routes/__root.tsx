import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import type { Loaders } from '../lib/data'

import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import { MyTenantsProvider } from '../lib/data'
import '../styles.css'

/** What route loaders get: the query client, to start their reads. */
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
