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
 * old shape). Past backfills: `addressNormalized` (S2, see git log).
 */
import { migrations } from '../lib/migrations'

export const run = migrations.runner()

/**
 * S4: `contacts.tagsVersion` = 0 on contacts created before S3 added the
 * tags slice. A contract counter, not payload: 0 is what a create writes and
 * means "no tags revision yet", which is true of every contact lacking it.
 */
export const backfillTagsVersion = migrations.define({
  table: 'contacts',
  migrateOne: (_ctx, contact) =>
    contact.tagsVersion === undefined ? { tagsVersion: 0 } : undefined,
})
