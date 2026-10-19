/**
 * The starter categories. Scheduled by platform.tenants.insertTenant for a
 * new tenant, and run for existing ones by sources/migrations:seedCategories.
 */
import { commandGroup } from '../lib/contracts'
import type { CommandGroup, ContractCtx } from '../lib/contracts'
import { internalTenantMutation } from '../lib/tenancy'
import { createPart } from './mutations'
import { SEED_CATEGORIES } from './rules'

/**
 * The seed categories, unless the tenant already has any source code (so
 * a rerun is a no-op, and a deleted seed never comes back). Through the
 * contract, source `seed`, under `group` or one of its own.
 */
export async function ensureSeedCategories(
  ctx: ContractCtx,
  group?: CommandGroup,
): Promise<number> {
  const existing = await ctx.db
    .query('sourceCodes')
    .withIndex('by_tenant_parent')
    .first()
  if (existing) return 0
  const g = group ?? (await commandGroup(ctx, 'seed source codes'))
  for (const name of SEED_CATEGORIES) {
    await createPart(ctx, undefined, { name, isActive: true }, 'seed', g)
  }
  return SEED_CATEGORIES.length
}

export const categories = internalTenantMutation({
  args: {},
  handler: async (ctx) => ({ seeded: await ensureSeedCategories(ctx) }),
})
