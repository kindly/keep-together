import type { GiveDonation } from '#/lib/data/rust-types/GiveDonation'
import type { GivePage } from '#/lib/data/rust-types/GivePage'
import type { GiveStarted } from '#/lib/data/rust-types/GiveStarted'

/**
 * The donor's page's two calls (server/README.md, "The donor's page").
 * Nobody is signed in: no cookie is sent, and the answers are the same
 * whoever asks.
 */

/** What loading the page came to. */
export type Loaded =
  | { kind: 'ok'; page: GivePage }
  /** No such page, or the group isn't taking donations: the same answer. */
  | { kind: 'absent' }
  | { kind: 'retry'; why: RetryWhy }

/** Why trying again may work: no connection, too many tries, or us. */
export type RetryWhy = 'offline' | 'limited' | 'stripe' | 'server'

/** A field of the form the server names in a `422 invalid`. */
export type Field =
  'amount' | 'firstName' | 'lastName' | 'email' | 'addressLine1' | 'postcode'

/** What sending a donation came to. */
export type Sent =
  /** Send the browser to Stripe's payment page. */
  | { kind: 'ok'; url: string }
  /** Fields to put right, each with the server's message. */
  | {
      kind: 'invalid'
      problems: Array<{ field: Field | null; message: string }>
    }
  /** The page changed under the donor (Gift Aid, the wording): reload it. */
  | { kind: 'changed'; message: string }
  /** This attempt already has its payment page: start another. */
  | { kind: 'duplicate' }
  | { kind: 'absent' }
  | { kind: 'retry'; why: RetryWhy }

/** The slug and view of `/give/{slug}` or `/give/{slug}/thanks`. */
export function routeFrom(
  pathname: string,
): { slug: string; view: 'form' | 'thanks' } | null {
  const m = /^\/give\/([a-z0-9][a-z0-9-]{0,99})(\/thanks)?\/?$/.exec(pathname)
  return m ? { slug: m[1], view: m[2] ? 'thanks' : 'form' } : null
}

/** A client-chosen id: 32 lower-case hex (CLAUDE.md, Conventions). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Send the browser to Stripe's payment page. */
export function leaveFor(url: string): void {
  window.location.assign(url)
}

const FIELDS: Record<string, Field | undefined> = {
  amount: 'amount',
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  'giftAid.addressLine1': 'addressLine1',
  'giftAid.postcode': 'postcode',
}

function retryOf(status: number): RetryWhy {
  if (status === 429) return 'limited'
  return 'server'
}

async function call(
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)
  try {
    return await fetch(path, {
      ...init,
      signal: abort.signal,
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function loadPage(slug: string): Promise<Loaded> {
  const res = await call(`/api/give/${slug}`)
  if (!res) return { kind: 'retry', why: 'offline' }
  if (res.ok) return { kind: 'ok', page: (await res.json()) as GivePage }
  if (res.status === 404) return { kind: 'absent' }
  return { kind: 'retry', why: retryOf(res.status) }
}

interface ErrorBody {
  kind?: string
  reason?: string
  message?: string
  problems?: Array<{ field: string; message: string }>
}

/** The outcome of the donation call's response. */
export async function sentOf(res: Response): Promise<Sent> {
  if (res.ok)
    return { kind: 'ok', url: ((await res.json()) as GiveStarted).url }
  const body = (await res.json().catch(() => ({}))) as ErrorBody
  switch (res.status) {
    case 404:
      return { kind: 'absent' }
    case 409:
      return { kind: 'duplicate' }
    case 422:
      if (body.kind === 'rejected')
        return {
          kind: 'changed',
          message: body.message ?? 'This page is out of date.',
        }
      return {
        kind: 'invalid',
        problems: (body.problems ?? []).map((p) => ({
          field: FIELDS[p.field] ?? null,
          message: p.message,
        })),
      }
    case 503:
      return {
        kind: 'retry',
        why: body.kind === 'stripe_unavailable' ? 'stripe' : 'server',
      }
    default:
      return { kind: 'retry', why: retryOf(res.status) }
  }
}

/**
 * Send what the donor typed. `donation.id` is this attempt's key: sent
 * again after a lost answer it is the same attempt, never a second one.
 */
export async function sendDonation(
  slug: string,
  donation: GiveDonation,
): Promise<Sent> {
  const res = await call(`/api/give/${slug}/donations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(donation),
  })
  if (!res) return { kind: 'retry', why: 'offline' }
  return sentOf(res)
}
