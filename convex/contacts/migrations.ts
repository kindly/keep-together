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
 * comms' emailSuppressions (E2a), `acquisitionVersion` (source codes),
 * `backfillContactTagName` (`contactTags.name`, perf tag name); see git
 * log. `backfillContactSearch` is not a two-phase step: it fills a
 * new derived table, and stays (rerunnable) as the way to rebuild it; run
 * it after deploying a change to what the search text holds (dropdown
 * fields step 7 took tag names out of it).
 */
import { migrations } from '../lib/migrations'
import { scopeWriter } from '../lib/tenancy'
import { allocateNumbers } from './number'
import { projectContactSearch } from './searchProjection'

export const run = migrations.runner()

/**
 * Search Q1: a `contactSearch` row for every contact, built exactly as the
 * contracts' projection hook builds it. Rewrites only rows that differ, so
 * a rerun is a read-only pass. Dropdown fields step 7 reruns it on every
 * deployment, so tag names leave every row's text.
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
 * Dropdown fields step 1: `fieldsVersion = 0` on contacts created before
 * the `contacts.fields` slice existed (0 is what a create writes: no fields
 * revision yet). A no-op on contacts that have it. The `fieldN` values need
 * no backfill: absent means not set, here and on `contactSearch`.
 *
 *   npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillFieldsVersion"}'
 */
export const backfillFieldsVersion = migrations.define({
  table: 'contacts',
  migrateOne: (_ctx, contact) =>
    contact.fieldsVersion === undefined ? { fieldsVersion: 0 } : undefined,
})

/**
 * The most contacts `backfillContactNumbers` numbers in one tenant (one
 * transaction). The binding limit is Convex's 4,096 index ranges read per
 * transaction, where every `db.get` and `db.query` counts as one
 * (docs.convex.dev/production/state/limits). A tenant of N contacts reads
 * N ranges, because the RLS writer `get`s each contact before patching it,
 * plus a fixed handful: the contacts query, the sequence query and the
 * sequence's own pre-patch `get`, the component's tenants page and state
 * reads, and the dry run's re-`get`. 4,000 leaves 96 for those. Bytes are
 * fine at this size: about 4 MB written and 8 MB read of the 16 MiB each.
 */
export const MAX_BACKFILL_PER_TENANT = 4000

/**
 * Contact numbers step 2: a number for every contact created before step 1
 * (plan: factory/plans/contact-numbers.sv). One tenant per batch: its
 * unnumbered contacts, oldest first, take one block from its sequence
 * (`allocateNumbers`), all in one mutation, so every number of the block
 * goes on a contact and they come out in creation order.
 *
 * Safe beside creates: a create takes its number from the same sequence
 * row, so the two serialise on it (Convex retries the loser) and never
 * share a number. Doing a whole tenant at once means no create lands in
 * the middle of its block: contacts created after the backfill are
 * numbered above every old one. Contacts created between the step 1 deploy
 * and this run keep their (lower) numbers; that one-off gap was accepted
 * (plan g1q7). Numbered contacts are never read or touched, so a rerun is
 * a no-op.
 *
 * A tenant with more than MAX_BACKFILL_PER_TENANT unnumbered contacts is
 * skipped whole rather than split its block (none is anywhere near): it
 * logs an error naming the tenant, leaves it untouched, and the run goes
 * on to the next tenant, so one big tenant doesn't hold up the rest. The
 * run still reports done; the step 6 tighten refuses to deploy while that
 * tenant's contacts have no number.
 *
 *   npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillContactNumbers"}'
 */
export const backfillContactNumbers = migrations.define({
  table: 'tenants',
  batchSize: 1,
  migrateOne: async (ctx, tenant) => {
    const db = scopeWriter(ctx, tenant._id)
    // `number` absent sorts first in the index; within it, creation order.
    const unnumbered = await db
      .query('contacts')
      .withIndex('by_tenant_number', (q) => q.eq('number', undefined))
      .take(MAX_BACKFILL_PER_TENANT + 1)
    if (unnumbered.length === 0) return
    if (unnumbered.length > MAX_BACKFILL_PER_TENANT) {
      console.error(
        `backfillContactNumbers: skipped tenant ${tenant._id} ` +
          `(${tenant.slug}): more than ${MAX_BACKFILL_PER_TENANT} ` +
          'unnumbered contacts, too many for one transaction',
      )
      return
    }
    const first = await allocateNumbers(db, unnumbered.length)
    for (const [i, contact] of unnumbered.entries()) {
      await db.patch('contacts', contact._id, { number: first + i })
    }
  },
})
