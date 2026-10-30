/**
 * `fetch` for the Rust API (server/README.md, "HTTP conventions"). Same
 * origin by default: Vite proxies `/api` to the server in dev and the api
 * serves the SPA when hosted, so the session cookie (`kt_session`,
 * HttpOnly) rides along with no CORS. Every failure is a
 * JSON `ApiError` tagged by `kind`; anything else (the server down, a
 * proxy's HTML page) becomes `internal`.
 */
import type { ApiError } from '../rust-types/ApiError'

/** A refused request, carrying the server's `ApiError` and status. */
export class RustApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(describe(error))
    this.name = 'RustApiError'
  }
}

/** A sentence for the form's error notice. */
export function describe(error: ApiError): string {
  switch (error.kind) {
    case 'unauthenticated':
      return 'Signed out: sign in again'
    case 'forbidden':
      return 'Not allowed'
    case 'step_up_required':
      return 'Confirm it’s you first'
    case 'not_found':
      return 'Not found'
    case 'gone':
      return 'This link has ended: start a new one'
    case 'stale':
      return 'Changed by someone else'
    case 'duplicate':
      return 'Already exists'
    case 'invalid':
      return error.problems.map((p) => p.message).join('; ') || 'Invalid'
    case 'rejected':
      return error.message
    case 'file_rows':
      return 'The file can’t be read: nothing was imported'
    case 'too_large':
      return `The file is over ${Math.floor(error.limit / 1024 / 1024)} MB`
    case 'rate_limited':
      return 'Too many attempts: wait a minute'
    case 'lookup_cap':
      return 'Lookups used up this month: type the address'
    case 'lookup_unavailable':
      return 'Lookup unavailable: type the address'
    case 'gocardless_unavailable':
      return 'GoCardless isn’t answering: try again'
    case 'busy':
      return 'Busy: try again in a moment'
    case 'storage_full':
      return 'The server is out of space: contact us'
    case 'internal':
      return 'Could not save'
  }
}

/**
 * The API's base: the origin's root unless the build sets `VITE_API_BASE`
 * (an origin, no trailing slash), wherever the SPA itself is served.
 */
const API = `${import.meta.env.VITE_API_BASE ?? ''}/api`

/** An API path's URL, for what isn't a `fetch` (the event stream). */
export const apiUrl = (path: string) => `${API}/${path}`

/** A tenant's resource path: `tenantPath('x', 'contacts', id)`. */
export function tenantPath(slug: string, ...parts: Array<string>): string {
  return ['t', slug, ...parts].map(encodeURIComponent).join('/')
}

async function call<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  // A file goes as itself (a statement upload); anything else as JSON.
  const raw = body instanceof Blob
  let response: Response
  try {
    response = await fetch(apiUrl(path), {
      method,
      // Same origin: as 'same-origin'. Another `VITE_API_BASE`: the cookie
      // still goes (the api has to allow the SPA's origin).
      credentials: 'include',
      headers:
        body === undefined
          ? {}
          : {
              'content-type': raw
                ? 'application/octet-stream'
                : 'application/json',
            },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    })
  } catch {
    throw new RustApiError(0, { kind: 'internal' })
  }
  const text = await response.text()
  let json: unknown = undefined
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    // not JSON: handled below
  }
  if (!response.ok) {
    const error =
      json && typeof json === 'object' && 'kind' in json
        ? (json as ApiError)
        : ({ kind: 'internal' } as const)
    throw new RustApiError(response.status, error)
  }
  return json as T
}

export const get = <T>(path: string, query?: URLSearchParams) =>
  call<T>('GET', query?.size ? `${path}?${query.toString()}` : path)

export const post = <T>(path: string, body: unknown = {}) =>
  call<T>('POST', path, body)

export const del = <T>(path: string) => call<T>('DELETE', path)

/** POST a file as the whole body, the rest in the query. */
export const postFile = <T>(path: string, query: URLSearchParams, file: Blob) =>
  call<T>('POST', `${path}?${query.toString()}`, file)
