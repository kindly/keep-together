/**
 * Scoped function constructors — the ONLY way to declare domain functions.
 *
 * `tenantQuery` / `tenantMutation` take a `tenantId` argument, verify the
 * caller is a member of that tenant, and hand the handler a `ctx.db` that is
 * wrapped so every read is filtered to, and every write checked against,
 * that tenant. Handlers never see `tenantId` and never filter by it.
 *
 * `internalTenant*` skip the membership check (callers are trusted:
 * scheduler, crons, webhook handlers) but keep the wrapped db.
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
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import { internal } from '../_generated/api'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from '../_generated/server'
import type { QueryCtx } from '../_generated/server'
import { ALL_TABLES, hasTenantId } from './tables'

export type TenantScope = {
  tenant: Doc<'tenants'>
  membership: Doc<'memberships'> | null
  userId: Id<'users'> | null
}

type RuleCtx = { tenantId: Id<'tenants'> }

// Built once from the schema: tenant-scoped tables compare `doc.tenantId`;
// the tenants table exposes only the current tenant; everything else
// (auth tables) is invisible to domain code.
const rules = Object.fromEntries(
  ALL_TABLES.map((name) => {
    if (name === 'tenants') {
      return [
        name,
        {
          read: async (c: RuleCtx, doc: Doc<'tenants'>) => doc._id === c.tenantId,
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
  return { tenant, membership, userId }
}

export const tenantQuery = customQuery(query, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    const scope = await requireMember(ctx, tenantId)
    return {
      ctx: { ...scope, db: wrapDatabaseReader({ tenantId }, ctx.db, rules) },
      args: {},
    }
  },
})

export const tenantMutation = customMutation(mutation, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    const scope = await requireMember(ctx, tenantId)
    return {
      ctx: { ...scope, db: wrapDatabaseWriter({ tenantId }, ctx.db, rules) },
      args: {},
    }
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
    const scope: TenantScope = { tenant, membership: null, userId: null }
    return {
      ctx: { ...scope, db: wrapDatabaseReader({ tenantId }, ctx.db, rules) },
      args: {},
    }
  },
})

export const internalTenantMutation = customMutation(internalMutation, {
  args: tenantArgs,
  input: async (ctx, { tenantId }) => {
    const tenant = await loadTenant(ctx, tenantId)
    const scope: TenantScope = { tenant, membership: null, userId: null }
    return {
      ctx: { ...scope, db: wrapDatabaseWriter({ tenantId }, ctx.db, rules) },
      args: {},
    }
  },
})

export const internalTenantAction = customAction(internalAction, {
  args: tenantArgs,
  input: async (_ctx, { tenantId }) => ({ ctx: { tenantId }, args: {} }),
})
