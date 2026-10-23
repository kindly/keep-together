// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { getFunctionName } from 'convex/server'
import type { FunctionReference, FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

// The gift page (cash gifts step 5): someone else's edit while the form is
// open merges in field by field and moves `expected`, so typed changes
// survive and Save goes through; Void and Unvoid each confirm first.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Gift = NonNullable<FunctionReturnType<typeof api.giving.queries.get>>

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ slug: 'a', giftId: 'g1' }),
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))

const mutations: Record<string, ReturnType<typeof vi.fn>> = {
  'giving/mutations:save': vi.fn(),
  'giving/mutations:setStatus': vi.fn(),
}
let gift: Gift
let members: Array<{ userId: string; name: string }> | undefined
vi.mock('convex/react', () => ({
  useQuery: (q: FunctionReference<'query'>) => {
    const name = getFunctionName(q)
    if (name === 'giving/queries:get') return gift
    if (name === 'platform/tenants:members') return members
    return { declarations: [], currentId: null }
  },
  useMutation: (m: FunctionReference<'mutation'>) =>
    mutations[getFunctionName(m)],
  useConvex: () => ({}),
}))
vi.mock('../components/contact-history', () => ({
  HistoryFeed: class {
    hold() {}
    release() {}
  },
  fetchHistoryPage: () => undefined,
  useHistoryPages: () => ({ moments: [], loading: false }),
}))
vi.mock('../components/source-code-picker', () => ({
  SourceCodePicker: ({ value }: { value: { code: string } | null }) => (
    <span data-testid="picker">{value?.code}</span>
  ),
  localToday: () => '2026-10-23',
}))
vi.mock('../lib/tenant', () => ({
  cachedTenant: () => undefined,
  useTenant: () => ({ _id: 'tenantA', slug: 'a' }),
  useCanWrite: () => true,
}))

const { Route } = await import('./t.$slug.gifts.$giftId')
const GiftPage = (Route as unknown as { options: { component: ComponentType } })
  .options.component

function makeGift(over: Partial<Gift> = {}): Gift {
  return {
    _id: 'g1' as Id<'contributions'>,
    _creationTime: 0,
    tenantId: 'tenantA' as Id<'tenants'>,
    contactId: 'c1' as Id<'contacts'>,
    contact: { kind: 'individual', displayName: 'Jo Bloggs' },
    receivedOn: '2026-10-01',
    amount: 2000n,
    method: 'cash',
    status: 'completed',
    giftVersion: 1,
    statusVersion: 0,
    enteredBy: 'u1',
    allocations: [
      {
        key: 'k1',
        sourceCodeId: 's1' as Id<'sourceCodes'>,
        amount: 2000n,
        code: 'Event-Gala-001',
        isActive: true,
        startDate: undefined,
        endDate: undefined,
      },
    ],
    ...over,
  } as unknown as Gift
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const m of Object.values(mutations)) m.mockReset().mockResolvedValue({})
  gift = makeGift()
  members = [{ userId: 'u1', name: 'Jo Staff' }]
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

const render = () => act(() => root.render(<GiftPage />))
const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === name)!
const click = (b: HTMLElement) => act(async () => b.click())
async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const form = () =>
  el.querySelector<HTMLFormElement>('form[aria-label="Edit gift"]')!
const input = (label: string) =>
  [...form().querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(label))!
    .querySelector('input')!

test('"Entered by" waits for the members rather than saying system', () => {
  members = undefined
  render()
  expect(el.textContent).toContain('Entered by…')
  expect(el.textContent).not.toContain('system')
})

test('the edit form takes the focus and announces its warnings', async () => {
  render()
  await click(button(el, 'Edit'))
  expect(document.activeElement).toBe(input('Received'))
  const live = form().querySelector('#gift-edit-warnings')!
  expect(live.getAttribute('aria-live')).toBe('polite')
  expect(input('Amount').getAttribute('aria-describedby')).toBe(
    'gift-edit-warnings',
  )
  await type(input('Amount'), '15000')
  expect(live.textContent).toContain('£10,000')
})

test("someone else's edit merges in, keeps typed changes, and Save sends their version", async () => {
  render()
  await click(button(el, 'Edit'))
  await type(input('Amount'), '25')
  // They change the date and, like us, the amount.
  gift = makeGift({ giftVersion: 2, receivedOn: '2026-10-05', amount: 3000n })
  await render()
  expect(input('Received').value).toBe('2026-10-05')
  expect(input('Amount').value).toBe('25')
  const notice = form().querySelector('[role="status"]')!
  expect(notice.textContent).toContain(
    'Someone else changed this gift while you were editing (date, amount)',
  )
  expect(notice.textContent).toContain('Changed by both of you: amount.')
  await act(async () => form().requestSubmit())
  expect(mutations['giving/mutations:save']).toHaveBeenCalledWith(
    expect.objectContaining({
      expected: 2,
      receivedOn: '2026-10-05',
      amount: 2500n,
    }),
  )
})

test('a save refused as stale keeps the typed changes and retries once their version arrives', async () => {
  render()
  await click(button(el, 'Edit'))
  await type(input('Amount'), '25')
  const save = mutations['giving/mutations:save']
  save.mockRejectedValueOnce(new ConvexError({ kind: 'stale', current: 2 }))
  await act(async () => form().requestSubmit())
  expect(form().querySelector('[role="alert"]')?.textContent).toContain(
    'Someone else changed this gift just now',
  )
  expect(input('Amount').value).toBe('25')
  gift = makeGift({ giftVersion: 2, method: 'card' })
  await render()
  expect(input('Amount').value).toBe('25')
  expect(form().querySelector('[role="alert"]')).toBeNull()
  await act(async () => form().requestSubmit())
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ expected: 2, method: 'card', amount: 2500n }),
  )
})

test('a £0 amount is one message, sent nowhere', async () => {
  render()
  await click(button(el, 'Edit'))
  await type(input('Amount'), '0')
  await act(async () => form().requestSubmit())
  expect(form().querySelector('[role="alert"]')?.textContent).toBe(
    'The amount must be over £0',
  )
  expect(mutations['giving/mutations:save']).not.toHaveBeenCalled()
})

test('"12 50" is asked about, never saved as £1,250 (as on the record page)', async () => {
  render()
  await click(button(el, 'Edit'))
  await type(input('Amount'), '12 50')
  await act(async () => form().requestSubmit())
  expect(form().querySelector('[role="alert"]')?.textContent).toBe(
    'Is that pounds and pence? Write it like 12.50, with no spaces',
  )
  await type(input('Amount'), '92233720368547758.08')
  await act(async () => form().requestSubmit())
  expect(form().querySelector('[role="alert"]')?.textContent).toBe(
    'That amount is too large',
  )
  expect(mutations['giving/mutations:save']).not.toHaveBeenCalled()
})

test('Unvoid confirms first, as Void does', async () => {
  gift = makeGift({ status: 'void', statusVersion: 3 })
  render()
  await click(button(el, 'Unvoid'))
  const setStatus = mutations['giving/mutations:setStatus']
  expect(setStatus).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('Unvoid this gift?')
  await click(button(dialog, 'Unvoid'))
  expect(setStatus).toHaveBeenCalledWith({
    tenantId: 'tenantA',
    id: 'g1',
    expected: 3,
    status: 'completed',
  })
})
