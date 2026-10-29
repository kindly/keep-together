import type { DirectDebitPaymentStatus } from '../data/rust-types/DirectDebitPaymentStatus'
import type { RegularGiftFrequency } from '../data/rust-types/RegularGiftFrequency'
import type { RegularGiftStatus } from '../data/rust-types/RegularGiftStatus'

// How the Direct Debit screens (GoCardless D3) name what GoCardless
// says. Keep in step with `giving::types` and `giving::RECEIVED`: a
// payment is money received only once GoCardless has collected it
// (`confirmed`, whose gift is `completed`); pending, failed, charged
// back and cancelled payments count for nothing (ADR 0025).

/** Collected: the only payment status that is money received. */
export function isCollected(status: DirectDebitPaymentStatus): boolean {
  return status === 'confirmed'
}

/** A payment's status as the card lists it. */
export const PAYMENT_LABELS: Record<DirectDebitPaymentStatus, string> = {
  pending: 'pending',
  confirmed: 'collected',
  failed: 'failed',
  chargedBack: 'charged back',
  cancelled: 'cancelled',
}

/** Where a regular gift stands, as its card's badge says it. */
export const REGULAR_STATUS_LABELS: Record<RegularGiftStatus, string> = {
  pending: 'Waiting for the donor',
  active: 'Active',
  cancelled: 'Cancelled',
  failed: 'Not set up',
}

/** What the badge means, in a sentence. */
export const REGULAR_STATUS_MEANINGS: Record<RegularGiftStatus, string> = {
  pending:
    'The donor hasn’t finished signing up yet: send them the link. Nothing is collected until their mandate is active.',
  active: 'The mandate is active: GoCardless collects on schedule.',
  cancelled: 'Ended: nothing more will be collected.',
  failed: 'The mandate couldn’t be set up: nothing will be collected.',
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** The month's name, 1–12. */
export function monthName(month: number): string {
  return MONTHS[month - 1] ?? `month ${month}`
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". */
export function ordinal(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  switch (day % 10) {
    case 1:
      return `${day}st`
    case 2:
      return `${day}nd`
    case 3:
      return `${day}rd`
    default:
      return `${day}th`
  }
}

/** "every month on the 1st", "every year on 5th March". */
export function scheduleText(s: {
  frequency: RegularGiftFrequency
  dayOfMonth: number
  month: number | null
}): string {
  if (s.frequency === 'monthly')
    return `every month on the ${ordinal(s.dayOfMonth)}`
  return `every year on ${ordinal(s.dayOfMonth)} ${s.month === null ? '' : monthName(s.month)}`.trimEnd()
}

/** The days a regular gift may be collected on (GoCardless's 1–28). */
export const DAYS_OF_MONTH: ReadonlyArray<number> = Array.from(
  { length: 28 },
  (_, i) => i + 1,
)

/** Whether a sign-up link has run out (GoCardless's last 7 days). */
export function linkExpired(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime()
}
