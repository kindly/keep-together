// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import { TenantContext } from '../../tenant'
import type { Tenant } from '../../tenant'
import { applyEvent } from '../events'
import { keys } from './keys'
import { useSetAcquisition, useSourceWrites } from './sources'

// A part saved from this tab: its own event is swallowed (`ownWrite`),
// so the save itself must refresh what that event would have, contact
// views included (a rename shows on every contact carrying the code).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SLUG = 'alpha'
const PART = '0190f1d23c4b7a008000000000000009' as Id<'sourceCodes'>
const CONTACT = '0190f1d23c4b7a008000000000000001'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith('/save') ? { id: PART, counter: 1 } : { parts: [] },
          ),
          { status: 200 },
        ),
      ),
    ),
  )
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

test("a part saved here refreshes this tab's contact views, though its own event is skipped", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const contact = keys.contact(SLUG, CONTACT)
  qc.setQueryData(contact, { id: CONTACT })
  let writes: ReturnType<typeof useSourceWrites> | undefined
  function Probe() {
    writes = useSourceWrites()
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

  await act(async () => {
    await writes!.save(PART, 0, { name: 'North', isActive: true })
  })
  // The answer won the race: the event that follows is this tab's own.
  applyEvent(qc, SLUG, {
    seq: 7,
    entity: 'source_codes',
    id: PART,
    contract: 'sources.code',
    counter: 1,
  })
  expect(qc.getQueryState(contact)?.isInvalidated).toBe(true)
})

// codex C1 (delta b): the acquisition answer's contact view, delayed past
// a later save another tab made (and a refetch already showed), must not
// put the older contact back; the contact is read again instead.
test('a delayed acquisition answer never replaces a newer contact view', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const contact = keys.contact(SLUG, CONTACT)
  const counters = {
    details: 0,
    methods: 0,
    addresses: 0,
    archive: 0,
    fields: 0,
    identifiers: 0,
    acquisition: 0,
  }
  const view = (over: Partial<typeof counters>, nickname: string) => ({
    id: CONTACT,
    details: { nickname },
    counters: { ...counters, ...over },
  })
  // Someone else's nickname save (details 1) is on screen already.
  qc.setQueryData(contact, view({ details: 1 }, 'newer'))
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: CONTACT,
            counter: 1,
            // Read in our transaction, before their save: details 0.
            view: view({ acquisition: 1 }, 'older'),
          }),
          { status: 200 },
        ),
      ),
    ),
  )
  let set: ReturnType<typeof useSetAcquisition> | undefined
  function Probe() {
    set = useSetAcquisition(CONTACT as Id<'contacts'>)
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
  await act(async () => {
    await set!(PART, 0)
  })
  expect(qc.getQueryData(contact)).toMatchObject({
    details: { nickname: 'newer' },
  })
  expect(qc.getQueryState(contact)?.isInvalidated).toBe(true)

  // Not behind on any slice: the answer lands as before.
  qc.setQueryData(contact, view({}, 'older'))
  await act(async () => {
    await set!(PART, 0)
  })
  expect(qc.getQueryData(contact)).toMatchObject({
    details: { nickname: 'older' },
    counters: { acquisition: 1 },
  })
})
