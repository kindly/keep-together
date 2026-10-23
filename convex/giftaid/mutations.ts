/**
 * Recording Gift Aid declarations and cancellations. Staff and admins
 * (the scoped constructor's default); viewers only read.
 */
import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { commandGroup, executeContract, invalid } from '../lib/contracts'
import type { CommandGroup, ContractCtx, Source } from '../lib/contracts'
import { tenantMutation } from '../lib/tenancy'
import { cancellation, chain, declaration } from './declarations'
import { isIsoDate, openAt } from './rules'
import { declarationFields } from './validators'
import type { DeclarationPayload } from './validators'

/** A new declaration; giving's one-save command runs it inside its group. */
export function makeDeclaration(
  ctx: ContractCtx,
  payload: DeclarationPayload,
  source: Source,
  group?: CommandGroup,
) {
  return executeContract(ctx, declaration, payload, { source, group })
}

export const declare = tenantMutation({
  args: declarationFields,
  handler: (ctx, payload) => makeDeclaration(ctx, payload, 'ui'),
})

/**
 * "Record cancellation" on the contact page: cancels from `cancelledFrom`
 * every declaration of the contact open at that date (rules `openAt`), in
 * one command group. Built from each declaration's fresh state inside the
 * transaction, so it needs no `expected`. Refused if none is open.
 */
export async function cancelDeclarations(
  ctx: ContractCtx,
  contactId: Id<'contacts'>,
  cancelledFrom: string,
  note: string | undefined,
  source: Source,
): Promise<{ cancelled: Array<Id<'giftAidDeclarations'>> }> {
  const date = cancelledFrom.trim()
  // Checked here as well as by the contract: `openAt` compares strings.
  if (!isIsoDate(date)) {
    throw invalid([
      { field: 'cancelledFrom', message: 'Enter a date (YYYY-MM-DD)' },
    ])
  }
  const open = (await chain(ctx.db, contactId)).filter((d) => openAt(d, date))
  if (open.length === 0) {
    throw invalid([
      {
        field: 'cancelledFrom',
        message: 'No declaration was in force on that date',
      },
    ])
  }
  const group = await commandGroup(ctx, `Gift Aid cancelled from ${date}`)
  for (const d of open) {
    await executeContract(
      ctx,
      cancellation,
      { cancelledFrom: date, note },
      { entityId: d._id, source, group },
    )
  }
  return { cancelled: open.map((d) => d._id) }
}

export const recordCancellation = tenantMutation({
  args: {
    contactId: v.id('contacts'),
    cancelledFrom: v.string(),
    note: v.optional(v.string()),
  },
  handler: (ctx, { contactId, cancelledFrom, note }) =>
    cancelDeclarations(ctx, contactId, cancelledFrom, note, 'ui'),
})
