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
 * old shape). Past backfills: `addressNormalized` (S2), `tagsVersion` (S4);
 * see git log.
 */
import type { Id } from '../_generated/dataModel'
import { executeContract } from '../lib/contracts'
import type { ContractCtx } from '../lib/contracts'
import { migrations } from '../lib/migrations'
import { internalTenantQuery, scopeWriter } from '../lib/tenancy'
import { identifierClashes, identifierType, identifiers } from './contracts'
import { normaliseIdentifier, normaliseTagName } from './rules'

export const run = migrations.runner()

/** The type the backfill files legacy values under (X2). */
const LEGACY_TYPE_NAME = 'External reference'

/**
 * X2: `contacts.externalIdentifier` → one `contacts.identifiers` row of the
 * tenant's "External reference" type, and `identifiersVersion` = 0 where it
 * is missing (0 is what a create writes: no identifiers revision yet).
 *
 * The type is created (through its contract) only in tenants that have a
 * legacy value, on the first one. The row goes through the identifiers
 * contract with source `system`, so it has a revision; then the old field
 * is unset. Contacts without a value just get the counter.
 *
 * A value the contract would refuse (the (type, value) pair is already held
 * by another contact, or the type has been archived) is left in place: the
 * contact gets its counter, keeps `externalIdentifier`, and a warning is
 * logged. `legacyLeftovers` lists them per tenant for review. A rerun
 * retries them, so once the other contact's row is gone they move. X3's
 * schema push fails while any remain, which is the point: nothing is lost.
 * Table order is creation order, so of two contacts with the same value the
 * older keeps it.
 */
export const backfillExternalIdentifiers = migrations.define({
  table: 'contacts',
  migrateOne: async (ctx, contact) => {
    const counter =
      contact.identifiersVersion === undefined ? { identifiersVersion: 0 } : {}
    const legacy = contact.externalIdentifier
    if (legacy === undefined) {
      return contact.identifiersVersion === undefined ? counter : undefined
    }
    const value = legacy.trim()
    if (!value) return { ...counter, externalIdentifier: undefined }

    const cctx = { db: scopeWriter(ctx, contact.tenantId), userId: null }
    const leave = (reason: string) => {
      console.warn(
        `backfillExternalIdentifiers: left ${legacy} on contact ${contact._id} (tenant ${contact.tenantId}): ${reason}`,
      )
      return counter
    }

    const typeId = await legacyType(cctx)
    if (typeId === null) return leave(`"${LEGACY_TYPE_NAME}" is archived`)

    const rows = await cctx.db
      .query('contactIdentifiers')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contact._id))
      .collect()
    const held = rows.some(
      (r) =>
        r.typeId === typeId && r.valueNormalized === normaliseIdentifier(value),
    )
    if (!held) {
      const clashes = await identifierClashes(cctx.db, contact._id, [
        { typeId, value },
      ])
      if (clashes.length) {
        const { displayName, contactId } = clashes[0]
        return leave(`already held by ${displayName} (${contactId})`)
      }
      if (contact.identifiersVersion === undefined) {
        await ctx.db.patch('contacts', contact._id, counter)
      }
      await executeContract(
        cctx,
        identifiers,
        {
          identifiers: [
            ...rows.map((r) => ({
              key: r.key,
              typeId: r.typeId,
              value: r.value,
            })),
            { typeId, value },
          ],
        },
        {
          entityId: contact._id,
          expected: contact.identifiersVersion ?? 0,
          source: 'system',
        },
      )
    }
    return { externalIdentifier: undefined }
  },
})

/** The tenant's active legacy type, created if missing; null if archived. */
async function legacyType(
  ctx: ContractCtx,
): Promise<Id<'identifierTypes'> | null> {
  const existing = await ctx.db
    .query('identifierTypes')
    .withIndex('by_tenant_nameNormalized', (q) =>
      q.eq('nameNormalized', normaliseTagName(LEGACY_TYPE_NAME)),
    )
    .unique()
  if (existing) return existing.isActive ? existing._id : null
  const { id } = await executeContract(
    ctx,
    identifierType,
    { name: LEGACY_TYPE_NAME, isActive: true },
    { source: 'system' },
  )
  return id
}

/**
 * Contacts the backfill left their `externalIdentifier` on (see above),
 * for review before X3 (the first 100; before the backfill, every contact
 * with a value). Empty in every tenant ⇒ X3 can tighten.
 */
export const legacyLeftovers = internalTenantQuery({
  args: {},
  handler: async (ctx) => {
    const contacts = await ctx.db
      .query('contacts')
      .withIndex('by_tenant_external', (q) => q.gt('externalIdentifier', ''))
      .take(100)
    return contacts.map((c) => ({
      contactId: c._id,
      displayName: c.displayName,
      externalIdentifier: c.externalIdentifier,
    }))
  },
})
