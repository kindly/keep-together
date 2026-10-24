/**
 * The contacts pages on the Rust API, through TanStack Query. A read is
 * fetched once and kept until something invalidates it: this tab's own
 * writes (each hook below), and every other change through the tenant's
 * event stream (`../events.ts`). A save against a change not yet seen
 * merges the stale slice at once (`save.ts`).
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
import { newKey } from '../../contact-form-state'
import { LIST_PAGE_SIZE } from '../../paged-list'
import type { ListFilters, PagedList } from '../../paged-list'
import type { Tenant } from '../../tenant'
import { useTenant } from '../../tenant'
import { ownWrite, setCursor } from '../events'
import type { ContactPage } from '../rust-types/ContactPage'
import type { ContactView as WireContact } from '../rust-types/ContactView'
import type { ArchivedContact } from '../rust-types/ArchivedContact'
import type { Boot } from '../rust-types/Boot'
import type { CreatedContact } from '../rust-types/CreatedContact'
import type { FieldDefinition as WireField } from '../rust-types/FieldDefinition'
import type { HistoryPage } from '../rust-types/HistoryPage'
import type { RestoredContact } from '../rust-types/RestoredContact'
import type { Group } from '../rust-types/Group'
import type { Me } from '../rust-types/Me'
import type { SaveFormResult } from '../rust-types/SaveFormResult'
import type { SearchResult as WireSearch } from '../rust-types/SearchResult'
import type {
  ContactView,
  CreateContact,
  FieldDefinition,
  Loaders,
  Member,
  SaveContactForm,
  SearchArgs,
  SearchResult,
} from '../types'
import { RustApiError, get, post, tenantPath } from './client'
import { keys } from './keys'
import { saveActions, saveRequest } from './save'
import {
  contactFromWire,
  fieldsFromWire,
  filterParams,
  rowFromWire,
  searchFromWire,
  searchParams,
} from './wire'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refused requests (403, 404 …) won't change on a retry.
      retry: (failures, error) =>
        !(error instanceof RustApiError && error.status >= 400) && failures < 2,
      // Fresh until invalidated: the event stream says when a tenant's
      // data changed, so a remount or a refocus needn't ask again.
      staleTime: Infinity,
    },
  },
})

// ── session ────────────────────────────────────────────────────────────────

async function fetchMe(): Promise<Me | null> {
  try {
    return await get<Me>('me')
  } catch (e) {
    if (e instanceof RustApiError && e.status === 401) return null
    throw e
  }
}

/** The signed-in user; null when signed out, undefined while loading. */
function useMe(): Me | null | undefined {
  const me = useQuery({
    queryKey: keys.me,
    queryFn: fetchMe,
    // Memberships change without a tenant event (an invite elsewhere).
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
  return me.data
}

/** `GET /api/groups` (`mine`); null when signed out. */
async function fetchGroups(): Promise<Array<Group> | null> {
  try {
    return await get<Array<Group>>('groups')
  } catch (e) {
    if (e instanceof RustApiError && e.status === 401) return null
    throw e
  }
}

const groupsQuery = {
  queryKey: keys.groups,
  queryFn: fetchGroups,
  // Memberships change without a tenant event (an invite elsewhere); a
  // switch saved in this group arrives as its event (events.ts).
  staleTime: 60_000,
  refetchOnWindowFocus: true,
}

function tenantOf(g: Group): Tenant {
  // The slug stands in for the id: the Rust API is addressed by slug.
  return { _id: g.slug as Id<'tenants'>, ...g }
}

const MyTenants = createContext<Array<Tenant> | undefined>(undefined)

/**
 * The caller's groups, with each one's role, "last used" and list
 * switches. Asked for alongside `/boot` on a cold load (`boot` below), not
 * after it.
 */
export function MyTenantsProvider({ children }: { children: ReactNode }) {
  const groups = useQuery(groupsQuery).data
  const tenants = useMemo(() => groups?.map(tenantOf), [groups])
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
    // Everything read was the last user's: drop it, refetch what's shown.
    await qc.resetQueries()
  }
}

export function useSignOut() {
  const qc = useQueryClient()
  return async () => {
    await post('dev/logout')
    // Everything read was the last user's: drop it, refetch what's shown.
    await qc.resetQueries()
  }
}

// ── cold load ──────────────────────────────────────────────────────────────

/** The list's key with no filters: the page the boot carries. */
const unfiltered = (slug: string) => keys.list(slug, { q: '' })

/**
 * A cold load of a tenant page: one request answers the session, the
 * field definitions and the unfiltered list's first page, and seeds each
 * one's query, so the hooks that ask for them as the page mounts join it
 * instead of asking themselves. Called once, before the first render
 * (`main.tsx`). If it fails, each query asks on its own.
 */
export function boot(qc: QueryClient, slug: string) {
  const answer = get<Boot>(tenantPath(slug, 'boot'))
  // In parallel: the tenant layout needs the caller's groups too.
  void qc.prefetchQuery(groupsQuery)
  // Before anything it answers can render: the stream opens after it.
  void answer.then(
    (b) => setCursor(slug, b.seq),
    () => {},
  )
  void qc.prefetchQuery({
    queryKey: keys.me,
    queryFn: () => answer.then((b) => b.me, fetchMe),
  })
  void qc.prefetchQuery({
    ...fieldsQuery(slug),
    queryFn: () => answer.then((b) => fieldsFromWire(b.fields)),
  })
  void qc.prefetchInfiniteQuery({
    queryKey: unfiltered(slug),
    initialPageParam: null as string | null,
    queryFn: () => answer.then((b) => b.firstPage),
  })
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
      if (pageParam) q.set('cursor', pageParam)
      return get<ContactPage>(tenantPath(slug, 'contacts'), q)
    },
    getNextPageParam: (page) => (page.isDone ? null : page.nextCursor),
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
  const q = args === 'skip' ? null : searchParams(args)
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

// Not ported yet (A3): nobody to name.
const NO_MEMBERS: Array<Member> = []
export const useMembers = (): Array<Member> | undefined => NO_MEMBERS

// ── writes ─────────────────────────────────────────────────────────────────

export function useSaveContactForm(id: Id<'contacts'>): SaveContactForm {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (submitted, current) => {
    try {
      const answer = await post<SaveFormResult>(
        tenantPath(slug, 'contacts', id, 'save'),
        saveRequest(submitted, current().counters),
      )
      for (const slice of answer.saved)
        ownWrite(
          slug,
          id,
          `contacts.${slice}`,
          answer.counters[slice as keyof SaveFormResult['counters']],
        )
      return saveActions(submitted, current(), answer, Date.now())
    } catch (e) {
      return [
        {
          type: 'failed',
          message: e instanceof RustApiError ? e.message : 'Could not save',
        },
      ]
    } finally {
      // The list, search and this contact (its history too) are out of date.
      void qc.invalidateQueries({ queryKey: keys.contacts(slug) })
      // So are "also used by" of this contact and any sharing an address.
      void qc.invalidateQueries({ queryKey: keys.emailContext(slug) })
    }
  }
}

export function useCreateContact(): CreateContact {
  const { slug } = useTenant()
  const qc = useQueryClient()
  // Minted once per form: a double submit lands on the existing contact.
  const clientKey = useMemo(newKey, [])
  return async (details) => {
    try {
      const created = await post<CreatedContact>(tenantPath(slug, 'contacts'), {
        clientKey,
        ...details,
      })
      // The page it opens on draws from this: no read of its own.
      qc.setQueryData(keys.contact(slug, created.id), created.view)
      return { type: 'created', id: created.id as Id<'contacts'> }
    } catch (e) {
      if (!(e instanceof RustApiError))
        return { type: 'failed', message: 'Could not save' }
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
      void listsChanged(qc, slug)
    }
  }
}

/** The list and search show every contact's row: refetch what's shown. */
function listsChanged(qc: QueryClient, slug: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.list(slug) }),
    qc.invalidateQueries({ queryKey: keys.search(slug) }),
  ])
}

// ── history ────────────────────────────────────────────────────────────────

/** The latest revisions (one page, newest first), restore and archive. */
export function useContactHistory(id: Id<'contacts'>) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const revisions = useQuery({
    queryKey: keys.history(slug, id),
    queryFn: async () =>
      (await get<HistoryPage>(tenantPath(slug, 'contacts', id, 'history')))
        .revisions,
  }).data
  // Each write answers the contact's view: it lands at once, and only the
  // lists and the history are fetched again. A refused one (a 409:
  // changed elsewhere meanwhile) refetches the view too, so the switch and
  // the form catch up.
  const landed = (view: WireContact) => {
    qc.setQueryData(keys.contact(slug, id), view)
    void qc.invalidateQueries({ queryKey: keys.history(slug, id) })
    return listsChanged(qc, slug)
  }
  const refused = () => qc.invalidateQueries({ queryKey: keys.contacts(slug) })
  return {
    revisions,
    restore: async (revisionId: number) => {
      let done: RestoredContact
      try {
        done = await post<RestoredContact>(
          tenantPath(slug, 'contacts', id, 'restore'),
          { revisionId },
        )
      } catch (e) {
        await refused()
        throw e
      }
      for (const contract of done.restored) {
        const slice = contract.split('.')[1] as keyof WireContact['counters']
        ownWrite(slug, id, contract, done.view.counters[slice])
      }
      await landed(done.view)
    },
    setArchived: async (archived: boolean, expected: number) => {
      let done: ArchivedContact
      try {
        done = await post<ArchivedContact>(
          tenantPath(slug, 'contacts', id, 'archive'),
          { expected, archived },
        )
      } catch (e) {
        await refused()
        throw e
      }
      ownWrite(slug, id, 'contacts.archive', done.counter)
      await landed(done.view)
    },
  }
}
