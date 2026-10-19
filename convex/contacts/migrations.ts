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
 * `externalIdentifier` → identifier rows (X2), `contactEmails.onHold` →
 * comms' emailSuppressions (E2a);
 * see git log. `backfillContactSearch` is not a two-phase step: it fills a
 * new derived table, and stays (rerunnable) as the way to rebuild it.
 */
import { migrations } from '../lib/migrations'
import { scopeWriter } from '../lib/tenancy'
import { projectContactSearch } from './searchProjection'

export const run = migrations.runner()

/**
 * Search Q1: a `contactSearch` row for every contact, built exactly as the
 * contracts' projection hook builds it. Rewrites only rows that differ, so
 * a rerun is a read-only pass.
 *
 *   npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillContactSearch"}'
 */
export const backfillContactSearch = migrations.define({
  table: 'contacts',
  migrateOne: async (ctx, contact) => {
    await projectContactSearch(
      { db: scopeWriter(ctx, contact.tenantId) },
      contact._id,
    )
  },
})

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

/**
 * Source codes step 1: `acquisitionVersion = 0` on contacts created before
 * the `contacts.acquisition` slice existed (0 is what a create writes: no
 * acquisition revision yet). A no-op on contacts that have it.
 *
 *   npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillAcquisitionVersion"}'
 *
 * Then rerun `backfillContactSearch`, which fills `contactSearch.sortName`.
 */
export const backfillAcquisitionVersion = migrations.define({
  table: 'contacts',
  migrateOne: (_ctx, contact) =>
    contact.acquisitionVersion === undefined
      ? { acquisitionVersion: 0 }
      : undefined,
})
