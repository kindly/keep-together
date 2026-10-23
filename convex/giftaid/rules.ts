/**
 * Gift Aid declaration rules, pure (shared by backend and UI). The law is
 * HMRC's *Charities detailed guidance notes*, chapter 3, as the cash gifts
 * plan recorded it (factory/plans/cash-gifts.sv, "What the law says").
 *
 * Coverage (rule 1: a dated chain, not a boolean): a gift dated `d` is
 * covered if some declaration of its donor has a window containing `d`
 * and isn't cancelled at or before `d`. Windows:
 *
 *   futureAndPast4y  [madeOn − 4 years, ∞)
 *   future           [madeOn, ∞)
 *   thisGift         exactly its own gift
 *
 * A cancellation with `cancelledFrom` ≤ `d` removes coverage for gifts on
 * or after that date (3.8.2). A voided declaration (recorded in error)
 * covers nothing, whatever its window. Dates are ISO `YYYY-MM-DD`, so they compare
 * as strings.
 */
import type { Id } from '../_generated/dataModel'
import { invalid } from '../lib/contracts'
import type { Problem } from '../lib/contracts'
import type {
  CancellationPayload,
  DeclarationPayload,
  VoidPayload,
} from './validators'

/** The most declarations one contact may have (each read on every coverage check). */
export const DECLARATION_LIMIT = 100
export const SNAPSHOT_FIELD_MAX = 200
export const CANCELLATION_NOTE_MAX = 1000
export const VOID_REASON_MAX = 1000
export const WORDING_VERSION_MAX = 50

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** A real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value)
  if (!m) return false
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  )
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

/**
 * The UK calendar date at `at` (ms since the epoch), `YYYY-MM-DD`: what
 * "today" means to the staff entering a declaration.
 */
export function ukDate(at: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/** What coverage needs to know about one declaration. */
export type DeclarationWindow = {
  scope: DeclarationPayload['scope']
  madeOn: string
  /** The gift a `thisGift` declaration was made with. */
  contributionId?: Id<'contributions'>
  cancelledFrom?: string
  /** Present = voided (recorded in error): it never applied. */
  voidedAt?: number
}

/** The gift being asked about: its date and, for `thisGift`, its id. */
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
  if (d.scope === 'thisGift') {
    return (
      d.contributionId !== undefined && d.contributionId === gift.contributionId
    )
  }
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
 * it. A later
 * cancellation date is moved earlier; a declaration made after `date` is
 * left alone (the donor declared again since).
 */
export function openAt(d: DeclarationWindow, date: string): boolean {
  return (
    d.voidedAt === undefined &&
    d.madeOn <= date &&
    (d.cancelledFrom === undefined || d.cancelledFrom > date)
  )
}

function tidy(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * Snapshot fields tidied (postcode upper-cased); `madeOn` a real date;
 * a wording version given; a gift named exactly when the scope is
 * `thisGift`; never `onScreenByDonor` while no donor-facing screen exists
 * (staff can't make that true). A future `madeOn` is refused by the
 * contract, which knows the time.
 * Empty snapshot fields are storable: they warn (warnings.ts), because
 * staff may tick before they have the address (g3q3).
 */
export function prepareDeclaration(p: DeclarationPayload): DeclarationPayload {
  const out = {
    ...p,
    madeOn: p.madeOn.trim(),
    wordingVersion: p.wordingVersion.trim(),
    firstName: tidy(p.firstName),
    lastName: tidy(p.lastName),
    addressLine1: tidy(p.addressLine1),
    postcode: tidy(p.postcode).toUpperCase(),
  }
  const problems: Array<Problem> = []
  if (!isIsoDate(out.madeOn)) {
    problems.push({ field: 'madeOn', message: 'Enter a date (YYYY-MM-DD)' })
  }
  if (out.method === 'onScreenByDonor') {
    problems.push({
      field: 'method',
      message:
        'There is no screen for donors to declare on yet: record how staff took the declaration',
    })
  }
  if (!out.wordingVersion) {
    problems.push({
      field: 'wordingVersion',
      message: 'Say which declaration wording the donor agreed to',
    })
  } else if (out.wordingVersion.length > WORDING_VERSION_MAX) {
    problems.push({
      field: 'wordingVersion',
      message: `At most ${WORDING_VERSION_MAX} characters`,
    })
  }
  if (out.scope === 'thisGift' && out.contributionId === undefined) {
    problems.push({
      field: 'contributionId',
      message: 'A “this gift only” declaration needs its gift',
    })
  }
  if (out.scope !== 'thisGift' && out.contributionId !== undefined) {
    problems.push({
      field: 'contributionId',
      message: 'Only a “this gift only” declaration names a gift',
    })
  }
  for (const field of [
    'firstName',
    'lastName',
    'addressLine1',
    'postcode',
  ] as const) {
    if (out[field].length > SNAPSHOT_FIELD_MAX) {
      problems.push({
        field,
        message: `At most ${SNAPSHOT_FIELD_MAX} characters`,
      })
    }
  }
  if (problems.length) throw invalid(problems)
  return out
}

/** Date a real date when present; a note only with a date; blanks → absent. */
export function prepareCancellation(
  p: CancellationPayload,
): CancellationPayload {
  const out = {
    cancelledFrom: p.cancelledFrom?.trim() || undefined,
    note: p.note?.trim() || undefined,
  }
  const problems: Array<Problem> = []
  if (out.cancelledFrom !== undefined && !isIsoDate(out.cancelledFrom)) {
    problems.push({
      field: 'cancelledFrom',
      message: 'Enter a date (YYYY-MM-DD)',
    })
  }
  if (out.note !== undefined && out.cancelledFrom === undefined) {
    problems.push({ field: 'note', message: 'A note needs a cancellation' })
  }
  if (out.note !== undefined && out.note.length > CANCELLATION_NOTE_MAX) {
    problems.push({
      field: 'note',
      message: `At most ${CANCELLATION_NOTE_MAX} characters`,
    })
  }
  if (problems.length) throw invalid(problems)
  return out
}

/** A reason is required: the void is the audit record of the mistake. */
export function prepareVoid(p: VoidPayload): VoidPayload {
  const out = { reason: p.reason.trim() }
  if (!out.reason) {
    throw invalid([
      { field: 'reason', message: 'Say why the declaration was made in error' },
    ])
  }
  if (out.reason.length > VOID_REASON_MAX) {
    throw invalid([
      { field: 'reason', message: `At most ${VOID_REASON_MAX} characters` },
    ])
  }
  return out
}
