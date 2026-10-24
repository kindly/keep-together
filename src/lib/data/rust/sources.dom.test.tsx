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
import { useSourceWrites } from './sources'

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
