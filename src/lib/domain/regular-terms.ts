import type { RegularGiftFrequency } from '../data/rust-types/RegularGiftFrequency'
import type { TermChangeKind } from '../data/rust-types/TermChangeKind'

// A regular gift's terms as a dated chain (ADR 0026): the twin of
// `giving::terms_rules`, rule for rule, so the change dialog shows what
// the server will store. Pence are bigint (rule 7) and nothing here
// divides: a split moves by whole layers, newest money first.

/** One layer of a split: pence to a source code, oldest money first. */
export type Share = { sourceCodeId: string; amount: bigint }

/** What a terms row says, as the rules read it. */
export type Terms = {
  /** ISO date: `appliesFrom` when set, else `effectiveFrom`. */
  effectiveOn: string
  amount: bigint
  frequency: RegularGiftFrequency
  dayOfMonth: number
  month: number | null
  split: Array<Share>
}

export function total(split: ReadonlyArray<Share>): bigint {
  return split.reduce((sum, s) => sum + s.amount, 0n)
}

/** The row in force on `date`: the last on or before it. */
export function termInForce(
  chain: ReadonlyArray<Terms>,
  date: string,
): Terms | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].effectiveOn <= date) return chain[i]
  }
  return undefined
}

/**
 * A new total, at least the split's: the difference goes to `code` as a
 * new last layer, merged into the last layer if it is already `code`.
 */
export function upgradeSplit(
  split: ReadonlyArray<Share>,
  newAmount: bigint,
  code: string,
): Array<Share> {
  const out = split.map((s) => ({ ...s }))
  const diff = newAmount - total(split)
  if (diff <= 0n) return out
  const last = out.at(-1)
  if (last && last.sourceCodeId === code) last.amount += diff
  else out.push({ sourceCodeId: code, amount: diff })
  return out
}

/**
 * A new total (over 0), at most the split's: pence come off the last
 * layer first; a layer left with nothing goes.
 */
export function downgradeSplit(
  split: ReadonlyArray<Share>,
  newAmount: bigint,
): Array<Share> {
  const out = split.map((s) => ({ ...s }))
  let cut = total(split) - newAmount
  while (cut > 0n && out.length > 0) {
    const last = out[out.length - 1]
    if (last.amount > cut) {
      last.amount -= cut
      cut = 0n
    } else {
      cut -= last.amount
      out.pop()
    }
  }
  return out
}

/** The split a payment of `collected` takes: the newest layer absorbs it. */
export function splitForCollected(
  split: ReadonlyArray<Share>,
  collected: bigint,
): Array<Share> {
  if (collected <= total(split)) return downgradeSplit(split, collected)
  const last = split.at(-1)
  return last ? upgradeSplit(split, collected, last.sourceCodeId) : []
}

/** A year's worth, in pence. */
export function annualValue(
  amount: bigint,
  frequency: RegularGiftFrequency,
): bigint {
  return frequency === 'monthly' ? amount * 12n : amount
}

function sameSplit(a: ReadonlyArray<Share>, b: ReadonlyArray<Share>): boolean {
  return (
    a.length === b.length &&
    a.every(
      (s, i) =>
        s.sourceCodeId === b[i].sourceCodeId && s.amount === b[i].amount,
    )
  )
}

/** Annual value first, then the schedule, then the split. */
export function changeKind(
  old: Terms | undefined,
  next: Terms,
): TermChangeKind {
  if (!old) return 'setup'
  const was = annualValue(old.amount, old.frequency)
  const now = annualValue(next.amount, next.frequency)
  if (now > was) return 'upgrade'
  if (now < was) return 'downgrade'
  if (
    old.frequency !== next.frequency ||
    old.dayOfMonth !== next.dayOfMonth ||
    old.month !== next.month
  )
    return 'schedule'
  if (!sameSplit(old.split, next.split)) return 'reallocation'
  return 'unchanged'
}

/** `YYYY-MM-DD` (or `YYYY-MM`) as a month count. */
export function monthIndex(date: string): number | undefined {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12)
    return undefined
  return y * 12 + m - 1
}

export function monthLabel(index: number): string {
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`
}

function dueIn(t: Terms, index: number): string | undefined {
  const day = `${monthLabel(index)}-${String(t.dayOfMonth).padStart(2, '0')}`
  if (t.frequency === 'monthly') return day
  return t.month === (index % 12) + 1 ? day : undefined
}

/** The next `n` due dates after `date` under `t`. */
export function nextDue(t: Terms, date: string, n: number): Array<string> {
  let index = monthIndex(date)
  if (index === undefined) return []
  const out: Array<string> = []
  for (let guard = 0; out.length < n && guard < 12 * (n + 1); guard++) {
    const due = dueIn(t, index)
    if (due !== undefined && due > date) out.push(due)
    index++
  }
  return out
}

export type ExpectedPeriod = {
  /** `YYYY-MM`: the month it is due in. */
  period: string
  dueOn: string
  amount: bigint
  split: Array<Share>
  /** Which row of the chain governs it. */
  row: number
}

/**
 * The payments a chain expects with due dates from `from` to `to`, and
 * before `endedOn`. A row governs the months from its own to the next
 * row's.
 */
export function expectedPeriods(
  chain: ReadonlyArray<Terms>,
  endedOn: string | null,
  from: string,
  to: string,
): Array<ExpectedPeriod> {
  const first = monthIndex(from)
  const last = monthIndex(to)
  if (first === undefined || last === undefined) return []
  const starts = chain.map((t) => monthIndex(t.effectiveOn))
  const out: Array<ExpectedPeriod> = []
  for (let index = first; index <= last; index++) {
    let row = -1
    for (let i = starts.length - 1; i >= 0; i--) {
      const s = starts[i]
      if (s !== undefined && s <= index) {
        row = i
        break
      }
    }
    if (row < 0) continue
    const t = chain[row]
    const due = dueIn(t, index)
    if (due === undefined || due < from || due > to) continue
    if (endedOn !== null && due >= endedOn) break
    out.push({
      period: monthLabel(index),
      dueOn: due,
      amount: t.amount,
      split: t.split.map((s) => ({ ...s })),
      row,
    })
  }
  return out
}
