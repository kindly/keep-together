// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// The phone page's screens before any photo: the link opened, ended,
// held by another phone, or not reachable; and the token going nowhere
// but the api path.

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
