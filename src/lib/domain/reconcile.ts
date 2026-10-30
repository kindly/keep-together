/**
 * Reconcile's rules on the client (bank transfers 6b): what a suggestion
 * is, so a tick follows it and not its place in a refetched list; which
 * suggestions may go in a bulk "Accept ticked" (never a name alone, g1q5);
 * and the order a picker lists candidates in (nearest by amount, then
 * date), with nothing chosen for staff.
 */
import type { BankProposal } from '../data/rust-types/BankProposal'

/**
 * A suggestion's identity: its kind and what it names. Two suggestions
 * with the same identity would do the same to the line.
 */
export function proposalKey(p: BankProposal): string {
  switch (p.kind) {
    case 'newGift':
      return `newGift:${p.contactId}`
    case 'existingGifts':
      return `existingGifts:${[...p.giftIds].sort().join(',')}`
    case 'notDonation':
      return `notDonation:${p.ruleId}`
  }
}

/** Made from a name alone: applied one at a time, never in bulk. */
export function nameOnly(s: { suggesters: ReadonlyArray<string> }): boolean {
  return s.suggesters.length > 0 && s.suggesters.every((n) => n === 'nameOnly')
}

/** Days between two ISO dates, either way round. */
function daysApart(a: string, b: string): number {
  return (
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
    86_400_000
  )
}

/**
 * Candidates nearest the target first: the closest amount, then the
 * closest date. A picker lists them so, and still chooses none.
 */
export function nearestFirst<T>(
  items: ReadonlyArray<T>,
  target: { amount: bigint; date: string | null },
  of: (t: T) => { amount: bigint | null; date: string | null },
): Array<T> {
  const gap = (t: T) => {
    const { amount } = of(t)
    if (amount === null) return Number.MAX_SAFE_INTEGER
    const d = amount - target.amount
    return Number(d < 0n ? -d : d)
  }
  const days = (t: T) => {
    const { date } = of(t)
    return date && target.date
      ? daysApart(date, target.date)
      : Number.MAX_SAFE_INTEGER
  }
  return [...items].sort((a, b) => gap(a) - gap(b) || days(a) - days(b))
}
