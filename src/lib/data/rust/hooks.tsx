/**
 * The contacts pages on the Rust API, through TanStack Query: no live
 * queries. A read is fetched, refetched when the window regains focus, and
 * invalidated after every write this tab makes; another tab's change shows
 * on focus, or as a 409 the form merges at save time (`save.ts`).
 */
import {
  QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { useBulkSetField as convexBulkSetField } from '../../../components/bulk-set-field'
import { LIST_PAGE_SIZE } from '../../paged-list'
import type { ListFilters, PagedList } from '../../paged-list'
import type { Tenant } from '../../tenant'
import { useTenant } from '../../tenant'
import type { Me } from '../rust-types/Me'
import type { Executed } from '../rust-types/Executed'
import type { Revision } from '../rust-types/Revision'
import type {
  ContactView,
  CreateContact,
  EmailContext,
  FieldDefinition,
  IdentifierType,
  Loaders,
  Member,
  SaveContactForm,
  SearchArgs,
  SearchResult,
} from '../types'
import { RustApiError, get, post, tenantPath } from './client'
import { saveRequest, savedActions, splitInvalid, staleActions } from './save'
import type {
  WireContact,
  WireField,
  WireListPage,
  WireSaved,
  WireSearch,
} from './wire'
import {
  contactFromWire,
  fieldsFromWire,
  rowFromWire,
  searchFromWire,
} from './wire'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refused requests (403, 404 …) won't change on a retry.
      retry: (failures, error) =>
        !(error instanceof RustApiError && error.status >= 400) && failures < 2,
      refetchOnWindowFocus: true,
    },
  },
})

const keys = {
  me: ['me'] as const,
  fields: (slug: string) => ['t', slug, 'fields'] as const,
  contacts: (slug: string) => ['t', slug, 'contacts'] as const,
  list: (slug: string, filters: object) =>
    ['t', slug, 'contacts', 'list', filters] as const,
  search: (slug: string, args: object) =>
    ['t', slug, 'contacts', 'search', args] as const,
  contact: (slug: string, id: string) =>
    ['t', slug, 'contacts', 'one', id] as const,
  history: (slug: string, id: string) =>
    ['t', slug, 'contacts', 'one', id, 'history'] as const,
}

// ── session ────────────────────────────────────────────────────────────────

/** The signed-in user; null when signed out, undefined while loading. */
function useMe(): Me | null | undefined {
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await get<Me>('me')
      } catch (e) {
        if (e instanceof RustApiError && e.status === 401) return null
        throw e
      }
    },
  })
  return me.data
}

function tenantOf(m: Me['memberships'][number]): Tenant {
  return {
    // The slug stands in for the id: the Rust API is addressed by slug.
    _id: m.slug as Id<'tenants'>,
    slug: m.slug,
    name: m.name,
    role: m.role,
    lastUsedAt: null,
    staffCanManageIdentifierTypes: false,
    identifierTypesVersion: null,
    staffCanManageSourceCodes: false,
    sourceCodesVersion: null,
    staffCanManageFields: false,
    fieldsVersion: null,
    canManageIdentifierTypes: false,
    canManageSourceCodes: false,
    canManageFields: false,
  }
}

const MyTenants = createContext<Array<Tenant> | undefined>(undefined)

export function MyTenantsProvider({ children }: { children: ReactNode }) {
  const me = useMe()
  const tenants = useMemo(() => me?.memberships.map(tenantOf), [me])
  return <MyTenants.Provider value={tenants}>{children}</MyTenants.Provider>
}

export function useMyTenants(): Array<Tenant> | undefined {
  return useContext(MyTenants)
}

export function SignedIn({ children }: { children: ReactNode }) {
  return useMe() ? children : null
}

export function SignedOut({ children }: { children: ReactNode }) {
  return useMe() === null ? children : null
}

export function SessionLoading({ children }: { children: ReactNode }) {
  return useMe() === undefined ? children : null
}

/** `POST /api/dev/login`: the stub's cookie session, no password. */
export function useDevLogin() {
  const qc = useQueryClient()
  return async (email: string) => {
    await post('dev/login', { email })
    qc.clear()
    await qc.invalidateQueries({ queryKey: keys.me })
  }
}

export function useSignOut() {
  const qc = useQueryClient()
  return async () => {
    await post('dev/logout')
    qc.clear()
    await qc.invalidateQueries({ queryKey: keys.me })
  }
}

// ── reads ──────────────────────────────────────────────────────────────────

function fieldsQuery(slug: string) {
  return {
    queryKey: keys.fields(slug),
    queryFn: async () =>
      fieldsFromWire(await get<Array<WireField>>(tenantPath(slug, 'fields'))),
  }
}

export function useFields(): Array<FieldDefinition> | undefined {
  return useQuery(fieldsQuery(useTenant().slug)).data
}

/** The list's filters as query parameters (every filter `list` takes). */
export function filterParams(
  f: Omit<ListFilters, 'tenantId'> & { source?: unknown },
): URLSearchParams {
  const q = new URLSearchParams()
  if (f.includeArchived) q.set('archived', '1')
  if (f.kind) q.set('kind', f.kind)
  for (const x of f.fields ?? [])
    q.append('field', `${x.fieldId}:${x.optionId ?? 'none'}`)
  return q
}

export function useContactList(filters: ListFilters | 'skip'): PagedList {
  const { slug } = useTenant()
  const params = filters === 'skip' ? null : filterParams(filters)
  const list = useInfiniteQuery({
    queryKey: keys.list(slug, { q: params?.toString() }),
    enabled: params !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams(params ?? undefined)
      q.set('limit', String(LIST_PAGE_SIZE))
      if (pageParam) q.set('after', pageParam)
      return get<WireListPage>(tenantPath(slug, 'contacts'), q)
    },
    getNextPageParam: (page) => page.next,
  })
  const rows = useMemo(
    () => list.data?.pages.flatMap((p) => p.rows.map(rowFromWire)),
    [list.data],
  )
  return {
    rows,
    status:
      list.isFetchingNextPage || rows === undefined
        ? 'loading'
        : list.hasNextPage
          ? 'more'
          : 'done',
    loadMore: () => void list.fetchNextPage(),
  }
}

export function useContactSearch(
  args: SearchArgs | 'skip',
): SearchResult | undefined {
  const { slug } = useTenant()
  const q = args === 'skip' ? null : filterParams(args)
  if (q && args !== 'skip') q.set('q', args.search ?? '')
  return useQuery({
    queryKey: keys.search(slug, { q: q?.toString() }),
    enabled: q !== null,
    queryFn: async () =>
      searchFromWire(
        await get<WireSearch>(tenantPath(slug, 'contacts', 'search'), q!),
      ),
  }).data
}

function contactQuery(slug: string, id: string) {
  return {
    queryKey: keys.contact(slug, id),
    queryFn: async () => {
      try {
        return await get<WireContact>(tenantPath(slug, 'contacts', id))
      } catch (e) {
        if (e instanceof RustApiError && e.error.kind === 'not_found')
          return null
        throw e
      }
    },
  }
}

export function useContact(id: Id<'contacts'>): {
  view: ContactView | null | undefined
  fields: Array<FieldDefinition> | undefined
} {
  const { slug } = useTenant()
  const fields = useFields()
  const wire = useQuery(contactQuery(slug, id)).data
  const view = useMemo(
    () =>
      wire === null
        ? null
        : wire === undefined || fields === undefined
          ? undefined
          : contactFromWire(wire, fields),
    [wire, fields],
  )
  return { view, fields }
}

/** Route loaders: start the page's reads as the navigation starts. */
export function preloadContactList({ queryClient: qc }: Loaders, slug: string) {
  void qc.prefetchQuery(fieldsQuery(slug))
}

export function preloadContact(
  { queryClient: qc }: Loaders,
  slug: string,
  id: string,
) {
  void qc.prefetchQuery(fieldsQuery(slug))
  void qc.prefetchQuery(contactQuery(slug, id))
}

/** No bulk set on Rust: never runs (the list hides the selection). */
export function useBulkSetField(): ReturnType<typeof convexBulkSetField> {
  return { bulk: IDLE, run: async () => {}, dismiss: () => {} }
}
const IDLE = { state: 'idle' } as const

/** Nothing held: no live list to hold on Rust. */
export function releaseListHold() {}

// Not in the Rust spike: nobody to name, no holds or shared-address
// lookups, no identifier types.
const NO_MEMBERS: Array<Member> = []
export const useMembers = (): Array<Member> | undefined => NO_MEMBERS
export const useEmailContext = (
  _id: Id<'contacts'>,
  _emails: ContactView['emails'],
): EmailContext => ({
  alsoUsedBy: undefined,
  held: undefined,
})
export const useIdentifierTypes = (): Array<IdentifierType> => []

// ── writes ─────────────────────────────────────────────────────────────────

export function useSaveContactForm(id: Id<'contacts'>): SaveContactForm {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (submitted, current) => {
    const path = tenantPath(slug, 'contacts', id, 'save')
    let problems = {}
    let sending = submitted
    try {
      for (;;) {
        try {
          const saved =
            Object.keys(sending).length === 0
              ? { slices: {} }
              : await post<WireSaved>(
                  path,
                  saveRequest(sending, current().counters),
                )
          return savedActions(submitted, current(), saved, Date.now(), problems)
        } catch (e) {
          if (!(e instanceof RustApiError))
            return [{ type: 'failed', message: 'Could not save' }]
          if (e.error.kind === 'invalid') {
            const split = splitInvalid(sending, e.error.problems)
            if (!split) return [{ type: 'failed', message: e.message }]
            problems = { ...problems, ...split.problems }
            sending = split.rest
            continue
          }
          if (e.error.kind === 'stale')
            return staleActions(
              submitted,
              current(),
              e.error,
              Date.now(),
              problems,
            )
          return [{ type: 'failed', message: e.message }]
        }
      }
    } finally {
      // The list, search and this contact (its history too) are out of date.
      void qc.invalidateQueries({ queryKey: keys.contacts(slug) })
    }
  }
}

/** A UUIDv7 as 32 hex chars, the API's id format. */
export function mintId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 6; i++)
    bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff
  bytes[6] = 0x70 | (bytes[6] & 0x0f)
  bytes[8] = 0x80 | (bytes[8] & 0x3f)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function useCreateContact(): CreateContact {
  const { slug } = useTenant()
  const qc = useQueryClient()
  // Minted once per form: a double submit lands on the existing contact.
  const id = useMemo(() => mintId(), [])
  return async (details) => {
    try {
      await post<Executed>(tenantPath(slug, 'contacts'), {
        id,
        source: 'ui',
        details,
      })
      return { type: 'created', id: id as Id<'contacts'> }
    } catch (e) {
      if (!(e instanceof RustApiError))
        return { type: 'failed', message: 'Could not save' }
      if (e.error.kind === 'duplicate')
        return { type: 'created', id: e.error.id as Id<'contacts'> }
      if (e.error.kind === 'invalid')
        return {
          type: 'invalid',
          problems: e.error.problems.map((p) => ({
            ...p,
            field: p.field.replace(/^details\./, ''),
          })),
        }
      return { type: 'failed', message: e.message }
    } finally {
      void qc.invalidateQueries({ queryKey: keys.contacts(slug) })
    }
  }
}

// ── history ────────────────────────────────────────────────────────────────

export function useContactHistory(id: Id<'contacts'>) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const revisions = useQuery({
    queryKey: keys.history(slug, id),
    queryFn: () =>
      get<Array<Revision>>(tenantPath(slug, 'contacts', id, 'history')),
  }).data
  const after = () => qc.invalidateQueries({ queryKey: keys.contacts(slug) })
  return {
    revisions,
    restore: async (revision: number) => {
      try {
        await post(tenantPath(slug, 'contacts', id, 'restore'), { revision })
      } finally {
        await after()
      }
    },
    setArchived: async (archived: boolean, expected: number) => {
      try {
        await post(tenantPath(slug, 'contacts', id, 'archive'), {
          expected,
          archived,
        })
      } finally {
        await after()
      }
    },
  }
}
