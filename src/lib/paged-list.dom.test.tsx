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
type Result = {
  page: Array<{ _id: string }>
  isDone: boolean
  continueCursor: string
  splitCursor?: string
  pageStatus?: 'SplitRecommended' | 'SplitRequired'
}
const useQueries = vi.fn()
vi.mock('convex/react', () => ({
  useQueries: (q: Request) => useQueries(q),
}))

const tenantId = 'tenantA' as Id<'tenants'>
const filters = { tenantId, includeArchived: false }
const row = (id: string) => ({ _id: id })
/** The hook's key for the page from `cursor` (to `end`, once pinned). */
const at = (cursor: string | null, end?: string) =>
  JSON.stringify([cursor, end ?? null])
let root: Root
let el: HTMLDivElement
let got: PagedList
/** What the server holds, by page key; anything else is still loading. */
let server: Record<string, Result>

function Probe({ filters: f }: { filters: ListFilters | 'skip' }) {
  got = usePagedList(f)
  return null
}
const render = (f: ListFilters | 'skip' = filters) =>
  act(() => root.render(<Probe filters={f} />))
const lastRequest = (): Request => useQueries.mock.lastCall![0]
const asked = () => Object.keys(lastRequest())

beforeEach(() => {
  el = document.createElement('div')
  root = createRoot(el)
  server = {}
  useQueries.mockReset()
  useQueries.mockImplementation((q: Request) =>
    Object.fromEntries(Object.keys(q).map((k) => [k, server[k]])),
  )
})
afterEach(() => act(() => root.unmount()))

test("page 0's args are the hold's, byte for byte, whatever order the page builds filters in", async () => {
  await render({ includeArchived: false, tenantId })
  expect(JSON.stringify(lastRequest()[at(null)].args)).toBe(
    JSON.stringify(firstPage({ tenantId, includeArchived: false })),
  )
  expect(got).toMatchObject({ rows: undefined, status: 'loading' })
})

test('load more starts at the cursor and pins the page before to end there', async () => {
  server[at(null)] = { page: [row('a')], isDone: false, continueCursor: 'c1' }
  await render()
  expect(got).toMatchObject({ rows: [row('a')], status: 'more' })
  await act(() => got.loadMore())
  const req = lastRequest()
  expect(req[at(null, 'c1')].args.paginationOpts).toEqual({
    numItems: 100,
    cursor: null,
    endCursor: 'c1',
  })
  expect(req[at('c1')].args.paginationOpts).toEqual({
    numItems: 100,
    cursor: 'c1',
  })
  // Page 0 re-subscribes pinned and page 1 loads: page 0 still shows.
  expect(got).toMatchObject({ rows: [row('a')], status: 'loading' })
  server[at(null, 'c1')] = server[at(null)]
  server[at('c1')] = { page: [row('b')], isDone: true, continueCursor: 'c2' }
  await render()
  expect(got).toMatchObject({ rows: [row('a'), row('b')], status: 'done' })
})

test('a page marked SplitRequired holds the list until its halves replace it', async () => {
  server[at(null)] = { page: [row('a')], isDone: false, continueCursor: 'c1' }
  await render()
  await act(() => got.loadMore())
  server[at('c1')] = { page: [row('z')], isDone: true, continueCursor: 'c2' }
  // Rows arrived in page 0's pinned range: it read its cap and stopped.
  server[at(null, 'c1')] = {
    page: [row('a'), row('b')],
    isDone: false,
    continueCursor: 'c1',
    splitCursor: 's',
    pageStatus: 'SplitRequired',
  }
  await render()
  // Incomplete: nothing past its start shows, and the list is loading.
  expect(got).toMatchObject({ rows: [], status: 'loading' })
  expect(asked()).toEqual(
    expect.arrayContaining([at(null, 's'), at('s', 'c1'), at('c1')]),
  )
  server[at(null, 's')] = {
    page: [row('a'), row('b')],
    isDone: false,
    continueCursor: 's',
  }
  server[at('s', 'c1')] = {
    page: [row('c')],
    isDone: false,
    continueCursor: 'c1',
  }
  await render()
  expect(got).toMatchObject({
    rows: [row('a'), row('b'), row('c'), row('z')],
    status: 'done',
  })
  // The halves now are the pages; the split page is gone.
  expect(asked().sort()).toEqual(
    [at(null, 's'), at('s', 'c1'), at('c1')].sort(),
  )
})

test("SplitRecommended splits nothing: page 0 keeps the hold's args", async () => {
  // The real backend marks every full page so (QC "Load more", 2026-10-23).
  server[at(null)] = {
    page: [row('a'), row('b')],
    isDone: false,
    continueCursor: 'c1',
    splitCursor: 's',
    pageStatus: 'SplitRecommended',
  }
  await render()
  expect(got).toMatchObject({ rows: [row('a'), row('b')], status: 'more' })
  expect(asked()).toEqual([at(null)])
  expect(JSON.stringify(lastRequest()[at(null)].args)).toBe(
    JSON.stringify(firstPage(filters)),
  )
  // Nor a pinned page.
  await act(() => got.loadMore())
  server[at(null, 'c1')] = server[at(null)]
  server[at('c1')] = {
    page: [row('c')],
    isDone: true,
    continueCursor: 'c2',
    splitCursor: 't',
    pageStatus: 'SplitRecommended',
  }
  await render()
  await render()
  expect(got).toMatchObject({
    rows: [row('a'), row('b'), row('c')],
    status: 'done',
  })
  expect(asked().sort()).toEqual([at(null, 'c1'), at('c1')].sort())
})

test('an empty SplitRequired page (list grew past what it shapes) splits', async () => {
  server[at(null)] = { page: [row('a')], isDone: false, continueCursor: 'c1' }
  await render()
  await act(() => got.loadMore())
  server[at('c1')] = { page: [row('z')], isDone: true, continueCursor: 'c2' }
  // `list` answers a pinned page grown past LIST_PAGE_MAX_ROWS so.
  server[at(null, 'c1')] = {
    page: [],
    isDone: false,
    continueCursor: 'c1',
    splitCursor: 's',
    pageStatus: 'SplitRequired',
  }
  await render()
  // Page 0's last rows are not shown in its place: it holds the list.
  expect(got).toMatchObject({ rows: [], status: 'loading' })
  server[at(null, 's')] = {
    page: [row('a'), row('b')],
    isDone: false,
    continueCursor: 's',
  }
  server[at('s', 'c1')] = {
    page: [row('c')],
    isDone: false,
    continueCursor: 'c1',
  }
  await render()
  expect(got).toMatchObject({
    rows: [row('a'), row('b'), row('c'), row('z')],
    status: 'done',
  })
})

test('new filters start again from one page; skip asks for nothing', async () => {
  server[at(null)] = { page: [], isDone: false, continueCursor: 'c1' }
  await render()
  await act(() => got.loadMore())
  await render({ tenantId, includeArchived: true })
  expect(asked()).toEqual([at(null)])
  await render('skip')
  expect(lastRequest()).toEqual({})
  expect(got.rows).toBeUndefined()
})

test('every filter reaches `list`: kind, source and fields, on page 0 and after', async () => {
  // Every key ListFilters has, set: a filter listFilters drops fails here.
  const all: Required<ListFilters> = {
    tenantId,
    includeArchived: true,
    kind: 'household',
    source: { level: 'detail', id: 'code1' as Id<'sourceCodes'> },
    fields: [
      {
        fieldId: 'field1' as Id<'contactFields'>,
        optionId: 'option1' as Id<'contactFieldOptions'>,
      },
      // "Not set" is a filter too, not an absent one.
      { fieldId: 'field2' as Id<'contactFields'>, optionId: null },
    ],
  }
  server[at(null)] = { page: [], isDone: false, continueCursor: 'c1' }
  await render(all)
  const { paginationOpts: _first, ...firstArgs } = lastRequest()[at(null)].args
  expect(firstArgs).toEqual(all)
  expect(firstPage(all)).toMatchObject(all)
  await act(() => got.loadMore())
  const { paginationOpts: _next, ...nextArgs } = lastRequest()[at('c1')].args
  expect(nextArgs).toEqual(all)
})

test('field filters are equal args whatever key order the page builds them in', async () => {
  const fieldId = 'field1' as Id<'contactFields'>
  const optionId = 'option1' as Id<'contactFieldOptions'>
  await render({ tenantId, fields: [{ optionId, fieldId }] })
  expect(JSON.stringify(lastRequest()[at(null)].args)).toBe(
    JSON.stringify(firstPage({ tenantId, fields: [{ fieldId, optionId }] })),
  )
  // No field filters is no `fields` key: the hold's args stay as before.
  expect(firstPage({ tenantId, fields: [] })).toEqual(firstPage({ tenantId }))
})
