/**
 * The `contributionAllocations` projection: one row per allocation of a
 * gift, carrying what reports range over (code, detail, category, date,
 * status, contact). Rebuilt from the gift by the `project` hook of both
 * giving contracts, in the same transaction; this file is its only writer.
 */
import type { Doc, Id } from '../_generated/dataModel'
import type { ContractCtx } from '../lib/contracts'
import { describe } from '../sources/code'
import { ALLOCATION_LIMIT } from './rules'

type Row = Omit<Doc<'contributionAllocations'>, '_id' | '_creationTime'>

/**
 * Reconcile the gift's rows by allocation key: insert, patch what changed,
 * delete what's gone. A row's detail and category are read only for a code
 * it didn't already carry (a part's parent never changes), so a void or a
 * date change reads no source codes.
 */
export async function projectAllocations(
  ctx: ContractCtx,
  id: Id<'contributions'>,
): Promise<void> {
  const [gift, rows] = await Promise.all([
    ctx.db.get(id),
    ctx.db
      .query('contributionAllocations')
      .withIndex('by_tenant_contribution', (q) => q.eq('contributionId', id))
      .take(ALLOCATION_LIMIT + 1),
  ])
  if (!gift) return
  const existing = new Map(rows.map((r) => [r.key, r]))
  for (const a of gift.allocations) {
    const row = existing.get(a.key)
    existing.delete(a.key)
    let parents: { detailId: Id<'sourceCodes'>; categoryId: Id<'sourceCodes'> }
    if (row && row.sourceCodeId === a.sourceCodeId) {
      parents = { detailId: row.detailId, categoryId: row.categoryId }
    } else {
      const code = await describe(ctx.db, a.sourceCodeId)
      // The contract has checked the code; a used code can't be deleted.
      if (!code) throw new Error(`allocation code ${a.sourceCodeId} missing`)
      parents = { detailId: code.detailId, categoryId: code.categoryId }
    }
    const want: Omit<Row, 'tenantId'> = {
      contributionId: gift._id,
      key: a.key,
      contactId: gift.contactId,
      sourceCodeId: a.sourceCodeId,
      ...parents,
      receivedOn: gift.receivedOn,
      amount: a.amount,
      status: gift.status,
    }
    if (!row) {
      await ctx.db.insert('contributionAllocations', want)
    } else if (
      (Object.keys(want) as Array<keyof typeof want>).some(
        (k) => want[k] !== row[k],
      )
    ) {
      await ctx.db.patch('contributionAllocations', row._id, want)
    }
  }
  for (const gone of existing.values()) {
    await ctx.db.delete('contributionAllocations', gone._id)
  }
}
