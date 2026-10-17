/**
 * Control plane: tenant lifecycle and membership. This folder is the only
 * place raw `query` / `mutation` may be imported.
 */
import { getAuthUserId } from '@convex-dev/auth/server'
import { ConvexError, v } from 'convex/values'
import { internalQuery, mutation, query } from '../_generated/server'
import { requireMember } from '../lib/tenancy'

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/

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
        const t = await ctx.db.get(m.tenantId)
        return t && t.status === 'active'
          ? { _id: t._id, slug: t.slug, name: t.name, role: m.role }
          : null
      }),
    )
    return tenants.filter((t) => t !== null)
  },
})

/** Self-serve signup: create a group and make the caller its owner. */
export const create = mutation({
  args: { slug: v.string(), name: v.string() },
  handler: async (ctx, { slug, name }) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) throw new ConvexError({ kind: 'unauthenticated' as const })
    if (!SLUG.test(slug)) {
      throw new ConvexError({ kind: 'invalid' as const, field: 'slug' })
    }
    const existing = await ctx.db
      .query('tenants')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()
    if (existing) {
      throw new ConvexError({ kind: 'taken' as const, field: 'slug' })
    }
    const tenantId = await ctx.db.insert('tenants', {
      slug,
      name: name.trim(),
      status: 'active',
    })
    await ctx.db.insert('memberships', { tenantId, userId, role: 'owner' })
    return tenantId
  },
})

/** Used by `tenantAction` (actions have no db) to enforce membership. */
export const assertMember = internalQuery({
  args: { tenantId: v.id('tenants') },
  handler: async (ctx, { tenantId }) => {
    await requireMember(ctx, tenantId)
    return null
  },
})
