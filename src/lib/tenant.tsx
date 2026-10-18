import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useConvexAuth, useQuery } from 'convex/react'
import type { ConvexReactClient } from 'convex/react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'

export type Tenant = {
  _id: Id<'tenants'>
  slug: string
  name: string
  role: 'admin' | 'staff' | 'viewer'
}

export const TenantContext = createContext<Tenant | null>(null)

export function useTenant(): Tenant {
  const tenant = useContext(TenantContext)
  if (!tenant) throw new Error('useTenant outside a tenant route')
  return tenant
}

/**
 * Whether the caller may write in this tenant: viewers read only (ADR
 * 0020). The backend enforces it; this only hides controls that would fail.
 */
export function useCanWrite(): boolean {
  return useTenant().role !== 'viewer'
}

/**
 * Whether the caller is an admin of this tenant: settings are admin only
 * (ADR 0020). As with useCanWrite, the backend enforces it.
 */
export function useIsAdmin(): boolean {
  return useTenant().role === 'admin'
}

// The signed-in user's groups, subscribed once above the router so the
// list stays live (and in the Convex client's cache) across navigation.
// The groups page lists it; a tenant route resolves its slug from it with
// no round trip of its own. undefined: loading or signed out.
const MyTenantsContext = createContext<Array<Tenant> | undefined>(undefined)

export function MyTenantsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth()
  const tenants = useQuery(
    api.platform.tenants.mine,
    isAuthenticated ? {} : 'skip',
  )
  return (
    <MyTenantsContext.Provider value={tenants}>
      {children}
    </MyTenantsContext.Provider>
  )
}

export function useMyTenants(): Array<Tenant> | undefined {
  return useContext(MyTenantsContext)
}

/**
 * A slug's tenant from the client's cache of `mine` (live while the
 * provider is mounted), for route loaders; undefined when not loaded.
 */
export function cachedTenant(
  convex: ConvexReactClient,
  slug: string,
): Tenant | undefined {
  return convex
    .watchQuery(api.platform.tenants.mine, {})
    .localQueryResult()
    ?.find((t) => t.slug === slug)
}
