/**
 * Scoped function constructors — the ONLY way to declare domain functions.
 *
 * `tenantQuery` / `tenantMutation` take a `tenantId` argument, verify the
 * caller is a member of that tenant, and hand the handler a scoped `ctx.db`:
 *
 * - every `insert` / `replace` is stamped with the tenant;
 * - every `withIndex` range is prefixed with `tenantId` (domain indexes are
 *   tenantId-first by schema test), every search filter gets `tenantId`;
 * - `get` returns null for another tenant's document, and `patch` /
 *   `replace` / `delete` on one throws (row-level rules).
 *
 * Handlers never see `tenantId` and never filter by it. There is no
 * unindexed `query(table)` on the scoped db: a domain read is always an
 * index range inside one tenant.
 *
 * `internalTenant*` skip the membership check (callers are trusted:
 * scheduler, crons, webhook handlers) but keep the scoped db.
 *
 * Raw `query` / `mutation` / `action` may only be imported under
 * `convex/platform/` — ESLint enforces this.
 */
import { getAuthUserId } from '@convex-dev/auth/server'
import {
  customAction,
  customMutation,
  customQuery,
} from 'convex-helpers/server/customFunctions'
import {
  wrapDatabaseReader,
  wrapDatabaseWriter,
} from 'convex-helpers/server/rowLevelSecurity'
import type { Rules } from 'convex-helpers/server/rowLevelSecurity'
import { ConvexError, v } from 'convex/values'
import type {
  DocumentByInfo,
  IndexNames,
  IndexRange,
  IndexRangeBuilder,
  NamedIndex,
  NamedSearchIndex,
  NamedTableInfo,
  OrderedQuery,
  Query,
  SearchFilterBuilder,
  SearchFilterFinalizer,
  SearchIndexNames,
  WithoutSystemFields,
} from 'convex/server'
import type { DataModel, Doc, Id, TableNames } from '../_generated/dataModel'
import { internal } from '../_generated/api'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from '../_generated/server'
import type {
  DatabaseReader,
  DatabaseWriter,
  QueryCtx,
} from '../_generated/server'
import { ALL_TABLES, hasTenantId } from './tables'

/** A tenant role (ADR 0020). */
export type Role = Exclude<Doc<'memberships'>['role'], 'owner'>

/** A membership's role; a not-yet-backfilled 'owner' reads as 'admin'. */
export function roleOf(membership: Doc<'memberships'>): Role {
  return membership.role === 'owner' ? 'admin' : membership.role
}

export type TenantScope = {
  tenant: Doc<'tenants'>
  membership: Doc<'memberships'> | null
  /** The caller's role; null in internal functions (no caller). */
  role: Role | null
  userId: Id<'users'> | null
}

// ── scoped db types ────────────────────────────────────────────────────────

type Info<T extends TableNames> = NamedTableInfo<DataModel, T>

/** A query on a tenant table: index ranges start *after* `tenantId`. */
export type ScopedQueryInitializer<T extends TableNames> = {
  withIndex: <TIndex extends IndexNames<Info<T>>>(
    index: TIndex,
    range?: (
      q: IndexRangeBuilder<
        DocumentByInfo<Info<T>>,
        NamedIndex<Info<T>, TIndex>,
        1
      >,
    ) => IndexRange,
  ) => Query<Info<T>>
  withSearchIndex: <TIndex extends SearchIndexNames<Info<T>>>(
    index: TIndex,
    filter: (
      q: SearchFilterBuilder<
        DocumentByInfo<Info<T>>,
        NamedSearchIndex<Info<T>, TIndex>
      >,
    ) => SearchFilterFinalizer<
      DocumentByInfo<Info<T>>,
      NamedSearchIndex<Info<T>, TIndex>
    >,
  ) => OrderedQuery<Info<T>>
}

export type ScopedDatabaseReader = {
  get: DatabaseReader['get']
  normalizeId: DatabaseReader['normalizeId']
  system: DatabaseReader['system']
  query: <T extends TableNames>(table: T) => ScopedQueryInitializer<T>
}

/** Insert / replace values never carry `tenantId`; the db stamps it. */
export type Insertable<T extends TableNames> = Omit<
  WithoutSystemFields<Doc<T>>,
  'tenantId'
>

export type ScopedDatabaseWriter = ScopedDatabaseReader & {
  insert: <T extends TableNames>(
    table: T,
    value: Insertable<T>,
  ) => Promise<Id<T>>
  patch: DatabaseWriter['patch']
  replace: <T extends TableNames>(
    table: T,
    id: Id<T>,
    value: Insertable<T>,
  ) => Promise<void>
  delete: DatabaseWriter['delete']
}

// ── row-level rules (built once from the schema) ───────────────────────────

type RuleCtx = { tenantId: Id<'tenants'> }

// Tenant-scoped tables compare `doc.tenantId`; the tenants table exposes only
// the current tenant; everything else (auth tables) is invisible to domain
// code.
const rules = Object.fromEntries(
  ALL_TABLES.map((name) => {
    if (name === 'tenants') {
      return [
        name,
        {
          read: async (c: RuleCtx, doc: Doc<'tenants'>) =>
            doc._id === c.tenantId,
          insert: async () => false,
          modify: async () => false,
        },
      ]
    }
    if (hasTenantId(name)) {
      const own = async (c: RuleCtx, doc: { tenantId: Id<'tenants'> }) =>
        doc.tenantId === c.tenantId
      return [name, { read: own, insert: own, modify: own }]
    }
    return [
      name,
      {
        read: async () => false,
        insert: async () => false,
        modify: async () => false,
      },
    ]
  }),
) as Rules<RuleCtx, DataModel>

// ── scoped db construction ─────────────────────────────────────────────────

/**
 * The RLS query (convex-helpers' QueryWithFilter) collects a row before it
 * checks the limit, so its `take(0)` returns one row. Every query handed to
 * domain code goes through this, as do the queries `order` returns.
 */
function guardTake<TQuery extends object>(q: TQuery): TQuery {
  return new Proxy(q, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (prop === 'take') {
        return (n: number) =>
          n <= 0 ? Promise.resolve([]) : value.call(target, n)
      }
      if (prop === 'order' || prop === 'filter') {
        return (...args: Array<unknown>) =>
          guardTake(value.apply(target, args) as object)
      }
      return value.bind(target)
    },
  })
}

function scopedReader(
  tenantId: Id<'tenants'>,
  rls: DatabaseReader,
): ScopedDatabaseReader {
  const get: DatabaseReader['get'] = rls.get.bind(rls)
  return {
    get,
    normalizeId: rls.normalizeId.bind(rls),
    system: rls.system,
    query: (table) => ({
      withIndex: (index, range) =>
        guardTake(
          rls.query(table).withIndex(index as any, (q: any) => {
            const scoped = q.eq('tenantId', tenantId)
            return range ? range(scoped) : scoped
          }),
        ),
      withSearchIndex: (index, filter) =>
        guardTake(
          rls
            .query(table)
            .withSearchIndex(index as any, (q: any) =>
              (filter(q) as any).eq('tenantId', tenantId),
            ),
        ),
    }),
  }
}

function scopedWriter(
  tenantId: Id<'tenants'>,
  rls: DatabaseWriter,
): ScopedDatabaseWriter {
  const patch: DatabaseWriter['patch'] = rls.patch.bind(rls)
  const remove: DatabaseWriter['delete'] = rls.delete.bind(rls)
  return {
    ...scopedReader(tenantId, rls),
    insert: (table, value) =>
      rls.insert(table, { ...(value as any), tenantId }),
    patch,
    replace: (table, id, value) =>
      rls.replace(table, id, { ...(value as any), tenantId }),
    delete: remove,
  }
}

export function scopeReader(ctx: QueryCtx, tenantId: Id<'tenants'>) {
  return scopedReader(tenantId, wrapDatabaseReader({ tenantId }, ctx.db, rules))
}

export function scopeWriter(
  ctx: { db: DatabaseWriter },
  tenantId: Id<'tenants'>,
) {
  return scopedWriter(tenantId, wrapDatabaseWriter({ tenantId }, ctx.db, rules))
}

// ── membership ─────────────────────────────────────────────────────────────

const tenantArgs = { tenantId: v.id('tenants') }

async function loadTenant(ctx: QueryCtx, tenantId: Id<'tenants'>) {
  const tenant = await ctx.db.get(tenantId)
  if (!tenant || tenant.status !== 'active') {
    throw new ConvexError({ kind: 'forbidden' as const })
  }
  return tenant
}

/** Authenticated caller must be a member of the tenant. */
export async function requireMember(
  ctx: QueryCtx,
  tenantId: Id<'tenants'>,
): Promise<TenantScope> {
  const userId = await getAuthUserId(ctx)
  if (!userId) throw new ConvexError({ kind: 'unauthenticated' as const })
  const membership = await ctx.db
    .query('memberships')
    .withIndex('by_tenant_user', (q) =>
      q.eq('tenantId', tenantId).eq('userId', userId),
    )
    .unique()
  if (!membership) throw new ConvexError({ kind: 'forbidden' as const })
  const tenant = await loadTenant(ctx, tenantId)
  return { tenant, membership, role: roleOf(membership), userId }
}

// ── constructors ───────────────────────────────────────────────────────────

export const tenantQuery = customQuery(query, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    const scope = await requireMember(ctx, tenantId)
    return { ctx: { ...scope, db: scopeReader(ctx, tenantId) }, args: {} }
  },
})

export const tenantMutation = customMutation(mutation, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    const scope = await requireMember(ctx, tenantId)
    return { ctx: { ...scope, db: scopeWriter(ctx, tenantId) }, args: {} }
  },
})

// Actions have no db; they verify membership and carry tenantId for the
// internal functions they call.
export const tenantAction = customAction(action, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    await ctx.runQuery(internal.platform.tenants.assertMember, { tenantId })
    return { ctx: { tenantId }, args: {} }
  },
})

export const internalTenantQuery = customQuery(internalQuery, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    const tenant = await loadTenant(ctx, tenantId)
    const scope: TenantScope = {
      tenant,
      membership: null,
      role: null,
      userId: null,
    }
    return { ctx: { ...scope, db: scopeReader(ctx, tenantId) }, args: {} }
  },
})

export const internalTenantMutation = customMutation(internalMutation, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    const tenant = await loadTenant(ctx, tenantId)
    const scope: TenantScope = {
      tenant,
      membership: null,
      role: null,
      userId: null,
    }
    return { ctx: { ...scope, db: scopeWriter(ctx, tenantId) }, args: {} }
  },
})

export const internalTenantAction = customAction(internalAction, {
  args: tenantArgs,
  input: async (_ctx, { tenantId }) => ({ ctx: { tenantId }, args: {} }),
})
