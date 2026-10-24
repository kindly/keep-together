/**
 * The contacts pages' data layer (rust spike, step 2b). Pages and the
 * contact form import from here, never `convex/react`, for everything the
 * Rust API also serves. Each export is picked once, at module load, by
 * `VITE_BACKEND` (`backend.ts`), so a hook is the same function on every
 * render. Anything Rust doesn't have is gated by `FEATURES` in the pages.
 */
import { BACKEND } from './backend'
import * as convexContact from './convex-contact'
import * as convexList from './convex-list'
import * as rust from './rust/hooks'

export { BACKEND, FEATURES } from './backend'
export type * from './types'

const onRust = BACKEND === 'rust'

// Session and groups.
export const SignedIn = onRust ? rust.SignedIn : convexContact.SignedIn
export const SignedOut = onRust ? rust.SignedOut : convexContact.SignedOut
export const SessionLoading = onRust
  ? rust.SessionLoading
  : convexContact.SessionLoading
export const MyTenantsProvider = onRust
  ? rust.MyTenantsProvider
  : convexContact.MyTenantsProvider
export const useMyTenants = onRust
  ? rust.useMyTenants
  : convexContact.useMyTenants
export const useSignOut = onRust ? rust.useSignOut : convexContact.useSignOut

// The list and search.
export const useContactList = onRust
  ? rust.useContactList
  : convexList.useContactList
export const useContactSearch = onRust
  ? rust.useContactSearch
  : convexList.useContactSearch
export const useBulkSetField = onRust
  ? rust.useBulkSetField
  : convexList.useBulkSetField
export const useFields = onRust ? rust.useFields : convexList.useFields
export const preloadContactList = onRust
  ? rust.preloadContactList
  : convexList.preloadContactList
export const releaseListHold = onRust
  ? rust.releaseListHold
  : convexList.releaseListHold

// The contact page and form.
export const useContact = onRust ? rust.useContact : convexContact.useContact
export const preloadContact = onRust
  ? rust.preloadContact
  : convexContact.preloadContact
export const useMembers = onRust ? rust.useMembers : convexContact.useMembers
export const useIdentifierTypes = onRust
  ? rust.useIdentifierTypes
  : convexContact.useIdentifierTypes
export const useEmailContext = onRust
  ? rust.useEmailContext
  : convexContact.useEmailContext
export const useSaveContactForm = onRust
  ? rust.useSaveContactForm
  : convexContact.useSaveContactForm
export const useCreateContact = onRust
  ? rust.useCreateContact
  : convexContact.useCreateContact
