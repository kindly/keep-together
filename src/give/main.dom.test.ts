// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type * as ApiModule from './api'

// The donor's page, screen by screen: no page, the form and what it
// sends, what the server's refusals show, and the thank-you page, which
// asks only for the group's name.

const left = vi.hoisted(() => ({ for: [] as Array<string> }))
vi.mock('./api', async (actual) => {
  const real = await actual<typeof ApiModule>()
  return { ...real, leaveFor: (url: string) => void left.for.push(url) }
})

const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

const PAGE = {
  name: 'Riverside Food Bank',
  amounts: [1000, 2500, 5000],
  minimum: 200,
  maximum: 100_000,
  giftAid: { wordingVersion: 'hmrc-2016-04' },
}

beforeEach(() => {
  vi.resetModules()
  left.for = []
  fetch.mockReset()
  vi.stubGlobal('fetch', fetch)
  document.body.innerHTML = '<main id="give"></main>'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

async function open(path: string) {
  history.replaceState(null, '', path)
  await import('./main')
  await settle()
  return document.querySelector<HTMLElement>('[data-screen]')!
}

const $ = <T extends HTMLElement = HTMLInputElement>(selector: string) =>
  document.querySelector<T>(selector)!

function type(selector: string, value: string) {
  const input = $(selector)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pick(input: HTMLInputElement) {
  input.checked = true
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

async function submit() {
  $<HTMLFormElement>('form').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
  await settle()
}

function fillWho() {
  type('#give-firstName', 'Jane')
  type('#give-lastName', 'Smith')
  type('#give-email', 'jane@example.org')
}

const sentBody = (call = 1) =>
  JSON.parse(fetch.mock.calls[call][1]?.body as string) as Record<
    string,
    unknown
  >

test('no page: one message, whatever the reason', async () => {
  fetch.mockReturnValueOnce(json(404, { kind: 'not_found' }))
  const screen = await open('/give/nobody')
  expect(screen.dataset.screen).toBe('absent')
  expect(screen.textContent).toContain('isn’t taking donations')
  expect(fetch.mock.calls[0][0]).toBe('/api/give/nobody')
})

test('an address that names no group asks the server nothing', async () => {
  const screen = await open('/give/')
  expect(screen.dataset.screen).toBe('absent')
  expect(fetch).not.toHaveBeenCalled()
})

test('a page that will not load can be tried again', async () => {
  fetch.mockRejectedValueOnce(new TypeError('offline'))
  const screen = await open('/give/riverside')
  expect(screen.dataset.screen).toBe('retry')
  fetch.mockReturnValueOnce(json(200, PAGE))
  $<HTMLButtonElement>('button').click()
  await settle()
  expect($<HTMLElement>('[data-screen]').dataset.screen).toBe('form')
})

test('the form shows the group’s amounts and sends the one picked', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  const screen = await open('/give/riverside')
  expect(screen.dataset.screen).toBe('form')
  expect($<HTMLElement>('h1').textContent).toBe('Give to Riverside Food Bank')
  const amounts = [
    ...document.querySelectorAll<HTMLElement>('.choice span'),
  ].map((s) => s.textContent)
  expect(amounts).toEqual(['£10', '£25', '£50', 'Other'])
  // The middle amount is picked to start with.
  expect($<HTMLElement>('button[type=submit]').textContent).toBe('Give £25')

  pick($('input[name=amount][value="5000"]'))
  expect($<HTMLElement>('button[type=submit]').textContent).toBe('Give £50')
  fillWho()
  fetch.mockReturnValueOnce(json(200, { url: 'https://stripe.example/c/cs_1' }))
  await submit()

  expect(fetch.mock.calls[1][0]).toBe('/api/give/riverside/donations')
  const body = sentBody()
  expect(body).toEqual({
    id: body.id,
    amount: 5000,
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane@example.org',
  })
  expect(body.id).toMatch(/^[0-9a-f]{32}$/)
  // Off to Stripe's page, and the button stays spent meanwhile.
  expect(left.for).toEqual(['https://stripe.example/c/cs_1'])
  expect($<HTMLButtonElement>('button[type=submit]').disabled).toBe(true)
})

test('another amount is typed in pounds and sent in pence', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  await open('/give/riverside')
  pick($('input[name=amount][value=other]'))
  expect($<HTMLElement>('.other').hidden).toBe(false)
  fillWho()

  for (const [typed, message] of [
    ['', 'Enter an amount in pounds'],
    ['a tenner', 'Enter an amount in pounds'],
    ['1.50', 'from £2 to £1,000'],
    ['1000.01', 'from £2 to £1,000'],
  ]) {
    type('#give-other', typed)
    await submit()
    expect($<HTMLElement>('#give-amount-error').textContent, typed).toContain(
      message,
    )
    expect($('#give-other').getAttribute('aria-invalid')).toBe('true')
  }
  expect(fetch).toHaveBeenCalledTimes(1)

  type('#give-other', '12.50')
  expect($<HTMLElement>('button[type=submit]').textContent).toBe('Give £12.50')
  fetch.mockReturnValueOnce(json(200, { url: 'u' }))
  await submit()
  expect(sentBody().amount).toBe(1250)
  expect($<HTMLElement>('#give-amount-error').hidden).toBe(true)
})

test('nothing is sent until the form is whole', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  await open('/give/riverside')
  await submit()
  expect($<HTMLElement>('#give-firstName-error').textContent).toBe(
    'Enter your first name',
  )
  expect($<HTMLElement>('#give-lastName-error').textContent).toBe(
    'Enter your last name',
  )
  expect($<HTMLElement>('#give-email-error').textContent).toBe(
    'Enter your email address',
  )
  type('#give-firstName', 'Jane')
  type('#give-lastName', 'Smith')
  type('#give-email', 'jane@')
  await submit()
  expect($<HTMLElement>('#give-firstName-error').hidden).toBe(true)
  expect($<HTMLElement>('#give-email-error').hidden).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('Gift Aid: the declaration shown, the address asked, the wording named', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  await open('/give/riverside')
  const declaration = () => $<HTMLElement>('.tick').textContent
  expect(declaration()).toContain(
    'I want to Gift Aid my donation of £25 and any donations I make in the future or have made in the past 4 years to Riverside Food Bank.',
  )
  expect(declaration()).toContain('Adds £6.25')
  // The address is asked only once Gift Aid is ticked.
  expect($<HTMLElement>('.home').hidden).toBe(true)
  pick($('input[name=amount][value="1000"]'))
  expect(declaration()).toContain('my donation of £10 ')

  pick($('#give-giftaid'))
  expect($<HTMLElement>('.home').hidden).toBe(false)
  expect($<HTMLElement>('.home').textContent).toContain('I am a UK taxpayer')
  fillWho()
  await submit()
  expect($<HTMLElement>('#give-addressLine1-error').textContent).toBe(
    'Enter your house name or number',
  )
  expect($<HTMLElement>('#give-postcode-error').textContent).toBe(
    'Enter your postcode',
  )
  expect(fetch).toHaveBeenCalledTimes(1)

  type('#give-addressLine1', '12 Mill Lane')
  type('#give-postcode', 'AB1 2CD')
  fetch.mockReturnValueOnce(json(200, { url: 'u' }))
  await submit()
  // The wording the page showed, and nothing about a scope: the server's.
  expect(sentBody().giftAid).toEqual({
    wordingVersion: 'hmrc-2016-04',
    addressLine1: '12 Mill Lane',
    postcode: 'AB1 2CD',
  })
})

test('a group that does not claim Gift Aid shows none of it', async () => {
  fetch.mockReturnValueOnce(json(200, { ...PAGE, giftAid: null }))
  await open('/give/riverside')
  expect(document.querySelector('.giftaid')).toBeNull()
  expect(document.body.textContent).not.toContain('Gift Aid')
  fillWho()
  fetch.mockReturnValueOnce(json(200, { url: 'u' }))
  await submit()
  expect(sentBody()).not.toHaveProperty('giftAid')
})

test('a wording this page has no text for is not offered', async () => {
  fetch.mockReturnValueOnce(
    json(200, { ...PAGE, giftAid: { wordingVersion: 'hmrc-2031-01' } }),
  )
  await open('/give/riverside')
  expect(document.querySelector('.giftaid')).toBeNull()
})

test('the server’s refusals land on their fields', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  await open('/give/riverside')
  fillWho()
  fetch.mockReturnValueOnce(
    json(422, {
      kind: 'invalid',
      problems: [{ field: 'email', message: 'Enter your email address' }],
    }),
  )
  await submit()
  expect($<HTMLElement>('#give-email-error').textContent).toBe(
    'Enter your email address',
  )
  expect(left.for).toEqual([])
  // The button is ready again.
  expect($<HTMLButtonElement>('button[type=submit]').disabled).toBe(false)

  for (const [status, body, shown] of [
    [
      503,
      { kind: 'stripe_unavailable' },
      'card payment service isn’t answering',
    ],
    [429, { kind: 'rate_limited' }, 'Too many tries'],
    [
      422,
      {
        kind: 'rejected',
        reason: 'wording_changed',
        message: 'This page is out of date',
      },
      'This page is out of date',
    ],
  ] as const) {
    fetch.mockReturnValueOnce(json(status, body))
    await submit()
    expect($<HTMLElement>('.notice').textContent, String(status)).toContain(
      shown,
    )
    expect($<HTMLElement>('.notice').hidden).toBe(false)
  }
  // The page went while the donor was typing.
  fetch.mockReturnValueOnce(json(404, { kind: 'not_found' }))
  await submit()
  expect($<HTMLElement>('[data-screen]').dataset.screen).toBe('absent')
})

test('the same attempt is sent again after a failure, a new one after "duplicate"', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  await open('/give/riverside')
  fillWho()
  fetch.mockRejectedValueOnce(new TypeError('offline'))
  await submit()
  expect($<HTMLElement>('.notice').textContent).toContain(
    'couldn’t reach the server',
  )
  const first = sentBody(1).id

  // The answer was lost, not the request: the attempt has its payment
  // page already, which nobody can reach. A new attempt, at once.
  fetch.mockReturnValueOnce(json(409, { kind: 'duplicate', id: first }))
  fetch.mockReturnValueOnce(json(200, { url: 'https://stripe.example/c/cs_2' }))
  await submit()
  expect(sentBody(2).id).toBe(first)
  expect(sentBody(3).id).not.toBe(first)
  expect(sentBody(3).id).toMatch(/^[0-9a-f]{32}$/)
  expect(left.for).toEqual(['https://stripe.example/c/cs_2'])
  expect(fetch).toHaveBeenCalledTimes(4)
})

test('back from Stripe’s page, the next press is a new attempt', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  await open('/give/riverside')
  fillWho()
  fetch.mockReturnValueOnce(json(200, { url: 'u' }))
  await submit()
  expect($<HTMLButtonElement>('button[type=submit]').disabled).toBe(true)

  const back = new Event('pageshow') as Event & { persisted: boolean }
  Object.defineProperty(back, 'persisted', { value: true })
  window.dispatchEvent(back)
  expect($<HTMLButtonElement>('button[type=submit]').disabled).toBe(false)
  fetch.mockReturnValueOnce(json(200, { url: 'u2' }))
  await submit()
  expect(sentBody(2).id).not.toBe(sentBody(1).id)
})

test('the thank-you page asks for the group’s name and sends nothing', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  const screen = await open('/give/riverside/thanks?session_id=cs_1')
  expect(screen.dataset.screen).toBe('thanks')
  expect(screen.textContent).toContain('giving to Riverside Food Bank')
  expect($<HTMLAnchorElement>('a').getAttribute('href')).toBe('/give/riverside')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][0]).toBe('/api/give/riverside')
  expect(fetch.mock.calls[0][1]?.method).toBeUndefined()
})

test('nothing the donor types is kept in the browser', async () => {
  fetch.mockReturnValueOnce(json(200, PAGE))
  await open('/give/riverside')
  fillWho()
  fetch.mockReturnValueOnce(json(200, { url: 'u' }))
  await submit()
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
  expect(location.pathname + location.search + location.hash).toBe(
    '/give/riverside',
  )
})
