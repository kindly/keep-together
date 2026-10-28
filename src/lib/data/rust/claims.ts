/**
 * Gift Aid claims on the Rust API (`/api/t/{slug}/giftaid/claims…`,
 * `…/giftaid/hmrc-details`), through TanStack Query: the claims list,
 * the preview of a new claim, one claim, its status steps and
 * downloads, and the charity's HMRC details. Every route is admin only
 * and needs a sign-in within the hour (`step_up_required`), reads
 * included: the pages show a step-up and refetch.
 *
 * **Never optimistic** (rule 4: a claim is a financial record): every
 * write waits for the server's answer, and what lands in the cache is
 * the claim the server read back in the same transaction. Pence cross
 * the wire as JSON integers and become `bigint` here (rule 7), as in
 * `gifts.ts`.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { Executed } from '../rust-types/Executed'
import type { GiftAidClaimAdjustment } from '../rust-types/GiftAidClaimAdjustment'
import type { GiftAidClaimLine } from '../rust-types/GiftAidClaimLine'
import type { GiftAidClaimPreview } from '../rust-types/GiftAidClaimPreview'
import type { GiftAidClaimSaved } from '../rust-types/GiftAidClaimSaved'
import type { GiftAidClaimSummary } from '../rust-types/GiftAidClaimSummary'
import type { GiftAidClaimTotals } from '../rust-types/GiftAidClaimTotals'
import type { GiftAidClaimView } from '../rust-types/GiftAidClaimView'
import type { GiftAidClaims } from '../rust-types/GiftAidClaims'
import type { GiftAidClaimsCreated } from '../rust-types/GiftAidClaimsCreated'
import type { GiftAidExcludedGift } from '../rust-types/GiftAidExcludedGift'
import type { HmrcDetails } from '../rust-types/HmrcDetails'
import type { HmrcDetailsView } from '../rust-types/HmrcDetailsView'
import type { SetGiftAidClaimStatus } from '../rust-types/SetGiftAidClaimStatus'
import { RustApiError, apiUrl, get, post, tenantPath } from './client'
import { keys } from './keys'

// ── shapes ─────────────────────────────────────────────────────────────────

export type ClaimStatus = GiftAidClaimSummary['status']
export type { HmrcDetails, HmrcDetailsView }

export type ClaimTotals = Omit<
  GiftAidClaimTotals,
  'donations' | 'reclaim' | 'adjustment' | 'net'
> & { donations: bigint; reclaim: bigint; adjustment: bigint; net: bigint }

export type ClaimLine = Omit<GiftAidClaimLine, 'amount' | 'reclaim'> & {
  amount: bigint
  reclaim: bigint
}

export type ClaimAdjustment = Omit<GiftAidClaimAdjustment, 'amount'> & {
  amount: bigint
}

export type ExcludedGift = Omit<GiftAidExcludedGift, 'amount'> & {
  amount: bigint
}

export type ClaimSummary = Omit<
  GiftAidClaimSummary,
  'totals' | 'paidAmount'
> & { totals: ClaimTotals; paidAmount: bigint | null }

export type Claim = Omit<
  GiftAidClaimView,
  'totals' | 'paidAmount' | 'lines' | 'adjustments'
> & {
  totals: ClaimTotals
  paidAmount: bigint | null
  lines: Array<ClaimLine>
  adjustments: Array<ClaimAdjustment>
}

export type ClaimPreview = Omit<
  GiftAidClaimPreview,
  'totals' | 'lines' | 'adjustments' | 'excluded'
> & {
  totals: ClaimTotals
  lines: Array<ClaimLine>
  adjustments: Array<ClaimAdjustment>
  excluded: Array<ExcludedGift>
}

/** A status step as the claim page asks for it; pence as `bigint`. */
export type ClaimStep =
  | { status: 'ready' | 'deleted' }
  | { status: 'submitted'; submittedOn: string; hmrcReference: string }
  | { status: 'paid'; paidOn: string; paidAmount: bigint }
  | { status: 'rejected'; reason: string }

/** What the claim page downloads: the schedule in either format, or the XML. */
export type ClaimDownload = 'excel' | 'libreoffice' | 'xml'

// ── wire → page ────────────────────────────────────────────────────────────

const pence = (n: number): bigint => BigInt(n)

/** Pence to the wire, refusing what JSON can't carry exactly. */
function toWire(amount: bigint): number {
  const n = Number(amount)
  if (!Number.isSafeInteger(n)) throw new RangeError('amount out of range')
  return n
}

const totalsFromWire = (t: GiftAidClaimTotals): ClaimTotals => ({
  lines: t.lines,
  donations: pence(t.donations),
  reclaim: pence(t.reclaim),
  adjustment: pence(t.adjustment),
  net: pence(t.net),
})

const lineFromWire = (l: GiftAidClaimLine): ClaimLine => ({
  ...l,
  amount: pence(l.amount),
  reclaim: pence(l.reclaim),
})

const adjustmentFromWire = (a: GiftAidClaimAdjustment): ClaimAdjustment => ({
  ...a,
  amount: pence(a.amount),
})

export const summaryFromWire = (s: GiftAidClaimSummary): ClaimSummary => ({
  ...s,
  totals: totalsFromWire(s.totals),
  paidAmount: s.paidAmount === null ? null : pence(s.paidAmount),
})

export const claimFromWire = (v: GiftAidClaimView): Claim => ({
  ...v,
  totals: totalsFromWire(v.totals),
  paidAmount: v.paidAmount === null ? null : pence(v.paidAmount),
  lines: v.lines.map(lineFromWire),
  adjustments: v.adjustments.map(adjustmentFromWire),
})

export const previewFromWire = (p: GiftAidClaimPreview): ClaimPreview => ({
  ...p,
  totals: totalsFromWire(p.totals),
  lines: p.lines.map(lineFromWire),
  adjustments: p.adjustments.map(adjustmentFromWire),
  excluded: p.excluded.map((e) => ({ ...e, amount: pence(e.amount) })),
})

const isNotFound = (err: unknown) =>
  err instanceof RustApiError && err.status === 404

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * A read's state for a page that may need a step-up first: `data`
 * (undefined while loading or refused), the refusal, and a refetch.
 */
export type ClaimRead<T> = {
  data: T | undefined
  error: unknown
  refetch: () => Promise<unknown>
}

// A refused read isn't retried: step-up and forbidden need the user,
// and the page says so at once.
const noRetry = { retry: false } as const

/** The group's claims, newest first (deleted drafts left out). */
export function useClaims(enabled = true): ClaimRead<Array<ClaimSummary>> {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.claims(slug),
    enabled,
    ...noRetry,
    queryFn: async () =>
      (
        await get<GiftAidClaims>(tenantPath(slug, 'giftaid', 'claims'))
      ).claims.map(summaryFromWire),
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

/**
 * What a claim up to `periodEnd` would take now; `enabled` false until
 * a date is chosen. Refetched on request ("Refresh", after fixing an
 * excluded gift), when the page opens again, and when a claim changes:
 * the create checks the totals shown against what is eligible then
 * (`preview_changed`).
 */
export function useClaimPreview(
  periodEnd: string,
  enabled = true,
): ClaimRead<ClaimPreview> & { fetching: boolean } {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.claimPreview(slug, periodEnd),
    enabled,
    // Dropped once nothing shows it: coming back (from fixing a gift
    // left out) reads it afresh, never the preview as it was left.
    gcTime: 0,
    ...noRetry,
    queryFn: async () =>
      previewFromWire(
        await get<GiftAidClaimPreview>(
          tenantPath(slug, 'giftaid', 'claims', 'preview'),
          new URLSearchParams({ periodEnd }),
        ),
      ),
  })
  return {
    data: q.data,
    error: q.error,
    refetch: q.refetch,
    fetching: q.isFetching,
  }
}

/** One claim; null for an unknown or deleted one, undefined while loading. */
export function useClaim(id: string): ClaimRead<Claim | null> {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.claim(slug, id),
    ...noRetry,
    queryFn: async (): Promise<Claim | null> => {
      try {
        return claimFromWire(
          await get<GiftAidClaimView>(
            tenantPath(slug, 'giftaid', 'claims', id),
          ),
        )
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

/** The charity's HMRC details, with their warnings. */
export function useHmrcDetails(enabled = true): ClaimRead<HmrcDetailsView> {
  const { slug } = useTenant()
  const q = useQuery({
    queryKey: keys.hmrcDetails(slug),
    enabled,
    ...noRetry,
    queryFn: () =>
      get<HmrcDetailsView>(tenantPath(slug, 'giftaid', 'hmrc-details')),
  })
  return { data: q.data, error: q.error, refetch: q.refetch }
}

// ── writes ─────────────────────────────────────────────────────────────────

/** Every claims read: the list, each claim, every preview. */
export function claimsChanged(qc: QueryClient, slug: string) {
  return qc.invalidateQueries({ queryKey: keys.giftaid(slug) })
}

/**
 * Create the claims a preview showed, sending its totals so the server
 * refuses (`preview_changed`) if what is eligible has changed since.
 * Resolves with the new claims once committed; the claimed gifts' pages
 * refetch (they are locked now).
 */
export function useCreateClaims() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (preview: ClaimPreview): Promise<Array<Claim>> => {
    try {
      const done = await post<GiftAidClaimsCreated>(
        tenantPath(slug, 'giftaid', 'claims'),
        {
          periodEnd: preview.periodEnd,
          expectedLines: preview.totals.lines,
          expectedDonations: toWire(preview.totals.donations),
          expectedAdjustment: toWire(preview.totals.adjustment),
        },
      )
      const claims = done.claims.map(claimFromWire)
      for (const c of claims) qc.setQueryData(keys.claim(slug, c.id), c)
      return claims
    } finally {
      void qc.invalidateQueries({
        queryKey: keys.giftaid(slug),
        predicate: (q) => q.queryKey[3] !== 'one',
      })
      void qc.invalidateQueries({ queryKey: keys.gifts(slug) })
    }
  }
}

/**
 * Move a claim on a step (`expected`: its `statusVersion`). Resolves
 * with the claim as it now is (null once a draft is deleted), which
 * lands in its query; throws `RustApiError` when refused (`stale`: the
 * claim is read again).
 */
export function useClaimStep(id: string) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const view = keys.claim(slug, id)
  return async (expected: number, step: ClaimStep): Promise<Claim | null> => {
    const body: SetGiftAidClaimStatus =
      step.status === 'paid'
        ? { ...step, expected, paidAmount: toWire(step.paidAmount) }
        : { ...step, expected }
    let done: GiftAidClaimSaved
    try {
      done = await post<GiftAidClaimSaved>(
        tenantPath(slug, 'giftaid', 'claims', id, 'status'),
        body,
      )
    } catch (err) {
      if (err instanceof RustApiError && err.error.kind === 'stale')
        void qc.invalidateQueries({ queryKey: view, exact: true })
      throw err
    }
    await qc.cancelQueries({ queryKey: view, exact: true })
    const claim = done.view && claimFromWire(done.view)
    const cached = qc.getQueryData<Claim | null>(view)
    // Never an answer older than what a refetch has already shown.
    if (cached && claim && cached.statusVersion > claim.statusVersion)
      void qc.invalidateQueries({ queryKey: view, exact: true })
    else qc.setQueryData(view, claim)
    void qc.invalidateQueries({
      queryKey: keys.giftaid(slug),
      predicate: (q) => !(q.queryKey[3] === 'one' && q.queryKey[4] === id),
    })
    // Deleting or rejecting lets the gifts go: their pages unlock.
    void qc.invalidateQueries({ queryKey: keys.gifts(slug) })
    return claim
  }
}

/** Save the HMRC details against `expected` (null before the first save). */
export function useSaveHmrcDetails() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (expected: number | null, details: HmrcDetails) => {
    try {
      return await post<Executed>(tenantPath(slug, 'giftaid', 'hmrc-details'), {
        ...details,
        ...(expected !== null && { expected }),
      })
    } finally {
      await qc.invalidateQueries({ queryKey: keys.hmrcDetails(slug) })
    }
  }
}

/** The file name from a `Content-Disposition: attachment; filename="…"`. */
export function attachmentName(header: string | null, fallback: string) {
  return /filename="([^"]+)"/.exec(header ?? '')?.[1] ?? fallback
}

/**
 * Fetch a claim's schedule or XML and hand it to the browser as a
 * download. Through `fetch`, not a link, so a refusal (`claim_draft`,
 * `missing_hmrc_details`, `org_name`, step-up) comes back as a
 * `RustApiError` the page shows, not a JSON page.
 */
export async function downloadClaim(
  slug: string,
  id: string,
  what: ClaimDownload,
): Promise<void> {
  const path =
    what === 'xml'
      ? tenantPath(slug, 'giftaid', 'claims', id, 'xml')
      : `${tenantPath(slug, 'giftaid', 'claims', id, 'schedule')}?format=${what}`
  let res: Response
  try {
    res = await fetch(apiUrl(path), { credentials: 'include' })
  } catch {
    throw new RustApiError(0, { kind: 'internal' })
  }
  if (!res.ok) {
    let error: RustApiError['error'] = { kind: 'internal' }
    try {
      const json: unknown = await res.json()
      if (json && typeof json === 'object' && 'kind' in json)
        error = json as RustApiError['error']
    } catch {
      // not JSON: internal
    }
    throw new RustApiError(res.status, error)
  }
  const blob = await res.blob()
  const name = attachmentName(
    res.headers.get('content-disposition'),
    what === 'xml' ? 'gift-aid-claim.xml' : 'gift-aid-claim.ods',
  )
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  // After the click has handed the file over.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
