/**
 * The SPA's data layer, on the Rust API (`server/README.md`, "HTTP
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
  useAddressLookupOn,
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
export { useAddressLookup } from './rust/address'
export type { LookupAddress, LookupOutcome } from './rust/address'
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
  fetchContactSnapshot,
  fetchGift,
  useContactGifts,
  useDeclarationHistory,
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
  DeclarationDetails,
  DeclarationDetailsHistory,
  DonorInfo,
  Gift,
  GiftFields,
  GiftMethod,
  GiftStatus,
  GiftView,
  RecentGift,
  RecordGiftArgs,
} from './rust/gifts'
export {
  downloadClaim,
  useClaim,
  useClaimPreview,
  useClaimStep,
  useClaims,
  useCreateClaims,
  useHmrcDetails,
  useSaveHmrcDetails,
} from './rust/claims'
export type {
  Claim,
  ClaimAdjustment,
  ClaimDownload,
  ClaimLine,
  ClaimPreview,
  ClaimRead,
  ClaimStatus,
  ClaimStep,
  ClaimSummary,
  ClaimTotals,
  ExcludedGift,
  HmrcDetails,
  HmrcDetailsView,
} from './rust/claims'
export {
  PAIRING_POLL_MS,
  endScanPairingNow,
  scanLink,
  scanPageUrl,
  useDeclarationScans,
  useDeletableScans,
  useEndScanPairing,
  useFilesUsage,
  useScan,
  useScanInbox,
  useScanPairing,
  useScanWrites,
  useStartScanPairing,
} from './rust/scans'
export type {
  DeclarationScans,
  DeletableScan,
  FilesUsage,
  ScanMatch,
  ScanPairingStarted,
  ScanPairingView,
  ScanPurpose,
  ScanView,
} from './rust/scans'
export {
  useDirectDebitWrites,
  useExpectedPeriods,
  useExpectedReport,
  useGoCardlessAdmin,
  useGoCardlessStatus,
  useMatchPayment,
  useRegularGiftForecast,
  useRegularGifts,
  useTermsWrites,
  useUnknownSubscriptions,
  useUnmatchedPayments,
} from './rust/gocardless'
export type {
  ChangeArgs,
  DirectDebitPayment,
  ExpectedGrouping,
  ExpectedPeriodRow,
  ExpectedReport,
  GoCardlessStatus,
  InstantPaymentLink,
  OneOffStarted,
  RegularGift,
  RegularGiftFrequency,
  ReportLine,
  ShareArgs,
  Term,
  TermShareView,
  UnknownSubscription,
  UnmatchedPayment,
  Upcoming,
} from './rust/gocardless'
export {
  kindOfFile,
  useBankAccounts,
  useBankImport,
  useBankImports,
  useBankPresets,
  useCreateBankAccount,
  useImportStatement,
  usePeekStatement,
  usePreviewImport,
  useSaveBankAccount,
} from './rust/banking'
export type {
  BankAccountPayload,
  BankAccountRow,
  BankColumnMapping,
  BankCsvLayout,
  BankFileLayout,
  BankImportRow,
  BankImportView,
  BankImportedOutcome,
  BankLine,
  BankPeekRow,
  BankPreset,
  BankPresets,
  BankPreviewOutcome,
  BankRowError,
  BankUndated,
} from './rust/banking'
