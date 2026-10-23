import { useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import type { RecentGift } from '../../convex/giving/types'

export type { RecentGift }

/**
 * The caller's last 10 gifts in this group; undefined while loading or
 * when `enabled` is false.
 */
export function useMyRecentGifts(
  tenantId: Id<'tenants'>,
  enabled = true,
): Array<RecentGift> | undefined {
  return useQuery(api.giving.queries.myRecent, enabled ? { tenantId } : 'skip')
}

export const METHOD_LABELS: Record<Doc<'contributions'>['method'], string> = {
  cash: 'Cash',
  card: 'Card (separate reader)',
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

/** Pence as the amount field shows it: "20.00", "1234.50". No grouping. */
export function penceToInput(pence: bigint): string {
  const sign = pence < 0n ? '-' : ''
  const abs = pence < 0n ? -pence : pence
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

/**
 * What staff typed as an amount in pounds, as pence: "20", "20.5",
 * "£1,250.00". Null for anything else (a third decimal, a letter, empty).
 * Parsed as digits, never through a float (rule 7). Zero and negatives
 * parse; the contract refuses them with its own message.
 */
export function parsePounds(text: string): bigint | null {
  const m = /^(-)?£?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/.exec(
    text.trim().replace(/\s+/g, ''),
  )
  if (!m) return null
  // Optional groups that didn't take part are undefined.
  const [, minus, whole, fraction] = m as Array<string | undefined>
  if (whole === undefined && fraction === undefined) return null
  const pounds = BigInt((whole ?? '0').replace(/,/g, ''))
  const pence = BigInt((fraction ?? '0').padEnd(2, '0'))
  const total = pounds * 100n + pence
  return minus ? -total : total
}

/**
 * A user-facing line for a refused gift or Gift Aid write: the problems
 * of an `invalid`, a `rejected`'s message, or `stale` for someone else's
 * change since the page loaded.
 */
export function refusal(err: unknown, fallback: string, stale: string): string {
  if (!(err instanceof ConvexError)) return fallback
  const d = err.data as {
    kind?: string
    message?: string
    problems?: Array<{ message: string }>
  }
  if (d.kind === 'stale') return stale
  if (d.kind === 'invalid' && d.problems?.length)
    return d.problems.map((p) => p.message).join('; ')
  return d.message ?? fallback
}
