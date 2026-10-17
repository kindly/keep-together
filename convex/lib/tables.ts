import schema from '../schema'

/**
 * Tables the control plane owns. Everything else is a domain table and must
 * be tenant-scoped (tenantId field, tenantId-first indexes). Auth tables
 * come from @convex-dev/auth and are global by nature.
 */
export const PLATFORM_TABLES = new Set<string>([
  'tenants',
  'memberships',
  'tenantSettings',
  // @convex-dev/auth
  'users',
  'authSessions',
  'authAccounts',
  'authRefreshTokens',
  'authVerificationCodes',
  'authVerifiers',
  'authRateLimits',
])

export const ALL_TABLES = Object.keys(schema.tables)

export const DOMAIN_TABLES = ALL_TABLES.filter((t) => !PLATFORM_TABLES.has(t))

type ExportedTable = {
  indexes: Array<{ indexDescriptor: string; fields: Array<string> }>
  searchIndexes: Array<{ indexDescriptor: string; filterFields: Array<string> }>
}

type TableLike = {
  validator: { fields?: Record<string, unknown> }
  export: () => ExportedTable
}

function table(name: string): TableLike {
  return (schema.tables as Record<string, unknown>)[name] as TableLike
}

/** Does this table's document validator declare a `tenantId` field? */
export function hasTenantId(name: string): boolean {
  return 'tenantId' in (table(name).validator.fields ?? {})
}

/** Indexes whose first field is not `tenantId` (empty for a well-formed domain table). */
export function unscopedIndexes(name: string): Array<string> {
  const exported = table(name).export()
  const bad = exported.indexes
    .filter((i) => i.fields[0] !== 'tenantId')
    .map((i) => i.indexDescriptor)
  const badSearch = exported.searchIndexes
    .filter((i) => !i.filterFields.includes('tenantId'))
    .map((i) => `search:${i.indexDescriptor}`)
  return [...bad, ...badSearch]
}
