// Standing orders' pure rules for the pages (bank transfers 6b part 3),
// in step with `giving::standing` and `giving::regular::schedule_problems`:
// a standing order's first payment date gives its day (1–28, as every
// month has) and, quarterly or yearly, its month.
import type { ExpectedStatus } from '../data/rust-types/ExpectedStatus'
import type { RegularGiftFrequency } from '../data/rust-types/RegularGiftFrequency'

/** What's wrong with a first payment date (ISO), or null. */
export function startProblem(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso))
    return 'Pick the date of the first payment'
  const day = Number(iso.slice(8, 10))
  if (day > 28)
    return 'Standing orders here fall on days 1 to 28: pick the 28th or earlier'
  return null
}

/** The schedule a first payment date gives: its day, and its month unless monthly. */
export function scheduleOf(
  startsOn: string,
  frequency: RegularGiftFrequency,
): { dayOfMonth: number; month: number | null } {
  return {
    dayOfMonth: Number(startsOn.slice(8, 10)),
    month: frequency === 'monthly' ? null : Number(startsOn.slice(5, 7)),
  }
}

/** The chain's row in force on `today`: the last that has started, else the first. */
export function termInForce<T extends { effectiveOn: string; status: string }>(
  chain: ReadonlyArray<T>,
  today: string,
): T | undefined {
  const live = chain.filter((t) => t.status !== 'withdrawn')
  return [...live].reverse().find((t) => t.effectiveOn <= today) ?? live[0]
}

/**
 * "Make this a standing order" from a statement line: its first payment is
 * the line itself, so the start is the line's own day (capped at the
 * 28th) in the line's month, and quarterly or yearly fall in that month.
 * Built exactly as the server builds it (`standing_order_from` in
 * `api/src/routes/bank_matching.rs`; tested on both sides).
 */
export function lineSchedule(
  postedOn: string,
  frequency: RegularGiftFrequency,
): { startsOn: string; dayOfMonth: number; month: number | null } {
  const dayOfMonth = Math.min(Number(postedOn.slice(8, 10)), 28)
  return {
    startsOn: `${postedOn.slice(0, 8)}${String(dayOfMonth).padStart(2, '0')}`,
    dayOfMonth,
    month: frequency === 'monthly' ? null : Number(postedOn.slice(5, 7)),
  }
}

/**
 * Expected vs actual in a standing order's words: the donor's bank sends
 * the money, so nothing is "collected" (Direct Debit's word).
 */
export const STANDING_EXPECTED_LABELS: Record<ExpectedStatus, string> = {
  collected: 'Came in',
  pending: 'Pending',
  failed: 'Returned',
  cancelled: 'Cancelled',
  missing: 'Missing',
  upcoming: 'To come',
}
