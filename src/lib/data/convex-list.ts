/**
 * The contacts list on Convex: today's live queries, moved here unchanged
 * from the list route. The list keeps `convex/react`'s `useQuery`, never
 * the contact page's keep-alive cache (a held `list`
 * would re-run on every contact save and join its wait).
 */
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { cachedTenant, useTenant } from '../tenant'
import { holdList, releaseList } from '../list-hold'
import { usePagedList } from '../paged-list'
import type {
  FieldDefinition,
  Loaders,
  SearchArgs,
  SearchResult,
} from './types'

export const useContactList = usePagedList

export { useBulkSetField } from '../../components/bulk-set-field'

export function useContactSearch(
  args: SearchArgs | 'skip',
): SearchResult | undefined {
  return useQuery(api.contacts.queries.search, args)
}

/** The tenant's field definitions, live (the list's filters and chips). */
export function useFields(): Array<FieldDefinition> | undefined {
  return useQuery(api.contacts.fields.list, { tenantId: useTenant()._id })
}

/** Subscribe as the navigation starts, not once the list has mounted. */
export function preloadContactList({ convex }: Loaders, slug: string) {
  const tenant = cachedTenant(convex, slug)
  if (!tenant) return
  holdList(convex, { tenantId: tenant._id, includeArchived: false })
  convex.prewarmQuery({
    query: api.sources.queries.filterOptions,
    args: { tenantId: tenant._id },
  })
  convex.prewarmQuery({
    query: api.contacts.fields.list,
    args: { tenantId: tenant._id },
  })
}

/**
 * Drop the route's hold on the first page, once the page's own
 * subscription is in place (list-hold).
 */
export const releaseListHold = releaseList
