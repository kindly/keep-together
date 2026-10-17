/**
 * The QC suite's seeded world (factory/plans/qc-suite.sv, step 3): per run
 * and per Playwright worker, two users who can sign in with a password and
 * two tenants, user A owning tenant A only and user B tenant B only, with
 * distinctive contact names so the isolation spec can look for leaks.
 * Internal: run from the QC harness via the CLI, and only on deployments
 * with `QC_SEED_ENABLED=1` (it creates owners with a known password).
 * Re-running with the same run, worker and password returns the same world.
 *
 *   npx convex run --deployment <d> platform/qcSeed:fixture \
 *     '{"runId":"12","worker":0,"password":"qc-password-123"}'
 */
import { createAccount } from '@convex-dev/auth/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { env, internalAction, internalMutation } from '../_generated/server'
import { commandGroup, executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { details, methods, relationshipType } from '../contacts/contracts'
import { UK_RELATIONSHIP_TYPES } from '../contacts/seed'
import { tenantForSlug } from './tenants'

const SIDES = [
  { suffix: 'a', label: 'Alpha' },
  { suffix: 'b', label: 'Bravo' },
] as const

const prefix = (runId: string, worker: number) => `r${runId}w${worker}`

function requireEnabled() {
  if (env.QC_SEED_ENABLED !== '1') {
    throw new ConvexError({
      kind: 'disabled' as const,
      message:
        'qcSeed is disabled on this deployment: set the env var QC_SEED_ENABLED=1 to allow it',
    })
  }
}

export const fixture = internalAction({
  args: { runId: v.string(), worker: v.number(), password: v.string() },
  handler: async (
    ctx,
    { runId, worker, password },
  ): Promise<{
    users: Array<{ email: string }>
    tenants: Array<{
      slug: string
      tenantId: Id<'tenants'>
      contactIds: Array<Id<'contacts'>>
    }>
  }> => {
    requireEnabled()
    const base = prefix(runId, worker)
    const users = []
    for (const { suffix } of SIDES) {
      // createAccount doesn't copy the account id into the profile.
      const email = `qc-${base}-${suffix}@example.com`
      const { user } = await createAccount(ctx, {
        provider: 'password',
        account: { id: email, secret: password },
        profile: { email, name: `${base}-${suffix} qc user` },
      })
      users.push({ email, userId: user._id })
    }
    const tenants = await ctx.runMutation(internal.platform.qcSeed.world, {
      runId,
      worker,
      userIds: users.map((u) => u.userId),
    })
    return { users: users.map(({ email }) => ({ email })), tenants }
  },
})

/** Tenants, memberships, reference data and contacts for `fixture`'s users. */
export const world = internalMutation({
  args: {
    runId: v.string(),
    worker: v.number(),
    userIds: v.array(v.id('users')),
  },
  handler: async (ctx, { runId, worker, userIds }) => {
    requireEnabled()
    const base = prefix(runId, worker)
    const out = []
    for (const [i, { suffix, label }] of SIDES.entries()) {
      const userId = userIds[i]
      const slug = `${base}-${suffix}`
      const existing = await tenantForSlug(ctx, slug)
      if (existing) {
        // A re-run: the same run and worker yield the same user, who owns it.
        const own = await ctx.db
          .query('memberships')
          .withIndex('by_tenant_user', (q) =>
            q.eq('tenantId', existing._id).eq('userId', userId),
          )
          .unique()
        if (!own) throw new ConvexError({ kind: 'taken' as const, slug })
        const contacts = await ctx.db
          .query('contacts')
          .withIndex('by_tenant_sort', (q) => q.eq('tenantId', existing._id))
          .collect()
        out.push({
          slug,
          tenantId: existing._id,
          contactIds: contacts.map((c) => c._id),
        })
        continue
      }
      const tenantId = await ctx.db.insert('tenants', {
        slug,
        name: `${label} ${base} qc group`,
        status: 'active',
      })
      await ctx.db.insert('memberships', { tenantId, userId, role: 'owner' })

      const scoped = { db: scopeWriter(ctx, tenantId), userId }
      const group = await commandGroup(scoped, 'qc seed')
      for (const [labelAB, labelBA, kindA, kindB] of UK_RELATIONSHIP_TYPES) {
        await executeContract(
          scoped,
          relationshipType,
          { labelAB, labelBA, kindA, kindB, isActive: true },
          { source: 'seed', group },
        )
      }
      const name = `${label}-${runId}`
      const contacts = [
        { kind: 'individual', firstName: 'Ada', lastName: name, name: '' },
        { kind: 'individual', firstName: 'Charles', lastName: name, name: '' },
        {
          kind: 'organization',
          firstName: '',
          lastName: '',
          name: `${name} Trust`,
        },
      ] as const
      const contactIds = []
      for (const c of contacts) {
        const { id } = await executeContract(
          scoped,
          details,
          {
            ...c,
            title: '',
            nickname: '',
            isDeceased: false,
            externalIdentifier: '',
          },
          { source: 'seed', group },
        )
        const local = (c.firstName || c.name).toLowerCase().replace(/\W+/g, '')
        await executeContract(
          scoped,
          methods,
          {
            emails: [
              {
                label: 'home',
                address: `${local}-${slug}@example.com`,
                isPrimary: true,
              },
            ],
            phones: [],
          },
          { entityId: id, expected: 0, source: 'seed', group },
        )
        contactIds.push(id)
      }
      out.push({ slug, tenantId, contactIds })
    }
    return out
  },
})
