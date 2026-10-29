import type { ScanSitting } from '#/lib/data/rust-types/ScanSitting'
import type { ScanUploaded } from '#/lib/data/rust-types/ScanUploaded'

/**
 * The phone page's calls to `/api/scan/{token}` (server/README.md,
 * "Declaration scans"). The token arrives in the page's fragment and only
 * ever travels in these calls' paths: never a query, a page URL or a log.
 */

/** What a call came to, as the page acts on it. */
export type Outcome<T> =
  | { kind: 'ok'; value: T }
  /** The link ended (or never was): start a new one on the laptop. */
  | { kind: 'gone' }
  /** Another phone opened this link first. */
  | { kind: 'forbidden' }
  /** This scan isn't a draft of this sitting any more. */
  | { kind: 'not_found' }
  /** Nothing was stored, and sending the same thing again may work. */
  | { kind: 'retry'; why: RetryWhy }
  /** Refused for good: sending it again won't help. */
  | { kind: 'refused'; reason: Refusal }

/**
 * Why a send will be tried again: no connection, a connection too slow
 * to finish in time, or the server busy or failing.
 */
export type RetryWhy = 'offline' | 'slow' | 'busy' | 'server'

export type Refusal =
  | 'page_limit'
  | 'upload_limit'
  | 'files_full'
  | 'storage_full'
  | 'invalid'
  | 'other'

/** The token from `location.hash`: 64 lower-case hex, or null. */
export function tokenFrom(hash: string): string | null {
  const token = hash.replace(/^#/, '')
  return /^[0-9a-f]{64}$/.test(token) ? token : null
}

/** A client-chosen id: 32 lower-case hex (CLAUDE.md, Conventions). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The outcome of a response, read from its status and `kind` body. */
export async function outcomeOf<T>(res: Response): Promise<Outcome<T>> {
  if (res.ok) return { kind: 'ok', value: (await res.json()) as T }
  const body = (await res.json().catch(() => ({}))) as {
    kind?: string
    reason?: string
  }
  switch (res.status) {
    case 410:
      return { kind: 'gone' }
    case 403:
      return { kind: 'forbidden' }
    case 404:
      return { kind: 'not_found' }
    case 507:
      return { kind: 'refused', reason: 'storage_full' }
    case 422:
      if (body.kind === 'invalid') return { kind: 'refused', reason: 'invalid' }
      return {
        kind: 'refused',
        reason:
          body.reason === 'page_limit' ||
          body.reason === 'upload_limit' ||
          body.reason === 'files_full'
            ? body.reason
            : 'other',
      }
    case 503:
    case 429:
    case 408:
      return { kind: 'retry', why: 'busy' }
  }
  if (res.status >= 500) return { kind: 'retry', why: 'server' }
  return { kind: 'refused', reason: 'other' }
}

/**
 * How long an upload of `bytes` may take before it counts as lost and is
 * sent again: a minute, plus a second for every 10 KB, so a 400 KB page
 * has 100 s, time enough at about 40 kbit/s (one bar in a church hall).
 */
export function uploadTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / 10_000) * 1000
}

async function call<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Outcome<T>> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), init.timeoutMs ?? 20_000)
  try {
    const res = await fetch(path, {
      ...init,
      signal: abort.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
    })
    return await outcomeOf<T>(res)
  } catch {
    // A network failure, a timeout or a body cut short: nothing tells
    // whether the server stored it, and the ids make sending it again safe.
    return { kind: 'retry', why: abort.signal.aborted ? 'slow' : 'offline' }
  } finally {
    clearTimeout(timer)
  }
}

export function openSitting(token: string): Promise<Outcome<ScanSitting>> {
  return call(`/api/scan/${token}`)
}

/**
 * One page: the first of scan `scanId` (a new draft) or the next one.
 * Both ids are the phone's, so a retry is the same scan and page.
 */
export function sendPage(
  token: string,
  page: { scanId: string; pageId: string; first: boolean; blob: Blob },
): Promise<Outcome<ScanUploaded>> {
  const path = page.first
    ? `/api/scan/${token}/scans?id=${page.scanId}`
    : `/api/scan/${token}/scans/${page.scanId}/pages?pageId=${page.pageId}`
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: page.blob,
    timeoutMs: uploadTimeoutMs(page.blob.size),
  })
}

const BACKOFF_S = [1, 2, 4, 8, 15, 30]

/** The wait before retry `attempt` (0-based): 1, 2, 4, 8, 15, then 30 s. */
export function backoffMs(attempt: number): number {
  return BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)] * 1000
}
