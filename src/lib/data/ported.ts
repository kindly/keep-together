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
  // A4: auth, and Settings › Members.
  '/sign-in',
  '/reset',
  '/invite',
  '/account',
  '/t/$slug',
  '/t/$slug/',
  '/t/$slug/contacts/',
  '/t/$slug/contacts/new',
  '/t/$slug/contacts/$contactId',
  // A3: Settings' layout (its list tabs come with their slices) and
  // Switch group.
  '/t/$slug/settings',
  '/t/$slug/settings/',
  '/t/$slug/settings/groups',
  '/t/$slug/settings/members',
  // A1: inside A3's Settings layout.
  '/t/$slug/settings/identifiers',
  // A2: Settings › Source codes.
  '/t/$slug/settings/sources',
]

const ported = new Set<string>(PORTED)

export function isPorted(routeId: string): boolean {
  return ported.has(routeId)
}

/** Sections of ported pages whose module isn't ported yet. */
export const FEATURES = {
  /** A2: the acquisition picker, the list's source filter. */
  sourceCodes: true,
  /** A1: the form's identifiers. */
  identifiers: true,
  /** A1: the contact page's notes. */
  notes: true,
  /** A1: the email hold notice and Release. */
  emailHolds: true,
  /** B1: the list's bulk set. */
  bulkSetField: false,
  /** B2: the contact's gifts and Gift Aid, home's recent gifts. */
  gifts: isPorted('/t/$slug/gifts/new'),
  /** A3: Settings, and "last used" group. */
  settings: isPorted('/t/$slug/settings'),
}
