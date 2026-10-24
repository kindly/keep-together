// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TenantContext } from '../../tenant'
import type { Tenant } from '../../tenant'
import { applyEvent } from '../events'
import type { DeclarationRow } from '../rust-types/DeclarationRow'
import type { GiftView as WireGift } from '../rust-types/GiftView'
import {
  declarationFromWire,
  giftViewFromWire,
  joinMoments,
  useGiftWrites,
  useRecordGift,
} from './gifts'
import type { GiftView, Moment } from './gifts'
import { keys } from './keys'

// Gifts on the Rust data layer: the wire's integers become the pages'
// bigint pence, and every write shows only what the server answered
// (gifts are never optimistic, human 2026-10-23).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SLUG = 'alpha'
const GIFT = '0190f1d23c4b7a00800000000000000a'

function wireGift(over: Partial<WireGift> = {}): WireGift {
  return {
    id: GIFT,
    contactId: 'c1',
    receivedOn: '2026-10-20',
    amount: 123456705,
    method: 'card',
    reference: null,
    allocations: [
      {
        key: 'k1',
        sourceCodeId: 's1',
        amount: 123456705,
        code: 'Street-Wesser-001',
        isActive: true,
        startDate: null,
        endDate: '2026-12-31',
      },
    ],
    status: 'completed',
    enteredBy: 1,
    enteredAt: 1000,
    giftVersion: 0,
    statusVersion: 1,
    contact: { id: 'c1', displayName: 'Jo Bloggs', kind: 'individual' },
    ...over,
  }
}

/** The next `fetch` answers: queued per call. */
let answers: Array<() => Promise<Response>> = []
const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))
const sent: Array<{ url: string; body: unknown }> = []

let root: Root
let el: HTMLDivElement
let qc: QueryClient
beforeEach(() => {
  answers = []
  sent.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      sent.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      const next = answers.shift()
      return next ? next() : json(200, {})()
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

test('wire integers become bigint pence; nulls are absent fields', () => {
  const g = giftViewFromWire(wireGift())
  expect(g).toMatchObject({
    _id: GIFT,
    _creationTime: 1000,
    amount: 123456705n,
    contact: { _id: 'c1', displayName: 'Jo Bloggs', kind: 'individual' },
  })
  expect('reference' in g).toBe(false)
  expect(g.allocations[0]).toMatchObject({
    amount: 123456705n,
    startDate: undefined,
    endDate: '2026-12-31',
  })
  const row: DeclarationRow = {
    id: 'd1',
    contactId: 'c1',
    scope: 'thisGift',
    contributionId: GIFT,
    madeOn: '2026-10-20',
    method: 'paperForm',
    wordingVersion: 'hmrc-2016-04',
    firstName: 'Jo',
    lastName: 'Bloggs',
    addressLine1: '1',
    postcode: 'AB1 2CD',
    cancelledFrom: null,
    cancellationNote: null,
    voidReason: null,
    voidedAt: null,
    voidedBy: null,
    enteredBy: 1,
    enteredAt: 1000,
    declarationVersion: 0,
    cancellationVersion: 0,
    voidVersion: 0,
    warnings: [],
  }
  // The coverage rules test `!== undefined`: a null must not read as set.
  const d = declarationFromWire(row)
  expect(d).toMatchObject({ _id: 'd1', contributionId: GIFT, enteredBy: 1 })
  expect(d.voidedAt).toBeUndefined()
  expect(d.cancelledFrom).toBeUndefined()
})

test('a void shows only once the server answers, and shows what it answered', async () => {
  const view = keys.gift(SLUG, GIFT)
  qc.setQueryData(view, giftViewFromWire(wireGift()))
  const writes = mount(() => useGiftWrites(GIFT))
  let answer!: (r: Response) => void
  answers.push(() => new Promise((r) => (answer = r)))
  let done!: Promise<unknown>
  act(() => {
    done = writes().setStatus(1, 'void')
  })
  // In flight: nothing changed on screen.
  expect(qc.getQueryData<GiftView>(view)?.status).toBe('completed')
  expect(sent.at(-1)).toEqual({
    url: `/api/t/${SLUG}/gifts/${GIFT}/status`,
    body: { expected: 1, status: 'void' },
  })
  await act(async () => {
    answer(
      new Response(
        JSON.stringify({
          id: GIFT,
          counter: 2,
          view: wireGift({ status: 'void', statusVersion: 2 }),
        }),
        { status: 200 },
      ),
    )
    await done
  })
  expect(qc.getQueryData<GiftView>(view)).toMatchObject({
    status: 'void',
    statusVersion: 2,
  })
})

test('a refused save leaves the gift as the server last said', async () => {
  const view = keys.gift(SLUG, GIFT)
  qc.setQueryData(view, giftViewFromWire(wireGift()))
  const writes = mount(() => useGiftWrites(GIFT))
  answers.push(
    json(409, {
      kind: 'stale',
      contract: 'giving.gift',
      counter: 1,
      current: {},
    }),
  )
  await act(async () => {
    await expect(
      writes().save(0, {
        contactId: 'c1' as never,
        receivedOn: '2026-10-21',
        amount: 2500n,
        method: 'cash',
        allocations: [{ key: 'k1', sourceCodeId: 's1' as never, amount: 2500n }],
      }),
    ).rejects.toMatchObject({ status: 409, error: { kind: 'stale' } })
  })
  expect(sent.at(-1)?.body).toMatchObject({
    expected: 0,
    amount: 2500,
    allocations: [{ amount: 2500 }],
  })
  expect(qc.getQueryData<GiftView>(view)).toMatchObject({
    amount: 123456705n,
    receivedOn: '2026-10-20',
  })
})

test('the record save sends JSON integer pence and refuses what JSON would round', async () => {
  const record = mount(() => useRecordGift())
  answers.push(json(200, { contactId: 'c1', giftId: GIFT, declarationId: null }))
  const args = {
    clientKey: 'k',
    contact: 'c1',
    receivedOn: '2026-10-20',
    method: 'cash' as const,
  }
  await act(async () => {
    await record()({
      ...args,
      amount: 2000n,
      allocations: [{ sourceCodeId: 's1' as never, amount: 2000n }],
    })
  })
  expect(sent.at(-1)?.body).toMatchObject({
    amount: 2000,
    allocations: [{ amount: 2000 }],
  })
  const calls = sent.length
  await act(async () => {
    await expect(
      record()({
        ...args,
        amount: 2n ** 60n,
        allocations: [{ sourceCodeId: 's1' as never, amount: 2n ** 60n }],
      }),
    ).rejects.toThrow(RangeError)
  })
  expect(sent.length).toBe(calls)
})

test('events: a gift, a declaration, a contact or a code refetch what shows them', () => {
  // A slug per event: `invalidate` coalesces a key still refetching.
  const stale = (slug: string, entity: string, contract: string) => {
    const gift = keys.gift(slug, GIFT)
    const panel = keys.declarations(slug, 'c1', '2026-10-23')
    qc.setQueryData(gift, {})
    qc.setQueryData(panel, {})
    applyEvent(qc, slug, { seq: 1, entity, id: 'x', contract, counter: 1 })
    return [
      qc.getQueryState(gift)?.isInvalidated,
      qc.getQueryState(panel)?.isInvalidated,
    ]
  }
  expect(stale('e1', 'gifts', 'giving.status')).toEqual([true, false])
  expect(stale('e2', 'gift_aid_declarations', 'giftaid.void')).toEqual([
    true,
    true,
  ])
  expect(stale('e3', 'contacts', 'contacts.details')[0]).toBe(true)
  expect(stale('e4', 'source_codes', 'sources.code')[0]).toBe(true)
})

test('a command group cut by a page boundary is one moment', () => {
  const m = (key: string, slices: Array<string>, revisionId: number) =>
    ({
      key,
      revisionId,
      at: 0,
      actor: 1,
      source: 'ui',
      groupName: null,
      slices,
      restored: false,
    }) as Moment
  expect(
    joinMoments([m('g1', ['status'], 3), m('g1', ['gift', 'status'], 2), m('r1', ['gift'], 1)]),
  ).toEqual([m('g1', ['status', 'gift'], 3), m('r1', ['gift'], 1)])
})
