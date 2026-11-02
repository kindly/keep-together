/**
 * Source codes on the Rust API (`/api/t/{slug}/sources…`), through
 * TanStack Query: the Settings tree, the contacts list's filter options,
 * the picker, and a contact's acquisition code. Reads are refetched when
 * the tenant's event stream says a part changed (`../events.ts`); writes
 * answer the server's state and the caller waits for it (a source code on
 * a contact is a record of how they were recruited: nothing optimistic).
 *
 * Parts come back in the shape the pages render (`_id`), so
 * the tab, the picker and their tests keep their types.
 */
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import type { Id } from '../../domain/ids'
import { useTenant } from '../../tenant'
import type { Loaders } from '../types'
import { ownWrite, showAnswer } from '../events'
import type { AcquisitionSet } from '../rust-types/AcquisitionSet'
import type { ContactView as WireContact } from '../rust-types/ContactView'
import type { DeletedSourceCode } from '../rust-types/DeletedSourceCode'
import type { Executed } from '../rust-types/Executed'
import type { SourceCodeDescription as WireDescription } from '../rust-types/SourceCodeDescription'
import type { SourceCodePart } from '../rust-types/SourceCodePart'
import type { SourceCodeCreated } from '../rust-types/SourceCodeCreated'
import type { SourceCodePayload } from '../rust-types/SourceCodePayload'
import type { SourceCodeSaved } from '../rust-types/SourceCodeSaved'
import type { SourceCodeTree } from '../rust-types/SourceCodeTree'
import type { SourceFilterOption } from '../rust-types/SourceFilterOption'
import type { SourcePicker } from '../rust-types/SourcePicker'
import type { SourcePickerEntry } from '../rust-types/SourcePickerEntry'
import { get, post, postWrite, tenantPath } from './client'
import { keys } from './keys'

type CodeId = Id<'sourceCodes'>

/** One row of the Settings tree. */
export type Part = Omit<SourceCodePart, 'id' | 'parentId'> & {
  _id: CodeId
  parentId?: CodeId
}

/** One part as the contacts list's source filter shows it. */
export type FilterOption = Omit<SourceFilterOption, 'id' | 'parentId'> & {
  _id: CodeId
  parentId?: CodeId
}

/** An assignable code, as the picker lists it. */
export type PickerEntry = Omit<SourcePickerEntry, 'versionId'> & {
  versionId: CodeId
}

/** A code by its version id, as a contact carries it. */
export type SourceCodeDescription = Omit<
  WireDescription,
  'versionId' | 'detailId' | 'categoryId'
> & { versionId: CodeId; detailId: CodeId; categoryId: CodeId }

export type { SourceCodePayload }

export function partFromWire({ id, parentId, ...p }: SourceCodePart): Part {
  return {
    ...p,
    _id: id as CodeId,
    ...(parentId && { parentId: parentId as CodeId }),
  }
}

export function describedFromWire(d: WireDescription): SourceCodeDescription {
  return d as SourceCodeDescription
}

// ── reads ──────────────────────────────────────────────────────────────────

/** The Settings tree as `useSourceTree` holds it. */
const treeFromWire = (t: SourceCodeTree) => ({
  parts: t.parts.map(partFromWire),
  canManage: t.canManage,
})

function treeQuery(slug: string) {
  return {
    queryKey: keys.sourceTree(slug),
    queryFn: async () =>
      treeFromWire(await get<SourceCodeTree>(tenantPath(slug, 'sources'))),
  }
}

/** Every part in tree order, archived included, and whether I may manage them. */
export function useSourceTree():
  { parts: Array<Part>; canManage: boolean } | undefined {
  return useQuery(treeQuery(useTenant().slug)).data
}

/** The Settings tab's loader: the tree starts as the navigation does. */
export function preloadSourceTree({ queryClient: qc }: Loaders, slug: string) {
  void qc.prefetchQuery(treeQuery(slug))
}

/** Every part with only what the list's filter shows; archived too. */
export function useSourceFilterOptions(): Array<FilterOption> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.sourceOptions(slug),
    queryFn: async () =>
      (
        await get<Array<SourceFilterOption>>(
          tenantPath(slug, 'sources', 'filter-options'),
        )
      ).map(({ id, parentId, ...o }) => ({
        ...o,
        _id: id as CodeId,
        ...(parentId && { parentId: parentId as CodeId }),
      })),
  }).data
}

/**
 * Assignable codes matching `search`, at most 50, in date first on
 * `today`. While a new search loads, the last answer stands.
 */
export function useSourcePicker(
  args: { today: string; search: string } | 'skip',
): { codes: Array<PickerEntry>; truncated: boolean } | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.sourcePicker(slug, args === 'skip' ? undefined : args),
    enabled: args !== 'skip',
    placeholderData: keepPreviousData,
    queryFn: async () => {
      if (args === 'skip') throw new Error('skipped')
      const q = new URLSearchParams({ today: args.today })
      if (args.search) q.set('search', args.search)
      const p = await get<SourcePicker>(
        tenantPath(slug, 'sources', 'picker'),
        q,
      )
      return p as { codes: Array<PickerEntry>; truncated: boolean }
    },
  }).data
}

// ── writes ─────────────────────────────────────────────────────────────────

/** Every read showing parts: the tree, the filter, the picker. */
export function sourcesChanged(qc: QueryClient, slug: string) {
  return qc.invalidateQueries({ queryKey: keys.sources(slug) })
}

/**
 * Create, save and delete parts. Each resolves once the server has
 * answered and the tree shows it (from the answer for a create or a save,
 * refetched after a delete), and throws `RustApiError` when refused
 * (`stale` carries the part as it is now). A save's or a create's event
 * refetches the filter, the picker and the contacts (a name or an archive
 * shows on every contact carrying a code under it), not the tree.
 */
export function useSourceWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const after = async <T>(write: Promise<T>): Promise<T> => {
    try {
      return await write
    } finally {
      await sourcesChanged(qc, slug)
    }
  }
  const shown = async <T extends { tree: SourceCodeTree }>(
    path: string,
    body: unknown,
  ): Promise<T> => {
    try {
      return await showAnswer(
        qc,
        slug,
        () => postWrite<T>(path, body),
        (done) => [[keys.sourceTree(slug), treeFromWire(done.tree)]],
      )
    } catch (e) {
      // Refused: show the tree as it is now.
      void sourcesChanged(qc, slug)
      throw e
    }
  }
  return {
    create: async (payload: SourceCodePayload) => {
      const c = await shown<SourceCodeCreated>(
        tenantPath(slug, 'sources'),
        payload,
      )
      return {
        id: c.id as CodeId,
        versionId: c.versionId as CodeId | undefined,
      }
    },
    save: async (
      id: CodeId,
      expected: number,
      payload: SourceCodePayload,
    ): Promise<Executed> => {
      const done = await shown<SourceCodeSaved>(
        tenantPath(slug, 'sources', id, 'save'),
        { ...payload, expected },
      )
      return { id: done.id, counter: done.counter }
    },
    remove: (id: CodeId, expected: number) =>
      after(
        post<DeletedSourceCode>(tenantPath(slug, 'sources', id, 'delete'), {
          expected,
        }),
      ),
  }
}

/**
 * Set or clear a contact's acquisition code. The answer carries the
 * contact's view, which lands in its query at once (no read of its own)
 * unless the cache already holds a newer one; the lists, which filter by
 * it, refetch.
 */
export function useSetAcquisition(id: Id<'contacts'>) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (codeId: CodeId | null, expected: number) => {
    const done = await post<AcquisitionSet>(
      tenantPath(slug, 'contacts', id, 'acquisition'),
      { expected, codeId },
    )
    ownWrite(slug, id, 'contacts.acquisition', done.counter)
    const view = keys.contact(slug, id)
    // A refetch begun before our commit would land the older view on top.
    // One begun after it (an event's, reading a later commit) is lost
    // when cancelled: it is run again once the answer is in.
    const inFlight = qc.isFetching({ queryKey: view, exact: true }) > 0
    await qc.cancelQueries({ queryKey: view, exact: true })
    // So would this answer, if it was delayed past a later save of the
    // contact that a refetch has already shown: install it only if no
    // slice is behind what is cached, else read the contact again.
    const cached = qc.getQueryData<WireContact | null>(view)
    const counters = done.view.counters
    if (
      cached &&
      (Object.keys(counters) as Array<keyof typeof counters>).some(
        (s) => cached.counters[s] > counters[s],
      )
    )
      void qc.invalidateQueries({ queryKey: view, exact: true })
    else {
      qc.setQueryData(view, done.view)
      if (inFlight) void qc.invalidateQueries({ queryKey: view, exact: true })
    }
    void qc.invalidateQueries({ queryKey: keys.list(slug) })
    void qc.invalidateQueries({ queryKey: keys.search(slug) })
    void qc.invalidateQueries({ queryKey: keys.history(slug, id) })
    // A first use marks the code used: the tree's delete becomes archive.
    void sourcesChanged(qc, slug)
    return { id: done.id, counter: done.counter }
  }
}
