/**
 * What a group that switched "We claim Gift Aid" off still sees (plan
 * stripe.sv, S5; review s5r M1). The switch stops the app *offering*
 * Gift Aid: the tick when recording a gift, new declarations, new claims,
 * scanning forms. It never hides what is on record: a claim is a
 * financial record (rule 4) and a declaration its evidence, so once the
 * group has either, its claims, each claim's page, a contact's
 * declarations and a gift's coverage and claim link stay in view,
 * read-only. A group with neither sees no Gift Aid at all.
 *
 * `GET giftaid/on-record` is asked only while the switch is off (a group
 * that claims shows everything anyway), and read again when a claim or a
 * declaration changes (events.ts).
 */
import { useQuery } from '@tanstack/react-query'
import { get, tenantPath } from './data/rust/client'
import { queryClient } from './data/rust/hooks'
import { keys } from './data/rust/keys'
import type { GiftAidOnRecord } from './data/rust-types/GiftAidOnRecord'
import { claimsGiftAid, useTenant } from './tenant'

export type { GiftAidOnRecord }

/**
 * How many declarations and claims the group holds; undefined while
 * loading or when not `enabled`. On the app's one query client, so it
 * works wherever the switch does (Settings' layout included).
 */
export function useGiftAidOnRecord(
  slug: string,
  enabled = true,
): GiftAidOnRecord | undefined {
  return useQuery(
    {
      queryKey: keys.giftAidOnRecord(slug),
      enabled,
      staleTime: 60_000,
      queryFn: () =>
        get<GiftAidOnRecord>(tenantPath(slug, 'giftaid', 'on-record')),
    },
    queryClient,
  ).data
}

export type GiftAidView = {
  /** The group claims: Gift Aid is offered (ticks, new claims, scans). */
  offered: boolean
  /**
   * Gift Aid's records are in view: the group claims, or it holds a
   * claim or a declaration. While that is still being read: not yet.
   */
  shown: boolean
}

/** [`GiftAidView`] for a group by slug and its switch. */
export function useGiftAidOf(slug: string, claims: boolean): GiftAidView {
  const held = useGiftAidOnRecord(slug, !claims)
  return {
    offered: claims,
    shown: claims || (held ? held.declarations + held.claims > 0 : false),
  }
}

/** [`GiftAidView`] for the group whose page this is. */
export function useGiftAid(): GiftAidView {
  const tenant = useTenant()
  return useGiftAidOf(tenant.slug, claimsGiftAid(tenant))
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

/** "3 declarations and 1 claim", or null with neither. */
export function onRecordText(held: GiftAidOnRecord): string | null {
  const parts = [
    ...(held.declarations > 0
      ? [count(held.declarations, 'declaration', 'declarations')]
      : []),
    ...(held.claims > 0 ? [count(held.claims, 'claim', 'claims')] : []),
  ]
  return parts.length ? parts.join(' and ') : null
}
