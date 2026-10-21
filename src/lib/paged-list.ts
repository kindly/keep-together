import { useQueries } from 'convex/react'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useRef, useState } from 'react'
import { api } from '../../convex/_generated/api'

/**
 * The contacts list a page at a time (`contacts/queries:list`). Not
 * `usePaginatedQuery`: that adds a counter `id` to the first page's
 * arguments, so the route's hold (list-hold.ts) could never name the same
 * subscription. Page 0 here is exactly `firstPage(args)`; each later page
 * starts at the one before's `continueCursor`, and once it is asked for,
 * the page before is pinned to end there (`endCursor`), as
 * `usePaginatedQuery` does, so pages stay contiguous while rows come and go.
 */

type ListArgs = FunctionArgs<typeof api.contacts.queries.list>
type Page = FunctionReturnType<typeof api.contacts.queries.list>
export type ListFilters = Omit<ListArgs, 'paginationOpts'>
export type ListRow = Page['page'][number]

/** Rows a page asks for (the query's own cap, LIST_LIMIT). */
export const LIST_PAGE_SIZE = 100

/** The filters in one fixed key order, so equal filters are equal args. */
export function listFilters(f: ListFilters): ListFilters {
  return {
    tenantId: f.tenantId,
    includeArchived: f.includeArchived ?? false,
    ...(f.kind && { kind: f.kind }),
    ...(f.source && { source: f.source }),
  }
}

/** Page 0's arguments: what the route's hold subscribes to. */
export function firstPage(filters: ListFilters): ListArgs {
  return {
    ...listFilters(filters),
    paginationOpts: { numItems: LIST_PAGE_SIZE, cursor: null },
  }
}

export type PagedList = {
  /** Undefined until page 0 has loaded. */
  rows: Array<ListRow> | undefined
  /** More may follow (`loadMore`); 'done' only once the last page says so. */
  status: 'loading' | 'more' | 'done'
  loadMore: () => void
}

export function usePagedList(filters: ListFilters | 'skip'): PagedList {
  const key = filters === 'skip' ? 'skip' : JSON.stringify(listFilters(filters))
  // ends[i]: the cursor page i is pinned to end at (page i + 1's start).
  const [state, setState] = useState<{ key: string; ends: Array<string> }>({
    key,
    ends: [],
  })
  const ends = state.key === key ? state.ends : []
  const queries: Parameters<typeof useQueries>[0] = {}
  if (filters !== 'skip') {
    const first = firstPage(filters)
    for (let i = 0; i <= ends.length; i++) {
      queries[i] = {
        query: api.contacts.queries.list,
        args:
          i === 0 && ends.length === 0
            ? first
            : {
                ...first,
                paginationOpts: {
                  numItems: LIST_PAGE_SIZE,
                  cursor: i === 0 ? null : ends[i - 1],
                  ...(i < ends.length && { endCursor: ends[i] }),
                },
              },
      }
    }
  }
  const results = useQueries(queries)
  // A page re-subscribing (pinned, or the filters changed back) shows what
  // it last showed rather than blinking to "Loading…".
  const last = useRef(new Map<string, Page>())
  const pages: Array<Page | undefined> = []
  for (let i = 0; i <= ends.length && filters !== 'skip'; i++) {
    const r = results[i] as Page | Error | undefined
    if (r instanceof Error) throw r
    const pageKey = `${key}#${i}`
    if (r) last.current.set(pageKey, r)
    pages.push(r ?? last.current.get(pageKey))
  }
  const loaded = pages.every((p) => p !== undefined)
  const tail = pages[pages.length - 1]
  return {
    rows:
      filters === 'skip' || pages[0] === undefined
        ? undefined
        : pages.flatMap((p) => p?.page ?? []),
    status: !loaded || !tail ? 'loading' : tail.isDone ? 'done' : 'more',
    loadMore: () => {
      if (!loaded || !tail || tail.isDone) return
      setState({ key, ends: [...ends, tail.continueCursor] })
    },
  }
}
