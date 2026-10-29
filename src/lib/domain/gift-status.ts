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
