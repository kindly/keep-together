/**
 * Per-tenant reference data. Scheduled by platform.tenants.create; idempotent.
 */
import { commandGroup, executeContract } from '../lib/contracts'
import type { CommandGroup, ContractCtx } from '../lib/contracts'
import { internalTenantMutation } from '../lib/tenancy'
import type { Id } from '../_generated/dataModel'
import { identifierType, relationshipType } from './contracts'
import { normaliseListName } from './rules'

type Kind = 'individual' | 'organization' | 'household'

/**
 * The relationship types every new tenant starts with (and the platform
 * seeds, which reuse this list). Households are dormant: the 'household'
 * kind is still valid, but nothing creates one, so new tenants get no
 * household types. When households return, restore these two rows here:
 *   ['Member of household', 'Household member is', 'individual', 'household'],
 *   ['Head of household for', 'Head of household is', 'individual', 'household'],
 * Tenants created while they were dormant won't have them; give those a
 * backfill.
 */
export const UK_RELATIONSHIP_TYPES: Array<[string, string, Kind, Kind]> = [
  ['Employee of', 'Employer of', 'individual', 'organization'],
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

/**
 * Identifier types by name, created (active) where the tenant has none of
 * that name, under `group` or else a group of their own made only if one
 * is created. Only the seeds call this: a real group starts with no types
 * (external-ids g2q4).
 */
export async function ensureIdentifierTypes(
  ctx: ContractCtx,
  names: ReadonlyArray<string>,
  group?: CommandGroup,
): Promise<Map<string, Id<'identifierTypes'>>> {
  const ids = new Map<string, Id<'identifierTypes'>>()
  let g = group
  for (const name of names) {
    const existing = await ctx.db
      .query('identifierTypes')
      .withIndex('by_tenant_nameNormalized', (q) =>
        q.eq('nameNormalized', normaliseListName(name)),
      )
      .unique()
    if (existing) {
      ids.set(name, existing._id)
      continue
    }
    g ??= await commandGroup(ctx, 'seed identifier types')
    const { id } = await executeContract(
      ctx,
      identifierType,
      { name, isActive: true },
      { source: 'seed', group: g },
    )
    ids.set(name, id)
  }
  return ids
}
