/**
 * Contacts backfills (two-phase schema changes, CLAUDE.md). Each runs in
 * batches over the whole table, is resumable, and should be a no-op on rows
 * that are already done, so running it twice is safe.
 *
 * Run one on a deployment, then wait for it to finish:
 *
 *   npx convex run contacts/migrations:run '{"fn":"contacts/migrations:<name>"}'
 *   npx convex run --component migrations lib:getStatus --watch
 *
 * (`--deployment <name>` or `--env-file .env.<name>.local` to pick the
 * deployment; `'{"fn":"…","dryRun":true}'` to try one batch without
 * committing.) Tighten the schema only once it reports `isDone: true` on
 * every deployment that will take the tightening; the tightening commit
 * deletes the backfill and its test (convex-test can no longer build the
 * old shape). Past backfills: `addressNormalized` (S2), `tagsVersion` (S4),
 * `externalIdentifier` → identifier rows (X2);
 * see git log.
 */
import { migrations } from '../lib/migrations'

export const run = migrations.runner()

/**
 * perf-storage step 1: `revisions.groupName`, copied from the revision's
 * command group, on revisions written before `executeContract` stamped it.
 * Envelope, not payload. A no-op on rows without a group or already stamped.
 * The field stays optional (no tightening); once this is done everywhere,
 * `history`'s fallback read never fires.
 */
export const backfillRevisionGroupName = migrations.define({
  table: 'revisions',
  migrateOne: async (ctx, revision) => {
    if (revision.group === undefined || revision.groupName !== undefined) {
      return undefined
    }
    const group = await ctx.db.get('commandGroups', revision.group)
    return group ? { groupName: group.name } : undefined
  },
})
