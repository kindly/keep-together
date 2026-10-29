/**
 * Declaration scans on the Rust API (`server/README.md`, "Declaration
 * scans"), through TanStack Query: a phone pairing and its sitting's
 * stack, "Scans to match", one scan, a declaration's scans, the "can be
 * deleted" report and the files usage; and their writes.
 *
 * **Never optimistic**, as gifts: a scan is the declaration's evidence
 * (HMRC 3.7.2), so what the cache holds is the server's answer. Every
 * read is under `keys.scans`, which a `declaration_scans` event
 * refetches (`../events.ts`). A pairing's own state (claimed, uploads,
 * ended) isn't an org event: its query also polls while it is live.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { DeclarationScans } from '../rust-types/DeclarationScans'
import type { DeletableScan } from '../rust-types/DeletableScan'
import type { FilesUsage } from '../rust-types/FilesUsage'
import type { ScanAccepted } from '../rust-types/ScanAccepted'
import type { ScanMatch } from '../rust-types/ScanMatch'
import type { ScanPairingStarted } from '../rust-types/ScanPairingStarted'
import type { ScanPairingView } from '../rust-types/ScanPairingView'
import type { ScanPurpose } from '../rust-types/ScanPurpose'
import type { ScanView } from '../rust-types/ScanView'
import { RustApiError, apiUrl, del, get, post, tenantPath } from './client'
import { keys } from './keys'

export type {
  DeclarationScans,
  DeletableScan,
  FilesUsage,
  ScanMatch,
  ScanPairingStarted,
  ScanPairingView,
  ScanPurpose,
  ScanView,
}

/** How often a live pairing is read again, for what no event says. */
export const PAIRING_POLL_MS = 15_000

/** A page's image, for an `<img>` (the session cookie rides along). */
export function scanPageUrl(slug: string, scanId: string, pageNo: number) {
  return apiUrl(tenantPath(slug, 'scans', scanId, 'pages', String(pageNo)))
}

/** The phone's link for a pairing's `path` (`/scan.html#<token>`). */
export function scanLink(path: string, origin = window.location.origin) {
  return `${origin}${path}`
}

/** Start a pairing: staff or admin, a sign-in within the hour. */
export function useStartScanPairing() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (purpose: ScanPurpose): Promise<ScanPairingStarted> => {
    const started = await post<ScanPairingStarted>(
      tenantPath(slug, 'scan-pairings'),
      { purpose },
    )
    qc.setQueryData(keys.scanPairing(slug, started.pairing.id), started.pairing)
    return started
  }
}

/**
 * A pairing and its sitting's scans (oldest first); polled while live,
 * so "phone connected" and the link's end show without an event.
 */
export function useScanPairing(id: string | null) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.scanPairing(slug, id ?? ''),
    enabled: id !== null,
    queryFn: () => get<ScanPairingView>(tenantPath(slug, 'scan-pairings', id!)),
    refetchInterval: (q) =>
      q.state.data && q.state.data.endedAt === null ? PAIRING_POLL_MS : false,
  })
}

/** End a pairing now: the phone's link stops working. */
export function useEndScanPairing() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (id: string) => {
    const view = await del<ScanPairingView>(
      tenantPath(slug, 'scan-pairings', id),
    )
    qc.setQueryData(keys.scanPairing(slug, id), view)
    return view
  }
}

/** "Scans to match": every draft in the group, oldest first. */
export function useScanInbox() {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.scanInbox(slug),
    queryFn: () => get<Array<ScanView>>(tenantPath(slug, 'scans')),
  })
}

/** One scan; `null` when there's no such scan. */
export function useScan(id: string) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.scan(slug, id),
    queryFn: async () => {
      try {
        return await get<ScanView>(tenantPath(slug, 'scans', id))
      } catch (err) {
        if (err instanceof RustApiError && err.status === 404) return null
        throw err
      }
    },
  })
}

/**
 * A declaration's scans: `held` ("✓ scan held" and when) for anyone,
 * `scans` for staff and admins (null for a viewer).
 */
export function useDeclarationScans(declarationId: string) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.declarationScans(slug, declarationId),
    queryFn: () =>
      get<DeclarationScans>(
        tenantPath(slug, 'giftaid', declarationId, 'scans'),
      ),
  }).data
}

/** The "can be deleted" report (admins, a sign-in within the hour). */
export function useDeletableScans(today: string) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.deletableScans(slug, today),
    queryFn: () =>
      get<Array<DeletableScan>>(
        tenantPath(slug, 'giftaid', 'scans', 'deletable'),
        new URLSearchParams({ today }),
      ),
    retry: false,
  })
}

/** How much of the group's 2 GB the scans use (Settings). */
export function useFilesUsage(enabled = true) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.filesUsage(slug),
    enabled,
    queryFn: () => get<FilesUsage>(tenantPath(slug, 'files-usage')),
  })
}

/**
 * A scan's writes. Each resolves once committed, with the scan as the
 * server has it, after the scan reads (and, for an accept, the
 * declarations) have been refetched: never optimistic. `stale` means
 * someone else changed the scan first; its reads are refetched, so the
 * caller says so and the user tries again on what is shown.
 */
export function useScanWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const after = async <T>(write: Promise<T>, declarations = false) => {
    try {
      return await write
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.scans(slug) }),
        declarations &&
          qc.invalidateQueries({ queryKey: keys.declarations(slug) }),
      ])
    }
  }
  const path = (id: string, action: string) =>
    tenantPath(slug, 'scans', id, action)
  return {
    /** Keep `order`'s pages (ids), in that order. */
    reorder: (scan: ScanView, order: Array<string>) =>
      after(
        post<ScanView>(path(scan.id, 'reorder'), {
          expected: scan.scanVersion,
          order,
        }),
      ),
    /** Append `from`'s pages to `into`; `from` is discarded ("merged"). */
    merge: (into: ScanView, from: ScanView) =>
      after(
        post<ScanView>(path(into.id, 'merge'), {
          expected: into.scanVersion,
          from: from.id,
          fromExpected: from.reviewVersion,
        }),
      ),
    accept: (scan: ScanView, contactId: string, match: ScanMatch) =>
      after(
        post<ScanAccepted>(path(scan.id, 'accept'), {
          expected: scan.reviewVersion,
          contactId,
          match,
        }),
        true,
      ),
    discard: (scan: ScanView, reason?: string) =>
      after(
        post<ScanView>(path(scan.id, 'discard'), {
          expected: scan.reviewVersion,
          ...(reason && { reason }),
        }),
      ),
    /** The report's delete (admins): the images go, the row stays. */
    deleteImages: (scan: ScanView) =>
      after(
        post<ScanView>(path(scan.id, 'delete-images'), {
          expected: scan.retentionVersion,
        }),
      ),
  }
}
