// Standing orders' pure rules for the pages (bank transfers 6b part 3),
// in step with `giving::standing` and `giving::regular::schedule_problems`:
// a standing order's first payment date gives its day (1–28, as every
// month has) and, quarterly or yearly, its month.
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

/** The next payment still to come, from the expected rows. */
export function nextDue<T extends { dueOn: string; status: string }>(
  rows: ReadonlyArray<T>,
  today: string,
): string | null {
  return (
    rows.find((r) => r.status === 'upcoming' && r.dueOn >= today)?.dueOn ?? null
  )
}
