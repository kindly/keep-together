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
import { migrations } from '../lib/migrations'
import { scopeWriter } from '../lib/tenancy'
import { splitStaffCanManageLists as split } from './preferences'

export const run = migrations.runner()

/**
 * settings-per-category (a): the old "staff can manage tags and identifier
 * types" switch → `staffCanManageTags` and `staffCanManageIdentifierTypes`,
 * both set to its value through their contracts (source `system`), then
 * the old fields unset. A no-op on rows already split (by this, or by a
 * save that got there first).
 *
 *   npx convex run platform/migrations:run '{"fn":"platform/migrations:splitStaffCanManageLists"}'
 */
export const splitStaffCanManageLists = migrations.define({
  table: 'tenantPreferences',
  migrateOne: async (ctx, row) => {
    await split(scopeWriter(ctx, row.tenantId), row)
  },
})
