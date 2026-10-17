/**
 * Per-tenant reference data. Scheduled by platform.tenants.create; idempotent.
 */
import { commandGroup, executeContract } from '../lib/contracts'
import { internalTenantMutation } from '../lib/tenancy'
import { relationshipType } from './contracts'

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
