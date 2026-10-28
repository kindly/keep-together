import { createContext, useContext } from 'react'
import type { Id } from './domain/ids'
import type { ListKind } from './data/rust-types/ListKind'

export type Tenant = {
  _id: Id<'tenants'>
  slug: string
  name: string
  role: 'admin' | 'staff' | 'viewer'
  /** When the caller last opened this group (ms); null if never recorded. */
  lastUsedAt: number | null
  /** The tenant's "staff can manage identifier types" switch. */
  staffCanManageIdentifierTypes: boolean
  /** Its counter, for the switch's save; null until first saved. */
  identifierTypesVersion: number | null
  /** The tenant's "staff can manage source codes" switch. */
  staffCanManageSourceCodes: boolean
  /** Its counter, for the switch's save; null until first saved. */
  sourceCodesVersion: number | null
  /** The tenant's "staff can manage fields" switch. */
  staffCanManageFields: boolean
  /** Its counter, for the switch's save; null until first saved. */
  fieldsVersion: number | null
  /** Whether this caller may manage identifier types, given role and switch. */
  canManageIdentifierTypes: boolean
  /** Whether this caller may manage source codes, given role and switch. */
  canManageSourceCodes: boolean
  /** Whether this caller may manage dropdown fields, given role and switch. */
  canManageFields: boolean
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

/**
 * Whether the caller may create, rename and archive the tenant's
 * identifier types, its source codes or its dropdown fields: admins, and
 * staff when the group allows it for that list. The backend enforces it (lib/lists).
 */
export function useCanManageList(kind: ListKind): boolean {
  const tenant = useTenant()
  return {
    identifierTypes: tenant.canManageIdentifierTypes,
    sourceCodes: tenant.canManageSourceCodes,
    fields: tenant.canManageFields,
  }[kind]
}

/**
 * The group signing in lands in (cash-gifts g2q3, g3q1): the one last
 * used, else the first by name; null with no groups.
 */
export function landingTenant<T extends Pick<Tenant, 'name' | 'lastUsedAt'>>(
  tenants: Array<T>,
): T | null {
  let best: T | null = null
  for (const t of tenants) {
    if (
      best === null ||
      (t.lastUsedAt ?? -1) > (best.lastUsedAt ?? -1) ||
      (t.lastUsedAt === best.lastUsedAt && t.name.localeCompare(best.name) < 0)
    )
      best = t
  }
  return best
}
