/**
 * Platform backfills (two-phase schema changes, CLAUDE.md). Each runs in
 * batches over the whole table, is resumable, and is a no-op on rows that
 * are already done, so running it twice is safe.
 *
 * Run one on a deployment, then wait for it to finish:
 *
 *   npx convex run platform/migrations:run '{"fn":"platform/migrations:<name>"}'
 *   npx convex run --component migrations lib:getStatus --watch
 *
 * (`--deployment <name>` or `--env-file .env.<name>.local` to pick the
 * deployment; `'{"fn":"…","dryRun":true}'` to try one batch without
 * committing.) Tighten the schema only once it reports `isDone: true` on
 * every deployment that will take the tightening; the tightening commit
 * deletes the backfill and its test. Past backfills: `ownerToAdmin`
 * (auth-roles R1, see git log).
 */
import { paginationOptsValidator } from 'convex/server'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { internalAction, internalQuery } from '../_generated/server'
import { migrations } from '../lib/migrations'

export const run = migrations.runner()

type TenantLeftovers = {
  tenantId: Id<'tenants'>
  slug: string
  count: number
  capped: boolean
}

/** How many leftovers per tenant `legacyLeftoverCounts` counts up to. */
const COUNT_CAP = 100

/**
 * External identifiers X2: per tenant on one page of tenants, how many
 * contacts still have `externalIdentifier` (capped at COUNT_CAP; `capped`
 * says more exist). Paginated so no call reads more than a page of
 * tenants' leftovers. X3 deletes it with the backfill.
 */
export const legacyLeftoverCounts = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const tenants = await ctx.db.query('tenants').paginate(paginationOpts)
    const page = await Promise.all(
      tenants.page.map(async (t) => {
        const found = await ctx.db
          .query('contacts')
          .withIndex('by_tenant_external', (q) =>
            q.eq('tenantId', t._id).gt('externalIdentifier', ''),
          )
          .take(COUNT_CAP + 1)
        const counted: TenantLeftovers = {
          tenantId: t._id,
          slug: t.slug,
          count: Math.min(found.length, COUNT_CAP),
          capped: found.length > COUNT_CAP,
        }
        return counted
      }),
    )
    return { ...tenants, page }
  },
})

/**
 * Run before the X3 push: every tenant's leftover count (non-zero ones
 * listed) and the total, a lower bound if any tenant is `capped`. Once
 * the backfill reports `isDone`, total 0 ⇒ X3's schema push will validate
 * (every path sets `identifiersVersion`). Details per tenant:
 * `contacts/migrations:legacyLeftovers`.
 *
 *   npx convex run platform/migrations:legacyLeftoverTotal
 */
export const legacyLeftoverTotal = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    total: number
    capped: boolean
    tenants: Array<TenantLeftovers>
  }> => {
    const tenants: Array<TenantLeftovers> = []
    let cursor: string | null = null
    for (;;) {
      const result: {
        page: Array<TenantLeftovers>
        isDone: boolean
        continueCursor: string
      } = await ctx.runQuery(
        internal.platform.migrations.legacyLeftoverCounts,
        {
          paginationOpts: { numItems: 20, cursor },
        },
      )
      tenants.push(...result.page.filter((t) => t.count > 0))
      if (result.isDone) break
      cursor = result.continueCursor
    }
    return {
      total: tenants.reduce((n, t) => n + t.count, 0),
      capped: tenants.some((t) => t.capped),
      tenants,
    }
  },
})
