/**
 * Direct Debit on the Rust API (`/api/t/{slug}/gocardless…`,
 * `…/regular-gifts…`, `…/contacts/{id}/instant-payment`; server/README.md
 * "GoCardless"), through TanStack Query: the group's connection, a
 * contact's regular gifts and their payments, one-off payments, and the
 * payments nobody could be matched to.
 *
 * **Never optimistic** (rule 4, ADR 0025): every write waits for the
 * server's answer, and what lands in the cache is the regular gift the
 * server read back in the same transaction; money is only ever what
 * GoCardless said. Each committed change comes back as an event
 * (events.ts), which refetches everything under `keys.gocardless`. Pence
 * cross the wire as JSON integers and become `bigint` here (rule 7).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { ConnectStart } from '../rust-types/ConnectStart'
import type { DirectDebitPaymentRow } from '../rust-types/DirectDebitPaymentRow'
import type { GoCardlessStatus } from '../rust-types/GoCardlessStatus'
import type { InstantPayment } from '../rust-types/InstantPayment'
import type { InstantPaymentLink } from '../rust-types/InstantPaymentLink'
import type { MatchedPayment } from '../rust-types/MatchedPayment'
import type { OneOffStarted } from '../rust-types/OneOffStarted'
import type { RegularGiftFrequency } from '../rust-types/RegularGiftFrequency'
import type { RegularGiftSaved } from '../rust-types/RegularGiftSaved'
import type { RegularGiftView } from '../rust-types/RegularGiftView'
import type { SetUpRegularGift } from '../rust-types/SetUpRegularGift'
import type { TakeOneOff } from '../rust-types/TakeOneOff'
import type { TermAllocationView } from '../rust-types/TermAllocationView'
import type { TermView } from '../rust-types/TermView'
import type { UnmatchedPayment as WireUnmatched } from '../rust-types/UnmatchedPayment'
import type { UpcomingPayment } from '../rust-types/UpcomingPayment'
import { RustApiError, get, post, tenantPath } from './client'
import { keys } from './keys'

// ── shapes ─────────────────────────────────────────────────────────────────

export type { GoCardlessStatus, RegularGiftFrequency }

export type TermShareView = Omit<TermAllocationView, 'amount'> & {
  amount: bigint
}

export type Term = Omit<TermView, 'amount' | 'allocations'> & {
  amount: bigint
  allocations: Array<TermShareView>
}

export type Upcoming = Omit<UpcomingPayment, 'amount'> & { amount: bigint }

export type DirectDebitPayment = Omit<DirectDebitPaymentRow, 'amount'> & {
  amount: bigint
}

export type RegularGift = Omit<
  RegularGiftView,
  | 'amount'
  | 'allocations'
  | 'terms'
  | 'scheduled'
  | 'upcoming'
  | 'lastFailure'
  | 'payments'
> & {
  amount: bigint
  allocations: Array<TermShareView>
  terms: Array<Term>
  scheduled: Term | null
  upcoming: Array<Upcoming>
  lastFailure: DirectDebitPayment | null
  payments: Array<DirectDebitPayment>
}

export type UnmatchedPayment = Omit<WireUnmatched, 'amount'> & {
  amount: bigint
}

export type SetUpArgs = Omit<SetUpRegularGift, 'amount'> & { amount: bigint }
export type OneOffArgs = Omit<TakeOneOff, 'amount'> & { amount: bigint }
export type InstantPaymentArgs = Omit<InstantPayment, 'amount'> & {
  amount: bigint
}
export type { InstantPaymentLink, OneOffStarted }

// ── wire → page ────────────────────────────────────────────────────────────

const pence = (n: number): bigint => BigInt(n)

/** Pence to the wire, refusing what JSON can't carry exactly. */
export function toWire(amount: bigint): number {
  const n = Number(amount)
  if (!Number.isSafeInteger(n)) throw new RangeError('amount out of range')
  return n
}

const shareFromWire = (a: TermAllocationView): TermShareView => ({
  ...a,
  amount: pence(a.amount),
})

export const termFromWire = (t: TermView): Term => ({
  ...t,
  amount: pence(t.amount),
  allocations: t.allocations.map(shareFromWire),
})

const paymentFromWire = (p: DirectDebitPaymentRow): DirectDebitPayment => ({
  ...p,
  amount: pence(p.amount),
})

export const regularGiftFromWire = (v: RegularGiftView): RegularGift => ({
  ...v,
  amount: pence(v.amount),
  allocations: v.allocations.map(shareFromWire),
  terms: v.terms.map(termFromWire),
  scheduled: v.scheduled === null ? null : termFromWire(v.scheduled),
  upcoming: v.upcoming.map((u) => ({ ...u, amount: pence(u.amount) })),
  lastFailure: v.lastFailure === null ? null : paymentFromWire(v.lastFailure),
  payments: v.payments.map(paymentFromWire),
})

const isNotFound = (err: unknown) =>
  err instanceof RustApiError && err.status === 404

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * Whether Direct Debit is on here and the group's connection; any
 * member. Undefined while loading.
 */
export function useGoCardlessStatus(): GoCardlessStatus | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.gocardlessStatus(slug),
    queryFn: () => get<GoCardlessStatus>(tenantPath(slug, 'gocardless')),
    staleTime: 60_000,
  }).data
}

/** A contact's regular gifts, newest first; undefined while loading. */
export function useRegularGifts(
  contactId: string,
  enabled = true,
): Array<RegularGift> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.regularGifts(slug, contactId),
    enabled,
    queryFn: async () =>
      (
        await get<Array<RegularGiftView>>(
          tenantPath(slug, 'contacts', contactId, 'regular-gifts'),
        )
      ).map(regularGiftFromWire),
  }).data
}

/**
 * One regular gift with GoCardless's next payments (only this read asks
 * GoCardless for them); null for an unknown id, undefined while loading.
 */
export function useRegularGift(
  id: string,
  enabled = true,
): RegularGift | null | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.regularGift(slug, id),
    enabled,
    queryFn: async () => {
      try {
        return regularGiftFromWire(
          await get<RegularGiftView>(tenantPath(slug, 'regular-gifts', id)),
        )
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
  }).data
}

/** Payments nobody could be matched to, newest first; any member. */
export function useUnmatchedPayments(): {
  data: Array<UnmatchedPayment> | undefined
  error: unknown
  refetch: () => Promise<unknown>
} {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.unmatched(slug),
    retry: false,
    queryFn: async () =>
      (
        await get<Array<WireUnmatched>>(
          tenantPath(slug, 'gocardless', 'unmatched'),
        )
      ).map((p) => ({ ...p, amount: pence(p.amount) })),
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

// ── writes ─────────────────────────────────────────────────────────────────

/**
 * A regular gift as the server read it back after a write: into its own
 * read and its contact's list, replacing what was there (never an answer
 * older than what is shown: the event refetch follows).
 */
export function landRegularGift(
  qc: QueryClient,
  slug: string,
  view: RegularGiftView,
): RegularGift {
  const gift = regularGiftFromWire(view)
  qc.setQueryData(keys.regularGift(slug, gift.id), (was?: RegularGift | null) =>
    // The single read has GoCardless's forecast; a write's answer may not.
    was && gift.upcoming.length === 0
      ? { ...gift, upcoming: was.upcoming }
      : gift,
  )
  const list = keys.regularGifts(slug, gift.contactId)
  const listed = qc.getQueryData<Array<RegularGift>>(list)
  if (listed?.some((g) => g.id === gift.id))
    qc.setQueryData(
      list,
      listed.map((g) => (g.id === gift.id ? gift : g)),
    )
  else void qc.invalidateQueries({ queryKey: list })
  return gift
}

/** The group's connection: admin, within the step-up hour. */
export function useGoCardlessAdmin() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const status = keys.gocardlessStatus(slug)
  return {
    /** Where to send the browser: GoCardless's consent page. */
    connect: async () =>
      (await post<ConnectStart>(tenantPath(slug, 'gocardless', 'connect'))).url,
    disconnect: async () => {
      const done = await post<GoCardlessStatus>(
        tenantPath(slug, 'gocardless', 'disconnect'),
      )
      qc.setQueryData(status, done)
      return done
    },
    retryEvents: async () => {
      const done = await post<GoCardlessStatus>(
        tenantPath(slug, 'gocardless', 'events', 'retry'),
      )
      qc.setQueryData(status, done)
      return done
    },
  }
}

/**
 * Setting up, re-linking and cancelling a regular gift, and taking one
 * payment (on its mandate, or by Instant Bank Pay). Each resolves once
 * the server has committed (and GoCardless answered); throws
 * `RustApiError` when refused.
 */
export function useDirectDebitWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const saved = (done: RegularGiftSaved) => landRegularGift(qc, slug, done.view)
  return {
    setUp: async (contactId: string, args: SetUpArgs) =>
      saved(
        await post<RegularGiftSaved>(
          tenantPath(slug, 'contacts', contactId, 'regular-gifts'),
          { ...args, amount: toWire(args.amount) } satisfies SetUpRegularGift,
        ),
      ),
    newLink: async (id: string, expected: number) =>
      saved(
        await post<RegularGiftSaved>(
          tenantPath(slug, 'regular-gifts', id, 'link'),
          { expected },
        ),
      ),
    cancel: async (id: string, expected: number) =>
      saved(
        await post<RegularGiftSaved>(
          tenantPath(slug, 'regular-gifts', id, 'cancel'),
          { expected },
        ),
      ),
    /** The gift follows from GoCardless's events (pending at first). */
    oneOff: (id: string, args: OneOffArgs) =>
      post<OneOffStarted>(tenantPath(slug, 'regular-gifts', id, 'one-off'), {
        ...args,
        amount: toWire(args.amount),
      } satisfies TakeOneOff),
    instantPayment: (contactId: string, args: InstantPaymentArgs) =>
      post<InstantPaymentLink>(
        tenantPath(slug, 'contacts', contactId, 'instant-payment'),
        { ...args, amount: toWire(args.amount) } satisfies InstantPayment,
      ),
  }
}

/** Match an unmatched payment to a contact: resolves with its gift's id. */
export function useMatchPayment() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (
    payment: UnmatchedPayment,
    contactId: string,
    sourceCodeId: string,
  ): Promise<string> => {
    try {
      const done = await post<MatchedPayment>(
        tenantPath(slug, 'gocardless', 'unmatched', payment.id, 'match'),
        { expected: payment.version, contactId, sourceCodeId },
      )
      return done.giftId
    } finally {
      // Matched, or matched by someone else meanwhile: read the list again.
      await qc.invalidateQueries({ queryKey: keys.unmatched(slug) })
      void qc.invalidateQueries({ queryKey: keys.gifts(slug) })
    }
  }
}
