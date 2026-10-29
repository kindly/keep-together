/**
 * What the Rust backend serves so far (migration-rust.sv, F3). The SPA
 * talks only to the Rust API; a route not in `PORTED` renders "being
 * ported" in the tenant layout and is left out of the navigation, and a
 * page section in `FEATURES` that is `false` isn't rendered at all. Each
 * wave step adds its routes and turns on its sections here, nowhere else.
 *
 * Every route is ported (cutover, C2); the list stays as the place a new
 * route is switched on.
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
  // B1: Settings › Fields, and the old tags URLs that land on it.
  '/t/$slug/settings/fields',
  '/t/$slug/settings/tags',
  '/t/$slug/tags',
  // B2: recording a gift and a gift's page; FEATURES.gifts follows.
  '/t/$slug/gifts/new',
  '/t/$slug/gifts/$giftId',
  // Gift Aid claims G3: the claims pages and Settings › HMRC details.
  '/t/$slug/giftaid',
  '/t/$slug/giftaid/',
  '/t/$slug/giftaid/new',
  '/t/$slug/giftaid/$claimId',
  '/t/$slug/settings/hmrc',
  // Declaration scans step 4: Scans to match, a scan's review, the "can
  // be deleted" report, and Settings › Scans storage.
  '/t/$slug/scans/',
  '/t/$slug/scans/$scanId',
  '/t/$slug/scans/deletable',
  '/t/$slug/settings/storage',
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
  bulkSetField: true,
  /** B2: the contact's gifts and Gift Aid, home's recent gifts. */
  gifts: isPorted('/t/$slug/gifts/new'),
  /** G3: the header's Gift Aid link (admins), the gift page's claim badge. */
  giftAidClaims: isPorted('/t/$slug/giftaid'),
  /** A3: Settings, and "last used" group. */
  settings: isPorted('/t/$slug/settings'),
}
