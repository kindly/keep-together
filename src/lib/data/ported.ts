/**
 * What the Rust backend serves so far (migration-rust.sv, F3). The SPA
 * talks only to the Rust API; a route not in `PORTED` renders "being
 * ported" in the tenant layout and is left out of the navigation, and a
 * page section in `FEATURES` that is `false` isn't rendered at all. Each
 * wave step adds its routes and turns on its sections here, nowhere else.
 *
 * The unported routes and components stay on disk, still written against
 * Convex (read-only reference), until their slice ports them.
 */
import type { FileRouteTypes } from '../../routeTree.gen'

export type RouteId = FileRouteTypes['id']

export const PORTED: ReadonlyArray<RouteId> = [
  '__root__',
  '/',
  '/t/$slug',
  '/t/$slug/',
  '/t/$slug/contacts/',
  '/t/$slug/contacts/new',
  '/t/$slug/contacts/$contactId',
]

const ported = new Set<string>(PORTED)

export function isPorted(routeId: string): boolean {
  return ported.has(routeId)
}

/** Sections of ported pages whose module isn't ported yet. */
export const FEATURES = {
  /** A2: the acquisition picker, the list's source filter. */
  sourceCodes: false,
  /** A1: the form's identifiers. */
  identifiers: false,
  /** A1: the contact page's notes. */
  notes: false,
  /** A1: the email hold notice and Release. */
  emailHolds: false,
  /** B1: the list's bulk set. */
  bulkSetField: false,
  /** B2: the contact's gifts and Gift Aid, home's recent gifts. */
  gifts: isPorted('/t/$slug/gifts/new'),
  /** A3: Settings, and "last used" group. */
  settings: isPorted('/t/$slug/settings'),
}
