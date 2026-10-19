/**
 * The starter categories, and demo details for the test and QC worlds.
 * The categories are scheduled by platform.tenants.insertTenant for a
 * new tenant, and run for existing ones by sources/migrations:seedCategories.
 */
import type { Id } from '../_generated/dataModel'
import { commandGroup, executeContract } from '../lib/contracts'
import type { CommandGroup, ContractCtx } from '../lib/contracts'
import { internalTenantMutation } from '../lib/tenancy'
import { code } from './code'
import { createPart } from './mutations'
import {
  FIRST_VERSION_NAME,
  SEED_CATEGORIES,
  normaliseSourceName,
} from './rules'

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

/** A detail to seed under an existing category, with its versions. */
export type SeedDetail = {
  category: string
  name: string
  description?: string
  startDate?: string
  endDate?: string
  /** The first is the auto-created `001`, renamed if named otherwise. */
  versions: Array<{
    name: string
    description?: string
    startDate?: string
    endDate?: string
  }>
  archived?: boolean
}

/**
 * Seed `details` (test and QC worlds) through the contract, source
 * `seed`. A detail whose category is missing, or that already exists, is
 * skipped, so a rerun changes nothing. Returns how many were created.
 */
export async function seedDetails(
  ctx: ContractCtx,
  details: ReadonlyArray<SeedDetail>,
  group?: CommandGroup,
): Promise<number> {
  const byName = (parentId: Id<'sourceCodes'> | undefined, name: string) =>
    ctx.db
      .query('sourceCodes')
      .withIndex('by_tenant_parent', (q) =>
        q
          .eq('parentId', parentId)
          .eq('nameNormalized', normaliseSourceName(name)),
      )
      .first()
  let created = 0
  let g = group
  for (const d of details) {
    const category = await byName(undefined, d.category)
    if (!category || (await byName(category._id, d.name))) continue
    g ??= await commandGroup(ctx, 'seed source codes')
    const opts = { source: 'seed', group: g } as const
    const { id, versionId } = await createPart(
      ctx,
      category._id,
      {
        name: d.name,
        description: d.description,
        startDate: d.startDate,
        endDate: d.endDate,
        isActive: !d.archived,
      },
      'seed',
      g,
    )
    const first = d.versions.at(0)
    const renamed =
      first &&
      (first.name !== FIRST_VERSION_NAME ||
        first.description ||
        first.startDate ||
        first.endDate)
    if (renamed && versionId) {
      await executeContract(
        ctx,
        code,
        { ...first, isActive: true },
        { ...opts, entityId: versionId, expected: 0 },
      )
    }
    for (const v of d.versions.slice(1)) {
      await executeContract(
        ctx,
        code,
        { ...v, isActive: true },
        { ...opts, createWith: { parentId: id } },
      )
    }
    created += 1
  }
  return created
}
