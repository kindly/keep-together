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
