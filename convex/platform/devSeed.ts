/**
 * Dev-only helpers for spinning up instances: a demo tenant with an owner
 * and a few contacts, and an inspection query used by the export/import
 * spike. Internal: callable only from the CLI / dashboard.
 *
 *   npx convex run platform/devSeed:demoTenant '{"slug":"demo"}'
 */
import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { details, methods, relationshipType } from '../contacts/contracts'
import { UK_RELATIONSHIP_TYPES } from '../contacts/seed'

export const demoTenant = internalMutation({
  args: { slug: v.string(), ownerEmail: v.optional(v.string()) },
  handler: async (ctx, { slug, ownerEmail }) => {
    const userId = await ctx.db.insert('users', {
      email: ownerEmail ?? `${slug}-owner@example.com`,
      name: `${slug} owner`,
    })
    const tenantId = await ctx.db.insert('tenants', {
      slug,
      name: `${slug} demo group`,
      status: 'active',
    })
    await ctx.db.insert('memberships', { tenantId, userId, role: 'owner' })

    const scoped = { db: scopeWriter(ctx, tenantId), userId }
    for (const [labelAB, labelBA, kindA, kindB] of UK_RELATIONSHIP_TYPES) {
      await executeContract(
        scoped,
        relationshipType,
        { labelAB, labelBA, kindA, kindB, isActive: true },
        { source: 'seed' },
      )
    }
    const people = [
      ['Ada', 'Lovelace', 'ada@example.com'],
      ['Charles', 'Babbage', 'charles@example.com'],
      ['Mary', 'Somerville', 'mary@example.com'],
    ] as const
    const contactIds = []
    for (const [firstName, lastName, address] of people) {
      const { id } = await executeContract(
        scoped,
        details,
        {
          kind: 'individual',
          title: '',
          firstName,
          lastName,
          nickname: '',
          name: '',
          isDeceased: false,
          externalIdentifier: '',
        },
        { source: 'seed' },
      )
      await executeContract(
        scoped,
        methods,
        { emails: [{ label: 'home', address, isPrimary: true }], phones: [] },
        { entityId: id, expected: 0, source: 'seed' },
      )
      contactIds.push(id)
    }
    return { tenantId, userId, contactIds }
  },
})

/** Everything one tenant owns, with reference checks — for the export/import spike. */
export const inspectTenant = internalQuery({
  args: { tenantId: v.id('tenants') },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId)
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_tenant_user', (q) => q.eq('tenantId', tenantId))
      .collect()
    const members = await Promise.all(
      memberships.map(async (m) => ({
        userId: m.userId,
        userResolves: (await ctx.db.get(m.userId)) !== null,
      })),
    )
    const contacts = await ctx.db
      .query('contacts')
      .withIndex('by_tenant_sort', (q) => q.eq('tenantId', tenantId))
      .collect()
    const emails = await Promise.all(
      contacts.map(async (c) => {
        const rows = await ctx.db
          .query('contactEmails')
          .withIndex('by_tenant_contact', (q) =>
            q.eq('tenantId', tenantId).eq('contactId', c._id),
          )
          .collect()
        return rows.map((e) => ({
          contactId: e.contactId,
          contactResolves: e.contactId === c._id,
          address: e.address,
        }))
      }),
    )
    const revisions = await ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) => q.eq('tenantId', tenantId))
      .collect()
    const revisionTargetsResolve = await Promise.all(
      revisions.map(async (r) =>
        r.entity === 'contacts'
          ? (await ctx.db.get(r.entityId as never)) !== null
          : true,
      ),
    )
    return {
      tenant: tenant ? { _id: tenant._id, slug: tenant.slug } : null,
      members,
      contacts: contacts.map((c) => ({
        _id: c._id,
        displayName: c.displayName,
      })),
      emails: emails.flat(),
      revisions: revisions.length,
      revisionTargetsResolve: revisionTargetsResolve.every(Boolean),
    }
  },
})
