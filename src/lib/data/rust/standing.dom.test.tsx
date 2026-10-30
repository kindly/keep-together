// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TenantContext } from '../../tenant'
import type { Tenant } from '../../tenant'
import type { StandingOrderView } from '../rust-types/StandingOrderView'
import { useStandingOrderWrites } from './standing'

// Recording a standing order on the data layer (review soui M2): a retry
// whose first answer was lost is the same standing order, read back.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SLUG = 'alpha'

function wire(over: Partial<StandingOrderView> = {}): StandingOrderView {
  return {
    id: 's1',
    contactId: 'c1',
    contactName: 'Jo Giver',
    status: 'active',
    bankReference: null,
    missedOn: null,
    nextDueOn: '2026-12-05',
    endedReason: null,
    endedAt: null,
    chain: [],
    expected: [],
    setupVersion: 0,
    mandateVersion: 0,
    missedVersion: 0,
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
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <TenantContext.Provider value={{ slug: SLUG } as unknown as Tenant}>
          <Probe />
        </TenantContext.Provider>
      </QueryClientProvider>,
    ),
  )
  return () => value!
}

test('a 409 duplicate under the same form key reads the first one back as recorded', async () => {
  const writes = mount(() => useStandingOrderWrites())
  answers.push(json(409, { kind: 'duplicate', id: 's9' }))
  answers.push(json(200, wire({ id: 's9' })))
  let recorded: { id: string } | undefined
  await act(async () => {
    recorded = await writes().record('c1', {
      amount: 1000n,
      frequency: 'monthly',
      dayOfMonth: 5,
      sourceCodeId: 'v1',
      startsOn: '2026-11-05',
      clientKey: 'k1',
    })
  })
  expect(recorded?.id).toBe('s9')
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatch(/\/api\/t\/alpha\/standing-orders\/s9$/)
})

test('any other refusal still throws', async () => {
  const writes = mount(() => useStandingOrderWrites())
  answers.push(json(422, { kind: 'invalid', problems: [] }))
  let refused: unknown
  await act(async () => {
    await writes()
      .record('c1', {
        amount: 1000n,
        frequency: 'monthly',
        dayOfMonth: 5,
        sourceCodeId: 'v1',
        startsOn: '2026-11-05',
        clientKey: 'k1',
      })
      .catch((err: unknown) => (refused = err))
  })
  expect(refused).toBeDefined()
  expect(sent).toHaveLength(1)
})
