/**
 * Email suppression per address (domain rule 5). One source of truth for
 * whether comms may send to an address in this tenant: every send checks
 * it (E2b), and the contact page shows "on hold" from it (`held`). Kept
 * per address, not per email row, so it survives edits and restores of a
 * contact, and covers every contact sharing the address.
 *
 * Only a hard bounce suppresses: the address is dead for every kind of
 * mail. A complaint is about one group's marketing; it never blocks
 * transactional mail (rule 5), so it is not a suppression. E2 keeps it in
 * `emailEvents`, and the comms plan turns it into a consent event.
 */
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internal } from '../_generated/api'
import { executeContract, rejected } from '../lib/contracts'
import type { ContractCtx } from '../lib/contracts'
import {
  internalTenantAction,
  internalTenantMutation,
  tenantMutation,
  tenantQuery,
} from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { normaliseEmail } from '../contacts/rules'
import { suppression } from './contracts'

/** The tenant's suppression row for an address (any case), or null. */
export async function suppressionOf(
  db: ScopedDatabaseReader,
  address: string,
): Promise<Doc<'emailSuppressions'> | null> {
  return db
    .query('emailSuppressions')
    .withIndex('by_tenant_addressNormalized', (q) =>
      q.eq('addressNormalized', normaliseEmail(address)),
    )
    .first()
}

/** Whether mail to `address` is suppressed in this tenant. */
export async function isSuppressed(
  db: ScopedDatabaseReader,
  address: string,
): Promise<boolean> {
  return (await suppressionOf(db, address))?.suppressed ?? false
}

/**
 * Suppress an address after a hard bounce. A no-op, keeping the first
 * bounce's `since`, if it already is; after a release, a new bounce holds
 * it again.
 *
 * Trusted callers only: it refuses a ctx with a role, so it runs from
 * internal functions (the SES webhook's ingest, a migration). That alone
 * doesn't keep users out: a public function must never call or schedule an
 * internal function that runs this. The webhook is an HTTP action with no
 * user behind it, which is why it may.
 */
export async function suppressAddress(
  ctx: ContractCtx,
  input: {
    address: string
    eventRef?: string
    note?: string
  },
): Promise<{ changed: boolean; counter: number }> {
  if (ctx.role !== null) {
    throw rejected('system_only', 'Only the system suppresses an address')
  }
  const existing = await suppressionOf(ctx.db, input.address)
  if (existing?.suppressed) {
    return { changed: false, counter: existing.saveVersion }
  }
  const { counter } = await executeContract(
    ctx,
    suppression,
    {
      addressNormalized: input.address,
      suppressed: true,
      reason: 'bounce',
      eventRef: input.eventRef,
      note: input.note,
    },
    { entityId: existing?._id, source: 'comms' },
  )
  return { changed: true, counter }
}

/** `suppressAddress` as its own internal mutation. */
export const suppress = internalTenantMutation({
  args: {
    address: v.string(),
    eventRef: v.optional(v.string()),
  },
  handler: async (ctx, args) => suppressAddress(ctx, args),
})

/**
 * Release a held address: admins only, with a reason (`note`). Lifts our
 * suppression and schedules removing the address from the provider's
 * suppression list, without which SES would keep dropping the mail.
 */
export const release = tenantMutation({
  minRole: 'admin',
  args: { address: v.string(), expected: v.number(), note: v.string() },
  handler: async (ctx, { address, expected, note }) => {
    const existing = await suppressionOf(ctx.db, address)
    if (!existing?.suppressed) {
      throw rejected('not_held', 'This address is not on hold')
    }
    const result = await executeContract(
      ctx,
      suppression,
      {
        addressNormalized: existing.addressNormalized,
        suppressed: false,
        reason: 'release',
        note,
      },
      { entityId: existing._id, expected, source: 'ui' },
    )
    await ctx.scheduler.runAfter(
      0,
      internal.comms.suppressions.releaseAtProvider,
      {
        address: existing.addressNormalized,
      },
    )
    return result
  },
})

/**
 * STUB, filled in by E2b (needs the SES transport): remove the address
 * from SES's account-level suppression list (sesv2
 * DeleteSuppressedDestination) in each account that sends for us
 * (`keep-mail-tx`, `keep-prod`). Must stay idempotent: an address SES
 * doesn't hold is not an error.
 *
 * For E2b (review R3): that list is account-wide, shared by every tenant,
 * but a bounce writes an `emailSuppressions` row only in the tenant whose
 * mail bounced. So after one tenant's admin releases an address, any
 * tenant without its own row can send to it again; if the address really
 * is dead, that costs each such tenant one more bounce (on the shared
 * reputation) before its own row holds it. Accepted: writing the
 * suppression into every tenant holding the address would be a
 * cross-tenant write.
 */
export const releaseAtProvider = internalTenantAction({
  args: { address: v.string() },
  handler: async () => {
    // No address in the log: it is personal data.
    console.warn('releaseAtProvider: not implemented until E2b (no-op)')
  },
})

/** The most addresses one `held` call looks up. */
export const HELD_LOOKUP_LIMIT = 20

/**
 * Of these addresses, the held ones, keyed by normalised address: the
 * contact page's "on hold" flag and what a release needs (`saveVersion`
 * is its `expected`). Takes the addresses as args, like
 * contacts:sharedAddresses, so it stays off a save's critical path.
 * Addresses past HELD_LOOKUP_LIMIT are not looked up.
 */
export const held = tenantQuery({
  args: { addresses: v.array(v.string()) },
  handler: async (ctx, { addresses }) => {
    const rows = await Promise.all(
      [...new Set(addresses.map(normaliseEmail))]
        .slice(0, HELD_LOOKUP_LIMIT)
        .map((a) => suppressionOf(ctx.db, a)),
    )
    return Object.fromEntries(
      rows
        .filter((r) => r !== null && r.suppressed)
        .map((r) => [
          r!.addressNormalized,
          { reason: r!.reason, since: r!.since, saveVersion: r!.saveVersion },
        ]),
    )
  },
})
