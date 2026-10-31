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
let lines: Array<object> = []
const matchWrites = { unmatch: vi.fn(), matchBatch: vi.fn() }
vi.mock('../lib/data', () => ({
  useBatches: () => ({ data: list, error: null, refetch: vi.fn() }),
  useBatch: () => ({ data: page, error: null }),
  useBatchWrites: () => writes,
  useLine: (id: string | null) => ({
    data:
      id === null
        ? undefined
        : {
            line: {
              id,
              matchVersion: 1,
              postedOn: '2026-11-04',
              amount: 7000n,
            },
          },
  }),
  useLineChoices: () => ({ data: lines }),
  useMatchWrites: () => matchWrites,
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
  figures: {
    receivedTotal: 2000n,
    pendingCount: 1,
    pendingTotal: 5000n,
    bouncedCount: 0,
    bouncedTotal: 0n,
  },
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
  notOnAStatement: false,
  ...over,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of [
    ...Object.values(writes),
    ...Object.values(matchWrites),
    navigate,
  ])
    f.mockReset()
  lines = []
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
  expect(el.textContent).toContain('Paid in £70.00 (2 gifts)')
  expect(el.textContent).toContain('1 cheque pending £50.00')
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
  // What was paid in, not money received: its pending cheque shown apart.
  expect(byTestId('batch-gifts-total')).toBe(
    'Paid in £70.00 (2 gifts)1 cheque pending £50.00',
  )
  expect(byTestId('batch-received')).toBe('£20.00')
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

test('the slip’s details can be corrected, open or closed', async () => {
  writes.save.mockResolvedValue({ id: 'b1', counter: 1 })
  await batchPage()
  await click(button('Edit the slip’s details'))
  expect(document.activeElement?.textContent).toBe('The slip’s details')
  const form = el.querySelector('form[aria-label="Edit the slip’s details"]')!
  const [slip, date] = form.querySelectorAll('input')
  expect(slip.value).toBe('12')
  await setInput(slip, '000125')
  await setInput(date, '2026-11-05')
  await click(button('Save'))
  expect(writes.save).toHaveBeenCalledWith(
    'b1',
    0,
    '000125',
    '2026-11-05',
    null,
  )
  // Closed: its total stays required.
  act(() => root.unmount())
  root = createRoot(el)
  page = {
    batch: batch({
      status: 'closed',
      total: 7000n,
      bankedOn: '2026-11-03',
      version: 3,
    }),
    gifts: [],
  }
  await batchPage()
  await click(button('Edit the slip’s details'))
  const closed = el.querySelector('form[aria-label="Edit the slip’s details"]')!
  const total = closed.querySelectorAll('input')[2]
  expect(total.value).toBe('70.00')
  await setInput(total, '')
  expect(button('Save')?.disabled).toBe(true)
  await setInput(total, '71.00')
  await click(button('Save'))
  expect(writes.save).toHaveBeenLastCalledWith(
    'b1',
    3,
    '12',
    '2026-11-03',
    7100n,
  )
})

test('a matched batch unmatches from its line, after asking', async () => {
  page = {
    batch: batch({
      status: 'closed',
      total: 7000n,
      bankedOn: '2026-11-03',
      lineId: 'l1',
      line: { id: 'l1', postedOn: '2026-11-04', amount: 7000n },
    }),
    gifts: [],
  }
  matchWrites.unmatch.mockResolvedValue({})
  await batchPage()
  await click(button('Unmatch from the statement line'))
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('Its cheques go back to pending')
  await click(
    [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent === 'Unmatch',
    ),
  )
  expect(matchWrites.unmatch).toHaveBeenCalledWith('l1', 1)
})

test('a closed batch matches from its side to an unmatched line of its account', async () => {
  page = {
    batch: batch({
      status: 'closed',
      total: 7000n,
      bankedOn: '2026-11-03',
      lineVersion: 3,
    }),
    gifts: [],
  }
  lines = [
    {
      id: 'l9',
      accountId: 'acc1',
      postedOn: '2026-11-04',
      amount: 6900n,
      payer: 'PAYING IN',
      reference: '',
      narrative: '',
      matchVersion: 0,
      suggestions: [],
    },
  ]
  matchWrites.matchBatch.mockResolvedValue({})
  await batchPage()
  // Nothing chosen for staff: the button waits for a pick.
  expect(button('Match to this line')?.disabled).toBe(true)
  await act(async () => {
    const select = el.querySelector<HTMLSelectElement>(
      'section[aria-label="Match to a statement line"] select',
    )!
    select.value = 'l9'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(el.textContent).toContain('The slip says £70.00; the line is £69.00.')
  await click(button('Match to this line'))
  expect(matchWrites.matchBatch).toHaveBeenCalledWith('l9', 0, 'b1', 3)
})
