import { createContext, useContext } from 'react'
import type { Id } from '../../convex/_generated/dataModel'

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
