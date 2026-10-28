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
  /** The charity's HMRC details (Settings). */
  hmrcDetails: (slug: string) => ['t', slug, 'hmrcDetails'] as const,
}
