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
      : (['t', slug, 'notes', contactId, archived ? 'archived' : 'live'] as const),
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
}
