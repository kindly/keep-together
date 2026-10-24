// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import type { Moment } from '../lib/data/rust-types/Moment'
import type { MomentPage } from '../lib/data/rust-types/MomentPage'
import { TenantContext } from '../lib/tenant'
import type { Tenant } from '../lib/tenant'
import { ContactHistory, joinMoments } from './contact-history'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ID = '0190f1d23c4b7a008000000000000001' as Id<'contacts'>

const moment = (n: number, over: Partial<Moment> = {}): Moment => ({
  key: `r${n}`,
  revisionId: n,
  at: 1_000 * n,
  actor: 1,
  source: 'ui',
  groupName: null,
  slices: ['details'],
  restored: false,
  retired: false,
  ...over,
})

/** The server's pages by `before` ('' for the newest). */
let pages: Record<string, MomentPage | 'fail'>
let posts: Array<{ url: string; body: unknown }>
let restoreAnswer: unknown

let root: Root
let el: HTMLDivElement
let role: 'staff' | 'viewer'
beforeEach(() => {
  role = 'staff'
  posts = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        return Promise.resolve(
          new Response(JSON.stringify(restoreAnswer), { status: 200 }),
        )
      }
      const before = new URL(url, 'http://x').searchParams.get('before') ?? ''
      const page = pages[before]
      return Promise.resolve(
        page === 'fail'
          ? new Response(JSON.stringify({ kind: 'internal' }), { status: 500 })
          : new Response(JSON.stringify(page), { status: 200 }),
      )
    }),
  )
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TenantContext.Provider
          value={{ slug: 'alpha', role } as unknown as Tenant}
        >
          <ContactHistory id={ID} archived={false} archiveVersion={0} />
        </TenantContext.Provider>
      </QueryClientProvider>,
    ),
  )
  await act(async () => new Promise((r) => setTimeout(r)))
}

const items = () =>
  [...el.querySelectorAll('li')].map((li) => li.getAttribute('data-revision'))
const button = (text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text)
const click = async (b: HTMLElement) => {
  await act(async () => b.click())
  await act(async () => new Promise((r) => setTimeout(r)))
}

test('moments newest first; Load older joins a group cut by the page', async () => {
  pages = {
    '': {
      moments: [moment(12), moment(11, { key: 'g5', groupName: 'contact form save', slices: ['methods'] })],
      nextBefore: 11,
    },
    '11': {
      moments: [moment(10, { key: 'g5', groupName: 'contact form save', slices: ['addresses'] }), moment(9)],
      nextBefore: null,
    },
  }
  await render()
  expect(items()).toEqual(['12', '11'])
  expect(el.textContent).toContain('current')
  await click(button('Load older')!)
  expect(items()).toEqual(['12', '11', '9'])
  expect(el.textContent).toContain('methods, addresses')
  expect(button('Load older')).toBeUndefined()
})

test('Restore to here sends the moment’s time and says what it left', async () => {
  pages = { '': { moments: [moment(2), moment(1)], nextBefore: null } }
  restoreAnswer = {
    restored: ['contacts.details', 'contacts.fields'],
    skippedFields: [{ label: 'Region', reason: 'retired' }],
    view: { id: ID, counters: { details: 3, fields: 2 } },
  }
  await render()
  const restore = [...el.querySelectorAll('button')].filter(
    (b) => b.textContent === 'Restore to here',
  )
  expect(restore).toHaveLength(1) // never on the newest
  await click(restore[0])
  expect(posts).toEqual([
    {
      url: `/api/t/alpha/contacts/${ID}/restore`,
      body: { at: 1_000 },
    },
  ])
  expect(el.querySelector('[role=status]')!.textContent).toContain(
    'Restored, except: Region (the field has been retired).',
  )
})

test('a retired moment is read-only; viewers restore nothing', async () => {
  pages = {
    '': {
      moments: [
        moment(3),
        moment(2, { retired: true, slices: ['tags (retired)'] }),
        moment(1),
      ],
      nextBefore: null,
    },
  }
  await render()
  const rows = [...el.querySelectorAll('li')]
  expect(rows[1].textContent).toContain('read-only')
  expect(rows[1].textContent).not.toContain('Restore to here')
  expect(rows[2].textContent).toContain('Restore to here')
  act(() => root.unmount())
  root = createRoot(el)
  role = 'viewer'
  await render()
  expect(el.textContent).not.toContain('Restore to here')
  expect(button('Archive')).toBeUndefined()
})

test('a failed load is an error with a retry, never a throw', async () => {
  pages = { '': 'fail' }
  await render()
  expect(el.textContent).toContain('History couldn’t load.')
  pages = { '': { moments: [moment(1)], nextBefore: null } }
  await click(button('Retry')!)
  expect(items()).toEqual(['1'])
})

test('joinMoments merges only adjacent halves of one group', () => {
  const a = moment(3, { key: 'g1', slices: ['details'] })
  const b = moment(2, { key: 'g1', slices: ['methods'] })
  const c = moment(1, { key: 'g2' })
  const d = moment(0, { key: 'g1', slices: ['fields'] })
  const joined = joinMoments([a, b, c, d])
  expect(joined.map((m) => m.key)).toEqual(['g1', 'g2', 'g1'])
  expect(joined[0].slices).toEqual(['details', 'methods'])
})
