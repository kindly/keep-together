/**
 * Standing orders on the Rust API (`/api/t/{slug}/contacts/{id}/
 * standing-orders`, `…/standing-orders/{id}`, `…/missed`; server/README.md
 * "Bank transfers"): regular gifts of kind `standing_order`, set up by the
 * donor in their own bank, so nothing here calls GoCardless.
 *
 * **Never optimistic** (rule 4, ADR 0025): every write waits for the
 * server, and what lands in the cache is the standing order it read back
 * in the same transaction. Each committed change comes back as an event
 * (events.ts), which refetches everything under `keys.standing`. Pence
 * cross the wire as JSON integers and become `bigint` here (rule 7).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { BankLineDetail } from '../rust-types/BankLineDetail'
import type { BankStandingOrderFromLine } from '../rust-types/BankStandingOrderFromLine'
import type { EndStandingOrder } from '../rust-types/EndStandingOrder'
import type { ExpectedRow } from '../rust-types/ExpectedRow'
import type { MissedStandingOrder as WireMissed } from '../rust-types/MissedStandingOrder'
import type { StandingOrderSetUp } from '../rust-types/StandingOrderSetUp'
import type { StandingOrderView } from '../rust-types/StandingOrderView'
import { get, post, tenantPath } from './client'
import type { ExpectedPeriodRow, Term } from './gocardless'
import { termFromWire, toWire } from './gocardless'
import { keys } from './keys'

// ── shapes ─────────────────────────────────────────────────────────────────

export type StandingOrder = Omit<StandingOrderView, 'chain' | 'expected'> & {
  chain: Array<Term>
  expected: Array<ExpectedPeriodRow>
}

export type MissedStandingOrder = Omit<WireMissed, 'amount'> & {
  amount: bigint | null
}

export type StandingOrderArgs = Omit<StandingOrderSetUp, 'amount'> & {
  amount: bigint
}

/** "Make this a standing order" from a statement line (its amount is the line's). */
export type StandingOrderFromLineArgs = Omit<
  BankStandingOrderFromLine,
  'expected'
>

// ── wire → page ────────────────────────────────────────────────────────────

const pence = (n: number): bigint => BigInt(n)

export const expectedRowFromWire = (r: ExpectedRow): ExpectedPeriodRow => ({
  ...r,
  expected: pence(r.expected),
  split: r.split.map((s) => ({ ...s, amount: pence(s.amount) })),
  amount: r.amount === null ? null : pence(r.amount),
})

export const standingOrderFromWire = (v: StandingOrderView): StandingOrder => ({
  ...v,
  chain: v.chain.map(termFromWire),
  expected: v.expected.map(expectedRowFromWire),
})

// ── reads ──────────────────────────────────────────────────────────────────

/** A contact's standing orders, newest first; any member. Undefined while loading. */
export function useStandingOrders(
  contactId: string,
): Array<StandingOrder> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.standingOrders(slug, contactId),
    queryFn: async () =>
      (
        await get<Array<StandingOrderView>>(
          tenantPath(slug, 'contacts', contactId, 'standing-orders'),
        )
      ).map(standingOrderFromWire),
  }).data
}

/** Standing orders with a missed payment, oldest miss first; any member. */
export function useMissedStandingOrders(
  enabled = true,
): Array<MissedStandingOrder> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.standingMissed(slug),
    enabled,
    queryFn: async () =>
      (
        await get<Array<WireMissed>>(
          tenantPath(slug, 'standing-orders', 'missed'),
        )
      ).map((m) => ({
        ...m,
        amount: m.amount === null ? null : pence(m.amount),
      })),
  }).data
}

// ── writes ─────────────────────────────────────────────────────────────────

/** Whether `was` has seen a change `next` hasn't (a counter is ahead). */
function newer(was: StandingOrder, next: StandingOrder): boolean {
  return (
    was.setupVersion > next.setupVersion ||
    was.mandateVersion > next.mandateVersion ||
    was.missedVersion > next.missedVersion
  )
}

/**
 * A standing order as the server read it back after a write: into its
 * contact's list, unless the list already holds a newer state (an
 * event's refetch landed first). Not on the list yet: the list is read
 * again, so the new one shows only as the server has it.
 */
export function landStandingOrder(
  qc: QueryClient,
  slug: string,
  view: StandingOrderView,
): StandingOrder {
  const so = standingOrderFromWire(view)
  const list = keys.standingOrders(slug, so.contactId)
  const listed = qc.getQueryData<Array<StandingOrder>>(list)
  if (listed?.some((s) => s.id === so.id))
    qc.setQueryData(
      list,
      listed.map((s) => (s.id === so.id && !newer(s, so) ? so : s)),
    )
  else void qc.invalidateQueries({ queryKey: list })
  return so
}

/**
 * Recording and ending a standing order (staff and admins). Each
 * resolves once the server has committed; throws `RustApiError` when
 * refused (`422 invalid` names its field; `409 stale` on an end someone
 * else saved first, the list read again before the error shows).
 */
export function useStandingOrderWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return {
    record: async (contactId: string, args: StandingOrderArgs) =>
      landStandingOrder(
        qc,
        slug,
        await post<StandingOrderView>(
          tenantPath(slug, 'contacts', contactId, 'standing-orders'),
          {
            ...args,
            amount: toWire(args.amount),
          } satisfies StandingOrderSetUp,
        ),
      ),
    /**
     * "Make this a standing order" (g2q3): a standing order for the
     * line's amount, the line its first payment, in one command against
     * the line's `matchVersion`. Answers the line as the server read it
     * back; the bank pages and the contact's standing orders read again.
     */
    fromLine: async (
      line: { id: string; matchVersion: number },
      args: StandingOrderFromLineArgs,
    ) => {
      try {
        return await post<BankLineDetail>(
          tenantPath(slug, 'bank', 'lines', line.id, 'standing-order'),
          {
            ...args,
            expected: line.matchVersion,
          } satisfies BankStandingOrderFromLine,
        )
      } finally {
        await Promise.all([
          qc.invalidateQueries({ queryKey: keys.bank(slug) }),
          qc.invalidateQueries({ queryKey: keys.standing(slug) }),
        ])
      }
    },
    end: async (so: StandingOrder, reason: string | undefined) => {
      try {
        return landStandingOrder(
          qc,
          slug,
          await post<StandingOrderView>(
            tenantPath(slug, 'standing-orders', so.id, 'end'),
            {
              expected: so.mandateVersion,
              reason,
            } satisfies EndStandingOrder,
          ),
        )
      } catch (err) {
        await qc.invalidateQueries({ queryKey: keys.standing(slug) })
        throw err
      }
    },
  }
}
