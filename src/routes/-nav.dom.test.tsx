// @vitest-environment happy-dom
import { act, createContext, use, useSyncExternalStore } from 'react'
import type { ComponentType, MouseEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RecentGift } from '../lib/gifts'
import type { Tenant } from '../lib/tenant'
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
// The browser history, reduced: entries of path and state. Links mark the
// current one (aria-current, as the router does), push it or replace it;
// the mobile drawer pushes its own entry, and back pops.
type Entry = { path: string; state: Record<string, unknown> }
const hist = vi.hoisted(() => {
  const h = {
    entries: [] as Array<Entry>,
    index: 0,
    subs: new Set<() => void>(),
    now: () => h.entries[h.index],
    emit: () => h.subs.forEach((f) => f()),
    reset(path: string) {
      h.entries = [{ path, state: {} }]
      h.index = 0
    },
    push(path: string, state: Record<string, unknown> = {}) {
      h.entries = [...h.entries.slice(0, h.index + 1), { path, state }]
      h.index++
      h.emit()
    },
    replace(path: string, state: Record<string, unknown> = {}) {
      h.entries[h.index] = { path, state }
      h.entries = [...h.entries]
      h.emit()
    },
    back() {
      h.index--
      h.emit()
    },
  }
  return h
})
const useEntry = () =>
  useSyncExternalStore(
    (f) => {
      hist.subs.add(f)
      return () => hist.subs.delete(f)
    },
    () => hist.now(),
  )
/** What the router's navigate does here: '.' keeps the path. */
function fakeNavigate(o: {
  to: string
  params?: Record<string, string>
  replace?: boolean
  state?: (s: Record<string, unknown>) => Record<string, unknown>
}) {
  const now = hist.now()
  const path = o.to === '.' ? now.path : fill(o.to, o.params)
  const state = o.state ? o.state(now.state) : {}
  if (o.replace) hist.replace(path, state)
  else hist.push(path, state)
  return Promise.resolve()
}
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
  // Other props pass through, as a menu item's role does (asChild). The
  // current page is marked as the router marks it: by prefix, or exactly.
  Link: ({
    to,
    params: p,
    children,
    activeOptions,
    activeProps: _,
    replace,
    onClick,
    ...rest
  }: {
    to: string
    params?: Record<string, string>
    children: ReactNode
    activeOptions?: { exact?: boolean }
    activeProps?: object
    replace?: boolean
    onClick?: (e: MouseEvent) => void
  }) => {
    const href = fill(to, p)
    const here = useEntry().path
    const active = activeOptions?.exact
      ? here === href
      : here === href || here.startsWith(`${href}/`)
    return (
      <a
        href={href}
        aria-current={active ? 'page' : undefined}
        onClick={(e) => {
          onClick?.(e)
          e.preventDefault()
          // As the router: the history changes after the click's own render.
          queueMicrotask(() => (replace ? hist.replace(href) : hist.push(href)))
        }}
        {...rest}
      >
        {children}
      </a>
    )
  },
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
  // The page; Record a gift's autofocuses its first field, as the real one.
  Outlet: () =>
    useEntry().path.endsWith('/gifts/new') ? (
      <input aria-label="Contact" autoFocus data-testid="outlet" />
    ) : (
      <div data-testid="outlet" />
    ),
  useNavigate: () => navigate,
  useRouterState: ({
    select,
  }: {
    select: (s: {
      location: { href: string; state: Record<string, unknown> }
    }) => unknown
  }) => {
    const { path, state } = useEntry()
    return select({ location: { href: path, state } })
  },
  useRouter: () => ({
    state: {
      get location() {
        return { state: hist.now().state }
      },
    },
    history: { back: () => hist.back() },
  }),
  useMatches: ({ select }: { select: (m: Array<object>) => unknown }) =>
    select([{ routeId: '__root__' }, { routeId: port.leaf }]),
}))

const opened = vi.fn()
const signOut = vi.fn()
let tenants: Array<Tenant> | undefined
vi.mock('../lib/data', async (original) => {
  const real = await original<typeof DataLib>()
  return {
    ...real,
    get FEATURES() {
      return {
        ...real.FEATURES,
        gifts: port.all || real.FEATURES.gifts,
        settings: port.all || real.FEATURES.settings,
      }
    },
    isPorted: (id: string) => port.all || real.isPorted(id),
    SignedIn: ({ children }: { children: ReactNode }) => children,
    SignedOut: () => null,
    SessionLoading: () => null,
    useMyTenants: () => tenants,
    useSignOut: () => signOut,
    useAuthState: () => ({ email: 'a@example.org' }),
    useOpened: () => opened,
    useOrgEvents: () => {},
  }
})

let gifts: Array<RecentGift> = []
vi.mock('../lib/gifts', async (original) => ({
  ...(await original<typeof GiftsLib>()),
  useMyRecentGifts: (enabled = true) => (enabled ? gifts : undefined),
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
  hist.reset('/t/alpha')
  params = { slug: 'alpha' }
  tenants = [group('alpha')]
  gifts = []
  navigated.length = 0
  opened.mockReset().mockResolvedValue(null)
  signOut.mockReset().mockResolvedValue(undefined)
  navigate.mockReset().mockImplementation(fakeNavigate)
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
  expect(opened).toHaveBeenCalledExactlyOnceWith('alpha')

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
  opened.mockImplementation((slug: string) => {
    used[slug] = ++clock
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
  expect(opened.mock.calls).toEqual([['alpha'], ['beta']])
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

test('being ported: the header has Contacts, Donations and Settings, nothing unported', async () => {
  port.all = false
  tenants = [group('alpha'), group('beta', { lastUsedAt: 5 })]
  await page(import('./t.$slug'))
  const nav = el.querySelector('nav[aria-label="Main"]')!
  expect(links(nav)).toEqual([
    ['Alpha', '/t/alpha'],
    ['Contacts', '/t/alpha/contacts'],
    // A3: Settings (it holds Sign out) and "last used".
    ['Settings', '/t/alpha/settings'],
  ])
  // B2: Donations ▾ (a menu, not a link).
  expect(nav.textContent).toContain('Donations')
  expect(opened).toHaveBeenCalledExactlyOnceWith('alpha')
  expect(el.querySelector('[data-testid="outlet"]')).not.toBeNull()
})

test('this build serves every list tab: Settings opens on Fields', async () => {
  port.all = false
  tenants = [group('alpha'), group('beta')]
  await page(import('./t.$slug.settings'))
  // Identifier types (A1), Source codes (A2) and Fields (B1) are served.
  expect(links()).toEqual([
    ['Fields', '/t/alpha/settings/fields'],
    ['Identifier types', '/t/alpha/settings/identifiers'],
    ['Source codes', '/t/alpha/settings/sources'],
    ['Members', '/t/alpha/settings/members'],
    ['Switch group', '/t/alpha/settings/groups'],
    ['Your account', '/account'],
  ])
  // The first list tab served, in nav order, opens: in one group as in
  // several.
  await page(import('./t.$slug.settings.index'))
  expect(navigated).toEqual(['/t/alpha/settings/fields'])
  tenants = [group('alpha')]
  navigated.length = 0
  await page(import('./t.$slug.settings.index'))
  expect(navigated).toEqual(['/t/alpha/settings/fields'])
})

test('settings: the first tab is Fields once every list is ported', async () => {
  await page(import('./t.$slug.settings'))
  expect(links()).toEqual([
    ['Fields', '/t/alpha/settings/fields'],
    ['Identifier types', '/t/alpha/settings/identifiers'],
    ['Source codes', '/t/alpha/settings/sources'],
    ['Members', '/t/alpha/settings/members'],
    ['Your account', '/account'],
  ])
  await page(import('./t.$slug.settings.index'))
  expect(navigated).toEqual(['/t/alpha/settings/fields'])
})

test('being ported: an unported route shows the placeholder, not the page', async () => {
  port.all = false
  // Every route is ported (B1, B2): a made-up one stands in.
  port.leaf = '/t/$slug/not-yet'
  await page(import('./t.$slug'))
  expect(text()).toContain('This page is being ported')
  expect(el.querySelector('[data-testid="outlet"]')).toBeNull()
  port.leaf = '/t/$slug/contacts/$contactId'
  await page(import('./t.$slug'))
  expect(text()).not.toContain('being ported')
  expect(el.querySelector('[data-testid="outlet"]')).not.toBeNull()
})

test('being ported: home has the gift actions (B2)', async () => {
  port.all = false
  await home(group('alpha', { role: 'staff' }))
  expect(links()).toEqual([
    ['Record a gift', '/t/alpha/gifts/new'],
    ['Find a contact', '/t/alpha/contacts'],
    ['New contact', '/t/alpha/contacts/new'],
  ])
  expect(text()).toContain('My recent gifts')
})

// The phone header (below md): a Menu button opens a drawer from the left
// with the same destinations, Donations flattened, then the account. The
// drawer is a history entry of its own: back closes it.

const menuButton = () =>
  el.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')!
const drawer = () => document.querySelector('[role="dialog"]')
const drawerLink = (name: string) =>
  [...drawer()!.querySelectorAll('a')].find((a) => a.textContent === name)!
const locked = () => document.body.hasAttribute('data-scroll-locked')
// Radix moves focus a tick after the drawer unmounts.
const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const paths = () => hist.entries.map((e) => e.path)
async function openDrawer() {
  await page(import('./t.$slug'))
  menuButton().focus()
  await act(async () => menuButton().click())
  expect(drawer()).not.toBeNull()
  return drawer()!
}

test('phone header: a Menu button and the group name, and the desktop nav only from md', async () => {
  await page(import('./t.$slug'))
  const button = menuButton()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  // 44px tap targets.
  expect(button.className).toContain('size-11')
  const bar = button.closest('div')!
  expect(bar.className.split(' ')).toContain('md:hidden')
  expect(links(bar)).toEqual([['Alpha', '/t/alpha']])
  expect(bar.querySelector('a')!.className).toContain('min-h-11')
  const nav = el.querySelector('nav[aria-label="Main"]')!
  expect(nav.className.split(' ')).toEqual(
    expect.arrayContaining(['hidden', 'md:flex']),
  )
  expect(nav.className.split(' ')).not.toContain('flex')
  expect(drawer()).toBeNull()
})

test('the drawer lists every destination, Donations flattened, then the account', async () => {
  gifts = [
    gift({
      _id: 'g2' as RecentGift['_id'],
      amount: 123456n,
      contactName: 'Acme Ltd',
    }),
    gift({ status: 'void' }),
  ]
  const d = await openDrawer()
  expect(d.textContent).toContain('Alpha')
  expect(links(d)).toEqual([
    ['Home', '/t/alpha'],
    ['Contacts', '/t/alpha/contacts'],
    ['Record a gift', '/t/alpha/gifts/new'],
    ['£1,234.56Acme Ltd23 Oct 2026', '/t/alpha/gifts/g2'],
    ['£20.00Jo Bloggsvoid23 Oct 2026', '/t/alpha/gifts/g1'],
    ['Settings', '/t/alpha/settings'],
    ['Your accounta@example.org', '/account'],
  ])
  // No dropdown inside the drawer: Donations is a section, its items links.
  const donations = d.querySelector('section[aria-label="Donations"]')!
  expect(donations.textContent).toContain('My recent gifts')
  expect(d.querySelector('[role="menu"]')).toBeNull()
  expect(
    [...d.querySelectorAll('button')].map((b) => b.textContent.trim()),
  ).toEqual(['', 'Sign out'])
  expect(d.querySelector('button[aria-label="Close menu"]')).not.toBeNull()
})

test('the drawer: a viewer has no Record a gift, and no gifts says so', async () => {
  tenants = [group('alpha', { role: 'viewer' })]
  const d = await openDrawer()
  expect(d.textContent).not.toContain('Record a gift')
  expect(d.querySelector('section[aria-label="Donations"]')!.textContent).toBe(
    'DonationsMy recent giftsNone yet.',
  )
})

test('the drawer marks the current page', async () => {
  hist.reset('/t/alpha/contacts/c1')
  const d = await openDrawer()
  const current = [...d.querySelectorAll('[aria-current="page"]')]
  expect(current.map((a) => a.textContent)).toEqual(['Contacts'])
  // The visible mark is the aria-current style.
  expect(current[0].className).toContain('aria-[current=page]:font-medium')
  // Home is marked only on the home page itself.
  act(() => root.unmount())
  root = createRoot(el)
  hist.reset('/t/alpha')
  const onHome = await openDrawer()
  expect(
    [...onHome.querySelectorAll('[aria-current="page"]')].map(
      (a) => a.textContent,
    ),
  ).toEqual(['Home'])
})

test('opening the drawer pushes an entry for the same page; back closes it and stays', async () => {
  await openDrawer()
  expect(paths()).toEqual(['/t/alpha', '/t/alpha'])
  expect(hist.now().state.mobileNav).toEqual(expect.any(String))
  expect(locked()).toBe(true)
  await act(async () => hist.back())
  await tick()
  expect(drawer()).toBeNull()
  expect(hist.now()).toEqual({ path: '/t/alpha', state: {} })
  expect(locked()).toBe(false)
  // Same page: focus goes back to the Menu button.
  expect(document.activeElement).toBe(menuButton())
  // Opening again works, with a new entry.
  await act(async () => menuButton().click())
  expect(drawer()).not.toBeNull()
  expect(hist.index).toBe(1)
})

test('a drawer link takes the drawer entry’s place in history and closes it', async () => {
  await openDrawer()
  await act(async () => drawerLink('Contacts').click())
  await tick()
  expect(drawer()).toBeNull()
  expect(paths()).toEqual(['/t/alpha', '/t/alpha/contacts'])
  expect(hist.index).toBe(1)
  expect(hist.now().state.mobileNav).toBeUndefined()
  expect(locked()).toBe(false)
  // Back from Contacts lands on the page the drawer was opened on.
  await act(async () => hist.back())
  expect(hist.now()).toEqual({ path: '/t/alpha', state: {} })
})

test('a drawer link to a page that autofocuses leaves focus on that page', async () => {
  await openDrawer()
  await act(async () => drawerLink('Record a gift').click())
  await tick()
  expect(drawer()).toBeNull()
  expect(document.activeElement).toBe(
    el.querySelector('input[aria-label="Contact"]'),
  )
  expect(menuButton()).not.toBe(document.activeElement)
})

test('a drawer link to the page already shown closes it, in place', async () => {
  await openDrawer()
  await act(async () => drawerLink('Home').click())
  await tick()
  expect(drawer()).toBeNull()
  expect(paths()).toEqual(['/t/alpha', '/t/alpha'])
  expect(hist.now().state.mobileNav).toBeUndefined()
})

const closers: Array<[string, () => void]> = [
  [
    'Esc',
    () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
  ],
  [
    'Close',
    () =>
      drawer()!
        .querySelector<HTMLButtonElement>('button[aria-label="Close menu"]')!
        .click(),
  ],
  [
    'an overlay tap',
    () => {
      // Radix acts on a primary press once its click follows, as a tap's.
      const overlay = document.querySelector('[data-slot="sheet-overlay"]')!
      overlay.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      )
      overlay.dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }),
      )
    },
  ],
]

test.each(closers)(
  'the drawer closes on %s, unwinds its entry once, and focus returns',
  async (_, close) => {
    await openDrawer()
    // Radix listens for outside presses a tick after opening.
    await tick()
    await act(async () => close())
    await tick()
    expect(drawer()).toBeNull()
    expect(paths()).toEqual(['/t/alpha', '/t/alpha'])
    expect(hist.index).toBe(0)
    expect(hist.now()).toEqual({ path: '/t/alpha', state: {} })
    expect(document.activeElement).toBe(menuButton())
    expect(locked()).toBe(false)
  },
)

test('the drawer traps focus while open', async () => {
  const d = await openDrawer()
  expect(d.contains(document.activeElement)).toBe(true)
  // Focus can't leave for the page behind it.
  await act(async () => menuButton().focus())
  expect(d.contains(document.activeElement)).toBe(true)
  // The page behind is hidden from assistive tech, and doesn't scroll.
  expect(el.getAttribute('aria-hidden')).toBe('true')
  expect(locked()).toBe(true)
})

test('any other navigation closes it: another page, or only the search', async () => {
  await openDrawer()
  await act(async () => hist.push('/t/alpha/contacts'))
  await tick()
  expect(drawer()).toBeNull()
  expect(locked()).toBe(false)

  await act(async () => menuButton().click())
  expect(drawer()).not.toBeNull()
  await act(async () => hist.push('/t/alpha/contacts?q=ada'))
  await tick()
  expect(drawer()).toBeNull()
  expect(locked()).toBe(false)
  // Nothing was unwound: the navigations stand.
  expect(hist.now().path).toBe('/t/alpha/contacts?q=ada')
})

test('Sign out in the drawer signs out and goes to the sign-in page', async () => {
  const d = await openDrawer()
  const button = [...d.querySelectorAll('button')].find(
    (b) => b.textContent === 'Sign out',
  )!
  await act(async () => button.click())
  expect(signOut).toHaveBeenCalledOnce()
  // In the drawer entry's place.
  expect(navigate).toHaveBeenLastCalledWith({ to: '/', replace: true })
  expect(paths()).toEqual(['/t/alpha', '/'])
})
