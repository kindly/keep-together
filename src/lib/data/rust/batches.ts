/**
 * Paying-in batches on the Rust API (`/api/t/{slug}/bank/batches…`, bank
 * transfers 6b): cash and cheques paid in together on one slip. Every
 * member reads; staff and admins open, close and reopen them, and record
 * gifts into an open one on the record-gift page.
 *
 * **Never optimistic**: a batch's total and its gifts are only what the
 * server answered, refetched after each write and on every gift's or
 * batch's event. Pence cross the wire as JSON integers and become
 * `bigint` here (rule 7).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { BatchStatus } from '../rust-types/BatchStatus'
import type { Executed } from '../rust-types/Executed'
import type { PayingInBatchDetail } from '../rust-types/PayingInBatchDetail'
import type { PayingInBatchView } from '../rust-types/PayingInBatchView'
import type { RecentGift as WireRecentGift } from '../rust-types/RecentGift'
import { get, post, tenantPath } from './client'
import { keys } from './keys'

export type { BatchStatus }

export type PayingInBatch = Omit<
  PayingInBatchView,
  'total' | 'giftsTotal' | 'line' | 'figures'
> & {
  /** The slip's total, once written. */
  total: bigint | null
  /**
   * What was paid in on the slip: every gift in it that isn't void, its
   * pending and bounced cheques included (the bank credited the slip in
   * full). Never money received: that is `figures.receivedTotal`.
   */
  giftsTotal: bigint
  figures: {
    receivedTotal: bigint
    pendingCount: number
    pendingTotal: bigint
    bouncedCount: number
    bouncedTotal: bigint
  }
  /** The statement line it is matched to, once matched. */
  line: { id: string; postedOn: string; amount: bigint } | null
}

export type BatchGift = Omit<WireRecentGift, 'amount'> & { amount: bigint }

export type PayingInBatchPage = {
  batch: PayingInBatch
  gifts: Array<BatchGift>
}

const batchFromWire = (b: PayingInBatchView): PayingInBatch => ({
  ...b,
  total: b.total === null ? null : BigInt(b.total),
  giftsTotal: BigInt(b.giftsTotal),
  figures: {
    receivedTotal: BigInt(b.figures.receivedTotal),
    pendingCount: b.figures.pendingCount,
    pendingTotal: BigInt(b.figures.pendingTotal),
    bouncedCount: b.figures.bouncedCount,
    bouncedTotal: BigInt(b.figures.bouncedTotal),
  },
  line: b.line
    ? {
        id: b.line.id,
        postedOn: b.line.postedOn,
        amount: BigInt(b.line.amount),
      }
    : null,
})

/** Pence to the wire, refusing what JSON can't carry exactly. */
function toWire(amount: bigint): number {
  const n = Number(amount)
  if (!Number.isSafeInteger(n)) throw new RangeError('amount out of range')
  return n
}

/** The batches, open ones first; with `status`, only those. */
export function useBatches(status?: BatchStatus, enabled = true) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.batchList(slug, status ?? 'all'),
    enabled,
    queryFn: async () => {
      const q = new URLSearchParams(status ? { status } : {})
      const rows = await get<Array<PayingInBatchView>>(
        tenantPath(slug, 'bank', 'batches'),
        q,
      )
      return rows.map(batchFromWire)
    },
  })
}

/** One batch and its gifts. */
export function useBatch(id: string) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.batch(slug, id),
    retry: false,
    queryFn: async (): Promise<PayingInBatchPage> => {
      const d = await get<PayingInBatchDetail>(
        tenantPath(slug, 'bank', 'batches', id),
      )
      return {
        batch: batchFromWire(d.batch),
        gifts: d.gifts.map((g) => ({ ...g, amount: BigInt(g.amount) })),
      }
    },
  })
}

/**
 * Open, close, reopen and save batches; each resolves once committed,
 * and every batch read (and the gifts' pages) refetches.
 */
export function useBatchWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  async function after<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f()
    } finally {
      await qc.invalidateQueries({ queryKey: keys.batches(slug) })
    }
  }
  const path = (...parts: Array<string>) =>
    tenantPath(slug, 'bank', 'batches', ...parts)
  return {
    open: (accountId: string, slipNumber: string) =>
      after(async () =>
        batchFromWire(
          await post<PayingInBatchView>(path(), { accountId, slipNumber }),
        ),
      ),
    close: (id: string, expected: number, bankedOn: string, total: bigint) =>
      after(() =>
        post<Executed>(path(id, 'close'), {
          expected,
          bankedOn,
          total: toWire(total),
        }),
      ),
    reopen: (id: string, expected: number) =>
      after(() => post<Executed>(path(id, 'reopen'), { expected })),
    save: (
      id: string,
      expected: number,
      slipNumber: string,
      bankedOn: string | null,
      total: bigint | null,
    ) =>
      after(() =>
        post<Executed>(path(id, 'save'), {
          expected,
          slipNumber,
          ...(bankedOn ? { bankedOn } : {}),
          ...(total !== null ? { total: toWire(total) } : {}),
        }),
      ),
  }
}
