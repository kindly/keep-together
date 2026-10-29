// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type * as PersistModule from './persist'
import type { Persist } from './persist'

// The phone page's screens before any photo: the link opened, ended,
// held by another phone, or not reachable; the token going nowhere but
// the api path; and pages kept on the phone sent again after a reload
// (IndexedDB stood in for by memoryPersist).

const kept = vi.hoisted(() => ({
  store: null as null | Persist,
}))
vi.mock('./persist', async (actual) => {
  const real = await actual<typeof PersistModule>()
  return {
    ...real,
    pairingKey: () => Promise.resolve('k'),
    openPersist: () => Promise.resolve(kept.store ?? real.noPersist),
  }
})

const TOKEN = 'c0'.repeat(32)

const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

const SITTING = {
  orgName: 'Riverside Food Bank',
  purpose: 'stack',
  expiresAt: 0,
  idleExpiresAt: 0,
  uploadsLeft: 300,
  maxPages: 6,
  maxPageBytes: 400_000,
  scans: [],
}

beforeEach(() => {
  kept.store = null
  vi.resetModules()
  fetch.mockReset()
  vi.stubGlobal('fetch', fetch)
  document.body.innerHTML =
    '<input id="camera" type="file"><main id="scan"></main>'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function open(hash: string) {
  history.replaceState(null, '', `/scan.html${hash}`)
  await import('./main')
  // The open call and its render.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  return document.querySelector<HTMLElement>('[data-screen]')!
}

test('opens the sitting with the token from the fragment, and shows the organisation', async () => {
  fetch.mockImplementation(() => json(200, SITTING))
  const screen = await open(`#${TOKEN}`)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][0]).toBe(`/api/scan/${TOKEN}`)
  expect(fetch.mock.calls[0][1]).toMatchObject({
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  })
  expect(screen.dataset.screen).toBe('home')
  expect(document.body.textContent).toContain('Riverside Food Bank')
  expect(document.querySelector('label[for="camera"]')?.textContent).toBe(
    'Photograph a declaration',
  )
})

test('without a token it asks for the laptop’s code and calls nothing', async () => {
  const screen = await open('')
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.dataset.why).toBe('no_token')
})

test('a malformed token never reaches a path', async () => {
  const screen = await open('#../../api/t/x')
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.dataset.why).toBe('no_token')
})

test('an ended link says so and how to start another', async () => {
  fetch.mockImplementation(() => json(410, { kind: 'gone' }))
  const screen = await open(`#${TOKEN}`)
  expect(screen.dataset.why).toBe('gone')
  expect(screen.textContent).toContain('This link has ended')
  expect(screen.textContent).toContain('Scan with phone')
})

test('a link held by another phone says so', async () => {
  fetch.mockImplementation(() => json(403, { kind: 'forbidden' }))
  const screen = await open(`#${TOKEN}`)
  expect(screen.dataset.why).toBe('forbidden')
  expect(screen.textContent).toContain('open on another phone')
})

test('no connection offers to try again, and trying again opens it', async () => {
  fetch.mockImplementationOnce(() =>
    Promise.reject(new TypeError('Load failed')),
  )
  const screen = await open(`#${TOKEN}`)
  expect(screen.dataset.screen).toBe('unreachable')
  fetch.mockImplementation(() => json(200, SITTING))
  screen.querySelector('button')!.click()
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  expect(
    document.querySelector<HTMLElement>('[data-screen]')!.dataset.screen,
  ).toBe('home')
})

test('the page logs nothing (the token is in its URL)', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
  fetch.mockImplementation(() => json(410, { kind: 'gone' }))
  await open(`#${TOKEN}`)
  for (const spy of spies) expect(spy).not.toHaveBeenCalled()
})

const A = 'a'.repeat(32)
const P1 = '1'.repeat(32)
const P2 = '2'.repeat(32)

async function keptPages() {
  const { memoryPersist } = await import('./persist')
  const store = memoryPersist()
  const page = (pageId: string, opens: boolean, seq: number) => ({
    key: 'k',
    pageId,
    scanId: A,
    opens,
    seq,
    bytes: new Uint8Array([0xff, 0xd8, seq]).buffer,
    savedAt: Date.now(),
  })
  // Page 1 landed (the scan exists) but its removal was lost; page 2
  // never got through before iOS threw the page away.
  await store.put(page(P1, true, 1))
  await store.put(page(P2, false, 2))
  await store.setCurrent('k', A)
  kept.store = store
  return store
}

test('a reload sends kept pages again, once, with their ids, and reopens the scan', async () => {
  const store = await keptPages()
  fetch.mockImplementation((url) =>
    url.endsWith(TOKEN)
      ? json(200, { ...SITTING, scans: [{ id: A, pages: 1, open: true }] })
      : json(200, { scanId: A, pages: 2, uploadsLeft: 298 }),
  )
  const screen = await open(`#${TOKEN}`)
  const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(posts.map(([url]) => url)).toEqual([
    `/api/scan/${TOKEN}/scans/${A}/pages?pageId=${P2}`,
  ])
  expect(screen.dataset.screen).toBe('scan')
  expect(screen.querySelector('h2')?.textContent).toBe('This scan: 2 pages')
  expect(document.body.textContent).toContain('Picked up 1 page')
  // Landed, both: nothing left kept for the link.
  expect(store.pages.size).toBe(0)
})

test('kept pages wait out no signal, still kept', async () => {
  const store = await keptPages()
  fetch.mockImplementation((url) =>
    url.endsWith(TOKEN)
      ? json(200, { ...SITTING, scans: [{ id: A, pages: 1, open: true }] })
      : Promise.reject(new TypeError('Load failed')),
  )
  await open(`#${TOKEN}`)
  expect(document.querySelector('[data-retrying="offline"]')).not.toBeNull()
  expect([...store.pages.keys()]).toEqual([P2])
})

test('kept pages of a link that has ended are let go', async () => {
  const store = await keptPages()
  fetch.mockImplementation(() => json(410, { kind: 'gone' }))
  const screen = await open(`#${TOKEN}`)
  expect(screen.dataset.why).toBe('gone')
  expect(store.pages.size).toBe(0)
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
    false,
  )
})
