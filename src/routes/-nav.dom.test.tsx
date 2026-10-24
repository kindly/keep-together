// @vitest-environment happy-dom
import { act, createContext, use } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RecentGift } from '../lib/gifts'
import type { Tenant } from '../lib/tenant'
import type * as TenantLib from '../lib/tenant'
import type * as GiftsLib from '../lib/gifts'
import type * as DataLib from '../lib/data'

// The navigation (cash-gifts step 4): header, group home, landing on "/",
// and Settings → Switch group. The router is reduced to plain links with
// their params filled in, so each test reads the hrefs it renders. Most
// tests run as if every route were ported (migration-rust F3); the
// "being ported" ones at the end run with today's PORTED list.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const fill = (to: string, params: Record<string, string> = {}) =>
  to.replace(/\$(\w+)/g, (_, k: string) => params[k])

let params: Record<string, string> = {}
// A tab's own params, for tests that render two tabs side by side.
const TabParams = createContext<Record<string, string> | null>(null)
const navigated: Array<string> = []
const navigate = vi.fn()
// Whether every route counts as ported, and the route the layout shows.
const port = vi.hoisted(() => ({ all: true, leaf: '/t/$slug/' }))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => use(TabParams) ?? params,
  }),
  // Other props pass through, as a menu item's role does (asChild).
  Link: ({
    to,
    params: p,
    children,
    ...rest
  }: {
    to: string
    params?: Record<string, string>
    children: ReactNode
  }) => (
    <a href={fill(to, p)} {...rest}>
      {children}
    </a>
  ),
  Navigate: ({
    to,
    params: p,
  }: {
    to: string
    params?: Record<string, string>
  }) => {
    navigated.push(fill(to, p))
    return null
  },
  Outlet: () => <div data-testid="outlet" />,
  useNavigate: () => navigate,
  useMatches: ({ select }: { select: (m: Array<object>) => unknown }) =>
    select([{ routeId: '__root__' }, { routeId: port.leaf }]),
}))

const opened = vi.fn()
const signOut = vi.fn()
vi.mock('convex/react', () => ({
  Authenticated: ({ children }: { children: ReactNode }) => children,
  Unauthenticated: () => null,
  AuthLoading: () => null,
  useMutation: () => opened,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true }),
}))
vi.mock('@convex-dev/auth/react', () => ({
  useAuthActions: () => ({ signIn: vi.fn(), signOut }),
}))
vi.mock('../lib/query-cache', () => ({
  ContactQueryCache: ({ children }: { children: ReactNode }) => children,
}))

let tenants: Array<Tenant> | undefined
vi.mock('../lib/data', async (original) => {
  const real = await original<typeof DataLib>()
  return {
    ...real,
    get FEATURES() {
      return { ...real.FEATURES, gifts: port.all, settings: port.all }
    },
    isPorted: (id: string) => port.all || real.isPorted(id),
    SignedIn: ({ children }: { children: ReactNode }) => children,
    SignedOut: () => null,
    SessionLoading: () => null,
    useMyTenants: () => tenants,
    useSignOut: () => signOut,
    useOrgEvents: () => {},
  }
})
vi.mock('../lib/tenant', async (original) => ({
  ...(await original<typeof TenantLib>()),
  useMyTenants: () => tenants,
}))

let gifts: Array<RecentGift> = []
vi.mock('../lib/gifts', async (original) => ({
  ...(await original<typeof GiftsLib>()),
  useMyRecentGifts: (_: string, enabled = true) =>
    enabled ? gifts : undefined,
}))

const group = (slug: string, over: Partial<Tenant> = {}) =>
  ({
    _id: `id-${slug}`,
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    role: 'admin',
    lastUsedAt: null,
    ...over,
  }) as Tenant

const gift = (over: Partial<RecentGift>) =>
  ({
    _id: 'g1',
    _creationTime: 0,
    contactId: 'c1',
    contactName: 'Jo Bloggs',
    amount: 2000n,
    receivedOn: '2026-10-23',
    method: 'cash',
    status: 'completed',
    ...over,
  }) as RecentGift

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  port.all = true
  port.leaf = '/t/$slug/'
  params = { slug: 'alpha' }
  tenants = [group('alpha')]
  gifts = []
  navigated.length = 0
  opened.mockReset().mockResolvedValue(null)
  signOut.mockReset().mockResolvedValue(undefined)
  navigate.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

async function page(module: Promise<{ Route: unknown }>) {
  const { Route } = await module
  const Page = (Route as { options: { component: ComponentType } }).options
    .component
  act(() => root.render(<Page />))
}
const links = (scope: ParentNode = el) =>
  [...scope.querySelectorAll('a')].map((a) => [
    a.textContent.trim(),
    a.getAttribute('href'),
  ])
const text = () => el.textContent

test('header: the group name leads home, then Contacts · Donations ▾ · Settings', async () => {
  await page(import('./t.$slug'))
  const nav = el.querySelector('nav[aria-label="Main"]')!
  expect(links(nav)).toEqual([
    ['Alpha', '/t/alpha'],
    ['Contacts', '/t/alpha/contacts'],
    ['Settings', '/t/alpha/settings'],
  ])
  expect(nav.textContent).toContain('Donations ▾')
  // The glyph is decoration: the button's name is just "Donations".
  const trigger = [...nav.querySelectorAll('button')].find((b) =>
    b.textContent.startsWith('Donations'),
  )!
  expect(trigger.querySelector('[aria-hidden="true"]')?.textContent).toBe('▾')
  expect(nav.textContent).not.toContain('keep-together')
})

test('header: a slug that is not yours offers the way home', async () => {
  params = { slug: 'nope' }
  await page(import('./t.$slug'))
  expect(text()).toContain('No group called “nope” that you belong to.')
  expect(links()).toEqual([['Go to your group', '/']])
})

test('a single group never records which group was opened', async () => {
  await page(import('./t.$slug'))
  expect(opened).not.toHaveBeenCalled()
})

test('several groups: opening one that was not last used records it, once', async () => {
  tenants = [group('alpha'), group('beta', { lastUsedAt: 5 })]
  await page(import('./t.$slug'))
  expect(opened).toHaveBeenCalledExactlyOnceWith({ tenantId: 'id-alpha' })

  opened.mockClear()
  tenants = [
    group('alpha', { lastUsedAt: 6 }),
    group('beta', { lastUsedAt: 5 }),
  ]
  await page(import('./t.$slug'))
  expect(opened).not.toHaveBeenCalled()
})

test('two tabs on different groups each record their group once, then stay quiet', async () => {
  // The server as `mine` reports it: every call stamps a later time, which
  // both tabs then see (the worst case: no server-side quiet window).
  let clock = 10
  const used: Record<string, number | null> = { alpha: null, beta: null }
  const mine = () =>
    Object.entries(used).map(([slug, lastUsedAt]) =>
      group(slug, { lastUsedAt }),
    )
  opened.mockImplementation(({ tenantId }: { tenantId: string }) => {
    used[tenantId.replace('id-', '')] = ++clock
    return Promise.resolve(null)
  })
  const { Route } = await import('./t.$slug')
  const Page = (Route as unknown as { options: { component: ComponentType } })
    .options.component
  const other = document.createElement('div')
  document.body.append(other)
  const second = createRoot(other)
  const tab = (slug: string) => (
    <TabParams value={{ slug }}>
      <Page />
    </TabParams>
  )
  // Tab 1 is open on alpha; then tab 2 opens on beta. After that, each
  // round `mine` pushes the server's state to both tabs.
  tenants = mine()
  await act(async () => root.render(tab('alpha')))
  for (let round = 0; round < 6; round++) {
    tenants = mine()
    await act(async () => {
      root.render(tab('alpha'))
      second.render(tab('beta'))
    })
  }
  expect(opened.mock.calls).toEqual([
    [{ tenantId: 'id-alpha' }],
    [{ tenantId: 'id-beta' }],
  ])
  act(() => second.unmount())
})

test('the Donations menu: Record a gift, then my recent gifts, each a link', async () => {
  gifts = [
    gift({
      _id: 'g2' as RecentGift['_id'],
      amount: 123456n,
      contactName: 'Acme Ltd',
    }),
    gift({ status: 'void' }),
  ]
  await page(import('./t.$slug'))
  const trigger = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Donations ▾',
  )!
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    )
  })
  const menu = document.querySelector('[role="menu"]')!
  expect(menu).not.toBeNull()
  const items = [...menu.querySelectorAll('[role="menuitem"]')]
  expect(items[0].textContent).toBe('Record a gift')
  expect(items[0].getAttribute('href')).toBe('/t/alpha/gifts/new')
  expect(items[0].getAttribute('aria-disabled')).toBeNull()
  expect(items.slice(1).map((i) => i.textContent)).toEqual([
    '£1,234.56Acme Ltd23 Oct 2026',
    '£20.00Jo Bloggsvoid23 Oct 2026',
  ])
  expect(items.slice(1).map((i) => i.getAttribute('href'))).toEqual([
    '/t/alpha/gifts/g2',
    '/t/alpha/gifts/g1',
  ])
})

test('the Donations menu has no Record a gift for a viewer', async () => {
  tenants = [group('alpha', { role: 'viewer' })]
  await page(import('./t.$slug'))
  const trigger = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Donations ▾',
  )!
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    )
  })
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.textContent).not.toContain('Record a gift')
  // Nothing but menu items (and the label) inside the menu.
  const none = [...menu.querySelectorAll('[role="menuitem"]')]
  expect(none.map((i) => i.textContent)).toEqual(['None yet.'])
  expect(none[0].getAttribute('aria-disabled')).toBe('true')
  expect(menu.querySelector('p')).toBeNull()
})

function home(tenant: Tenant) {
  return import('../lib/tenant').then(async ({ TenantContext }) => {
    const { Route } = await import('./t.$slug.index')
    const Page = (Route as unknown as { options: { component: ComponentType } })
      .options.component
    act(() =>
      root.render(
        <TenantContext.Provider value={tenant}>
          <Page />
        </TenantContext.Provider>,
      ),
    )
  })
}

test('home: the four actions for staff', async () => {
  gifts = [gift({})]
  await home(group('alpha', { role: 'staff' }))
  // Each recent gift links to its page.
  expect(links()).toEqual([
    ['Record a gift', '/t/alpha/gifts/new'],
    ['Find a contact', '/t/alpha/contacts'],
    ['New contact', '/t/alpha/contacts/new'],
    ['£20.00Jo Bloggs23 Oct 2026', '/t/alpha/gifts/g1'],
  ])
  expect(text()).toContain('My recent gifts')
})

test('home: a viewer can only find contacts, and has no gifts of their own', async () => {
  await home(group('alpha', { role: 'viewer' }))
  expect(links()).toEqual([['Find a contact', '/t/alpha/contacts']])
  expect(text()).not.toContain('Record a gift')
  expect(text()).toContain("You haven't recorded any gifts yet.")
})

test('landing: signing in goes straight to the group last used', async () => {
  tenants = [
    group('alpha', { lastUsedAt: 1 }),
    group('beta', { lastUsedAt: 9 }),
    group('aardvark'),
  ]
  await page(import('./index'))
  expect(navigated).toEqual(['/t/beta'])
  expect(text()).not.toContain('Your groups')
})

test('landing: with no group, says so and offers sign out', async () => {
  tenants = []
  await page(import('./index'))
  expect(navigated).toEqual([])
  expect(text()).toContain("You don't belong to a group yet.")
  const button = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Sign out',
  )!
  act(() => button.click())
  expect(signOut).toHaveBeenCalledOnce()
})

test('settings: Switch group shows only for people in more than one group', async () => {
  await page(import('./t.$slug.settings'))
  expect(text()).not.toContain('Switch group')
  const button = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Sign out',
  )!
  await act(async () => button.click())
  expect(signOut).toHaveBeenCalledOnce()
  expect(navigate).toHaveBeenCalledWith({ to: '/' })

  tenants = [group('alpha'), group('beta')]
  await page(import('./t.$slug.settings'))
  expect(links()).toContainEqual(['Switch group', '/t/alpha/settings/groups'])
})

test('Switch group lists every group by name, each opening at its home', async () => {
  tenants = [group('gamma', { role: 'viewer' }), group('alpha'), group('beta')]
  const { TenantContext } = await import('../lib/tenant')
  const { Route } = await import('./t.$slug.settings.groups')
  const Page = (Route as unknown as { options: { component: ComponentType } })
    .options.component
  act(() =>
    root.render(
      <TenantContext.Provider value={tenants![1]}>
        <Page />
      </TenantContext.Provider>,
    ),
  )
  expect(links()).toEqual([
    ['Beta', '/t/beta'],
    ['Gamma', '/t/gamma'],
  ])
  const rows = [...el.querySelectorAll('li')].map((li) => li.textContent)
  expect(rows).toEqual([
    'Alpha (this group)alpha · admin',
    'Betabeta · admin',
    'Gammagamma · viewer',
  ])
})

test('being ported: the header has Contacts and Sign out, nothing unported', async () => {
  port.all = false
  tenants = [group('alpha'), group('beta', { lastUsedAt: 5 })]
  await page(import('./t.$slug'))
  const nav = el.querySelector('nav[aria-label="Main"]')!
  expect(links(nav)).toEqual([
    ['Alpha', '/t/alpha'],
    ['Contacts', '/t/alpha/contacts'],
  ])
  expect(nav.textContent).not.toContain('Donations')
  // "Last used" is Settings' (A3): nothing recorded meanwhile.
  expect(opened).not.toHaveBeenCalled()
  const button = [...nav.querySelectorAll('button')].find(
    (b) => b.textContent === 'Sign out',
  )!
  await act(async () => button.click())
  expect(signOut).toHaveBeenCalledOnce()
  expect(navigate).toHaveBeenCalledWith({ to: '/' })
  expect(el.querySelector('[data-testid="outlet"]')).not.toBeNull()
})

test('being ported: an unported route shows the placeholder, not the page', async () => {
  port.all = false
  port.leaf = '/t/$slug/settings/fields'
  await page(import('./t.$slug'))
  expect(text()).toContain('This page is being ported')
  expect(el.querySelector('[data-testid="outlet"]')).toBeNull()
  port.leaf = '/t/$slug/contacts/$contactId'
  await page(import('./t.$slug'))
  expect(text()).not.toContain('being ported')
  expect(el.querySelector('[data-testid="outlet"]')).not.toBeNull()
})

test('being ported: home has no gift actions', async () => {
  port.all = false
  await home(group('alpha', { role: 'staff' }))
  expect(links()).toEqual([
    ['Find a contact', '/t/alpha/contacts'],
    ['New contact', '/t/alpha/contacts/new'],
  ])
  expect(text()).not.toContain('My recent gifts')
})
