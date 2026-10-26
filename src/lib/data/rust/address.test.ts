import { afterEach, expect, test, vi } from 'vitest'
import { lookupAddresses } from './address'

// `POST /api/t/{slug}/address-lookup`'s answers as the picker's outcomes.

afterEach(() => vi.unstubAllGlobals())

function answer(status: number, body: unknown) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const ADDRESS = {
  line1: '1 Test Street',
  line2: '',
  line3: '',
  town: 'Fakebury',
  postcode: 'ID1 1QD',
}

test('asks the tenant’s route with the postcode as typed', async () => {
  const fetch = answer(200, { addresses: [ADDRESS] })
  expect(await lookupAddresses('alpha', 'id1 1qd')).toEqual({
    kind: 'found',
    addresses: [ADDRESS],
  })
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe('/api/t/alpha/address-lookup')
  expect(init?.method).toBe('POST')
  expect(JSON.parse(init?.body as string)).toEqual({ postcode: 'id1 1qd' })
})

test.each([
  [404, { kind: 'not_found' }, { kind: 'none' }],
  [429, { kind: 'lookup_cap' }, { kind: 'cap' }],
  [503, { kind: 'lookup_unavailable' }, { kind: 'unavailable' }],
  [500, { kind: 'internal' }, { kind: 'unavailable' }],
  [
    422,
    {
      kind: 'invalid',
      problems: [
        { field: 'postcode', message: 'Enter a UK postcode, like SW1A 1AA.' },
      ],
    },
    { kind: 'invalid', message: 'Enter a UK postcode, like SW1A 1AA.' },
  ],
])('%i %o → %o', async (status, body, outcome) => {
  answer(status, body)
  expect(await lookupAddresses('alpha', 'X')).toEqual(outcome)
})

test('the network down is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline')
    }),
  )
  expect(await lookupAddresses('alpha', 'ID1 1QD')).toEqual({
    kind: 'unavailable',
  })
})
