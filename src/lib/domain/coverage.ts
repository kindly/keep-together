/**
 * Gift Aid coverage (rule 1: a dated chain, not a boolean), as
 * `server/crates/giftaid/src/rules.rs` decides it: which declaration
 * covers a gift, and which a cancellation applies to. Dates are ISO
 * `YYYY-MM-DD`, so they compare as strings.
 */
import type { Id } from './ids'
import type { DeclarationScope } from '../data/rust-types/DeclarationScope'

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The same day `years` years earlier. 29 February with no such day that
 * year becomes 1 March: the narrower window, so a gift is never counted
 * as covered on a day the wording doesn't reach.
 */
export function yearsBefore(date: string, years: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const y = year - years
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  if (day > daysInMonth(y, month)) return `${pad(y, 4)}-${pad(month + 1)}-01`
  return `${pad(y, 4)}-${pad(month)}-${pad(day)}`
}

/** What coverage needs to know about one declaration. */
export type DeclarationWindow = {
  scope: DeclarationScope
  madeOn: string
  /** The gift it was made with (always, for `thisGift`). */
  contributionId?: Id<'contributions'>
  cancelledFrom?: string
  /** Present = voided (recorded in error): it never applied. */
  voidedAt?: number
}

/** The gift being asked about: its date and, once saved, its id. */
export type GiftRef = { date: string; contributionId?: Id<'contributions'> }

/** The first day the declaration covers; null for `thisGift` (no range). */
export function windowStart(d: DeclarationWindow): string | null {
  if (d.scope === 'futureAndPast4y') return yearsBefore(d.madeOn, 4)
  if (d.scope === 'future') return d.madeOn
  return null
}

export function covers(d: DeclarationWindow, gift: GiftRef): boolean {
  if (d.voidedAt !== undefined) return false
  if (d.cancelledFrom !== undefined && d.cancelledFrom <= gift.date) {
    return false
  }
  if (
    d.contributionId !== undefined &&
    d.contributionId === gift.contributionId
  ) {
    return true
  }
  if (d.scope === 'thisGift') return false
  return windowStart(d)! <= gift.date
}

/**
 * The declaration that covers the gift, or null. Of several, the one made
 * last (the evidence a reviewer would look at first).
 */
export function coveringDeclaration<T extends DeclarationWindow>(
  declarations: ReadonlyArray<T>,
  gift: GiftRef,
): T | null {
  let best: T | null = null
  for (const d of declarations) {
    if (covers(d, gift) && (best === null || d.madeOn >= best.madeOn)) {
      best = d
    }
  }
  return best
}

/**
 * The enduring declaration in force on `today`: one that would cover a
 * new gift made today. A `thisGift` declaration never is (it covers one
 * gift), so the gift form offers the tick again (g2q6).
 */
export function currentOf<T extends DeclarationWindow>(
  declarations: ReadonlyArray<T>,
  today: string,
): T | null {
  return coveringDeclaration(
    declarations.filter((d) => d.scope !== 'thisGift'),
    { date: today },
  )
}

/**
 * Whether a cancellation from `date` applies to the declaration: it had
 * been made by then, isn't void and wasn't already cancelled on or before
 * it. A later cancellation date is moved earlier; a declaration made
 * after `date` is left alone (the donor declared again since).
 */
export function openAt(d: DeclarationWindow, date: string): boolean {
  return (
    d.voidedAt === undefined &&
    d.madeOn <= date &&
    (d.cancelledFrom === undefined || d.cancelledFrom > date)
  )
}
