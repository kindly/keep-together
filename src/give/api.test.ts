import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { loadPage, newId, routeFrom, sendDonation, sentOf } from './api'

const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status })

beforeEach(() => {
  fetch.mockReset()
  vi.stubGlobal('fetch', fetch)
})
afterEach(() => vi.unstubAllGlobals())

test('the address names the group and which page', () => {
  expect(routeFrom('/give/riverside')).toEqual({
    slug: 'riverside',
    view: 'form',
  })
  expect(routeFrom('/give/riverside/')).toEqual({
    slug: 'riverside',
    view: 'form',
  })
  expect(routeFrom('/give/food-bank-2/thanks')).toEqual({
    slug: 'food-bank-2',
    view: 'thanks',
  })
  for (const path of [
    '/give',
    '/give/',
    '/give/A',
    '/give/a/b',
    '/give/a/thanks/x',
    '/',
  ])
    expect(routeFrom(path), path).toBeNull()
})

test('an attempt id is 32 lower-case hex, new each time', () => {
  expect(newId()).toMatch(/^[0-9a-f]{32}$/)
  expect(newId()).not.toBe(newId())
})

test('loading: the page, no page, or try again', async () => {
  const page = {
    name: 'Alpha',
    amounts: [1, 2, 3],
    minimum: 1,
    maximum: 3,
    giftAid: null,
  }
  fetch.mockResolvedValueOnce(json(200, page))
  expect(await loadPage('alpha')).toEqual({ kind: 'ok', page })
  expect(fetch.mock.calls[0][0]).toBe('/api/give/alpha')
  // No cookie goes with it: nobody is signed in on this page.
  expect(fetch.mock.calls[0][1]?.credentials).toBe('omit')
  fetch.mockResolvedValueOnce(json(404, { kind: 'not_found' }))
  expect(await loadPage('alpha')).toEqual({ kind: 'absent' })
  fetch.mockResolvedValueOnce(json(429, { kind: 'rate_limited' }))
  expect(await loadPage('alpha')).toEqual({ kind: 'retry', why: 'limited' })
  fetch.mockRejectedValueOnce(new TypeError('offline'))
  expect(await loadPage('alpha')).toEqual({ kind: 'retry', why: 'offline' })
})

test('sending: what each answer means for the donor', async () => {
  expect(
    await sentOf(json(200, { url: 'https://stripe.example/c/1' })),
  ).toEqual({
    kind: 'ok',
    url: 'https://stripe.example/c/1',
  })
  expect(
    await sentOf(
      json(422, {
        kind: 'invalid',
        problems: [
          { field: 'giftAid.postcode', message: 'Enter your postcode' },
          { field: 'amount', message: 'Between £2.00 and £1,000.00' },
          { field: '', message: 'unknown field `scope`' },
        ],
      }),
    ),
  ).toEqual({
    kind: 'invalid',
    problems: [
      { field: 'postcode', message: 'Enter your postcode' },
      { field: 'amount', message: 'Between £2.00 and £1,000.00' },
      { field: null, message: 'unknown field `scope`' },
    ],
  })
  expect(
    await sentOf(
      json(422, {
        kind: 'rejected',
        reason: 'wording_changed',
        message: 'Out of date',
      }),
    ),
  ).toEqual({ kind: 'changed', message: 'Out of date' })
  expect(await sentOf(json(409, { kind: 'duplicate', id: 'x' }))).toEqual({
    kind: 'duplicate',
  })
  expect(await sentOf(json(404, { kind: 'not_found' }))).toEqual({
    kind: 'absent',
  })
  expect(await sentOf(json(429, { kind: 'rate_limited' }))).toEqual({
    kind: 'retry',
    why: 'limited',
  })
  expect(await sentOf(json(503, { kind: 'stripe_unavailable' }))).toEqual({
    kind: 'retry',
    why: 'stripe',
  })
  expect(await sentOf(new Response('<html>', { status: 502 }))).toEqual({
    kind: 'retry',
    why: 'server',
  })
})

test('a donation is one JSON post to the group’s page', async () => {
  fetch.mockResolvedValueOnce(json(200, { url: 'u' }))
  const donation = {
    id: 'a'.repeat(32),
    amount: 2500,
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane@example.org',
  }
  expect(await sendDonation('alpha', donation)).toEqual({
    kind: 'ok',
    url: 'u',
  })
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe('/api/give/alpha/donations')
  expect(init?.method).toBe('POST')
  expect(JSON.parse(init?.body as string)).toEqual(donation)
  fetch.mockRejectedValueOnce(new TypeError('offline'))
  expect(await sendDonation('alpha', donation)).toEqual({
    kind: 'retry',
    why: 'offline',
  })
})
