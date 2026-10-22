import { useQueries } from 'convex/react'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../convex/_generated/api'

/**
 * The contacts list a page at a time (`contacts/queries:list`). Not
 * `usePaginatedQuery`: that adds a counter `id` to the first page's
 * arguments, so the route's hold (list-hold.ts) could never name the same
 * subscription. Page 0 here is exactly `firstPage(args)`; each later page
 * starts at the one before's `continueCursor`, and once it is asked for,
 * the page before is pinned to end there (`endCursor`), so pages stay
 * contiguous while rows come and go. A pinned page whose range grows is
 * split in two at its `splitCursor`: `list` answers `SplitRequired`, with
 * no rows, once it holds more than a page and a bit (the backend's own
 * `SplitRecommended` comes on every full page, so it splits nothing). The
 * list stops at such a page (and says it is loading) until both halves
 * arrive.
 */

type ListArgs = FunctionArgs<typeof api.contacts.queries.list>
type Page = FunctionReturnType<typeof api.contacts.queries.list>
export type ListFilters = Omit<ListArgs, 'paginationOpts'>
export type ListRow = Page['page'][number]

/** Rows a page asks for (the query's own cap, LIST_LIMIT). */
export const LIST_PAGE_SIZE = 100

/**
 * The filters in one fixed key order, so equal filters are equal args.
 * Every filter `list` takes must be here: one left out is silently not
 * applied (the "every filter reaches `list`" test). Field filters keep
 * their order (the first is the index range) and their own key order.
 */
export function listFilters(f: ListFilters): ListFilters {
  return {
    tenantId: f.tenantId,
    includeArchived: f.includeArchived ?? false,
    ...(f.kind && { kind: f.kind }),
    ...(f.source && { source: f.source }),
    ...(f.fields?.length && {
      fields: f.fields.map((x) => ({
        fieldId: x.fieldId,
        optionId: x.optionId,
      })),
    }),
  }
}

/** Page 0's arguments: what the route's hold subscribes to. */
export function firstPage(filters: ListFilters): ListArgs {
  return {
    ...listFilters(filters),
    paginationOpts: { numItems: LIST_PAGE_SIZE, cursor: null },
  }
}

/** One page's range: from `cursor`, to `end` once pinned. */
type Range = { cursor: string | null; end?: string }
/** A page, and the two halves replacing it while a split loads. */
type Slot = Range & { halves?: [Range, Range] }

const rangeKey = (r: Range) => JSON.stringify([r.cursor, r.end ?? null])

export type PagedList = {
  /** Undefined until page 0 has loaded. */
  rows: Array<ListRow> | undefined
  /** More may follow (`loadMore`); 'done' only once the last page says so. */
  status: 'loading' | 'more' | 'done'
  loadMore: () => void
}

/** A Convex error saying a cursor no longer exists (the index changed). */
function invalidCursor(e: Error) {
  const data = (e as { data?: { paginationError?: string } }).data
  return (
    e.message.includes('InvalidCursor') ||
    data?.paginationError === 'InvalidCursor'
  )
}

export function usePagedList(filters: ListFilters | 'skip'): PagedList {
  const key = filters === 'skip' ? 'skip' : JSON.stringify(listFilters(filters))
  const [state, setState] = useState<{ key: string; slots: Array<Slot> }>({
    key,
    slots: [{ cursor: null }],
  })
  const slots = state.key === key ? state.slots : [{ cursor: null }]
  const argsOf = (r: Range): ListArgs => {
    const first = firstPage(filters as ListFilters)
    return r.cursor === null && r.end === undefined
      ? first
      : {
          ...first,
          paginationOpts: {
            numItems: LIST_PAGE_SIZE,
            cursor: r.cursor,
            ...(r.end !== undefined && { endCursor: r.end }),
          },
        }
  }
  const request: Record<string, ListArgs> = {}
  if (filters !== 'skip') {
    for (const s of slots) {
      for (const r of [s, ...(s.halves ?? [])]) request[rangeKey(r)] = argsOf(r)
    }
  }
  // `useQueries` re-subscribes whenever this object is a new one, and its
  // results are new each time, so a fresh object per render never settles
  // ("too many re-renders"). Same requests, same object.
  const requestKey = JSON.stringify(request)
  const queries = useMemo(() => {
    const args = JSON.parse(requestKey) as Record<string, ListArgs>
    const out: Parameters<typeof useQueries>[0] = {}
    for (const [k, a] of Object.entries(args)) {
      out[k] = { query: api.contacts.queries.list, args: a }
    }
    return out
  }, [requestKey])
  const results = useQueries(queries)
  // A page re-subscribing (pinned, or the filters changed back) shows what
  // it last showed rather than blinking to "Loading…": by its range, or for
  // a page just pinned, by where it starts (halves never stand in).
  const last = useRef(new Map<string, Page>())
  const resultOf = (r: Range, slot = true): Page | undefined => {
    const exact = `${key}#${rangeKey(r)}`
    const start = `${key}@${r.cursor}`
    const got = results[rangeKey(r)] as Page | Error | undefined
    if (got instanceof Error) {
      if (invalidCursor(got)) return undefined
      throw got
    }
    if (got) {
      last.current.set(exact, got)
      if (slot) last.current.set(start, got)
      return got
    }
    return (
      last.current.get(exact) ?? (slot ? last.current.get(start) : undefined)
    )
  }

  // Walk the pages in order: rows up to the first one not loaded (or
  // incomplete), and what each page needs doing (pin, split, swap halves).
  const rows: Array<ListRow> = []
  let tail: Page | undefined
  let complete = filters !== 'skip'
  let reset = false
  const next: Array<Slot> = []
  let changed = false
  for (const s of slots) {
    if (!complete) {
      next.push(s)
      continue
    }
    const got = results[rangeKey(s)]
    if (got instanceof Error && invalidCursor(got)) reset = true
    const page = resultOf(s)
    if (s.halves) {
      const [a, b] = s.halves.map((h) => resultOf(h, false))
      if (a && b) {
        // Both halves are in: they replace the page.
        next.push(s.halves[0], s.halves[1])
        changed = true
        rows.push(...a.page, ...b.page)
        tail = b
        continue
      }
      // Until then the page stands (or, if incomplete, holds the list).
      next.push(s)
    } else if (
      page?.splitCursor &&
      // Not on SplitRecommended alone: the backend says it of every
      // 100-row page, and page 0 must keep the hold's args (list-hold.ts).
      // `list` itself answers SplitRequired, with no rows, for a page grown
      // past what it shapes.
      (page.pageStatus === 'SplitRequired' ||
        page.page.length > 2 * LIST_PAGE_SIZE)
    ) {
      next.push({
        ...s,
        halves: [
          { cursor: s.cursor, end: page.splitCursor },
          { cursor: page.splitCursor, end: s.end ?? page.continueCursor },
        ],
      })
      changed = true
    } else {
      next.push(s)
    }
    if (!page || page.pageStatus === 'SplitRequired') {
      complete = false
      continue
    }
    rows.push(...page.page)
    tail = page
  }
  useEffect(() => {
    if (reset) setState({ key, slots: [{ cursor: null }] })
    else if (changed) setState({ key, slots: next })
  })

  const status = !complete || !tail ? 'loading' : tail.isDone ? 'done' : 'more'
  const first = filters === 'skip' ? undefined : resultOf(slots[0])
  return {
    rows: first === undefined ? undefined : rows,
    status,
    loadMore: () => {
      if (status !== 'more' || !tail) return
      const pinned = slots.map((s, i) =>
        i === slots.length - 1 && s.end === undefined
          ? { ...s, end: tail.continueCursor }
          : s,
      )
      setState({ key, slots: [...pinned, { cursor: tail.continueCursor }] })
    },
  }
}
