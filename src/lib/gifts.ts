import type { Id } from '../../convex/_generated/dataModel'
import type { RecentGift } from '../../convex/giving/types'

export type { RecentGift }

/**
 * The caller's last 10 gifts in this group; undefined while loading or
 * when `enabled` is false.
 *
 * STUB until the giving backend lands (cash-gifts step 1a): then this is
 * `useQuery(api.giving.queries.myRecent, enabled ? { tenantId } : 'skip')`.
 */
export function useMyRecentGifts(
  tenantId: Id<'tenants'>,
  enabled = true,
): Array<RecentGift> | undefined {
  void tenantId
  return enabled ? [] : undefined
}

const POUNDS = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
})

/** Pence as "£1,234.50". */
export function formatPence(pence: bigint): string {
  const sign = pence < 0n ? '-' : ''
  const abs = pence < 0n ? -pence : pence
  // Pounds and pence split as bigints: never a float division.
  const pounds = POUNDS.format(Number(abs / 100n)).replace(/\.00$/, '')
  return `${sign}${pounds}.${(abs % 100n).toString().padStart(2, '0')}`
}

const ON = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/** An ISO date as "23 Oct 2026". */
export function formatDay(iso: string): string {
  return ON.format(new Date(`${iso}T00:00:00Z`))
}
