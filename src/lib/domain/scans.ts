/**
 * Declaration scans' pure rules for the laptop (plan declaration-scans,
 * step 4): what a sitting's link is doing, which declarations a scan may
 * be matched to (as `giftaid::scans::accept_scan` refuses the rest), how
 * the files usage reads, and how a page list is reordered. The server
 * decides; these only say it first.
 */
import type { DeclarationMethod } from '../data/rust-types/DeclarationMethod'
import type { ScanPairingView } from '../data/rust-types/ScanPairingView'

/** Bytes as people read them, decimal as the 2 GB cap is: "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1000
  let u = 0
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000
    u += 1
  }
  const shown = n >= 100 || Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)
  return `${shown.replace(/\.0$/, '')} ${units[u]}`
}

/** From this share of the cap, Settings warns that scans will stop. */
export const USAGE_WARN_AT = 0.9

/**
 * "120 MB of 2 GB (6%)", and whether it is nearly or quite full; with no
 * cap (`capBytes` null, the default), just "120 MB" and no share.
 */
export function describeUsage(usage: {
  bytes: number
  capBytes: number | null
}): {
  text: string
  share: number | null
  level: 'ok' | 'warn' | 'full'
} {
  if (usage.capBytes === null)
    return { text: formatBytes(usage.bytes), share: null, level: 'ok' }
  const share = usage.capBytes > 0 ? usage.bytes / usage.capBytes : 1
  const percent = Math.min(100, Math.floor(share * 100))
  return {
    text: `${formatBytes(usage.bytes)} of ${formatBytes(usage.capBytes)} (${percent}%)`,
    share,
    level: share >= 1 ? 'full' : share >= USAGE_WARN_AT ? 'warn' : 'ok',
  }
}

export type LinkState =
  | { kind: 'waiting'; endsAt: number }
  | { kind: 'connected'; endsAt: number }
  | { kind: 'ended' }

/**
 * Where a sitting's link stands at `now`: not yet opened on a phone,
 * held by one, or ended (by the laptop, sign-out, or its idle or 2-hour
 * limit, which the server reports as `endedAt` once read past it).
 * `endsAt` is the sooner of the two limits.
 */
export function linkState(
  p: Pick<
    ScanPairingView,
    'claimed' | 'endedAt' | 'expiresAt' | 'idleExpiresAt'
  >,
  now: number,
): LinkState {
  const endsAt = Math.min(p.expiresAt, p.idleExpiresAt)
  if (p.endedAt !== null || now >= endsAt) return { kind: 'ended' }
  return { kind: p.claimed ? 'connected' : 'waiting', endsAt }
}

/** "in 14 min", "in under a minute". */
export function endsIn(endsAt: number, now: number): string {
  const minutes = Math.floor((endsAt - now) / 60_000)
  return minutes < 1 ? 'in under a minute' : `in ${minutes} min`
}

/**
 * Whether a scan may be matched to this declaration: a paper form
 * (HMRC 3.7.2: the scan is that form's replica) that wasn't made in
 * error and holds no scan yet (`heldScans`: undefined while unknown).
 */
export function matchable(
  d: { method: DeclarationMethod; voidedAt?: number },
  heldScans: number | undefined,
): boolean {
  return d.method === 'paperForm' && d.voidedAt === undefined && heldScans === 0
}

/** The page ids with the one at `from` moved by `by` (−1 up, +1 down). */
export function movePage(
  order: ReadonlyArray<string>,
  from: number,
  by: -1 | 1,
): Array<string> {
  const to = from + by
  if (from < 0 || from >= order.length || to < 0 || to >= order.length)
    return [...order]
  const next = [...order]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/** At most this many pages in one scan (`giftaid::scans::MAX_PAGES`). */
export const MAX_PAGES = 6

/** Whether `from`'s pages fit after `into`'s, as a merge needs. */
export function canMerge(intoPages: number, fromPages: number): boolean {
  return intoPages + fromPages <= MAX_PAGES
}
