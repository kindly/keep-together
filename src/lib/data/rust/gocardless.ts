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
import type { AdoptSubscription } from '../rust-types/AdoptSubscription'
import type { ChangeTerms } from '../rust-types/ChangeTerms'
import type { CodeTerms } from '../rust-types/CodeTerms'
import type { EditTerms } from '../rust-types/EditTerms'
import type { ExpectedGrouping } from '../rust-types/ExpectedGrouping'
import type { ExpectedLine } from '../rust-types/ExpectedLine'
import type { ExpectedReport as WireReport } from '../rust-types/ExpectedReport'
import type { ExpectedRow } from '../rust-types/ExpectedRow'
import type { UnknownSubscription as WireUnknown } from '../rust-types/UnknownSubscription'
import type { UpgradeLine } from '../rust-types/UpgradeLine'
import type { NotRealised as WireNotRealised } from '../rust-types/NotRealised'
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
 * One regular gift's next payments as GoCardless forecasts them (its
 * single read, the one that asks GoCardless): read when a live card
 * shows, kept five minutes, and refetched by no event, so activity
 * elsewhere never costs a GoCardless call per open card. A terms write
 * refetches it (the amounts change). Undefined while loading.
 */
export function useRegularGiftForecast(
  id: string,
  /** The gift's status as listed: a new status reads it afresh. */
  status: string,
  enabled = true,
): Array<Upcoming> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.regularGiftForecast(slug, id, status),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () =>
      regularGiftFromWire(
        await get<RegularGiftView>(tenantPath(slug, 'regular-gifts', id)),
      ).upcoming,
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
 * Whether `was` has seen a change `next` hasn't: a counter of it, or of
 * one of its terms rows, is ahead, or it has a row `next` lacks.
 */
function newer(was: RegularGift, next: RegularGift): boolean {
  if (
    was.setupVersion > next.setupVersion ||
    was.mandateVersion > next.mandateVersion
  )
    return true
  const rows = new Map(next.terms.map((t) => [t.id, t]))
  return was.terms.some((t) => {
    const n = rows.get(t.id)
    return (
      !n ||
      t.termsVersion > n.termsVersion ||
      t.syncVersion > n.syncVersion ||
      t.codeVersion > n.codeVersion
    )
  })
}

/**
 * A regular gift as the server read it back after a write: into its
 * contact's list, replacing what was there, unless the list already
 * holds a newer state (an event's refetch landed first): then that
 * stays. Not on the list yet: the list is read again.
 */
export function landRegularGift(
  qc: QueryClient,
  slug: string,
  view: RegularGiftView,
): RegularGift {
  const gift = regularGiftFromWire(view)
  const list = keys.regularGifts(slug, gift.contactId)
  const listed = qc.getQueryData<Array<RegularGift>>(list)
  if (listed?.some((g) => g.id === gift.id))
    qc.setQueryData(
      list,
      listed.map((g) => (g.id === gift.id && !newer(g, gift) ? gift : g)),
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
  // Someone else's change won: read the regular gifts again before
  // saying so, so a retry sends their counter, event or no event.
  const fresh = async <T>(call: Promise<T>): Promise<T> => {
    try {
      return await call
    } catch (err) {
      if (err instanceof RustApiError && err.error.kind === 'stale')
        await qc.invalidateQueries({ queryKey: keys.regularGiftLists(slug) })
      throw err
    }
  }
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
        await fresh(
          post<RegularGiftSaved>(
            tenantPath(slug, 'regular-gifts', id, 'link'),
            { expected },
          ),
        ),
      ),
    cancel: async (id: string, expected: number) =>
      saved(
        await fresh(
          post<RegularGiftSaved>(
            tenantPath(slug, 'regular-gifts', id, 'cancel'),
            { expected },
          ),
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

// ── regular-gift terms (ADR 0026; regular-gift-terms step 6) ──────────────

export type { ExpectedGrouping }

/** One layer of a split as a form sends it: pence to a code version. */
export type ShareArgs = { key?: string; sourceCodeId: string; amount: bigint }

export type ChangeArgs = Omit<ChangeTerms, 'amount' | 'allocations'> & {
  amount: bigint
  allocations?: Array<ShareArgs>
}

export type EditArgs = Omit<EditTerms, 'amount' | 'allocations'> & {
  amount: bigint
  allocations?: Array<ShareArgs>
}

export type ExpectedPeriodRow = Omit<
  ExpectedRow,
  'expected' | 'split' | 'amount'
> & {
  expected: bigint
  split: Array<{ sourceCodeId: string; amount: bigint }>
  amount: bigint | null
}

export type ReportLine = Omit<
  ExpectedLine,
  'expected' | 'received' | 'failed' | 'missing' | 'pending'
> & {
  expected: bigint
  received: bigint
  failed: bigint
  missing: bigint
  pending: bigint
}

export type ReportUpgrade = Omit<
  UpgradeLine,
  'upgrades' | 'downgrades' | 'annual' | 'monthly'
> & { upgrades: number; downgrades: number; annual: bigint; monthly: bigint }

export type NotRealised = Omit<WireNotRealised, 'annual' | 'monthly'> & {
  annual: bigint
  monthly: bigint | null
}

export type ExpectedReport = Omit<
  WireReport,
  'lines' | 'total' | 'upgrades' | 'notRealised'
> & {
  lines: Array<ReportLine>
  total: ReportLine
  upgrades: Array<ReportUpgrade>
  notRealised: Array<NotRealised>
}

export type UnknownSubscription = Omit<WireUnknown, 'lastAmount'> & {
  lastAmount: bigint
}

const lineFromWire = (l: ExpectedLine): ReportLine => ({
  ...l,
  expected: pence(l.expected),
  received: pence(l.received),
  failed: pence(l.failed),
  missing: pence(l.missing),
  pending: pence(l.pending),
})

export const reportFromWire = (r: WireReport): ExpectedReport => ({
  ...r,
  lines: r.lines.map(lineFromWire),
  total: lineFromWire(r.total),
  upgrades: r.upgrades.map((u) => ({
    ...u,
    annual: pence(u.annual),
    monthly: pence(u.monthly),
  })),
  notRealised: r.notRealised.map((n) => ({
    ...n,
    annual: pence(n.annual),
    monthly: n.monthly === null ? null : pence(n.monthly),
  })),
})

const sharesToWire = (shares: Array<ShareArgs> | undefined) =>
  shares?.map((a) => ({ ...a, amount: toWire(a.amount) }))

/**
 * A regular gift's last 12 periods (to this month) of expected against
 * what happened; undefined while loading.
 */
export function useExpectedPeriods(
  id: string,
  enabled = true,
): Array<ExpectedPeriodRow> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.expected(slug, id),
    enabled,
    queryFn: async () =>
      (
        await get<Array<ExpectedRow>>(
          tenantPath(slug, 'regular-gifts', id, 'expected'),
        )
      ).map((r) => ({
        ...r,
        expected: pence(r.expected),
        split: r.split.map((s) => ({ ...s, amount: pence(s.amount) })),
        amount: r.amount === null ? null : pence(r.amount),
      })),
  }).data
}

/** The expected vs actual and upgrades report over months `from`–`to`. */
export function useExpectedReport(
  from: string,
  to: string,
  by: ExpectedGrouping,
): {
  data: ExpectedReport | undefined
  error: unknown
  refetch: () => Promise<unknown>
} {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.expectedReport(slug, { from, to, by }),
    retry: false,
    queryFn: async () =>
      reportFromWire(
        await get<WireReport>(
          tenantPath(slug, 'reports', 'expected'),
          new URLSearchParams({ from, to, by }),
        ),
      ),
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

/** Subscriptions nobody here set up, on mandates we know; any member. */
export function useUnknownSubscriptions():
  Array<UnknownSubscription> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.unknownSubscriptions(slug),
    queryFn: async () =>
      (
        await get<Array<WireUnknown>>(
          tenantPath(slug, 'gocardless', 'unknown-subscriptions'),
        )
      ).map((u) => ({ ...u, lastAmount: pence(u.lastAmount) })),
  }).data
}

/**
 * A regular gift's terms: a change from a date, editing or withdrawing
 * one still scheduled, crediting one to a code; and adopting a
 * subscription set up elsewhere. Each resolves with the regular gift as
 * the server read it back; throws `RustApiError` when refused (`stale`:
 * someone else's change won, and the gift is read again).
 */
export function useTermsWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const write = async (
    id: string,
    path: Array<string>,
    body: unknown,
    /** The amounts may change: read the forecast (a GoCardless call) again. */
    forecast = true,
  ) => {
    try {
      const done = await post<RegularGiftSaved>(
        tenantPath(slug, 'regular-gifts', id, ...path),
        body,
      )
      // The expected periods and GoCardless's forecast follow the chain.
      void qc.invalidateQueries({ queryKey: keys.expected(slug, id) })
      if (forecast)
        void qc.invalidateQueries({
          queryKey: keys.regularGiftForecast(slug, id),
        })
      return landRegularGift(qc, slug, done.view)
    } catch (err) {
      // Someone else's change won: read the chain again before saying so.
      if (err instanceof RustApiError && err.error.kind === 'stale')
        await qc.invalidateQueries({ queryKey: keys.regularGiftLists(slug) })
      throw err
    }
  }
  return {
    change: (id: string, { amount, allocations, ...rest }: ChangeArgs) =>
      write(id, ['terms'], {
        ...rest,
        amount: toWire(amount),
        allocations: sharesToWire(allocations),
      } satisfies ChangeTerms),
    edit: (
      id: string,
      termId: string,
      { amount, allocations, ...rest }: EditArgs,
    ) =>
      write(id, ['terms', termId], {
        ...rest,
        amount: toWire(amount),
        allocations: sharesToWire(allocations),
      } satisfies EditTerms),
    withdraw: (id: string, termId: string, expected: number) =>
      write(id, ['terms', termId, 'withdraw'], { expected }),
    code: (
      id: string,
      termId: string,
      expected: number,
      changeCodeId: string | null,
    ) =>
      write(
        id,
        ['terms', termId, 'code'],
        {
          expected,
          changeCodeId,
        } satisfies CodeTerms,
        // A code changes no amount: no GoCardless call for the forecast.
        false,
      ),
    adopt: async (subscriptionId: string, args: AdoptSubscription) => {
      try {
        const done = await post<RegularGiftSaved>(
          tenantPath(
            slug,
            'gocardless',
            'unknown-subscriptions',
            subscriptionId,
            'adopt',
          ),
          args,
        )
        return landRegularGift(qc, slug, done.view)
      } finally {
        await qc.invalidateQueries({
          queryKey: keys.unknownSubscriptions(slug),
        })
      }
    },
  }
}
