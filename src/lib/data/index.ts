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
  useFields,
  useMembers,
  useMyTenants,
  useSaveContactForm,
} from './rust/hooks'
export * from './rust/auth'
export { useOrgEvents } from './events'
export { useOpened, useSetStaffCanManage } from './rust/platform'
export {
  useEmailContext,
  useIdentifierTypes,
  useNoteActions,
  useNotes,
  useRelease,
  useSaveIdentifierType,
} from './rust/contact-extras'
export type { Note } from './rust/contact-extras'
export {
  preloadSourceTree,
  useSetAcquisition,
  useSourceFilterOptions,
  useSourcePicker,
  useSourceTree,
  useSourceWrites,
} from './rust/sources'
export type {
  FilterOption,
  Part,
  PickerEntry,
  SourceCodeDescription,
  SourceCodePayload,
} from './rust/sources'
