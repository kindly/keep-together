/**
 * The TanStack Query keys. Everything a tenant shows is under
 * `['t', slug]`, so a `reset` (events.ts) or a sign-out can drop it in
 * one go; a key without its last part is the prefix for all of them.
 */
export const keys = {
  me: ['me'] as const,
  /** The caller's groups (`GET /api/groups`): across tenants, so not under `t`. */
  groups: ['groups'] as const,
  fields: (slug: string) => ['t', slug, 'fields'] as const,
  contacts: (slug: string) => ['t', slug, 'contacts'] as const,
  list: (slug: string, filters?: { q?: string }) =>
    filters
      ? (['t', slug, 'contacts', 'list', filters] as const)
      : (['t', slug, 'contacts', 'list'] as const),
  search: (slug: string, args?: { q?: string }) =>
    args
      ? (['t', slug, 'contacts', 'search', args] as const)
      : (['t', slug, 'contacts', 'search'] as const),
  contact: (slug: string, id: string) =>
    ['t', slug, 'contacts', 'one', id] as const,
  history: (slug: string, id: string) =>
    ['t', slug, 'contacts', 'one', id, 'history'] as const,
  // A1. Identifier types, archived ones included.
  identifierTypes: (slug: string) => ['t', slug, 'identifierTypes'] as const,
  // A contact's live and archived notes; without an id, every contact's.
  notes: (slug: string, contactId?: string, archived?: boolean) =>
    contactId === undefined
      ? (['t', slug, 'notes'] as const)
      : ([
          't',
          slug,
          'notes',
          contactId,
          archived ? 'archived' : 'live',
        ] as const),
  // "Also used by" and holds for a contact's saved emails; without an id,
  // every contact's (another contact's save or a release changes them).
  emailContext: (slug: string, id?: string) =>
    id === undefined
      ? (['t', slug, 'emailContext'] as const)
      : (['t', slug, 'emailContext', id] as const),
  /** Every source-code read: the tree, the filter options, the picker. */
  sources: (slug: string) => ['t', slug, 'sources'] as const,
  sourceTree: (slug: string) => ['t', slug, 'sources', 'tree'] as const,
  sourceOptions: (slug: string) => ['t', slug, 'sources', 'options'] as const,
  sourcePicker: (slug: string, args?: { today: string; search: string }) =>
    args
      ? (['t', slug, 'sources', 'picker', args] as const)
      : (['t', slug, 'sources', 'picker'] as const),
  // B2. Everything a gift shows is under `gifts`: a gift, its history,
  // a contact's gifts, my recent gifts, the record page's donor.
  gifts: (slug: string) => ['t', slug, 'gifts'] as const,
  recentGifts: (slug: string) => ['t', slug, 'gifts', 'recent'] as const,
  gift: (slug: string, id: string) => ['t', slug, 'gifts', 'one', id] as const,
  giftHistory: (slug: string, id: string) =>
    ['t', slug, 'gifts', 'one', id, 'history'] as const,
  contactGifts: (slug: string, contactId: string) =>
    ['t', slug, 'gifts', 'contact', contactId] as const,
  donor: (slug: string, contactId: string, date: string) =>
    ['t', slug, 'gifts', 'donor', contactId, date] as const,
  /** A contact's Gift Aid panel; without a contact, every contact's. */
  declarations: (slug: string, contactId?: string, today?: string) =>
    contactId === undefined
      ? (['t', slug, 'declarations'] as const)
      : (['t', slug, 'declarations', contactId, today ?? ''] as const),
  /** A declaration's details history: under `declarations`, so their events refetch it. */
  declarationHistory: (slug: string, id: string) =>
    ['t', slug, 'declarations', 'history', id] as const,
  /** Gift Aid claims: the list, each claim, each preview. */
  giftaid: (slug: string) => ['t', slug, 'giftaid'] as const,
  claims: (slug: string) => ['t', slug, 'giftaid', 'list'] as const,
  claim: (slug: string, id: string) =>
    ['t', slug, 'giftaid', 'one', id] as const,
  claimPreview: (slug: string, periodEnd: string) =>
    ['t', slug, 'giftaid', 'preview', periodEnd] as const,
  /**
   * Declaration scans: "Scans to match", a scan, a sitting's stack, a
   * declaration's scans, the "can be deleted" report, files usage. One
   * prefix, so a `declaration_scans` event refetches whatever shows one.
   */
  scans: (slug: string) => ['t', slug, 'scans'] as const,
  scanInbox: (slug: string) => ['t', slug, 'scans', 'inbox'] as const,
  scan: (slug: string, id: string) => ['t', slug, 'scans', 'one', id] as const,
  scanPairing: (slug: string, id: string) =>
    ['t', slug, 'scans', 'pairing', id] as const,
  declarationScans: (slug: string, declarationId: string) =>
    ['t', slug, 'scans', 'declaration', declarationId] as const,
  deletableScans: (slug: string, today: string) =>
    ['t', slug, 'scans', 'deletable', today] as const,
  filesUsage: (slug: string) => ['t', slug, 'scans', 'usage'] as const,
  /**
   * Direct Debit (GoCardless D3): the connection, a contact's regular
   * gifts, one regular gift, the unmatched payments. One prefix, so an
   * event from any of its tables refetches whatever shows one.
   */
  gocardless: (slug: string) => ['t', slug, 'gocardless'] as const,
  gocardlessStatus: (slug: string) =>
    ['t', slug, 'gocardless', 'status'] as const,
  regularGifts: (slug: string, contactId: string) =>
    ['t', slug, 'gocardless', 'contact', contactId] as const,
  /** Every contact's regular gifts (each with its latest payments). */
  regularGiftLists: (slug: string) =>
    ['t', slug, 'gocardless', 'contact'] as const,
  /**
   * One regular gift's next payments, as GoCardless forecasts them (its
   * single read, which asks GoCardless): outside `gocardless`, so no
   * event makes every open card call GoCardless; it lapses instead.
   * Keyed by the gift's status too: a gift going live (pending, with no
   * subscription and so no forecast, to active) reads it at once.
   */
  regularGiftForecast: (slug: string, id: string, status?: string) =>
    status === undefined
      ? (['t', slug, 'gocardlessForecast', id] as const)
      : (['t', slug, 'gocardlessForecast', id, status] as const),
  unmatched: (slug: string) => ['t', slug, 'gocardless', 'unmatched'] as const,
  /** A regular gift's expected periods (terms step 6). */
  expected: (slug: string, id: string) =>
    ['t', slug, 'gocardless', 'expected', id] as const,
  expectedReport: (
    slug: string,
    args: { from: string; to: string; by: string },
  ) => ['t', slug, 'gocardless', 'report', args] as const,
  unknownSubscriptions: (slug: string) =>
    ['t', slug, 'gocardless', 'unknown'] as const,
  /** The charity's HMRC details (Settings). */
  hmrcDetails: (slug: string) => ['t', slug, 'hmrcDetails'] as const,
  /**
   * Bank accounts and statement imports (bank transfers 6a): one prefix,
   * so an account's or an import's event refetches whatever shows one.
   */
  bank: (slug: string) => ['t', slug, 'bank'] as const,
  bankPresets: (slug: string) => ['t', slug, 'bankPresets'] as const,
  bankAccounts: (slug: string) => ['t', slug, 'bank', 'accounts'] as const,
  bankImports: (slug: string, accountId: string) =>
    ['t', slug, 'bank', 'imports', accountId] as const,
  bankImport: (slug: string, id: string) =>
    ['t', slug, 'bank', 'import', id] as const,
  /**
   * Paying-in batches (bank transfers 6b): one prefix, so a batch's event
   * or one of its gifts' refetches the list and the batch.
   */
  batches: (slug: string) => ['t', slug, 'batches'] as const,
  batchList: (slug: string, status: string) =>
    ['t', slug, 'batches', 'list', status] as const,
  batch: (slug: string, id: string) =>
    ['t', slug, 'batches', 'one', id] as const,
}
