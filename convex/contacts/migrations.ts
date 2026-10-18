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
import { ConvexError } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { executeContract } from '../lib/contracts'
import type { ContractCtx } from '../lib/contracts'
import { migrations } from '../lib/migrations'
import { internalTenantQuery, scopeWriter } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { identifierClashes, identifierType, identifiers } from './contracts'
import { normaliseIdentifier, normaliseTagName } from './rules'

export const run = migrations.runner()

/** The type the backfill files legacy values under (X2). */
const LEGACY_TYPE_NAME = 'External reference'

/**
 * X2: `contacts.externalIdentifier` → one `contacts.identifiers` row of the
 * tenant's "External reference" type, and `identifiersVersion` = 0 where it
 * is missing (0 is what a create writes: no identifiers revision yet). Every
 * path sets the counter, so X3 can make it required.
 *
 * The type is created (through its contract) only in tenants that have a
 * legacy value, on the first one; an existing active type of that name is
 * used. The row goes through the identifiers contract with source `system`,
 * so it has a revision; then the old field is unset. Contacts without a
 * value just get the counter.
 *
 * A value that can't move (`blockedReason`: the type is archived, or the
 * (type, value) pair is already held by another contact; or the tenant is
 * at the identifier type limit) is left in place: the contact gets its
 * counter, keeps `externalIdentifier`, and a warning is logged.
 * `legacyLeftovers` lists them per tenant with the reason, and
 * `platform/migrations:legacyLeftoverTotal` counts them across tenants. A
 * rerun retries them. X3's schema push fails while any remain, which is the
 * point: nothing is lost. Table order is creation order, so of two contacts
 * with the same value the older keeps it.
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

    const type =
      (await findLegacyType(cctx.db)) ?? (await createLegacyType(cctx))
    if (type === null) return leave(TYPE_LIMIT_REASON)
    const blocked = await blockedReason(cctx.db, contact._id, type, value)
    if (blocked) return leave(blocked)

    const rows = await cctx.db
      .query('contactIdentifiers')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contact._id))
      .collect()
    const held = rows.some(
      (r) =>
        r.typeId === type._id &&
        r.valueNormalized === normaliseIdentifier(value),
    )
    // Already there (added by hand, say): just drop the old field.
    if (held) return { ...counter, externalIdentifier: undefined }

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
          { typeId: type._id, value },
        ],
      },
      {
        entityId: contact._id,
        expected: contact.identifiersVersion ?? 0,
        source: 'system',
      },
    )
    // Not `counter`: the contract has bumped it past 0 already.
    return { externalIdentifier: undefined }
  },
})

const TYPE_LIMIT_REASON = `no "${LEGACY_TYPE_NAME}" type, and the tenant is at the identifier type limit`

function findLegacyType(
  db: ScopedDatabaseReader,
): Promise<Doc<'identifierTypes'> | null> {
  return db
    .query('identifierTypes')
    .withIndex('by_tenant_nameNormalized', (q) =>
      q.eq('nameNormalized', normaliseTagName(LEGACY_TYPE_NAME)),
    )
    .unique()
}

/** Creates the tenant's legacy type; null if the tenant is at the limit. */
async function createLegacyType(
  ctx: ContractCtx,
): Promise<Doc<'identifierTypes'> | null> {
  try {
    const { id } = await executeContract(
      ctx,
      identifierType,
      { name: LEGACY_TYPE_NAME, isActive: true },
      { source: 'system' },
    )
    return ctx.db.get(id)
  } catch (e) {
    // The contract refuses before writing anything, so carrying on is safe.
    if (
      e instanceof ConvexError &&
      (e.data as { reason?: string }).reason === 'identifier_type_limit'
    ) {
      return null
    }
    throw e
  }
}

/** Why a legacy value can't move into a row of `type`, or null if it can. */
async function blockedReason(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
  type: Doc<'identifierTypes'>,
  value: string,
): Promise<string | null> {
  if (!type.isActive) return `"${LEGACY_TYPE_NAME}" type archived`
  const clashes = await identifierClashes(db, contactId, [
    { typeId: type._id, value },
  ])
  if (!clashes.length) return null
  const { displayName, contactId: holder } = clashes[0]
  return `held by ${displayName} (${holder})`
}

/** How many leftovers one `legacyLeftovers` call lists. */
const LEFTOVER_LIMIT = 100

/**
 * Contacts the backfill left their `externalIdentifier` on, with the
 * reason, for review before X3 (the first 100; before the backfill has
 * run, every contact with a value, as "not backfilled yet"). Empty in every
 * tenant ⇒ X3 can tighten; `platform/migrations:legacyLeftoverTotal` checks
 * that across tenants.
 */
export const legacyLeftovers = internalTenantQuery({
  args: {},
  handler: async (ctx) => {
    const [contacts, type] = await Promise.all([
      ctx.db
        .query('contacts')
        .withIndex('by_tenant_external', (q) => q.gt('externalIdentifier', ''))
        .take(LEFTOVER_LIMIT),
      findLegacyType(ctx.db),
    ])
    return Promise.all(
      contacts.map(async (c) => {
        const value = c.externalIdentifier!.trim()
        const reason =
          c.identifiersVersion === undefined
            ? 'not backfilled yet'
            : type === null
              ? TYPE_LIMIT_REASON
              : (value && (await blockedReason(ctx.db, c._id, type, value))) ||
                'none now: moves on a rerun'
        return {
          contactId: c._id,
          displayName: c.displayName,
          externalIdentifier: c.externalIdentifier,
          reason,
        }
      }),
    )
  },
})
