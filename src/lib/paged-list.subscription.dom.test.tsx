// @vitest-environment happy-dom
/**
 * usePagedList against Convex's real `useQueries` machinery
 * (`useQueriesHelper` with a fake watch per query), not a mock of it. The
 * real hook memoises its subscription on the identity of the `queries`
 * object, and its results are a new object every read, so a hook that
 * builds `queries` afresh each render re-subscribes every render: React's
 * "too many re-renders" (main 6af1e20 crashed the contacts page so).
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import { usePagedList } from './paged-list'
import type { ListFilters, PagedList } from './paged-list'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Result = {
  page: Array<{ _id: string }>
  isDone: boolean
  continueCursor: string
}
type Opts = { cursor: string | null; endCursor?: string }

/** What the server holds, by [cursor, endCursor]; missing = loading. */
let server: Record<string, Result>
let listeners: Set<() => void>
let renders: number
const keyOf = (o: Opts) => JSON.stringify([o.cursor, o.endCursor ?? null])

/** One stable watch factory, as `useQueries` memoises on the client. */
const createWatch = (_query: unknown, args: { paginationOpts: Opts }) => ({
  onUpdate: (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  localQueryResult: () => server[keyOf(args.paginationOpts)],
  journal: () => undefined,
})

vi.mock('convex/react', async () => {
  const { useQueriesHelper } = await import(
    // Not re-exported from convex/react; the real hook takes a watch maker.
    // @ts-expect-error -- the built file's types live under esm-types
    '../../node_modules/convex/dist/esm/react/use_queries.js'
  )
  return {
    useQueries: (q: unknown) => useQueriesHelper(q, createWatch),
  }
})

const tenantId = 'tenantA' as Id<'tenants'>
const filters = { tenantId, includeArchived: false }
let root: Root
let got: PagedList

/** The page's filters; a test may build them afresh each render. */
let filtersOf: () => ListFilters = () => filters

function Probe() {
  renders++
  got = usePagedList(filtersOf())
  return null
}
const render = () => act(() => root.render(<Probe />))
/** The server pushes an update, as a query result arriving does. */
const push = () => act(() => listeners.forEach((l) => l()))

beforeEach(() => {
  server = {}
  listeners = new Set()
  renders = 0
  filtersOf = () => filters
  root = createRoot(document.createElement('div'))
})
afterEach(() => act(() => root.unmount()))

test('renders settle: loading, the first page, more pages, a re-render', async () => {
  await render()
  expect(got.status).toBe('loading')
  server[keyOf({ cursor: null })] = {
    page: [{ _id: 'a' }],
    isDone: false,
    continueCursor: 'c1',
  }
  await push()
  expect(got).toMatchObject({ rows: [{ _id: 'a' }], status: 'more' })
  await act(() => got.loadMore())
  server[keyOf({ cursor: null, endCursor: 'c1' })] =
    server[keyOf({ cursor: null })]
  server[keyOf({ cursor: 'c1' })] = {
    page: [{ _id: 'b' }],
    isDone: true,
    continueCursor: 'c2',
  }
  await push()
  expect(got).toMatchObject({
    rows: [{ _id: 'a' }, { _id: 'b' }],
    status: 'done',
  })
  const settled = renders
  await render()
  expect(renders - settled).toBeLessThanOrEqual(2)
})

test('a split settles too: SplitRequired, then its halves replace it', async () => {
  server[keyOf({ cursor: null })] = {
    page: [{ _id: 'a' }],
    isDone: true,
    continueCursor: 'end',
    splitCursor: 's',
    pageStatus: 'SplitRequired',
  } as Result
  await render()
  expect(got.status).toBe('loading')
  server[keyOf({ cursor: null, endCursor: 's' })] = {
    page: [{ _id: 'a' }],
    isDone: false,
    continueCursor: 's',
  }
  server[keyOf({ cursor: 's', endCursor: 'end' })] = {
    page: [{ _id: 'b' }],
    isDone: true,
    continueCursor: 'end',
  }
  await push()
  expect(got).toMatchObject({
    rows: [{ _id: 'a' }, { _id: 'b' }],
    status: 'done',
  })
  const settled = renders
  await render()
  expect(renders - settled).toBeLessThanOrEqual(2)
})

test('after Load more, an empty SplitRequired page 0 splits and settles', async () => {
  server[keyOf({ cursor: null })] = {
    page: [{ _id: 'a' }],
    isDone: false,
    continueCursor: 'c1',
  }
  await render()
  await act(() => got.loadMore())
  server[keyOf({ cursor: 'c1' })] = {
    page: [{ _id: 'z' }],
    isDone: true,
    continueCursor: 'c2',
  }
  // Pinned page 0 grew past what `list` shapes: no rows, split here.
  server[keyOf({ cursor: null, endCursor: 'c1' })] = {
    page: [],
    isDone: false,
    continueCursor: 'c1',
    splitCursor: 's',
    pageStatus: 'SplitRequired',
  } as Result
  await push()
  expect(got).toMatchObject({ rows: [], status: 'loading' })
  server[keyOf({ cursor: null, endCursor: 's' })] = {
    page: [{ _id: 'a' }, { _id: 'b' }],
    isDone: false,
    continueCursor: 's',
  }
  server[keyOf({ cursor: 's', endCursor: 'c1' })] = {
    page: [{ _id: 'c' }],
    isDone: false,
    continueCursor: 'c1',
  }
  await push()
  expect(got).toMatchObject({
    rows: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }, { _id: 'z' }],
    status: 'done',
  })
  const settled = renders
  await render()
  expect(renders - settled).toBeLessThanOrEqual(2)
})

test('a full page marked SplitRecommended settles unsplit', async () => {
  server[keyOf({ cursor: null })] = {
    page: [{ _id: 'a' }],
    isDone: false,
    continueCursor: 'c1',
    splitCursor: 's',
    pageStatus: 'SplitRecommended',
  } as Result
  await render()
  expect(got).toMatchObject({ rows: [{ _id: 'a' }], status: 'more' })
  const settled = renders
  await render()
  await push()
  expect(renders - settled).toBeLessThanOrEqual(3)
})

test('field filters built afresh each render still settle', async () => {
  // The contacts page builds its field filters from state on every render:
  // a new array of new objects each time, equal in value.
  filtersOf = () => ({
    tenantId,
    includeArchived: false,
    fields: [
      {
        fieldId: 'field1' as Id<'contactFields'>,
        optionId: 'option1' as Id<'contactFieldOptions'>,
      },
      { fieldId: 'field2' as Id<'contactFields'>, optionId: null },
    ],
  })
  server[keyOf({ cursor: null })] = {
    page: [{ _id: 'a' }],
    isDone: true,
    continueCursor: 'c1',
  }
  await render()
  expect(got).toMatchObject({ rows: [{ _id: 'a' }], status: 'done' })
  const settled = renders
  await render()
  await push()
  expect(renders - settled).toBeLessThanOrEqual(3)
})
