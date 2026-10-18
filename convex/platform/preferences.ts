/**
 * Per-tenant preferences: plain, non-secret switches an admin sets on the
 * Settings page (secrets go in `tenantSettings`, encrypted). One row per
 * tenant at most, created by the first save; no row means every default.
 *
 * `staffCanManageLists` (default off): whether staff, as well as admins,
 * may create, rename and archive / reactivate the tenant's tags and
 * identifier types (the rule is in lib/lists). Putting tags and
 * identifiers on contacts is ordinary staff editing either way; viewers
 * never write.
 */
import { ConvexError, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { defineContract, executeContract } from '../lib/contracts'
import { tenantPreferences } from '../lib/lists'
import { tenantMutation } from '../lib/tenancy'

export const listsFields = { staffCanManageLists: v.boolean() }

export const lists = defineContract({
  name: 'tenantPreferences.lists',
  entity: 'tenantPreferences',
  version: 1,
  counter: 'listsVersion',
  fields: listsFields,
  apply: async (ctx, p, root) => {
    if (!root) {
      return ctx.db.insert('tenantPreferences', { ...p, listsVersion: 0 })
    }
    await ctx.db.patch('tenantPreferences', root._id, p)
    return root._id
  },
})

/**
 * The tenant's preferences row, for `platform/tenants:mine`, which reads
 * across the caller's tenants with the raw db.
 */
export async function preferencesFor(
  ctx: QueryCtx,
  tenantId: Doc<'tenants'>['_id'],
) {
  return ctx.db
    .query('tenantPreferences')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
    .unique()
}

/** Turn "staff can manage tags and identifier types" on or off. Admin only. */
export const setStaffCanManageLists = tenantMutation({
  minRole: 'admin',
  args: { expected: v.optional(v.number()), ...listsFields },
  handler: async (ctx, { expected, ...payload }) => {
    const row = await tenantPreferences(ctx.db)
    // The caller saw no row (the default), but another admin saved first.
    if (row && expected === undefined) {
      throw new ConvexError({
        kind: 'stale' as const,
        contract: lists.name,
        current: row.listsVersion,
      })
    }
    return executeContract(ctx, lists, payload, {
      entityId: row?._id,
      expected,
      source: 'ui',
    })
  },
})
