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
 * `SplitRecommended` comes on every full page, so it splits nothing).
 * Until both halves arrive the page keeps showing its last rows, and the
 * list says it is loading (no Load more meanwhile).
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
/**
 * A page, and the parts replacing it while a split loads: two halves,
 * each of which may split again before it has loaded. Once every part is
 * in, the parts become pages of their own.
 */
type Slot = Range & { halves?: [Slot, Slot] }

/** The ranges a slot subscribes to: itself, or the leaves of its split. */
const leavesOf = (s: Slot): Array<Range> =>
  s.halves ? s.halves.flatMap(leavesOf) : [{ cursor: s.cursor, end: s.end }]

const rangeKey = (r: Range) => JSON.stringify([r.cursor, r.end ?? null])

export type PagedList = {
  /** Undefined until page 0 has loaded. */
  rows: Array<ListRow> | undefined
  /** More may follow (`loadMore`); 'done' only once the last page says so. */
  status: 'loading' | 'more' | 'done'
  loadMore: () => void
}

const warned = new Set<string>()
/** Says once per range that a SplitRequired page can't be split. */
function unsplittable(r: Range) {
  const k = rangeKey(r)
  if (warned.has(k)) return
  warned.add(k)
  console.warn(
    `contacts list: page ${k} asked to split with no usable splitCursor; shown as it is`,
  )
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
      for (const r of leavesOf(s)) request[rangeKey(r)] = argsOf(r)
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
  // a page just pinned, by where it starts (halves never stand in). So
  // does a page to split: its SplitRequired answer has no rows to show
  // (or only part of its range), so it is never what a page last showed.
  const last = useRef(new Map<string, Page>())
  const lastShown = (r: Range, slot: boolean) =>
    last.current.get(`${key}#${rangeKey(r)}`) ??
    (slot ? last.current.get(`${key}@${r.cursor}`) : undefined)
  const resultOf = (r: Range, slot = true): Page | undefined => {
    const got = results[rangeKey(r)] as Page | Error | undefined
    if (got instanceof Error) {
      if (invalidCursor(got)) return undefined
      throw got
    }
    if (got) {
      if (got.pageStatus !== 'SplitRequired') {
        last.current.set(`${key}#${rangeKey(r)}`, got)
        if (slot) last.current.set(`${key}@${r.cursor}`, got)
      }
      return got
    }
    return lastShown(r, slot)
  }

  // One slot's split, part by part: its rows once every part is in (and
  // the parts, flattened, to replace it), else what to subscribe next.
  // A part answering SplitRequired splits again; parts never stand in.
  type Resolved =
    | { done: true; rows: Array<ListRow>; tail: Page; parts: Array<Range> }
    | { done: false; slot: Slot; changed: boolean }
  const resolve = (s: Slot, top: boolean): Resolved => {
    if (s.halves) {
      const [a, b] = s.halves.map((h) => resolve(h, false))
      if (a.done && b.done) {
        return {
          done: true,
          rows: [...a.rows, ...b.rows],
          tail: b.tail,
          parts: [...a.parts, ...b.parts],
        }
      }
      const changed = (!a.done && a.changed) || (!b.done && b.changed)
      return {
        done: false,
        changed,
        slot: changed
          ? {
              ...s,
              halves: [
                a.done ? s.halves[0] : a.slot,
                b.done ? s.halves[1] : b.slot,
              ],
            }
          : s,
      }
    }
    const page = resultOf(s, false)
    if (page?.pageStatus === 'SplitRequired') {
      const at = page.splitCursor
      const end = s.end ?? page.continueCursor
      if (!at || at === s.cursor || at === end) {
        // Nowhere to split, or a split that wouldn't shrink the range
        // (it would split forever): shown as it is, like `list` shows a
        // page with no splitCursor, and the list goes on.
        unsplittable(s)
        const shown = page.page.length
          ? page
          : { ...page, page: lastShown(s, top)?.page ?? [] }
        return { done: true, rows: shown.page, tail: page, parts: [s] }
      }
      return {
        done: false,
        changed: true,
        slot: {
          ...s,
          halves: [
            { cursor: s.cursor, end: at },
            { cursor: at, end },
          ],
        },
      }
    }
    return page
      ? { done: true, rows: page.page, tail: page, parts: [s] }
      : { done: false, changed: false, slot: s }
  }

  // Walk the pages in order: what each needs doing (pin, split, swap in
  // its parts), and the rows to show. A page still loading, or being
  // split, shows what it last showed; the list is then 'loading' (no Load
  // more), and stops only at a page with nothing to show yet. Only
  // SplitRequired splits a page, which `list` answers (with no rows) for
  // one grown past what it shapes. Not SplitRecommended: the backend says
  // it of every full page, and page 0 must keep the hold's args
  // (list-hold.ts).
  const rows: Array<ListRow> = []
  // A row moving across a page boundary while a page shows its last rows
  // would show twice: once is enough.
  const seen = new Set<string>()
  const push = (page: Array<ListRow>) => {
    for (const row of page) {
      if (seen.has(row._id)) continue
      seen.add(row._id)
      rows.push(row)
    }
  }
  let tail: Page | undefined
  let complete = filters !== 'skip'
  let walking = complete
  let reset = false
  const next: Array<Slot> = []
  let changed = false
  for (const s of slots) {
    if (!walking) {
      next.push(s)
      continue
    }
    for (const r of leavesOf(s)) {
      const got = results[rangeKey(r)]
      if (got instanceof Error && invalidCursor(got)) reset = true
    }
    const r = resolve(s, true)
    if (r.done) {
      // A page that split: its parts are pages now.
      if (s.halves) changed = true
      next.push(...r.parts)
      push(r.rows)
      tail = r.tail
      // As the page shows now, for when it re-subscribes (pinned).
      if (!s.halves) resultOf(s)
      continue
    }
    if (r.changed) changed = true
    next.push(r.slot)
    complete = false
    const shown = lastShown(s, true)
    if (!shown) {
      walking = false
      continue
    }
    push(shown.page)
    tail = shown
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
