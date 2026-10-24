// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Tenant } from '../../tenant'
import type { ContactPage } from '../rust-types/ContactPage'
import type { ContactView } from '../rust-types/ContactView'
import type { OrgEvent } from '../rust-types/OrgEvent'

// The contacts pages' Rust path against a mocked API (step 2a's endpoints
// replace the mock): the real form, hooks and reducer, only `fetch` and
// `EventSource` faked.

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

/** The tenant's event stream, driven by the test. */
class FakeSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static all: Array<FakeSource> = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null
  listeners: Partial<
    Record<string, Array<(m: { data: string; lastEventId: string }) => void>>
  > = {}
  readyState = FakeSource.CONNECTING
  closed = false
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeSource.all.push(this)
  }
  addEventListener(
    kind: string,
    f: (m: { data: string; lastEventId: string }) => void,
  ) {
    ;(this.listeners[kind] ??= []).push(f)
  }
  close() {
    this.closed = true
    this.readyState = FakeSource.CLOSED
  }
  open() {
    this.readyState = FakeSource.OPEN
    this.onopen?.()
  }
  emit(e: OrgEvent) {
    this.onmessage?.({ data: JSON.stringify(e), lastEventId: String(e.seq) })
  }
  reset(head = 0) {
    for (const f of this.listeners.reset ?? [])
      f({ data: '', lastEventId: String(head) })
  }
  /** The server refused a reconnect: the browser gives up for good. */
  refused() {
    this.readyState = FakeSource.CLOSED
    this.onerror?.()
  }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  vi.resetModules()
  FakeSource.all = []
  vi.stubGlobal('EventSource', FakeSource)
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
const ada: ContactView = {
  id: ID,
  number: 10001,
  kind: 'individual',
  displayName: 'Ada Lovelace',
  sortName: 'lovelace ada',
  archived: false,
  details,
  methods: { emails: [], phones: [] },
  addresses: { addresses: [] },
  fields: { values: [] },
  acquisition: null,
  counters: {
    details: 3,
    methods: 0,
    addresses: 0,
    fields: 0,
    archive: 0,
    acquisition: 0,
  },
  warnings: [],
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
  test('a stale slice: merges the other tab’s change and retries with its counter', async () => {
    const { ContactForm } = await import('../../../components/contact-form')
    const { contactFromWire } = await import('./wire')
    const Wrap = await providers('a')
    // The other tab changed the last name (details 3 → 4).
    let saves = 0
    answers.push((c) => {
      if (c.method !== 'POST' || !c.url.endsWith(`/contacts/${ID}/save`))
        return undefined
      saves++
      const counters = {
        details: 3,
        methods: 0,
        addresses: 0,
        fields: 0,
        archive: 0,
      }
      return saves === 1
        ? json(200, {
            saved: [],
            problems: {},
            stale: { details: 4 },
            current: { details: { ...details, lastName: 'King' } },
            counters,
          })
        : json(200, {
            saved: ['details'],
            problems: {},
            stale: {},
            current: {},
            counters: { ...counters, details: 5 },
          })
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
    // The retry goes at once, not after the autosave pause (700 ms).
    const asked = Date.now()
    await vi.waitFor(() => expect(saves).toBe(2), { timeout: 2_000 })
    expect(Date.now() - asked).toBeLessThan(400)
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.url)).toEqual([
      `/api/t/a/contacts/${ID}/save`,
      `/api/t/a/contacts/${ID}/save`,
    ])
    expect(posts[0].body).toEqual({
      source: 'autosave',
      details: { expected: 3, ...details, nickname: 'Countess' },
    })
    expect(posts[1].body).toEqual({
      source: 'autosave',
      details: {
        expected: 4,
        ...details,
        lastName: 'King',
        nickname: 'Countess',
      },
    })
    await vi.waitFor(() =>
      expect(el.textContent).toContain('All changes saved'),
    )
    expect(field('Last name')).toBe('King')
    expect(field('Known as')).toBe('Countess')
  })
})

describe('the contact page live, over the event stream', () => {
  /** The contact as the server has it now: what a GET answers. */
  let server: ContactView
  let saves: Array<unknown>
  const gets = () =>
    calls.filter(
      (c) => c.method === 'GET' && c.url === `/api/t/a/contacts/${ID}`,
    ).length

  beforeEach(() => {
    server = ada
    saves = []
    answers.push((c) =>
      c.method === 'GET' && c.url === `/api/t/a/contacts/${ID}`
        ? json(200, server)
        : c.url === '/api/t/a/fields'
          ? json(200, [])
          : undefined,
    )
    answers.push((c) => {
      if (c.method !== 'POST' || !c.url.endsWith(`/contacts/${ID}/save`))
        return undefined
      saves.push(c.body)
      const expected = (c.body as { details: { expected: number } }).details
        .expected
      const counter = expected + 1
      server = {
        ...server,
        details: {
          ...server.details,
          ...(c.body as { details: object }).details,
        },
        counters: { ...server.counters, details: counter },
      }
      return json(200, {
        saved: ['details'],
        problems: {},
        stale: {},
        current: {},
        counters: { ...server.counters },
      })
    })
  })

  /**
   * The contact page's data path: the view, the form, the stream, which
   * opens on `url`, showing `known` as the nickname.
   */
  async function open(url = '/api/t/a/events', known = '') {
    const { ContactForm } = await import('../../../components/contact-form')
    const { useContact, useOrgEvents } = await import('../index')
    const Wrap = await providers('a')
    function Page() {
      useOrgEvents('a')
      const { view, fields } = useContact(ID as never)
      return view ? (
        <ContactForm id={ID as never} data={view} fields={fields ?? []} />
      ) : null
    }
    act(() =>
      root.render(
        <Wrap>
          <Page />
        </Wrap>,
      ),
    )
    await vi.waitFor(() => expect(field('Known as')).toBe(known))
    const events = FakeSource.all.at(-1)!
    expect([events.url, events.init]).toEqual([url, { withCredentials: true }])
    return events
  }

  /** As `open`, then the stream connects and its open refetch lands. */
  async function connected() {
    const events = await open()
    act(() => events.open())
    await vi.waitFor(() => expect(gets()).toBe(2))
    return events
  }

  /** Another tab saved the contact's details: the server moves on. */
  function remote(change: Partial<typeof details>): OrgEvent {
    server = {
      ...server,
      details: { ...server.details, ...change },
      counters: { ...server.counters, details: server.counters.details + 1 },
    }
    return {
      seq: server.counters.details,
      entity: 'contacts',
      id: ID,
      contract: 'contacts.details',
      counter: server.counters.details,
    }
  }

  test('a remote edit lands under in-progress typing', async () => {
    const events = await open()
    act(() => void type('Title', 'typing in b'))
    const e = remote({ nickname: 'from a' })
    act(() => events.emit(e))
    await vi.waitFor(() => expect(field('Known as')).toBe('from a'))
    expect(field('Title')).toBe('typing in b')
    expect(el.textContent).not.toContain('changed by someone else too')
    expect(saves).toEqual([])
  })

  test('the same field edited in both shows the conflict badge', async () => {
    const events = await open()
    act(() => void type('Known as', 'mine in b'))
    act(() => events.emit(remote({ nickname: 'theirs in a' })))
    await vi.waitFor(() =>
      expect(el.textContent).toContain('changed by someone else too'),
    )
    expect(el.textContent).toContain('Changed by both of you: details.nickname')
    expect(field('Known as')).toBe('mine in b')

    // B's value is kept and wins on save, against the counter it merged;
    // the badge clears.
    await act(async () => {
      el.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    await vi.waitFor(() =>
      expect(el.textContent).toContain('All changes saved'),
    )
    expect(saves).toEqual([
      {
        source: 'autosave',
        details: { expected: 4, ...details, nickname: 'mine in b' },
      },
    ])
    expect(el.textContent).not.toContain('changed by someone else too')
  })

  test('the echo of a change already shown, or of this tab’s own save, fetches nothing', async () => {
    const events = await open()
    expect(gets()).toBe(1)
    // An event at the counter the view already holds.
    act(() =>
      events.emit({
        seq: 3,
        entity: 'contacts',
        id: ID,
        contract: 'contacts.details',
        counter: 3,
      }),
    )
    // This tab's save: refetched once after its answer, not again on its
    // event.
    act(() => void type('Known as', 'own'))
    await act(async () => {
      el.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    await vi.waitFor(() => expect(gets()).toBe(2))
    act(() =>
      events.emit({
        seq: 4,
        entity: 'contacts',
        id: ID,
        contract: 'contacts.details',
        counter: 4,
      }),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(gets()).toBe(2)
    // A reset (too far behind to replay) refetches what is shown.
    act(() => events.reset())
    await vi.waitFor(() => expect(gets()).toBe(3))
  })

  test('another contact’s change, or another entity’s, refetches only what shows it', async () => {
    const events = await open()
    act(() =>
      events.emit({
        seq: 9,
        entity: 'contacts',
        id: '0190f1d23c4b7a008000000000000002',
        contract: 'contacts.details',
        counter: 7,
      }),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(gets()).toBe(1)
    // An entity no table names (a module ported later): the whole tenant.
    act(() =>
      events.emit({
        seq: 10,
        entity: 'sources',
        id: 'x',
        contract: 'sources.code',
        counter: 1,
      }),
    )
    await vi.waitFor(() => expect(gets()).toBe(2))
  })

  test('a burst of events costs one refetch, then one more for the rest', async () => {
    const events = await open()
    expect(gets()).toBe(1)
    act(() => {
      events.emit(remote({ nickname: 'one' }))
      events.emit(remote({ nickname: 'two' }))
      events.emit(remote({ nickname: 'three' }))
    })
    await vi.waitFor(() => expect(field('Known as')).toBe('three'))
    await new Promise((r) => setTimeout(r, 50))
    expect(gets()).toBe(3)
  })

  test('opened with no cursor, it refetches what was read before it', async () => {
    const events = await open()
    expect(gets()).toBe(1)
    act(() => events.open())
    // Live from now: the view read before the stream could be behind.
    await vi.waitFor(() => expect(gets()).toBe(2))
  })

  test('with no cursor, the browser’s reconnects refetch until an event gives one', async () => {
    const events = await open()
    act(() => events.open())
    await vi.waitFor(() => expect(gets()).toBe(2))
    // Reconnected before any event: no Last-Event-ID, live from now again.
    act(() => events.open())
    await vi.waitFor(() => expect(gets()).toBe(3))
    act(() => events.reset(5))
    await vi.waitFor(() => expect(gets()).toBe(4))
    // Now the browser sends Last-Event-ID and the server replays.
    act(() => events.open())
    await new Promise((r) => setTimeout(r, 50))
    expect(gets()).toBe(4)
  })

  test('a cold load’s boot cursor: the stream opens after it, and refetches nothing', async () => {
    const { setCursor } = await import('../events')
    setCursor('a', 41)
    const { ContactForm } = await import('../../../components/contact-form')
    const { useContact, useOrgEvents } = await import('../index')
    const Wrap = await providers('a')
    function Page() {
      useOrgEvents('a')
      const { view, fields } = useContact(ID as never)
      return view ? (
        <ContactForm id={ID as never} data={view} fields={fields ?? []} />
      ) : null
    }
    act(() =>
      root.render(
        <Wrap>
          <Page />
        </Wrap>,
      ),
    )
    await vi.waitFor(() => expect(field('Known as')).toBe(''))
    const [events] = FakeSource.all
    expect(events.url).toBe('/api/t/a/events?after=41')
    act(() => events.open())
    await new Promise((r) => setTimeout(r, 50))
    expect(gets()).toBe(1)
  })

  test('a refused reconnect reopens, after a pause, from the last event', async () => {
    const events = await connected()
    act(() => events.emit(remote({ nickname: 'before the drop' })))
    await vi.waitFor(() => expect(field('Known as')).toBe('before the drop'))
    // A 502 while the api restarts: the browser gives up for good.
    act(() => events.refused())
    expect(events.closed).toBe(true)
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(2), {
      timeout: 2_000,
    })
    expect(FakeSource.all[1].url).toBe(
      `/api/t/a/events?after=${server.counters.details}`,
    )
    // Its replay lands as usual, and nothing is refetched just for opening.
    const before = gets()
    act(() => FakeSource.all[1].open())
    act(() => FakeSource.all[1].emit(remote({ nickname: 'replayed' })))
    await vi.waitFor(() => expect(field('Known as')).toBe('replayed'))
    expect(gets()).toBe(before + 1)
  })

  test('a reset moves the cursor to the head it names', async () => {
    const events = await connected()
    act(() => events.reset(77))
    act(() => events.refused())
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(2), {
      timeout: 2_000,
    })
    expect(FakeSource.all[1].url).toBe('/api/t/a/events?after=77')
  })

  test('leaving the tenant and coming back replays from where it stopped', async () => {
    const events = await connected()
    act(() => events.emit(remote({ nickname: 'seen' })))
    await vi.waitFor(() => expect(field('Known as')).toBe('seen'))
    act(() => root.unmount())
    expect(events.closed).toBe(true)
    root = createRoot(el)
    const again = await open(
      `/api/t/a/events?after=${server.counters.details}`,
      'seen',
    )
    expect(FakeSource.all).toHaveLength(2)
    expect(again.closed).toBe(false)
  })

  test('the stream closes when the page goes', async () => {
    const events = await open()
    act(() => root.unmount())
    expect(events.closed).toBe(true)
    root = createRoot(el)
  })
})

describe('cold load', () => {
  test('one boot request answers the session, the fields and the first page; the groups go alongside', async () => {
    const { QueryClient: Client } = await import('@tanstack/react-query')
    const { TenantContext } = await import('../../tenant')
    const data = await import('../index')
    const { boot } = await import('./hooks')
    const me = {
      email: 'a@example.com',
      memberships: [{ slug: 'a', name: 'A', role: 'staff' }],
    }
    const groups = [
      {
        slug: 'a',
        name: 'A',
        role: 'staff',
        lastUsedAt: null,
        staffCanManageIdentifierTypes: false,
        identifierTypesVersion: null,
        staffCanManageSourceCodes: false,
        sourceCodesVersion: null,
        staffCanManageFields: true,
        fieldsVersion: 0,
        canManageIdentifierTypes: false,
        canManageSourceCodes: false,
        canManageFields: true,
      },
    ]
    answers.push((c) =>
      c.url === '/api/groups'
        ? json(200, groups)
        : c.url === '/api/t/a/boot'
          ? json(200, {
              me,
              org: { slug: 'a', name: 'A', role: 'staff' },
              fields: [],
              firstPage: {
                rows: [
                  {
                    id: 'a1',
                    number: 10001,
                    kind: 'individual',
                    displayName: 'Booted',
                    sortName: 'booted',
                    archived: false,
                    email: null,
                    fieldOptionIds: [],
                  },
                ],
                nextCursor: null,
                isDone: true,
              },
            })
          : undefined,
    )
    const qc = new Client({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    boot(qc, 'a')
    const seen: {
      list?: ReturnType<typeof data.useContactList>
      fields?: ReturnType<typeof data.useFields>
      tenants?: ReturnType<typeof data.useMyTenants>
    } = {}
    function Probe() {
      seen.tenants = data.useMyTenants()
      seen.fields = data.useFields()
      seen.list = data.useContactList({
        tenantId: 'a' as never,
        includeArchived: false,
      })
      return null
    }
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <data.MyTenantsProvider>
            <TenantContext.Provider value={tenant('a')}>
              <Probe />
            </TenantContext.Provider>
          </data.MyTenantsProvider>
        </QueryClientProvider>,
      ),
    )
    await vi.waitFor(() =>
      expect(seen.list?.rows?.map((r) => r.displayName)).toEqual(['Booted']),
    )
    expect(seen.fields).toEqual([])
    expect(seen.tenants?.map((t) => [t.slug, t.canManageFields])).toEqual([
      ['a', true],
    ])
    // Both asked for before anything rendered: in parallel, not one after
    // the other.
    expect(calls.map((c) => c.url)).toEqual(['/api/t/a/boot', '/api/groups'])
  })

  test('a failed boot leaves each read to ask on its own', async () => {
    const { QueryClient: Client } = await import('@tanstack/react-query')
    const data = await import('../index')
    const { boot } = await import('./hooks')
    answers.push((c) =>
      c.url === '/api/t/a/boot'
        ? json(403, { kind: 'forbidden' })
        : c.url === '/api/me'
          ? json(200, { email: 'a@example.com', memberships: [] })
          : c.url === '/api/groups'
            ? json(200, [])
            : undefined,
    )
    const qc = new Client({ defaultOptions: { queries: { retry: false } } })
    boot(qc, 'a')
    const seen: { tenants?: ReturnType<typeof data.useMyTenants> } = {}
    function Probe() {
      seen.tenants = data.useMyTenants()
      return null
    }
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <data.MyTenantsProvider>
            <Probe />
          </data.MyTenantsProvider>
        </QueryClientProvider>,
      ),
    )
    await vi.waitFor(() => expect(seen.tenants).toEqual([]))
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.map((c) => c.url).sort()).toEqual([
      '/api/groups',
      '/api/me',
      '/api/t/a/boot',
    ])
  })
})

describe('contacts list on the Rust API', () => {
  const page = (slug: string): ContactPage => ({
    rows: [
      {
        id: `${slug}1`,
        number: 10001,
        kind: 'individual',
        displayName: `Only in ${slug}`,
        sortName: `only in ${slug}`,
        archived: false,
        email: null,
        fieldOptionIds: [],
      },
    ],
    nextCursor: slug === 'a' ? 'cursor-a' : null,
    isDone: slug !== 'a',
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
      '/api/t/a/contacts?kind=individual&fields=f1%3Anone&limit=100',
      '/api/t/b/contacts?kind=individual&fields=f1%3Anone&limit=100',
    ])
  })

  test('Load more asks for the page after the cursor', async () => {
    answers.push((c) =>
      c.url.includes('cursor=cursor-a')
        ? json(200, {
            ...page('a'),
            rows: [{ ...page('a').rows[0], id: 'a2', displayName: 'Second' }],
            nextCursor: null,
            isDone: true,
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
