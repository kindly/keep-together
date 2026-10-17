/**
 * Per-tenant reference data. Scheduled by platform.tenants.create; idempotent.
 */
import type { Id } from '../_generated/dataModel'
import { commandGroup, executeContract } from '../lib/contracts'
import type { ContractCtx } from '../lib/contracts'
import { internalTenantMutation } from '../lib/tenancy'
import { relationshipType, tag } from './contracts'

type Kind = 'individual' | 'organization' | 'household'

export const UK_RELATIONSHIP_TYPES: Array<[string, string, Kind, Kind]> = [
  ['Employee of', 'Employer of', 'individual', 'organization'],
  ['Member of household', 'Household member is', 'individual', 'household'],
  ['Head of household for', 'Head of household is', 'individual', 'household'],
  ['Trustee of', 'Has trustee', 'individual', 'organization'],
  ['Spouse/partner of', 'Spouse/partner of', 'individual', 'individual'],
  ['Parent of', 'Child of', 'individual', 'individual'],
  ['Volunteer for', 'Has volunteer', 'individual', 'organization'],
]

export const relationshipTypes = internalTenantMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query('relationshipTypes')
      .withIndex('by_tenant')
      .first()
    if (existing) return { seeded: 0 }
    const group = await commandGroup(ctx, 'seed relationship types')
    for (const [labelAB, labelBA, kindA, kindB] of UK_RELATIONSHIP_TYPES) {
      await executeContract(
        ctx,
        relationshipType,
        { labelAB, labelBA, kindA, kindB, isActive: true },
        { source: 'seed', group },
      )
    }
    return { seeded: UK_RELATIONSHIP_TYPES.length }
  },
})

/** Donor is not here: it becomes a computed segment once giving exists. */
export const SEED_TAGS = ['Member', 'Volunteer']

/**
 * The seed tags, unless the tenant already has any tags. Shared with the
 * platform seeds, which seed inline so their world is complete on return.
 */
export async function seedTags(
  ctx: ContractCtx,
  group?: Id<'commandGroups'>,
): Promise<number> {
  const existing = await ctx.db
    .query('tags')
    .withIndex('by_tenant_nameNormalized')
    .first()
  if (existing) return 0
  const g = group ?? (await commandGroup(ctx, 'seed tags'))
  for (const name of SEED_TAGS) {
    await executeContract(
      ctx,
      tag,
      { name, isActive: true },
      { source: 'seed', group: g },
    )
  }
  return SEED_TAGS.length
}

export const tags = internalTenantMutation({
  args: {},
  handler: async (ctx) => ({ seeded: await seedTags(ctx) }),
})
