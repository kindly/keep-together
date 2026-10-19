/**
 * Sources backfills. Run one on a deployment, then wait for it to finish:
 *
 *   npx convex run sources/migrations:run '{"fn":"sources/migrations:<name>"}'
 *   npx convex run --component migrations lib:getStatus --watch
 *
 * (`--deployment <name>` or `--env-file .env.<name>.local` to pick the
 * deployment.) Each is resumable and a no-op where already done.
 */
import { migrations } from '../lib/migrations'
import { scopeWriter } from '../lib/tenancy'
import { ensureSeedCategories } from './seed'

export const run = migrations.runner()

/**
 * Source codes step 2: the starter categories for tenants created before
 * `insertTenant` seeded them. Unlike a field backfill, these are domain
 * rows, so they go through the `sources.code` contract (source `seed`,
 * revisions and all), as a new tenant's do. A no-op for a tenant that has
 * any source code. Closed and suspended tenants are seeded too: reference
 * data, harmless, and ready if they come back.
 *
 *   npx convex run sources/migrations:run '{"fn":"sources/migrations:seedCategories"}'
 */
export const seedCategories = migrations.define({
  table: 'tenants',
  migrateOne: async (ctx, tenant) => {
    await ensureSeedCategories({
      db: scopeWriter(ctx, tenant._id),
      userId: null,
      role: null,
    })
  },
})
