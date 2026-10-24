/**
 * The SPA's data layer, on the Rust API (`rs/README.md`, "HTTP
 * conventions") through TanStack Query. Pages and the contact form import
 * from here. What isn't ported yet is listed in `ported.ts`.
 */
export { FEATURES, PORTED, isPorted } from './ported'
export type * from './types'
export {
  MyTenantsProvider,
  SessionLoading,
  SignedIn,
  SignedOut,
  preloadContact,
  preloadContactList,
  queryClient,
  useBulkSetField,
  useContact,
  useContactList,
  useContactSearch,
  useCreateContact,
  useEmailContext,
  useFields,
  useIdentifierTypes,
  useMembers,
  useMyTenants,
  useSaveContactForm,
  useSignOut,
} from './rust/hooks'
export { useOrgEvents } from './events'
export { useOpened, useSetStaffCanManage } from './rust/platform'
