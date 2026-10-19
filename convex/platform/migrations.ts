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
 * (auth-roles R1), `splitStaffCanManageLists` (settings-per-category);
 * see git log.
 */
import { migrations } from '../lib/migrations'

export const run = migrations.runner()

/**
 * Source codes step 1: `staffCanManageSourceCodes = false` with
 * `sourceCodesVersion = 0` on preferences rows created before the switch
 * existed. That is the default a row-less tenant reads and what a new row
 * is created with, so no revision: the `tenantPreferences.sourceCodes`
 * contract's history starts at its first real save. A no-op on rows that
 * have it.
 *
 *   npx convex run platform/migrations:run '{"fn":"platform/migrations:backfillSourceCodesPreference"}'
 */
export const backfillSourceCodesPreference = migrations.define({
  table: 'tenantPreferences',
  migrateOne: (_ctx, row) =>
    row.sourceCodesVersion === undefined
      ? {
          staffCanManageSourceCodes: row.staffCanManageSourceCodes ?? false,
          sourceCodesVersion: 0,
        }
      : undefined,
})
