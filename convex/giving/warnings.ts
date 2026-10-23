/**
 * Advisory validation (ADR 0015): storable but probably wrong. Never blocks
 * a save. Pure and shared by backend and UI; `today` (the caller's local
 * ISO date) is an argument because a query can't read the clock.
 */
import type { Warning } from '../contacts/warnings'

export type { Warning }

/** Over this (pence) a gift is probably mistyped: £10,000. */
export const LARGE_GIFT = 1_000_000n

/** Years back Gift Aid can still be claimed. */
export const CLAIMABLE_YEARS = 4

/** `date` moved back `years` calendar years (ISO strings compare as dates). */
export function yearsBefore(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) - years
  return `${String(year).padStart(4, '0')}${date.slice(4)}`
}

export function giftWarnings(
  gift: { receivedOn: string; amount: bigint },
  today: string,
): Array<Warning> {
  const warnings: Array<Warning> = []
  if (gift.receivedOn > today) {
    warnings.push({
      anchor: 'receivedOn',
      label: 'date',
      message: 'This date is in the future',
    })
  } else if (gift.receivedOn < yearsBefore(today, CLAIMABLE_YEARS)) {
    warnings.push({
      anchor: 'receivedOn',
      label: 'date',
      message: `More than ${CLAIMABLE_YEARS} years ago: too old to claim Gift Aid on`,
    })
  }
  if (gift.amount > LARGE_GIFT) {
    warnings.push({
      anchor: 'amount',
      label: 'amount',
      message: 'Over £10,000: check the amount',
    })
  }
  return warnings
}
