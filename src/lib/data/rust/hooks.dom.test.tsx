// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Tenant } from '../../tenant'
import type { WireContact, WireListPage } from './wire'

// The contacts pages' Rust path against a mocked API (step 2a's endpoints
// replace the mock): the real form, hooks and reducer, only `fetch` faked.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Call = { method: string; url: string; body: unknown }
let calls: Array<Call>
let answers: Array<(c: Call) => { status: number; json: unknown } | undefined>

function respond(c: Call) {
  for (const a of answers) {
    const r = a(c)
    if (r) return r
  }
  return { status: 404, json: { kind: 'not_found' } }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  vi.stubEnv('VITE_BACKEND', 'rust')
  vi.resetModules()
  calls = []
  answers = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const c = {
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(c)
      const r = respond(c)
      return Promise.resolve(
        new Response(JSON.stringify(r.json), { status: r.status }),
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
  vi.unstubAllEnvs()
})

const tenant = (slug: string): Tenant =>
  ({
    _id: slug,
    slug,
    name: slug,
    role: 'staff',
    lastUsedAt: null,
  }) as unknown as Tenant

async function providers(slug: string) {
  const { TenantContext } = await import('../../tenant')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TenantContext.Provider value={tenant(slug)}>
        {children}
      </TenantContext.Provider>
    </QueryClientProvider>
  )
}

const ID = '0190f1d23c4b7a008000000000000001'
const details = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
}
const ada: WireContact = {
  id: ID,
  number: 10001,
  displayName: 'Ada Lovelace',
  archived: false,
  details,
  emails: [],
  phones: [],
  addresses: [],
  fields: [],
  counters: { details: 3, methods: 0, addresses: 0, fields: 0, archive: 0 },
}

const json = (status: number, body: unknown) => ({ status, json: body })

/** Type into a labelled text input, as the user would. */
function type(label: string, value: string) {
  const input = [...el.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(label))
    ?.querySelector('input')
  if (!input) throw new Error(`no input labelled ${label}`)
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input
}

const field = (label: string) =>
  [...el.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(label))
    ?.querySelector('input')?.value

describe('contact form on the Rust API', () => {
  test('409 stale: merges the other tab’s change and retries with its counter', async () => {
    const { ContactForm } = await import('../../../components/contact-form')
    const { contactFromWire } = await import('./wire')
    const Wrap = await providers('a')
    // The other tab changed the last name (details 3 → 4).
    let saves = 0
    answers.push((c) => {
      if (c.method !== 'POST' || !c.url.endsWith(`/contacts/${ID}/save`))
        return undefined
      saves++
      return saves === 1
        ? json(409, {
            kind: 'stale',
            contract: 'contacts.details',
            counter: 4,
            current: { ...details, lastName: 'King' },
          })
        : json(200, { slices: { details: { id: ID, counter: 5 } } })
    })
    answers.push((c) =>
      c.url.endsWith(`/contacts/${ID}`) ? json(200, ada) : undefined,
    )
    act(() =>
      root.render(
        <Wrap>
          <ContactForm
            id={ID as never}
            data={contactFromWire(ada, [])}
            fields={[]}
          />
        </Wrap>,
      ),
    )
    await act(async () => {
      type('Known as', 'Countess')
      el.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    // The retry waits out the autosave pause.
    await vi.waitFor(() => expect(saves).toBe(2), { timeout: 3000 })
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.url)).toEqual([
      `/api/t/a/contacts/${ID}/save`,
      `/api/t/a/contacts/${ID}/save`,
    ])
    expect(posts[0].body).toEqual({
      source: 'autosave',
      slices: { details: { expected: 3, ...details, nickname: 'Countess' } },
    })
    expect(posts[1].body).toEqual({
      source: 'autosave',
      slices: {
        details: {
          expected: 4,
          ...details,
          lastName: 'King',
          nickname: 'Countess',
        },
      },
    })
    await vi.waitFor(() =>
      expect(el.textContent).toContain('All changes saved'),
    )
    expect(field('Last name')).toBe('King')
    expect(field('Known as')).toBe('Countess')
  })
})

describe('contacts list on the Rust API', () => {
  const page = (slug: string): WireListPage => ({
    rows: [
      {
        id: `${slug}1`,
        number: 10001,
        kind: 'individual',
        displayName: `Only in ${slug}`,
        archived: false,
        email: null,
        fieldOptionIds: [],
      },
    ],
    next: slug === 'a' ? 'cursor-a' : null,
  })

  async function list(slug: string) {
    const { useContactList } = await import('../index')
    const Wrap = await providers(slug)
    const seen: { current?: ReturnType<typeof useContactList> } = {}
    function Probe() {
      seen.current = useContactList({
        tenantId: slug as never,
        includeArchived: false,
        kind: 'individual',
        fields: [{ fieldId: 'f1' as never, optionId: null }],
      })
      return null
    }
    act(() =>
      root.render(
        <Wrap>
          <Probe />
        </Wrap>,
      ),
    )
    await vi.waitFor(() => expect(seen.current?.rows).toBeDefined())
    return seen
  }

  test('each tenant reads only its own slug, filters as parameters', async () => {
    answers.push((c) => {
      const m = /^\/api\/t\/([^/]+)\/contacts\?/.exec(c.url)
      return m ? json(200, page(m[1])) : undefined
    })
    const a = await list('a')
    expect(a.current?.rows?.map((r) => r.displayName)).toEqual(['Only in a'])
    expect(a.current?.status).toBe('more')
    act(() => root.unmount())
    root = createRoot(el)
    const b = await list('b')
    expect(b.current?.rows?.map((r) => r.displayName)).toEqual(['Only in b'])
    expect(b.current?.status).toBe('done')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/t/a/contacts?kind=individual&field=f1%3Anone&limit=100',
      '/api/t/b/contacts?kind=individual&field=f1%3Anone&limit=100',
    ])
  })

  test('Load more asks for the page after the cursor', async () => {
    answers.push((c) =>
      c.url.includes('after=cursor-a')
        ? json(200, {
            ...page('a'),
            rows: [{ ...page('a').rows[0], id: 'a2', displayName: 'Second' }],
            next: null,
          })
        : c.url.startsWith('/api/t/a/contacts?')
          ? json(200, page('a'))
          : undefined,
    )
    const a = await list('a')
    await act(async () => a.current!.loadMore())
    await vi.waitFor(() => expect(a.current?.status).toBe('done'))
    expect(a.current?.rows?.map((r) => r.displayName)).toEqual([
      'Only in a',
      'Second',
    ])
  })
})
