/**
 * Card donations on the Rust API (`/api/t/{slug}/stripe…`;
 * server/README.md "Stripe"), through TanStack Query: the group's Stripe
 * connection, its donation page's settings, the card payments nobody
 * could be matched to, and the ones set aside as not donations.
 *
 * **Never optimistic** (rule 4, ADR 0025): a card gift exists only once
 * Stripe said it was paid and the server made it. Every write here waits
 * for the server's answer, and the lists are read again after it; nothing
 * is shown as matched, set aside or saved before then. Pence cross the
 * wire as JSON integers and become `bigint` here (rule 7).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { CardPaymentExpected } from '../rust-types/CardPaymentExpected'
import type { DismissCardPayment } from '../rust-types/DismissCardPayment'
import type { DonationPage as WirePage } from '../rust-types/DonationPage'
import type { DonationPageSaved } from '../rust-types/DonationPageSaved'
import type { Executed } from '../rust-types/Executed'
import type { GiftView as WireGiftView } from '../rust-types/GiftView'
import type { MatchCardPayment } from '../rust-types/MatchCardPayment'
import type { MatchedCardPayment } from '../rust-types/MatchedCardPayment'
import type { SaveDonationPage } from '../rust-types/SaveDonationPage'
import type { StripeConnectStart } from '../rust-types/StripeConnectStart'
import type { StripeStatus } from '../rust-types/StripeStatus'
import type { UnmatchedCardPayment as WireUnmatched } from '../rust-types/UnmatchedCardPayment'
import type { UnmatchedReason } from '../rust-types/UnmatchedReason'
import { RustApiError, get, post, tenantPath } from './client'
import { giftViewFromWire } from './gifts'
import { keys } from './keys'

export type { StripeStatus, UnmatchedReason }

/** A card payment in the queue (or set aside), as its page shows it. */
export type UnmatchedCardPayment = Omit<WireUnmatched, 'amount'> & {
  amount: bigint
}

/** The donation page's settings, amounts in pence. */
export type DonationPage = Omit<WirePage, 'amounts' | 'minimum' | 'maximum'> & {
  amounts: [bigint, bigint, bigint]
  minimum: bigint
  maximum: bigint
}

/** What Settings saves of the page. */
export type DonationPageFields = Pick<
  DonationPage,
  'amounts' | 'minimum' | 'maximum' | 'sourceCodeId'
>

const pence = (n: number): bigint => BigInt(n)

function toWire(amount: bigint): number {
  const n = Number(amount)
  if (!Number.isSafeInteger(n)) throw new RangeError('amount out of range')
  return n
}

export function donationPageFromWire(p: WirePage): DonationPage {
  return {
    ...p,
    amounts: [pence(p.amounts[0]), pence(p.amounts[1]), pence(p.amounts[2])],
    minimum: pence(p.minimum),
    maximum: pence(p.maximum),
  }
}

const cardFromWire = (p: WireUnmatched): UnmatchedCardPayment => ({
  ...p,
  amount: pence(p.amount),
})

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * Whether card donations are on here and the group's Stripe account; any
 * member. Undefined while loading. `poll` reads it again every few
 * seconds until Stripe takes payments (a minute at most): back from
 * Stripe's form, what it decided arrives by webhook, which is no event
 * of the group's.
 */
export function useStripeStatus(poll = false): StripeStatus | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.stripeStatus(slug),
    queryFn: () => get<StripeStatus>(tenantPath(slug, 'stripe')),
    staleTime: 60_000,
    // Until Stripe takes payments, and for a minute at most.
    refetchInterval: (q) =>
      poll &&
      q.state.data?.chargesEnabled !== true &&
      q.state.dataUpdateCount < 20
        ? 3_000
        : false,
  }).data
}

type Read<T> = {
  data: T | undefined
  error: unknown
  refetch: () => Promise<unknown>
}

/** The donation page's settings; any member. */
export function useDonationPage(enabled = true): Read<DonationPage> {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.donationPage(slug),
    enabled,
    retry: false,
    queryFn: async () =>
      donationPageFromWire(
        await get<WirePage>(tenantPath(slug, 'stripe', 'page')),
      ),
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

/** Card payments nobody could be matched to, newest first; any member. */
export function useCardQueue(): Read<Array<UnmatchedCardPayment>> {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.cardQueue(slug),
    retry: false,
    queryFn: async () =>
      (
        await get<Array<WireUnmatched>>(tenantPath(slug, 'stripe', 'unmatched'))
      ).map(cardFromWire),
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

/** Card payments set aside as not donations, newest first; any member. */
export function useCardsSetAside(): Read<Array<UnmatchedCardPayment>> {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.cardsSetAside(slug),
    retry: false,
    queryFn: async () =>
      (
        await get<Array<WireUnmatched>>(tenantPath(slug, 'stripe', 'dismissed'))
      ).map(cardFromWire),
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

// ── writes ─────────────────────────────────────────────────────────────────

/** The group's connection: admin, within the step-up hour. */
export function useStripeAdmin() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const status = keys.stripeStatus(slug)
  return {
    /**
     * Where to send the browser (Stripe's form), or null when Stripe
     * asks for nothing more: the status is then in the cache.
     */
    connect: async () => {
      const done = await post<StripeConnectStart>(
        tenantPath(slug, 'stripe', 'connect'),
      )
      qc.setQueryData(status, done.status)
      return done.url
    },
    disconnect: async () => {
      const done = await post<StripeStatus>(
        tenantPath(slug, 'stripe', 'disconnect'),
      )
      qc.setQueryData(status, done)
      return done
    },
  }
}

/**
 * Save the donation page's settings (admin). What lands in the cache is
 * the page as the server read it back; a stale save reads it again
 * first, so a retry sends the other admin's counter.
 */
export function useSaveDonationPage() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (
    expected: number | null,
    fields: DonationPageFields,
  ): Promise<DonationPage> => {
    try {
      const done = await post<DonationPageSaved>(
        tenantPath(slug, 'stripe', 'page'),
        {
          expected,
          amounts: [
            toWire(fields.amounts[0]),
            toWire(fields.amounts[1]),
            toWire(fields.amounts[2]),
          ],
          minimum: toWire(fields.minimum),
          maximum: toWire(fields.maximum),
          sourceCodeId: fields.sourceCodeId,
        } satisfies SaveDonationPage,
      )
      const page = donationPageFromWire(done.page)
      qc.setQueryData(keys.donationPage(slug), page)
      return page
    } catch (err) {
      if (err instanceof RustApiError && err.error.kind === 'stale')
        await qc.invalidateQueries({ queryKey: keys.donationPage(slug) })
      throw err
    }
  }
}

/**
 * The queue's writes (staff and admins). Each resolves once the server
 * has committed, with both lists read again: matched, set aside or put
 * back by us, or by someone else meanwhile.
 */
export function useCardQueueWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const reread = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.cardQueue(slug) }),
      qc.invalidateQueries({ queryKey: keys.cardsSetAside(slug) }),
    ])
  }
  const then = async <T>(call: Promise<T>): Promise<T> => {
    try {
      return await call
    } finally {
      await reread()
    }
  }
  return {
    /**
     * Whose it is: makes the contact's gift (and the donor's declaration
     * if they ticked Gift Aid). `sourceCodeId` only for a payment that
     * has no page code of its own. The gift as the server made it.
     */
    match: async (
      payment: UnmatchedCardPayment,
      contactId: string,
      sourceCodeId?: string,
    ) => {
      const done = await then(
        post<MatchedCardPayment>(
          tenantPath(slug, 'stripe', 'unmatched', payment.id, 'match'),
          {
            expected: payment.matchVersion,
            contactId,
            ...(sourceCodeId !== undefined && { sourceCodeId }),
          } satisfies MatchCardPayment,
        ),
      )
      void qc.invalidateQueries({ queryKey: keys.gifts(slug) })
      return giftViewFromWire(done.gift)
    },
    /** Not a donation, and why: it leaves the queue, nothing is deleted. */
    setAside: (payment: UnmatchedCardPayment, reason: string) =>
      then(
        post<Executed>(
          tenantPath(slug, 'stripe', 'unmatched', payment.id, 'dismiss'),
          {
            expected: payment.matchVersion,
            reason,
          } satisfies DismissCardPayment,
        ),
      ),
    /** Back in the queue. */
    putBack: (payment: UnmatchedCardPayment) =>
      then(
        post<Executed>(
          tenantPath(slug, 'stripe', 'unmatched', payment.id, 'put-back'),
          { expected: payment.matchVersion } satisfies CardPaymentExpected,
        ),
      ),
  }
}

/**
 * "Name checked" on a card gift whose donor typed another first name:
 * the flag is cleared and the gift as the server read it back lands in
 * the cache. A refusal reads the gift again.
 */
export function useNameChecked(giftId: string) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const view = keys.gift(slug, giftId)
  return async (paymentId: string, expected: number): Promise<void> => {
    try {
      const done = await post<WireGiftView>(
        tenantPath(slug, 'stripe', 'payments', paymentId, 'name-checked'),
        { expected } satisfies CardPaymentExpected,
      )
      await qc.cancelQueries({ queryKey: view, exact: true })
      qc.setQueryData(view, giftViewFromWire(done))
    } catch (err) {
      await qc.invalidateQueries({ queryKey: view, exact: true })
      throw err
    }
  }
}
