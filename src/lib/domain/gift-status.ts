import type { GiftMethod } from '../data/rust-types/GiftMethod'
import type { GiftStatus } from '../data/rust-types/GiftStatus'

// Where a gift stands (ADR 0025: a gift is every payment attempt). Keep
// in step with `giving::types::Status` and `giving::RECEIVED`: only
// `completed` is money received, so only it counts in a total or for
// Gift Aid. `void` is the staff's word; the rest are a payment
// provider's (GoCardless's), following its payment.

/** Money received: counts in totals, may be claimed. */
export function isReceived(status: GiftStatus): boolean {
  return status === 'completed'
}

/** Set by the payment provider, never by staff. */
export function isProviderStatus(status: GiftStatus): boolean {
  return status !== 'completed' && status !== 'void'
}

/** How a list or a badge names each status. */
export const STATUS_LABELS: Record<GiftStatus, string> = {
  pending: 'pending',
  completed: 'received',
  failed: 'failed',
  cancelled: 'cancelled',
  refunded: 'refunded',
  charged_back: 'charged back',
  void: 'void',
}

/** What a gift that isn't money received means, in a sentence. */
export const STATUS_MEANINGS: Record<GiftStatus, string> = {
  pending: 'Pending: not collected yet. It counts once the money arrives.',
  completed: 'Received.',
  failed: 'Failed: the payment wasn’t collected. It counts for nothing.',
  cancelled: 'Cancelled: never collected. It counts for nothing.',
  refunded: 'Refunded to the donor: it counts for nothing.',
  charged_back:
    'Charged back: the donor’s bank returned the money. It counts for nothing.',
  void: 'Void: kept for the record, counts for nothing.',
}

/** The pence a list of gifts adds up to: money received only. */
export function receivedTotal(
  gifts: ReadonlyArray<{ status: GiftStatus; amount: bigint }>,
): bigint {
  return gifts.reduce(
    (sum, g) => (isReceived(g.status) ? sum + g.amount : sum),
    0n,
  )
}

/**
 * Where a gift stands against the bank (ADR 0027), beside its status: a
 * transfer entered by hand that no statement line is matched to yet
 * (`giving::bank::not_on_a_statement`, derived on the server), and a
 * cheque, pending until it clears (with its paying-in batch's line, or by
 * hand outside a batch) or bounced. Null for anything else.
 */
export function bankNote(g: {
  method: GiftMethod
  status: GiftStatus
  notOnAStatement: boolean
  payingInBatchId: string | null
}): { short: string; long: string } | null {
  if (g.notOnAStatement)
    return {
      short: 'not on a statement yet',
      long: 'Not on a statement yet: it counts, and no statement line is matched to it so far.',
    }
  if (g.method !== 'cheque') return null
  if (g.status === 'pending')
    return g.payingInBatchId
      ? {
          short: 'pending: in a paying-in batch',
          long: 'Pending until its paying-in batch is matched to a statement line.',
        }
      : {
          short: 'pending: not cleared',
          long: 'Pending until it clears: mark it cleared once the bank has the money.',
        }
  if (g.status === 'failed')
    return {
      short: 'bounced',
      long: 'Bounced: the cheque didn’t clear. It counts for nothing.',
    }
  return null
}
