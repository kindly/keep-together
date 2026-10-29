// @vitest-environment happy-dom
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TenantContext } from '../../tenant'
import type { Tenant } from '../../tenant'
import { applyEvent } from '../events'
import type { RegularGiftView } from '../rust-types/RegularGiftView'
import { RustApiError } from './client'
import {
  landRegularGift,
  regularGiftFromWire,
  useDirectDebitWrites,
} from './gocardless'
import type { RegularGift } from './gocardless'
import { keys } from './keys'

// Direct Debit on the data layer (GoCardless D3): a write's answer never
// overwrites a newer state, a 409 reads the regular gifts again before
// it is reported, and a gift recorded anywhere refetches the contacts'
// cards but never asks GoCardless for a card's forecast.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SLUG = 'alpha'

function wire(over: Partial<RegularGiftView> = {}): RegularGiftView {
  return {
    id: 'r1',
    contactId: 'c1',
    amount: 1250,
    frequency: 'monthly',
    dayOfMonth: 1,
    month: null,
    sourceCodeId: 'v1',
    sourceCode: 'STREET-1',
    allocations: [
      { key: 'a', sourceCodeId: 'v1', sourceCode: 'STREET-1', amount: 1250 },
    ],
    status: 'pending',
    endedReason: null,
    endedAt: null,
    billingRequestId: 'BRQ1',
    flowUrl: null,
    flowExpiresAt: null,
    mandateId: null,
    subscriptionId: null,
    enteredBy: 1,
    enteredAt: 0,
    setupVersion: 0,
    mandateVersion: 1,
    terms: [],
    scheduled: null,
    changeNotCoded: false,
    upcoming: [],
    lastFailure: null,
    payments: [],
    connected: true,
    ...over,
  }
}

let answers: Array<() => Promise<Response>> = []
const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))
const sent: Array<string> = []

let root: Root
let el: HTMLDivElement
let qc: QueryClient
beforeEach(() => {
  answers = []
  sent.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      sent.push(url)
      const next = answers.shift()
      return next ? next() : json(200, [])()
    }),
  )
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

function mount<T>(hook: () => T): () => T {
  let value: T | undefined
  function Probe() {
    value = hook()
    return null
  }
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TenantContext.Provider value={{ slug: SLUG } as unknown as Tenant}>
        {children}
      </TenantContext.Provider>
    </QueryClientProvider>
  )
  act(() => root.render(wrap({ children: <Probe /> })))
  return () => value!
}

const list = keys.regularGifts(SLUG, 'c1')
const listed = () => qc.getQueryData<Array<RegularGift>>(list)

test('a write’s answer replaces the card, unless the list already holds a newer state', () => {
  qc.setQueryData(list, [regularGiftFromWire(wire())])
  landRegularGift(qc, SLUG, wire({ mandateVersion: 2, flowUrl: 'https://x/2' }))
  expect(listed()?.[0].flowUrl).toBe('https://x/2')
  // A webhook's refetch landed first (mandate version 3, active): the
  // late answer (version 2) leaves it.
  qc.setQueryData(list, [
    regularGiftFromWire(wire({ mandateVersion: 3, status: 'active' })),
  ])
  landRegularGift(qc, SLUG, wire({ mandateVersion: 2, flowUrl: 'https://x/2' }))
  expect(listed()?.[0]).toMatchObject({ mandateVersion: 3, status: 'active' })
})

test('a 409 on cancel or a new link reads the regular gifts again before it is reported', async () => {
  const writes = mount(() => useDirectDebitWrites())
  // The card shows the list: count its reads.
  let reads = 0
  const unsubscribe = new QueryObserver(qc, {
    queryKey: list,
    queryFn: () => {
      reads += 1
      return Promise.resolve([
        regularGiftFromWire(wire({ mandateVersion: reads })),
      ])
    },
  }).subscribe(() => {})
  await act(async () => {})
  expect(reads).toBe(1)
  for (const call of [
    () => writes().cancel('r1', 1),
    () => writes().newLink('r1', 1),
  ]) {
    const before = reads
    answers.push(
      json(409, {
        kind: 'stale',
        contract: 'giving.regularGiftMandate',
        counter: 1,
        current: 4,
      }),
    )
    let refused: unknown
    await act(async () => {
      await call().catch((err: unknown) => (refused = err))
    })
    expect(refused).toBeInstanceOf(RustApiError)
    // Read again, and in the cache, by the time the refusal is reported.
    expect(reads).toBe(before + 1)
    expect(listed()?.[0].mandateVersion).toBe(reads)
  }
  unsubscribe()
})

test('a gift anywhere refetches the contacts’ cards, never a card’s GoCardless forecast', () => {
  const spy = vi.spyOn(qc, 'invalidateQueries')
  applyEvent(qc, SLUG, {
    entity: 'gifts',
    id: 'g1',
    contract: 'giving.gift',
    counter: 0,
  } as never)
  const invalidated = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
  expect(invalidated).toContain(JSON.stringify(keys.regularGiftLists(SLUG)))
  expect(invalidated).not.toContain(JSON.stringify(keys.gocardless(SLUG)))
  expect(keys.regularGiftForecast(SLUG, 'r1').slice(0, 3)).not.toEqual(
    keys.gocardless(SLUG),
  )
})
