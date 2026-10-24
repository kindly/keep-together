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
  preloadFields,
  queryClient,
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
export {
  BULK_FIELD_LIMIT,
  bulkFailure,
  useBulkSetField,
  useFieldWrites,
  useFollowRetires,
} from './rust/fields'
export type { BulkFieldState, FieldPayload, OptionPayload } from './rust/fields'
export {
  GIFTS_PAGE_SIZE,
  fetchGift,
  useContactGifts,
  useDeclarations,
  useDonor,
  useGift,
  useGiftAidWrites,
  useGiftWrites,
  useMyRecentGifts,
  useRecordGift,
} from './rust/gifts'
export type {
  ContactDeclarations,
  Declaration,
  DonorInfo,
  Gift,
  GiftFields,
  GiftMethod,
  GiftStatus,
  GiftView,
  RecentGift,
  RecordGiftArgs,
} from './rust/gifts'
