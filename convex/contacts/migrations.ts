/**
 * Contacts backfills (two-phase schema changes, CLAUDE.md). Each runs in
 * batches over the whole table, is resumable, and is a no-op on rows that
 * are already done, so running it twice is safe.
 *
 * Run on a deployment, then wait for it to finish:
 *
 *   npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillAddressNormalized"}'
 *   npx convex run --component migrations lib:getStatus --watch
 *
 * (`--deployment <name>` or `--env-file .env.<name>.local` to pick the
 * deployment; `'{"fn":"…","dryRun":true}'` to try one batch without
 * committing.) Tighten the schema only once it reports `isDone: true` on
 * every deployment that will take the tightening.
 */
import { migrations } from '../lib/migrations'
import { normaliseEmail } from './rules'

export const run = migrations.runner()

/** S2: `contactEmails.addressNormalized` on rows inserted before S1 stamped it. */
export const backfillAddressNormalized = migrations.define({
  table: 'contactEmails',
  migrateOne: (_ctx, row) =>
    row.addressNormalized === undefined
      ? { addressNormalized: normaliseEmail(row.address) }
      : undefined,
})
