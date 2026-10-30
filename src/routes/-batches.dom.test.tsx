// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BatchGift, PayingInBatch } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'

// Bank transfers 6b's paying-in batch pages: the list (open first, each
// with where it stands), opening one, a batch with its gifts and total
// against the slip, closing it with the slip's total, reopening it, and
// a matched one left alone. Never optimistic: what shows is the server's.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let role: 'admin' | 'staff' | 'viewer' = 'staff'
let list: Array<PayingInBatch> = []
let page: { batch: PayingInBatch; gifts: Array<BatchGift> } | undefined
const writes = {
  open: vi.fn(),
  close: vi.fn(),
  reopen: vi.fn(),
  save: vi.fn(),
}
const navigate = vi.fn()
vi.mock('../lib/data', () => ({
  useBatches: () => ({ data: list, error: null, refetch: vi.fn() }),
  useBatch: () => ({ data: page, error: null }),
  useBatchWrites: () => writes,
  useBankAccounts: () => ({
    data: [
      { id: 'acc1', name: 'CAF current', active: true },
      { id: 'acc2', name: 'Old', active: false },
    ],
  }),
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha', role }),
  useIsAdmin: () => role === 'admin',
  useCanWrite: () => role !== 'viewer',
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ slug: 'alpha', batchId: 'b1' }),
  }),
  useNavigate: () => navigate,
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string
    params: Record<string, string>
    search?: Record<string, string>
    children: ReactNode
  }) => (
    <a
      href={`${to.replace(/\$(\w+)/g, (_, k: string) => params[k])}${search ? `?${new URLSearchParams(search).toString()}` : ''}`}
    >
      {children}
    </a>
  ),
}))

const batch = (over: Partial<PayingInBatch> = {}): PayingInBatch => ({
  id: 'b1',
  accountId: 'acc1',
  accountName: 'CAF current',
  slipNumber: '12',
  bankedOn: null,
  total: null,
  status: 'open',
  lineId: null,
  line: null,
  openedBy: 1,
  openedAt: Date.UTC(2026, 10, 2),
  closedBy: null,
  closedAt: null,
  giftCount: 2,
  giftsTotal: 7000n,
  version: 0,
  lineVersion: 0,
  ...over,
})

const gift = (over: Partial<BatchGift> = {}): BatchGift => ({
  id: 'g1',
  enteredAt: 0,
  contactId: 'c1',
  contactName: 'Jo Bloggs',
  amount: 2000n,
  receivedOn: '2026-11-02',
  method: 'cash',
  status: 'completed',
  ...over,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of [...Object.values(writes), navigate]) f.mockReset()
  role = 'staff'
  list = []
  page = {
    batch: batch(),
    gifts: [
      gift(),
      gift({ id: 'g2', amount: 5000n, method: 'cheque', status: 'pending' }),
    ],
  }
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

async function render(module: Promise<{ Route: unknown }>) {
  const { Route } = await module
  const Page = (Route as { options: { component: ComponentType } }).options
    .component
  await act(async () => root.render(<Page />))
}
const listPage = () => render(import('./t.$slug.bank.batches.index'))
const batchPage = () => render(import('./t.$slug.bank.batches.$batchId'))
const button = (name: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (b: HTMLElement | undefined) =>
  act(async () => {
    if (!b) throw new Error('no such button')
    b.click()
  })
const byTestId = (id: string) =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent
const setInput = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

test('the list: where each batch stands; a viewer reads, opens none', async () => {
  list = [
    batch(),
    batch({
      id: 'b2',
      status: 'closed',
      total: 3000n,
      bankedOn: '2026-11-03',
      line: { id: 'l1', postedOn: '2026-11-04', amount: 3000n },
    }),
  ]
  role = 'viewer'
  await listPage()
  const states = [...el.querySelectorAll('[data-testid="batch-state"]')].map(
    (s) => s.textContent,
  )
  expect(states).toEqual([
    'open',
    'matched to the line of 4 Nov 2026; paid in 3 Nov 2026',
  ])
  expect(el.textContent).toContain('2 gifts, £70.00')
  expect(el.querySelector('form[aria-label="Open a batch"]')).toBeNull()
})

test('staff open a batch on an active account, then go to it', async () => {
  writes.open.mockResolvedValue(batch({ id: 'b9' }))
  await listPage()
  const form = el.querySelector('form[aria-label="Open a batch"]')!
  expect(
    [...form.querySelectorAll('option')].map((o) => o.textContent),
  ).toEqual(['CAF current'])
  await setInput(form.querySelectorAll('input')[0], '000124')
  await click(button('Open a batch'))
  expect(writes.open).toHaveBeenCalledWith('acc1', '000124')
  expect(navigate).toHaveBeenCalledWith({
    to: '/t/$slug/bank/batches/$batchId',
    params: { slug: 'alpha', batchId: 'b9' },
  })
})

test('an open batch: its gifts and total, record into it, close with the slip', async () => {
  let done!: () => void
  writes.close.mockReturnValue(new Promise<void>((r) => (done = r)))
  await batchPage()
  expect(byTestId('batch-gifts-total')).toBe('2, £70.00')
  expect(el.textContent).toContain('Cheque, pending')
  expect(
    [...el.querySelectorAll('a')]
      .find((a) => a.textContent.startsWith('Record cash or a cheque'))
      ?.getAttribute('href'),
  ).toBe('/t/alpha/gifts/new?batch=b1')
  await click(button('Close the batch'))
  // The heading takes focus; the total starts at the gifts' sum.
  expect(document.activeElement?.textContent).toBe('Close the batch')
  const form = el.querySelector('form[aria-label="Close the batch"]')!
  const [total, date] = form.querySelectorAll('input')
  expect(total.value).toBe('70.00')
  await setInput(total, '69.00')
  await setInput(date, '2026-11-03')
  await click(button('Close it'))
  expect(writes.close).toHaveBeenCalledWith('b1', 0, '2026-11-03', 6900n)
  // In flight: disabled, nothing claimed yet.
  expect(button('Closing…')?.disabled).toBe(true)
  await act(async () => done())
  expect(el.querySelector('form[aria-label="Close the batch"]')).toBeNull()
})

test('a closed batch: the difference is shown, and it can be reopened', async () => {
  page = {
    batch: batch({
      status: 'closed',
      total: 6900n,
      bankedOn: '2026-11-03',
      version: 1,
    }),
    gifts: [],
  }
  writes.reopen.mockRejectedValue(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'giving.payingInBatch',
      counter: 2,
      current: {},
    }),
  )
  await batchPage()
  expect(byTestId('batch-difference')).toContain(
    'The slip says £1.00 less than the gifts recorded',
  )
  expect(el.textContent).not.toContain('Record cash or a cheque')
  await click(button('Reopen to add a gift'))
  expect(writes.reopen).toHaveBeenCalledWith('b1', 1)
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'Someone else changed this batch just now',
  )
})

test('a matched batch says so and offers nothing to change', async () => {
  page = {
    batch: batch({
      status: 'closed',
      total: 7000n,
      bankedOn: '2026-11-03',
      lineId: 'l1',
      line: { id: 'l1', postedOn: '2026-11-04', amount: 7000n },
    }),
    gifts: [gift({ method: 'cheque', status: 'failed' })],
  }
  await batchPage()
  expect(byTestId('batch-state')).toBe(
    'Matched to the statement line of 4 Nov 2026 (£70.00): its cheques have cleared.',
  )
  expect(button('Reopen to add a gift')).toBeUndefined()
  expect(button('Close the batch')).toBeUndefined()
  expect(el.textContent).toContain('Cheque, bounced')
})
