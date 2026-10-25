/**
 * Gifts and Gift Aid on the Rust API (`/api/t/{slug}/gifts…`,
 * `…/giftaid…`), through TanStack Query: my recent gifts, a gift, a
 * contact's gifts, the record-gift page's donor, the
 * Gift Aid panel, and their writes.
 *
 * **Never optimistic** (gifts are financial records, human 2026-10-23):
 * every write waits for the server's answer, and what lands in the cache
 * is the server's state, never what the form sent. Reads refetch when the
 * tenant's event stream names a gift or a declaration (`../events.ts`).
 *
 * The answers come back in the shapes the pages rendered from Convex
 * (`_id`, amounts as `bigint` pence, absent fields `undefined`), so the
 * pages' formatting, rules and tests are unchanged. Pence cross the wire
 * as JSON integers (rule 7: never pounds, never a float); `bigint` ↔
 * `number` happens only here.
 */
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Id } from '../../../../convex/_generated/dataModel'
import { useTenant } from '../../tenant'
import { ownWrite } from '../events'
import type { AllocationView } from '../rust-types/AllocationView'
import type { Cancelled } from '../rust-types/Cancelled'
import type { DeclarationDetails } from '../rust-types/DeclarationDetails'
import type { DeclarationDetailsHistory } from '../rust-types/DeclarationDetailsHistory'
import type { DeclarationRow } from '../rust-types/DeclarationRow'
import type { DeclarationSummary } from '../rust-types/DeclarationSummary'
import type { Declarations as WireDeclarations } from '../rust-types/Declarations'
import type { DonorView } from '../rust-types/DonorView'
import type { Executed } from '../rust-types/Executed'
import type { GiftPage } from '../rust-types/GiftPage'
import type { GiftRow } from '../rust-types/GiftRow'
import type { GiftSaved } from '../rust-types/GiftSaved'
import type { GiftView as WireGiftView } from '../rust-types/GiftView'
import type { RecentGift as WireRecent } from '../rust-types/RecentGift'
import type { RecordGift } from '../rust-types/RecordGift'
import type { RecordedGift } from '../rust-types/RecordedGift'
import type { SourceCodeDescription } from './sources'
import { RustApiError, get, post, tenantPath } from './client'
import { keys } from './keys'

type GiftId = Id<'contributions'>
type DeclarationId = Id<'giftAidDeclarations'>

// ── shapes ─────────────────────────────────────────────────────────────────

export type GiftMethod = GiftRow['method']
export type GiftStatus = GiftRow['status']

export type Allocation = Omit<
  AllocationView,
  'amount' | 'sourceCodeId' | 'startDate' | 'endDate'
> & {
  sourceCodeId: Id<'sourceCodes'>
  amount: bigint
  startDate?: string
  endDate?: string
}

/** A gift as a page shows it. */
export type Gift = Omit<
  GiftRow,
  'id' | 'contactId' | 'amount' | 'allocations' | 'reference' | 'enteredAt'
> & {
  _id: GiftId
  /** When it was entered (ms since the epoch). */
  _creationTime: number
  contactId: Id<'contacts'>
  amount: bigint
  reference?: string
  allocations: Array<Allocation>
}

/** One gift for its page: the gift, its donor's name and kind. */
export type GiftView = Gift & {
  contact: {
    _id: Id<'contacts'>
    displayName: string
    kind: NonNullable<WireGiftView['contact']>['kind']
  } | null
}

/** One row of "my recent gifts". */
export type RecentGift = Omit<
  WireRecent,
  'id' | 'enteredAt' | 'contactId' | 'amount'
> & {
  _id: GiftId
  _creationTime: number
  contactId: Id<'contacts'>
  amount: bigint
}

/** What the record-gift page knows about a picked contact. */
export type DonorInfo = Omit<DonorView, 'id' | 'acquisition'> & {
  id: Id<'contacts'>
  acquisition: SourceCodeDescription | null
}

/** A declaration as the Gift Aid panel and the coverage rules read it. */
export type Declaration = Omit<
  DeclarationRow,
  | 'id'
  | 'contactId'
  | 'contributionId'
  | 'cancelledFrom'
  | 'cancellationNote'
  | 'voidReason'
  | 'voidedAt'
  | 'voidedBy'
  | 'enteredBy'
> & {
  _id: DeclarationId
  contactId: Id<'contacts'>
  contributionId?: GiftId
  cancelledFrom?: string
  cancellationNote?: string
  voidReason?: string
  voidedAt?: number
  voidedBy?: number
  enteredBy?: number
}

export type ContactDeclarations = {
  declarations: Array<Declaration>
  currentId: DeclarationId | null
}

export type {
  DeclarationDetails,
  DeclarationDetailsHistory,
  DeclarationSummary,
}

/** The record-gift page's one save, amounts in pence as `bigint`. */
export type RecordGiftArgs = Omit<RecordGift, 'amount' | 'allocations'> & {
  amount: bigint
  allocations: Array<{ sourceCodeId: Id<'sourceCodes'>; amount: bigint }>
}

/** A gift's fields as the edit form saves them. */
export type GiftFields = {
  contactId: Id<'contacts'>
  receivedOn: string
  amount: bigint
  method: GiftMethod
  reference?: string
  allocations: Array<{
    key?: string
    sourceCodeId: Id<'sourceCodes'>
    amount: bigint
  }>
}

// ── wire → page ────────────────────────────────────────────────────────────

const orUndefined = <T>(v: T | null | undefined): T | undefined =>
  v === null ? undefined : v

/** Pence from the wire: always a JSON integer. */
const pence = (n: number): bigint => BigInt(n)

/** Pence to the wire, refusing what JSON can't carry exactly. */
function toWire(amount: bigint): number {
  const n = Number(amount)
  if (!Number.isSafeInteger(n)) throw new RangeError('amount out of range')
  return n
}

export function giftFromWire(g: GiftRow): Gift {
  const { id, enteredAt, contactId, amount, allocations, reference, ...rest } =
    g
  return {
    ...rest,
    _id: id as GiftId,
    _creationTime: enteredAt,
    contactId: contactId as Id<'contacts'>,
    amount: pence(amount),
    ...(reference !== null && { reference }),
    allocations: allocations.map((a) => ({
      ...a,
      sourceCodeId: a.sourceCodeId as Id<'sourceCodes'>,
      amount: pence(a.amount),
      startDate: orUndefined(a.startDate),
      endDate: orUndefined(a.endDate),
    })),
  }
}

export function giftViewFromWire(v: WireGiftView): GiftView {
  const { contact, ...gift } = v
  return {
    ...giftFromWire(gift),
    contact: contact && {
      _id: contact.id as Id<'contacts'>,
      displayName: contact.displayName,
      kind: contact.kind,
    },
  }
}

function recentFromWire(r: WireRecent): RecentGift {
  const { id, enteredAt, contactId, amount, ...rest } = r
  return {
    ...rest,
    _id: id as GiftId,
    _creationTime: enteredAt,
    contactId: contactId as Id<'contacts'>,
    amount: pence(amount),
  }
}

export function declarationFromWire(d: DeclarationRow): Declaration {
  const {
    id,
    contactId,
    contributionId,
    cancelledFrom,
    cancellationNote,
    voidReason,
    voidedAt,
    voidedBy,
    enteredBy,
    ...rest
  } = d
  return {
    ...rest,
    _id: id as DeclarationId,
    contactId: contactId as Id<'contacts'>,
    contributionId: orUndefined(contributionId) as GiftId | undefined,
    cancelledFrom: orUndefined(cancelledFrom),
    cancellationNote: orUndefined(cancellationNote),
    voidReason: orUndefined(voidReason),
    voidedAt: orUndefined(voidedAt),
    voidedBy: orUndefined(voidedBy),
    enteredBy: orUndefined(enteredBy),
  }
}

function declarationsFromWire(d: WireDeclarations): ContactDeclarations {
  return {
    declarations: d.declarations.map(declarationFromWire),
    currentId: d.currentId as DeclarationId | null,
  }
}

function donorFromWire(d: DonorView): DonorInfo {
  return {
    ...d,
    id: d.id as Id<'contacts'>,
    acquisition: d.acquisition as SourceCodeDescription | null,
  }
}

function fieldsToWire(f: GiftFields) {
  return {
    ...f,
    amount: toWire(f.amount),
    allocations: f.allocations.map((a) => ({ ...a, amount: toWire(a.amount) })),
  }
}

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * The caller's last 10 gifts in this group, newest entered first;
 * undefined while loading or when `enabled` is false.
 */
export function useMyRecentGifts(
  enabled = true,
): Array<RecentGift> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.recentGifts(slug),
    enabled,
    queryFn: async () =>
      (await get<Array<WireRecent>>(tenantPath(slug, 'gifts', 'recent'))).map(
        recentFromWire,
      ),
  }).data
}

function giftQuery(slug: string, id: string) {
  return {
    queryKey: keys.gift(slug, id),
    queryFn: async (): Promise<GiftView | null> => {
      try {
        return giftViewFromWire(
          await get<WireGiftView>(tenantPath(slug, 'gifts', id)),
        )
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
  }
}

const isNotFound = (err: unknown) =>
  typeof err === 'object' &&
  err !== null &&
  'status' in err &&
  (err as { status: number }).status === 404

/** One gift for its page; null for an unknown id, undefined while loading. */
export function useGift(id: string): GiftView | null | undefined {
  const { slug } = useTenant()
  return useQuery(giftQuery(slug, id)).data
}

/** One gift read once (the record page's "Already saved" read-back). */
export function fetchGift(
  qc: QueryClient,
  slug: string,
  id: string,
): Promise<GiftView | null> {
  return qc.fetchQuery(giftQuery(slug, id))
}

/** Gifts a page of the contact's panel asks for (the API caps it at 50). */
export const GIFTS_PAGE_SIZE = 20

/**
 * A contact's gifts, newest date first, a page at a time: `rows` (all
 * pages loaded so far), `status` and `loadMore`, like the contacts list.
 */
export function useContactGifts(contactId: string): {
  rows: Array<Gift> | undefined
  status: 'loading' | 'more' | 'done'
  loadMore: () => void
} {
  const { slug } = useTenant()
  const list = useInfiniteQuery({
    queryKey: keys.contactGifts(slug, contactId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(GIFTS_PAGE_SIZE) })
      if (pageParam) q.set('cursor', pageParam)
      return get<GiftPage>(tenantPath(slug, 'contacts', contactId, 'gifts'), q)
    },
    getNextPageParam: (page) => (page.isDone ? null : page.nextCursor),
  })
  const rows = useMemo(
    () => list.data?.pages.flatMap((p) => p.rows.map(giftFromWire)),
    [list.data],
  )
  return {
    rows,
    status:
      list.isFetchingNextPage || rows === undefined
        ? 'loading'
        : list.hasNextPage
          ? 'more'
          : 'done',
    loadMore: () => void list.fetchNextPage(),
  }
}

/**
 * The record-gift page's donor, judged on the gift's `date`; null for an
 * unknown contact, undefined while loading or with no contact.
 */
export function useDonor(
  contactId: string | null,
  date: string,
): DonorInfo | null | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.donor(slug, contactId ?? '', date),
    enabled: contactId !== null,
    queryFn: async (): Promise<DonorInfo | null> => {
      try {
        return donorFromWire(
          await get<DonorView>(
            tenantPath(slug, 'contacts', contactId!, 'donor'),
            new URLSearchParams({ date }),
          ),
        )
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
  }).data
}

/**
 * A contact's Gift Aid declarations as of `today`, newest first, and
 * which is current; undefined while loading or with no contact. One
 * query however many parts of a page ask.
 */
export function useDeclarations(
  contactId: string | undefined,
  today: string,
): ContactDeclarations | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.declarations(slug, contactId ?? '', today),
    enabled: contactId !== undefined,
    queryFn: async () =>
      declarationsFromWire(
        await get<WireDeclarations>(
          tenantPath(slug, 'contacts', contactId!, 'giftaid'),
          new URLSearchParams({ today }),
        ),
      ),
  }).data
}

/**
 * A declaration's details history (who changed its name and address
 * snapshot, when, old → new), newest first; undefined while loading or
 * when not `enabled`. A declaration's events refetch it.
 */
export function useDeclarationHistory(
  id: string,
  enabled: boolean,
): DeclarationDetailsHistory | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.declarationHistory(slug, id),
    enabled,
    queryFn: () =>
      get<DeclarationDetailsHistory>(
        tenantPath(slug, 'giftaid', id, 'history'),
      ),
  }).data
}

/**
 * The contact's name and home address as a declaration made now would
 * snapshot them (the record-gift tick's), read fresh: "Edit details"
 * fills its form from it.
 */
export async function fetchContactSnapshot(
  slug: string,
  contactId: string,
  today: string,
): Promise<DeclarationDetails> {
  const donor = await get<DonorView>(
    tenantPath(slug, 'contacts', contactId, 'donor'),
    new URLSearchParams({ date: today }),
  )
  return {
    firstName: donor.firstName,
    lastName: donor.lastName,
    addressLine1: donor.home.line1,
    postcode: donor.home.postcode,
  }
}

// ── writes ─────────────────────────────────────────────────────────────────

/** The gift's own view (not its history): a write's answer replaces it. */
const isGiftView = (key: ReadonlyArray<unknown>, id: string) =>
  key.length === 5 && key[3] === 'one' && key[4] === id

/** Every read showing gifts: the gift pages, panels, recent and the donor. */
export function giftsChanged(qc: QueryClient, slug: string) {
  return qc.invalidateQueries({ queryKey: keys.gifts(slug) })
}

/**
 * The record-gift page's one save. Resolves with the ids once the server
 * has committed; throws `RustApiError` when refused (`409 duplicate`
 * carries the gift a repeat already saved).
 */
export function useRecordGift() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (args: RecordGiftArgs): Promise<RecordedGift> => {
    const body: RecordGift = {
      ...args,
      amount: toWire(args.amount),
      allocations: args.allocations.map((a) => ({
        ...a,
        amount: toWire(a.amount),
      })),
    }
    try {
      return await post<RecordedGift>(tenantPath(slug, 'gifts', 'record'), body)
    } finally {
      // A new contact, an acquisition fill, a declaration: refetch them.
      void giftsChanged(qc, slug)
      void qc.invalidateQueries({ queryKey: keys.contacts(slug) })
      void qc.invalidateQueries({ queryKey: keys.declarations(slug) })
      void qc.invalidateQueries({ queryKey: keys.sources(slug) })
    }
  }
}

/**
 * Correct, void or un-void a gift. Each resolves once the server has
 * committed, with the gift as it now is, which lands in the gift's query
 * (never what was sent, nor an answer older than what is shown); throws `RustApiError` when refused (`stale`
 * carries the slice as it is now).
 */
export function useGiftWrites(id: string) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const view = keys.gift(slug, id)
  const write = async (contract: string, path: string, body: unknown) => {
    let done: GiftSaved
    try {
      done = await post<GiftSaved>(tenantPath(slug, 'gifts', id, path), body)
    } catch (err) {
      // Someone else's change won: read the gift as the server has it now,
      // so the form merges it and retries from its counter, whether or not
      // their event reaches this tab.
      if (err instanceof RustApiError && err.error.kind === 'stale')
        void qc.invalidateQueries({ queryKey: view, exact: true })
      throw err
    }
    ownWrite(slug, done.id, contract, done.counter)
    // A refetch begun before our commit would land the older view on top.
    // One begun after it (an event's, reading a later commit) is lost
    // when cancelled: it is run again once the answer is in.
    const inFlight = qc.isFetching({ queryKey: view, exact: true }) > 0
    await qc.cancelQueries({ queryKey: view, exact: true })
    // So would this answer, if it was delayed past a later commit that a
    // refetch has already shown: install it only if neither slice is
    // behind what is cached, else read the gift again. Never the older
    // financial state, not even for a moment.
    const cached = qc.getQueryData<GiftView>(view)
    if (
      cached &&
      (cached.giftVersion > done.view.giftVersion ||
        cached.statusVersion > done.view.statusVersion)
    )
      void qc.invalidateQueries({ queryKey: view, exact: true })
    else {
      qc.setQueryData(view, giftViewFromWire(done.view))
      if (inFlight) void qc.invalidateQueries({ queryKey: view, exact: true })
    }
    // The panels, the recent list, the history, the donor's coverage.
    void qc.invalidateQueries({
      queryKey: keys.gifts(slug),
      predicate: (q) => !isGiftView(q.queryKey, id),
    })
    return { id: done.id as GiftId, counter: done.counter }
  }
  return {
    save: (expected: number, fields: GiftFields) =>
      write('giving.gift', 'save', { ...fieldsToWire(fields), expected }),
    setStatus: (expected: number, status: GiftStatus) =>
      write('giving.status', 'status', { expected, status }),
  }
}

/**
 * The Gift Aid panel's writes: cancel every declaration open at a date,
 * mark one made in error, or change one's name and address snapshot
 * (`expected`: its `detailsVersion`; `stale` carries the snapshot now).
 * Each resolves once committed and the panel has been refetched: never
 * optimistic.
 */
export function useGiftAidWrites(contactId: string) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const after = async <T>(write: Promise<T>): Promise<T> => {
    try {
      return await write
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.declarations(slug) }),
        giftsChanged(qc, slug),
      ])
    }
  }
  return {
    cancel: (cancelledFrom: string, note?: string) =>
      after(
        post<Cancelled>(
          tenantPath(slug, 'contacts', contactId, 'giftaid', 'cancel'),
          { cancelledFrom, ...(note !== undefined && { note }) },
        ),
      ),
    voidDeclaration: (id: string, reason: string) =>
      after(
        post<Executed>(tenantPath(slug, 'giftaid', id, 'void'), { reason }),
      ),
    saveDetails: (id: string, expected: number, details: DeclarationDetails) =>
      after(
        post<Executed>(tenantPath(slug, 'giftaid', id, 'details'), {
          ...details,
          expected,
        }),
      ),
  }
}
