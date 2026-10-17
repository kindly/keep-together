import { v } from 'convex/values'
import { executeContract } from '../lib/contracts'
import { tenantMutation, tenantQuery } from '../lib/tenancy'
import { relationship, relationshipType } from './contracts'
import { relationshipFields, relationshipTypeFields } from './validators'

export const types = tenantQuery({
  args: {},
  handler: async (ctx) =>
    ctx.db.query('relationshipTypes').withIndex('by_tenant').take(200),
})

/** Both directions, with the other party's name and the label as seen from this contact. */
export const forContact = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => {
    const [out, incoming] = await Promise.all([
      ctx.db
        .query('relationships')
        .withIndex('by_tenant_a', (q) => q.eq('contactA', id))
        .take(200),
      ctx.db
        .query('relationships')
        .withIndex('by_tenant_b', (q) => q.eq('contactB', id))
        .take(200),
    ])
    const rows = [
      ...out.map((r) => ({ r, otherId: r.contactB, direction: 'ab' as const })),
      ...incoming.map((r) => ({
        r,
        otherId: r.contactA,
        direction: 'ba' as const,
      })),
    ]
    return Promise.all(
      rows.map(async ({ r, otherId, direction }) => {
        const [other, type] = await Promise.all([
          ctx.db.get(otherId),
          ctx.db.get(r.typeId),
        ])
        return {
          _id: r._id,
          otherId,
          otherName: other?.displayName ?? '?',
          label: direction === 'ab' ? type?.labelAB : type?.labelBA,
          startDate: r.startDate,
          endDate: r.endDate,
          isActive: r.isActive,
          description: r.description,
          saveVersion: r.saveVersion,
        }
      }),
    )
  },
})

export const saveType = tenantMutation({
  args: {
    id: v.optional(v.id('relationshipTypes')),
    expected: v.optional(v.number()),
    ...relationshipTypeFields,
  },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, relationshipType, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

export const save = tenantMutation({
  args: {
    id: v.optional(v.id('relationships')),
    expected: v.optional(v.number()),
    ...relationshipFields,
  },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, relationship, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})
