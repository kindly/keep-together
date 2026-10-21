// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import { firstPage, usePagedList } from './paged-list'
import type { ListFilters, PagedList } from './paged-list'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Request = Record<string, { args: Record<string, unknown> }>
const useQueries = vi.fn()
vi.mock('convex/react', () => ({
  useQueries: (q: Request) => useQueries(q),
}))

const tenantId = 'tenantA' as Id<'tenants'>
const row = (id: string) => ({ _id: id })
let root: Root
let el: HTMLDivElement
let got: PagedList

function Probe({ filters }: { filters: ListFilters | 'skip' }) {
  got = usePagedList(filters)
  return null
}
const render = (filters: ListFilters | 'skip') =>
  act(() => root.render(<Probe filters={filters} />))
const lastRequest = (): Request => useQueries.mock.lastCall![0]

beforeEach(() => {
  el = document.createElement('div')
  root = createRoot(el)
  useQueries.mockReset()
})
afterEach(() => act(() => root.unmount()))

test("page 0's args are the hold's, byte for byte, whatever order the page builds filters in", async () => {
  useQueries.mockReturnValue({})
  await render({ includeArchived: false, tenantId })
  expect(JSON.stringify(lastRequest()[0].args)).toBe(
    JSON.stringify(firstPage({ tenantId, includeArchived: false })),
  )
  expect(got).toMatchObject({ rows: undefined, status: 'loading' })
})

test('load more starts at the cursor and pins the page before to end there', async () => {
  useQueries.mockReturnValue({
    0: { page: [row('a')], isDone: false, continueCursor: 'c1' },
  })
  await render({ tenantId, includeArchived: false })
  expect(got).toMatchObject({ rows: [row('a')], status: 'more' })
  // While page 0 re-subscribes pinned and page 1 loads, page 0 still shows.
  useQueries.mockReturnValue({})
  await act(() => got.loadMore())
  const req = lastRequest()
  expect(req[0].args.paginationOpts).toEqual({
    numItems: 100,
    cursor: null,
    endCursor: 'c1',
  })
  expect(req[1].args.paginationOpts).toEqual({ numItems: 100, cursor: 'c1' })
  expect(got).toMatchObject({ rows: [row('a')], status: 'loading' })
  useQueries.mockReturnValue({
    0: { page: [row('a')], isDone: false, continueCursor: 'c1' },
    1: { page: [row('b')], isDone: true, continueCursor: 'c2' },
  })
  await render({ tenantId, includeArchived: false })
  expect(got).toMatchObject({ rows: [row('a'), row('b')], status: 'done' })
})

test('new filters start again from one page; skip asks for nothing', async () => {
  useQueries.mockReturnValue({
    0: { page: [], isDone: false, continueCursor: 'c1' },
  })
  await render({ tenantId, includeArchived: false })
  await act(() => got.loadMore())
  await render({ tenantId, includeArchived: true })
  expect(Object.keys(lastRequest())).toEqual(['0'])
  await render('skip')
  expect(lastRequest()).toEqual({})
  expect(got.rows).toBeUndefined()
})
