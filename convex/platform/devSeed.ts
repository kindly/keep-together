/**
 * Dev-only helpers for spinning up instances: a demo tenant with an admin
 * and a few contacts, and an inspection query used by the export/import
 * spike. Internal: callable only from the CLI / dashboard.
 *
 *   npx convex run platform/devSeed:demoTenant '{"slug":"demo"}'
 *   npx convex run platform/devSeed:demoTenant '{"slug":"demo","adminEmail":"me@example.org"}'
 *
 * An `adminEmail` that matches a signed-up user makes that user the admin,
 * so you can sign in and open the demo; otherwise a password-less user is
 * created for it.
 */
import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { details, methods } from '../contacts/contracts'
import { insertTenant } from './tenants'

export const demoTenant = internalMutation({
  args: { slug: v.string(), adminEmail: v.optional(v.string()) },
  handler: async (ctx, { slug, adminEmail }) => {
    const email = adminEmail?.trim() ?? `${slug}-admin@example.com`
    const existing = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', email))
      .first()
    const userId =
      existing?._id ??
      (await ctx.db.insert('users', { email, name: `${slug} admin` }))
    // Relationship types are seeded by the job insertTenant schedules.
    const tenantId = await insertTenant(ctx, {
      slug,
      name: `${slug} demo group`,
      adminUserId: userId,
    })

    const scoped = { db: scopeWriter(ctx, tenantId), userId }
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
