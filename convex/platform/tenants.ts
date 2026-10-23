/**
 * Control plane: tenant lifecycle and membership. This folder is the only
 * place raw `query` / `mutation` may be imported.
 */
import { getAuthUserId } from '../lib/authUser'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from '../_generated/server'
import { requireMember, roleValidator } from '../lib/tenancy'
import { mayManageList, staffMayManage } from '../lib/lists'
import { preferencesFor } from './preferences'
import type { Role } from '../lib/tenancy'

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/

/** Throws `invalid` for a malformed slug; returns the tenant already using it, if any. */
export async function tenantForSlug(ctx: QueryCtx, slug: string) {
  if (!SLUG.test(slug)) {
    throw new ConvexError({ kind: 'invalid' as const, field: 'slug' })
  }
  return ctx.db
    .query('tenants')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .unique()
}

/** Tenants the signed-in user belongs to (for the picker / routing). */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return []
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    const tenants = await Promise.all(
      memberships.map(async (m) => {
        const [t, prefs] = await Promise.all([
          ctx.db.get(m.tenantId),
          preferencesFor(ctx, m.tenantId),
        ])
        return t && t.status === 'active'
          ? {
              _id: t._id,
              slug: t.slug,
              name: t.name,
              role: m.role,
              // For landing a user in more than one group (g3q1).
              lastUsedAt: m.lastUsedAt ?? null,
              // The Settings page's switches, with the counters their saves
              // need, and what they mean for this caller.
              staffCanManageTags: staffMayManage(prefs, 'tags'),
              tagsVersion: prefs?.tagsVersion ?? null,
              staffCanManageIdentifierTypes: staffMayManage(
                prefs,
                'identifierTypes',
              ),
              identifierTypesVersion: prefs?.identifierTypesVersion ?? null,
              staffCanManageSourceCodes: staffMayManage(prefs, 'sourceCodes'),
              sourceCodesVersion: prefs?.sourceCodesVersion ?? null,
              staffCanManageFields: staffMayManage(prefs, 'fields'),
              fieldsVersion: prefs?.fieldsVersion ?? null,
              canManageTags: mayManageList(m.role, prefs, 'tags'),
              canManageIdentifierTypes: mayManageList(
                m.role,
                prefs,
                'identifierTypes',
              ),
              canManageSourceCodes: mayManageList(m.role, prefs, 'sourceCodes'),
              canManageFields: mayManageList(m.role, prefs, 'fields'),
            }
          : null
      }),
    )
    return tenants.filter((t) => t !== null)
  },
})

/**
 * The caller opened this group: remember it, so signing in lands them back
 * here (cash-gifts g3q1). Only for people in more than one group, and only
 * when it isn't already their last used, so moving around inside a group
 * writes nothing.
 */
export const opened = mutation({
  args: { tenantId: v.id('tenants') },
  handler: async (ctx, { tenantId }) => {
    const { membership, userId } = await requireMember(ctx, tenantId)
    // Always set for a member; the scope's type allows null for internal
    // functions.
    if (!membership || !userId) {
      throw new ConvexError({ kind: 'unauthenticated' as const })
    }
    const all = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    if (all.length < 2) return
    const latest = Math.max(...all.map((m) => m.lastUsedAt ?? 0))
    if (membership.lastUsedAt !== undefined && membership.lastUsedAt === latest)
      return
    await ctx.db.patch('memberships', membership._id, {
      lastUsedAt: Math.max(Date.now(), latest + 1),
    })
  },
})

/** Resolve a slug for routing; null when unknown or not a member. */
export const bySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return null
    const tenant = await ctx.db
      .query('tenants')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()
    if (!tenant || tenant.status !== 'active') return null
    const membership = await ctx.db
      .query('memberships')
      .withIndex('by_tenant_user', (q) =>
        q.eq('tenantId', tenant._id).eq('userId', userId),
      )
      .unique()
    if (!membership) return null
    return {
      _id: tenant._id,
      slug: tenant.slug,
      name: tenant.name,
      role: membership.role,
    }
  },
})

/** Members of a tenant with display names — for "changed by …" in the UI. */
export const members = query({
  args: { tenantId: v.id('tenants') },
  handler: async (ctx, { tenantId }) => {
    await requireMember(ctx, tenantId)
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_tenant_user', (q) => q.eq('tenantId', tenantId))
      .collect()
    return Promise.all(
      memberships.map(async (m) => {
        const user = await ctx.db.get(m.userId)
        return {
          userId: m.userId,
          role: m.role,
          name: user?.name ?? user?.email ?? 'someone',
        }
      }),
    )
  },
})

/**
 * Operator-only: tenants are created from the CLI, never from the app.
 *
 *   npx convex run platform/tenants:create \
 *     '{"slug":"anytown-hall","name":"Anytown Village Hall","adminEmail":"jo@example.org"}'
 *
 * Until invitations exist (auth-roles R4), `adminEmail` must belong to a
 * user who has already signed up; they become the tenant's admin.
 */
export const create = internalMutation({
  args: { slug: v.string(), name: v.string(), adminEmail: v.string() },
  handler: async (ctx, { slug, name, adminEmail }) => {
    const email = adminEmail.trim()
    const users = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', email))
      .take(2)
    if (users.length === 0) {
      throw new ConvexError({
        kind: 'unknownUser' as const,
        field: 'adminEmail',
        message: `No user with email ${email}: they must sign up before the tenant is created.`,
      })
    }
    if (users.length > 1) {
      throw new ConvexError({
        kind: 'ambiguousUser' as const,
        field: 'adminEmail',
        message: `More than one user has email ${email}.`,
      })
    }
    return insertTenant(ctx, { slug, name, adminUserId: users[0]._id })
  },
})

/**
 * A new active tenant with one admin, reference data scheduled after commit.
 * Shared by `create` and the dev seed.
 */
export async function insertTenant(
  ctx: MutationCtx,
  args: { slug: string; name: string; adminUserId: Id<'users'> },
) {
  if (await tenantForSlug(ctx, args.slug)) {
    throw new ConvexError({ kind: 'taken' as const, field: 'slug' })
  }
  const tenantId = await ctx.db.insert('tenants', {
    slug: args.slug,
    name: args.name.trim(),
    status: 'active',
  })
  await ctx.db.insert('memberships', {
    tenantId,
    userId: args.adminUserId,
    role: 'admin',
  })
  // Reference data lands after commit, through the scoped constructors.
  await ctx.scheduler.runAfter(0, internal.contacts.seed.relationshipTypes, {
    tenantId,
  })
  await ctx.scheduler.runAfter(0, internal.contacts.seed.tags, { tenantId })
  await ctx.scheduler.runAfter(0, internal.sources.seed.categories, {
    tenantId,
  })
  return tenantId
}

/**
 * Used by `tenantAction` (actions have no db) to enforce membership and
 * role; returns the caller and their role.
 */
export const assertMember = internalQuery({
  args: { tenantId: v.id('tenants'), minRole: roleValidator },
  handler: async (
    ctx,
    { tenantId, minRole },
  ): Promise<{ role: Role; userId: Id<'users'> }> => {
    const { role, userId } = await requireMember(ctx, tenantId, minRole)
    // A member always has a user; the scope's type allows null for
    // internal functions.
    if (!userId) throw new ConvexError({ kind: 'unauthenticated' as const })
    return { role, userId }
  },
})
