import { appTables } from './appSchema'

/**
 * @convex-dev/auth's tables, global by nature. Named here rather than read
 * from `authTables`, so the tenancy rules can deny them without importing
 * the auth library (`appSchema.ts` says why); `tables.test.ts` checks the
 * list against the real schema.
 */
export const AUTH_TABLES = [
  'users',
  'authSessions',
  'authAccounts',
  'authRefreshTokens',
  'authVerificationCodes',
  'authVerifiers',
  'authRateLimits',
]

/**
 * Tables the control plane owns. Everything else is a domain table and must
 * be tenant-scoped (tenantId field, tenantId-first indexes).
 */
export const PLATFORM_TABLES = new Set<string>([
  'tenants',
  'memberships',
  'tenantSettings',
  ...AUTH_TABLES,
])

export const ALL_TABLES = [...Object.keys(appTables), ...AUTH_TABLES]

export const DOMAIN_TABLES = ALL_TABLES.filter((t) => !PLATFORM_TABLES.has(t))

type ExportedTable = {
  indexes: Array<{ indexDescriptor: string; fields: Array<string> }>
  searchIndexes: Array<{ indexDescriptor: string; filterFields: Array<string> }>
}

type TableLike = {
  validator: { fields?: Record<string, unknown> }
  export: () => ExportedTable
}

// Domain tables are all app tables; an auth table has no tenantId.
function table(name: string): TableLike | undefined {
  return (appTables as Record<string, unknown>)[name] as TableLike | undefined
}

/** Does this table's document validator declare a `tenantId` field? */
export function hasTenantId(name: string): boolean {
  return 'tenantId' in (table(name)?.validator.fields ?? {})
}

/** Indexes whose first field is not `tenantId` (empty for a well-formed domain table). */
export function unscopedIndexes(name: string): Array<string> {
  const t = table(name)
  if (!t) return [`unknown table ${name}`]
  const exported = t.export()
  const bad = exported.indexes
    .filter((i) => i.fields[0] !== 'tenantId')
    .map((i) => i.indexDescriptor)
  const badSearch = exported.searchIndexes
    .filter((i) => !i.filterFields.includes('tenantId'))
    .map((i) => `search:${i.indexDescriptor}`)
  return [...bad, ...badSearch]
}
