/**
 * Gift writes. Every one runs the giving contracts; nothing deletes a gift
 * (a mistake is void). Staff and admins only (the constructors' default):
 * a viewer never writes.
 */
import { ConvexError, v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { commandGroup, executeContract, restore } from '../lib/contracts'
import type { CommandGroup, ContractCtx } from '../lib/contracts'
import { tenantMutation } from '../lib/tenancy'
import { describe } from '../sources/code'
import { gift, givingContracts, status } from './contracts'
import { formatPence } from './rules'
import { giftFields, statusFields } from './validators'
import type { GiftPayload } from './validators'

/**
 * The command group's name for a new gift, with the code as it reads now
 * (history keeps it through renames): "gift £20 cash, Street-Wesser-001".
 */
export async function giftGroupName(
  ctx: ContractCtx,
  p: GiftPayload,
): Promise<string> {
  const codes = await Promise.all(
    p.allocations.map((a) => describe(ctx.db, a.sourceCodeId)),
  )
  const named = codes.filter((c) => c !== null).map((c) => c.code)
  const head = `gift ${formatPence(p.amount)} ${p.method}`
  return named.length ? `${head}, ${named.join(', ')}` : head
}

/**
 * Record a gift in the caller's transaction: `giving.gift`, then
 * `giving.status` (completed), so status history starts with the gift.
 * Runs under `group`, or one of its own named by `giftGroupName`. A
 * refusal throws, rolling back the caller's whole mutation. For commands
 * that compose it (recordGift).
 */
export async function createGift(
  ctx: ContractCtx,
  p: GiftPayload,
  opts: { group?: CommandGroup } = {},
): Promise<Id<'contributions'>> {
  const group =
    opts.group ?? (await commandGroup(ctx, await giftGroupName(ctx, p)))
  const { id } = await executeContract(ctx, gift, p, { source: 'ui', group })
  await executeContract(
    ctx,
    status,
    { status: 'completed' },
    { entityId: id, expected: 0, source: 'ui', group },
  )
  return id
}

/** A gift from an existing contact. */
export const create = tenantMutation({
  args: giftFields,
  handler: async (ctx, payload) => createGift(ctx, payload),
})

/** Correct a gift. Stale only if the gift's fields changed since `expected`. */
export const save = tenantMutation({
  args: { id: v.id('contributions'), expected: v.number(), ...giftFields },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, gift, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

/** Void or un-void. Re-sending the current status is a no-op. */
export const setStatus = tenantMutation({
  args: { id: v.id('contributions'), expected: v.number(), ...statusFields },
  handler: async (ctx, { id, expected, status: next }) => {
    const current = await ctx.db.get(id)
    if (!current) throw new ConvexError({ kind: 'not_found' as const })
    if (current.status === next) {
      return { id, counter: current.statusVersion }
    }
    return executeContract(
      ctx,
      status,
      { status: next },
      { entityId: id, expected, source: 'ui' },
    )
  },
})

/** Restore one stored gift revision as a new command. */
export const restoreRevision = tenantMutation({
  args: { revisionId: v.id('revisions') },
  handler: async (ctx, { revisionId }) =>
    restore(ctx, givingContracts, revisionId),
})
