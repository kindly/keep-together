import type { ExpectedStatus } from './data/rust-types/ExpectedStatus'
import type { RegularGiftFrequency } from './data/rust-types/RegularGiftFrequency'
import type { TermChangeKind } from './data/rust-types/TermChangeKind'
import type { TermStatus } from './data/rust-types/TermStatus'
import {
  downgradeSplit,
  isDueDate,
  nextDue,
  total,
  upgradeSplit,
} from './domain/regular-terms'
import type { Share, Terms } from './domain/regular-terms'

// "Change amount or schedule" on a regular gift's card (regular-gift
// terms step 6): what the dialog proposes before anything is sent, from
// the TS twin of `giving::terms_rules` (domain/regular-terms.ts), so it
// shows what the server will store. Pence are bigint; nothing divides.

export const KIND_LABELS: Record<TermChangeKind, string> = {
  setup: 'Set up',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  schedule: 'New schedule',
  reallocation: 'Split changed',
  unchanged: 'No change',
}

export const TERM_STATUS_LABELS: Record<TermStatus, string> = {
  scheduled: 'Scheduled',
  sending: 'Sending to GoCardless',
  sent: 'Sent to GoCardless',
  applied: 'In force',
  withdrawn: 'Withdrawn',
}

export const EXPECTED_LABELS: Record<ExpectedStatus, string> = {
  collected: 'Collected',
  pending: 'Pending',
  failed: 'Failed (arrears)',
  cancelled: 'Cancelled',
  missing: 'Missing',
  upcoming: 'To come',
}

/** What a terms row says, as the chain shows it. */
export type ChainRow = {
  id: string
  effectiveOn: string
  amount: bigint
  frequency: RegularGiftFrequency
  dayOfMonth: number
  month: number | null
  status: TermStatus
  allocations: ReadonlyArray<{ sourceCodeId: string; amount: bigint }>
}

/** The rows in force, in order: withdrawn ones out, and `except` (the one being edited). */
export function liveChain(
  rows: ReadonlyArray<ChainRow>,
  except?: string,
): Array<Terms> {
  return rows
    .filter((r) => r.status !== 'withdrawn' && r.id !== except)
    .map((r) => ({
      effectiveOn: r.effectiveOn,
      amount: r.amount,
      frequency: r.frequency,
      dayOfMonth: r.dayOfMonth,
      month: r.month,
      split: r.allocations.map((a) => ({
        sourceCodeId: a.sourceCodeId,
        amount: a.amount,
      })),
    }))
}

/** The row a change from `date` changes: the last before it (or the last of all, with no date yet). */
export function rowBefore(
  chain: ReadonlyArray<Terms>,
  date: string,
): Terms | undefined {
  if (!date) return chain.at(-1)
  for (let i = chain.length - 1; i >= 0; i--)
    if (chain[i].effectiveOn < date) return chain[i]
  return undefined
}

/**
 * The split the server makes when none is sent: an upgrade's difference
 * to `code` (the code that won it) as a new last layer; a downgrade off
 * the newest money first.
 */
export function proposedSplit(
  before: ReadonlyArray<Share>,
  amount: bigint,
  code: string | null,
): Array<Share> {
  if (amount >= total(before)) return upgradeSplit(before, amount, code ?? '')
  return downgradeSplit(before, amount)
}

/** `YYYY-MM-DD` plus `n` days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Whether `next`'s schedule is `prev`'s. */
export function sameSchedule(
  prev: Pick<Terms, 'frequency' | 'dayOfMonth' | 'month'>,
  next: Pick<Terms, 'frequency' | 'dayOfMonth' | 'month'>,
): boolean {
  return (
    prev.frequency === next.frequency &&
    prev.dayOfMonth === next.dayOfMonth &&
    (prev.frequency === 'monthly' || prev.month === next.month)
  )
}

/**
 * The payments a change can start on. On the same schedule: GoCardless's
 * next payments still far enough off (`changeable`). On a new one: the
 * new schedule's first dates from the earliest of those (or a week and
 * a day from today, with none), as the server wants a payment date of the
 * new terms. `own` (an edited row's date) is kept, if it still fits.
 */
export function effectiveOptions(args: {
  schedule: Pick<Terms, 'frequency' | 'dayOfMonth' | 'month'>
  same: boolean
  upcoming: ReadonlyArray<{ chargeDate: string; changeable: boolean }>
  today: string
  own?: string
  count?: number
}): Array<string> {
  const { schedule, same, upcoming, today, own, count = 6 } = args
  const changeable = upcoming
    .filter((u) => u.changeable)
    .map((u) => u.chargeDate)
  const next: Terms = {
    ...schedule,
    effectiveOn: today,
    amount: 0n,
    split: [],
  }
  const dates = same
    ? changeable.slice(0, count)
    : nextDue(next, addDays(changeable.at(0) ?? addDays(today, 8), -1), count)
  if (own && own > today && !dates.includes(own) && isDueDate(next, own))
    return [own, ...dates].sort()
  return dates
}

/** What's wrong with an edited split, as the server would refuse it. */
export function splitProblem(
  split: ReadonlyArray<{ sourceCodeId: string; amount: bigint | null }>,
  amount: bigint,
): string | null {
  if (split.length === 0) return 'The split needs at least one code'
  if (split.some((s) => !s.sourceCodeId)) return 'Pick a code for every line'
  if (split.some((s) => s.amount === null || s.amount <= 0n))
    return 'Every line needs an amount over £0'
  const sum = split.reduce((t, s) => t + (s.amount ?? 0n), 0n)
  if (sum !== amount) return 'The split must add up to the new amount'
  return null
}
