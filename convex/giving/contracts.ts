/**
 * Gift contracts (cash gifts plan). A gift is its own aggregate, split in
 * two slices so voiding never conflicts with an edit: `giving.gift` (what
 * was given, `giftVersion`) and `giving.status` (`statusVersion`). Both
 * rebuild the allocation projection. Gifts are never deleted.
 * Apply functions are pure state application — restore re-runs them.
 *
 * A gift is editable whatever its status, void included: nothing is locked
 * yet. The claim lock that comes with Gift Aid claims must gate BOTH
 * contracts' applies (so every restore path is covered too:
 * `restoreRevision` and any whole-gift `restoreEntityTo`), not just the
 * `save` mutation — otherwise un-void plus a restore could change a
 * claimed gift's amount.
 */
import type { Id } from '../_generated/dataModel'
import type { Command, ContractCtx } from '../lib/contracts'
import { defineContract, registry, rejected } from '../lib/contracts'
import { describe, markUsed } from '../sources/code'
import { projectAllocations } from './projection'
import { prepareGift } from './rules'
import { giftFields, statusFields } from './validators'
import type { GiftPayload } from './validators'

/**
 * Check the codes the payload brings in: each must be a version of this
 * tenant and not archived (out of date is fine), and its first use marks
 * it used. Codes the gift already carries are kept as they are, even once
 * archived, as `contacts.acquisition` does; a restore may bring one back
 * (it was assigned before, so it is already marked).
 */
async function checkNewCodes(
  ctx: ContractCtx,
  p: GiftPayload,
  held: ReadonlySet<Id<'sourceCodes'>>,
  command: Command,
) {
  const fresh = new Set(
    p.allocations.map((a) => a.sourceCodeId).filter((id) => !held.has(id)),
  )
  for (const id of fresh) {
    const code = await describe(ctx.db, id)
    if (!code) {
      throw rejected(
        'unknown_source_code',
        'The source code must be a full code (category, detail and version)',
      )
    }
    if (command.source !== 'restore') {
      if (!code.isActive) {
        throw rejected(
          'archived_source_code',
          `${code.code} is archived: choose another`,
        )
      }
      await markUsed(ctx, id)
    }
  }
}

/**
 * What was given: donor, date, amount, method, card reference and the
 * split across source codes. `contactId` is fixed at create (g3q2).
 * System-owned: `enteredBy`, the creator, which no payload carries.
 */
export const gift = defineContract({
  name: 'giving.gift',
  entity: 'contributions',
  version: 1,
  counter: 'giftVersion',
  fields: giftFields,
  prepare: prepareGift,
  project: (ctx, id) => projectAllocations(ctx, id),
  apply: async (ctx, p, root, command) => {
    const fields = {
      receivedOn: p.receivedOn,
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      allocations: p.allocations.map((a) => ({
        key: a.key!,
        sourceCodeId: a.sourceCodeId,
        amount: a.amount,
      })),
    }
    if (!root) {
      // Another tenant's id reads as null through the scoped db.
      const contact = await ctx.db.get(p.contactId)
      if (!contact) throw rejected('unknown_contact', 'Contact must exist')
      await checkNewCodes(ctx, p, new Set(), command)
      return ctx.db.insert('contributions', {
        contactId: p.contactId,
        ...fields,
        status: 'completed',
        enteredBy: command.actor ?? undefined,
        giftVersion: 0,
        statusVersion: 0,
      })
    }
    if (p.contactId !== root.contactId) {
      throw rejected(
        'contact_change',
        'A gift’s donor can’t change: void it and record it again',
      )
    }
    await checkNewCodes(
      ctx,
      p,
      new Set(root.allocations.map((a) => a.sourceCodeId)),
      command,
    )
    await ctx.db.patch('contributions', root._id, fields)
    return root._id
  },
})

/** Completed or void. A void gift is kept and counts for nothing. */
export const status = defineContract({
  name: 'giving.status',
  entity: 'contributions',
  version: 1,
  counter: 'statusVersion',
  fields: statusFields,
  project: (ctx, id) => projectAllocations(ctx, id),
  apply: async (ctx, p, root) => {
    if (!root) {
      throw rejected('no_root', 'giving.status targets an existing gift')
    }
    await ctx.db.patch('contributions', root._id, { status: p.status })
    return root._id
  },
})

/** Everything restore needs to know about this module. */
export const givingContracts = registry(gift, status)
