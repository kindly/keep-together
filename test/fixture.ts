/// <reference types="vite/client" />
/**
 * The two-tenant fixture every test uses (ADR 0017): tenants A and B with one
 * admin each, reference data seeded, and `snapshot` to assert that tenant B
 * observes nothing of tenant A's operations.
 */
import { convexTest } from 'convex-test'
import type { TestConvex } from 'convex-test'
import { ConvexError } from 'convex/values'
import type { Id, TableNames } from '../convex/_generated/dataModel'
import { internal } from '../convex/_generated/api'
import schema from '../convex/schema'
import { DOMAIN_TABLES } from '../convex/lib/tables'

export const modules = import.meta.glob('../convex/**/*.ts')

export type Tenant = {
  tenantId: Id<'tenants'>
  userId: Id<'users'>
  as: ReturnType<TestConvex<typeof schema>['withIdentity']>
}

export async function setup() {
  const t = convexTest(schema, modules)
  const make = async (slug: string): Promise<Tenant> => {
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        email: `${slug}@example.com`,
      })
      const tenantId = await ctx.db.insert('tenants', {
        slug,
        name: slug,
        status: 'active',
      })
      await ctx.db.insert('memberships', { tenantId, userId, role: 'admin' })
      return { tenantId, userId }
    })
    await t.mutation(internal.contacts.seed.relationshipTypes, {
      tenantId: ids.tenantId,
    })
    await t.mutation(internal.sources.seed.categories, {
      tenantId: ids.tenantId,
    })
    return {
      ...ids,
      // Convex Auth encodes `${userId}|${sessionId}` in the JWT subject.
      as: t.withIdentity({ subject: `${ids.userId}|session-${slug}` }),
    }
  }
  const a = await make('alpha')
  const b = await make('beta')
  return { t, a, b }
}

/** Every domain row of one tenant, as a comparable string. */
export async function snapshot(
  t: TestConvex<typeof schema>,
  tenantId: Id<'tenants'>,
): Promise<string> {
  return t.run(async (ctx) => {
    const out: Record<string, unknown> = {}
    for (const table of DOMAIN_TABLES) {
      const rows = await ctx.db.query(table as TableNames).collect()
      out[table] = rows.filter(
        (r) => (r as { tenantId?: Id<'tenants'> }).tenantId === tenantId,
      )
    }
    return JSON.stringify(out)
  })
}

/** The `data` of a ConvexError a promise rejects with. */
export async function errorData(
  promise: Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await promise
  } catch (e) {
    if (e instanceof ConvexError) return e.data as Record<string, unknown>
    throw e
  }
  throw new Error('expected the call to throw a ConvexError')
}
