// @vitest-environment happy-dom
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { MissedStandingOrder, StandingOrder, Term } from '../lib/data'
import type { Id } from '../lib/domain/ids'
import {
  ContactStandingOrders,
  MissedStandingOrders,
  RecordStandingOrderDialog,
} from './standing-orders'

// Standing orders on the contact (bank transfers 6b part 3): the section,
// a card (its terms, next due, a missed payment, expected vs actual),
// "Record a standing order" (quarterly and yearly take their month from
// the first payment's date; the reference is optional), ending one, and
// the home page's missed list. Nothing is optimistic: what shows is what
// the server answered.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let orders: Array<StandingOrder> | undefined
let missed: Array<MissedStandingOrder> | undefined
let canWrite = true
const writes = { record: vi.fn(), end: vi.fn() }
vi.mock('../lib/data', () => ({
  useStandingOrders: () => orders,
  useMissedStandingOrders: () => missed,
  useStandingOrderWrites: () => writes,
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha' }),
  useCanWrite: () => canWrite,
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string
    params: Record<string, string>
    children: ReactNode
  }) => (
    <a href={to.replace(/\$(\w+)/g, (_, k: string) => params[k])}>{children}</a>
  ),
}))
// The picker as one button: picks STREET-1.
vi.mock('./source-code-picker', () => ({
  SourceCodePicker: ({
    value,
    onPick,
  }: {
    value: { code: string } | null
    onPick: (e: { versionId: string; code: string }) => void
  }) => (
    <button
      type="button"
      onClick={() => onPick({ versionId: 'v1', code: 'STREET-1' })}
    >
      {value ? value.code : 'Pick a code'}
    </button>
  ),
}))

function term(over: Partial<Term> = {}): Term {
  return {
    id: 't1',
    regularGiftId: 's1',
    effectiveFrom: '2026-01-05',
    appliesFrom: null,
    effectiveOn: '2026-01-05',
    amount: 1000n,
    frequency: 'monthly',
    dayOfMonth: 5,
    month: null,
    allocations: [
      { key: 'a', sourceCodeId: 'v1', sourceCode: 'STREET-1', amount: 1000n },
    ],
    note: null,
    origin: 'setup',
    status: 'applied',
    subscriptionId: null,
    sentAt: null,
    syncError: null,
    changeCodeId: null,
    changeCode: null,
    changeKind: 'setup',
    uncoded: false,
    enteredBy: 1,
    enteredAt: 0,
    termsVersion: 0,
    syncVersion: 1,
    codeVersion: 0,
    ...over,
  }
}

function order(over: Partial<StandingOrder> = {}): StandingOrder {
  return {
    id: 's1',
    contactId: 'c1',
    contactName: 'Jo Giver',
    status: 'active',
    bankReference: 'SMITH123',
    missedOn: null,
    endedReason: null,
    endedAt: null,
    chain: [term()],
    expected: [
      {
        period: '2026-01',
        dueOn: '2026-01-05',
        expected: 1000n,
        split: [{ sourceCodeId: 'v1', amount: 1000n }],
        termId: 't1',
        status: 'collected',
        giftId: 'g1',
        amount: 1000n,
      },
      {
        period: '2026-02',
        dueOn: '2026-02-05',
        expected: 1000n,
        split: [{ sourceCodeId: 'v1', amount: 1000n }],
        termId: 't1',
        status: 'missing',
        giftId: null,
        amount: null,
      },
      {
        period: '2099-03',
        dueOn: '2099-03-05',
        expected: 1000n,
        split: [{ sourceCodeId: 'v1', amount: 1000n }],
        termId: 't1',
        status: 'upcoming',
        giftId: null,
        amount: null,
      },
    ],
    setupVersion: 0,
    mandateVersion: 1,
    missedVersion: 0,
    ...over,
  }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  writes.record.mockReset()
  writes.end.mockReset()
  orders = []
  missed = []
  canWrite = true
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

const render = (node: ReactNode) => act(() => root.render(node))
const text = () => document.body.textContent
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === name,
  )!
const click = (name: string) => act(() => button(name).click())
async function type(label: string, value: string) {
  const input = [...document.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(label))!
    .querySelector('input, select') as HTMLInputElement | HTMLSelectElement
  await act(async () => {
    const proto = Object.getPrototypeOf(input) as object
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
    input.dispatchEvent(
      new Event(input.tagName === 'SELECT' ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
}

test('a card: its terms, the next payment due, a missed one, expected vs actual', () => {
  orders = [order({ missedOn: '2026-02-05' })]
  render(<ContactStandingOrders contactId={'c1' as Id<'contacts'>} />)
  const card = document.querySelector('[data-testid="standing-order"]')!
  expect(card.textContent).toContain('£10.00 every month on the 5th')
  expect(card.textContent).toContain('STREET-1')
  expect(card.textContent).toContain('SMITH123')
  expect(
    document.querySelector('[data-testid="standing-order-next"]')!.textContent,
  ).toContain('2099')
  expect(
    document.querySelector('[data-testid="standing-order-missed"]')!
      .textContent,
  ).toMatch(/Missed: the payment due .*5.*Feb/)
  const rows = [
    ...document.querySelectorAll(
      '[data-testid="standing-order-expected"] tbody tr',
    ),
  ].map((r) => r.getAttribute('data-status'))
  // Due ones only, newest first; the one still to come isn't in it.
  expect(rows).toEqual(['missing', 'collected'])
})

test('viewers read them but record and end nothing', () => {
  canWrite = false
  orders = [order()]
  render(<ContactStandingOrders contactId={'c1' as Id<'contacts'>} />)
  expect(text()).toContain('£10.00 every month')
  expect(button('Record a standing order')).toBeUndefined()
  expect(button('End standing order')).toBeUndefined()
})

test('record: quarterly takes its month from the first payment, the reference optional', async () => {
  writes.record.mockResolvedValue(
    order({
      chain: [term({ frequency: 'quarterly', month: 2, dayOfMonth: 10 })],
    }),
  )
  render(<ContactStandingOrders contactId={'c1' as Id<'contacts'>} />)
  click('Record a standing order')
  await type('Amount', '25.50')
  await type('How often', 'quarterly')
  await type('First payment', '2026-02-10')
  expect(text()).toContain('every quarter on the 10th from February')
  // Nothing goes until a code is picked.
  expect(button('Record').disabled).toBe(true)
  click('Pick a code')
  await act(async () => button('Record').click())
  expect(writes.record).toHaveBeenCalledTimes(1)
  const [contact, args] = writes.record.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ]
  expect(contact).toBe('c1')
  expect(args).toMatchObject({
    amount: 2550n,
    frequency: 'quarterly',
    dayOfMonth: 10,
    month: 2,
    sourceCodeId: 'v1',
    startsOn: '2026-02-10',
  })
  expect(args.bankReference).toBeUndefined()
  expect(typeof args.clientKey).toBe('string')
  // Only once the server answered.
  expect(text()).toContain(
    'Recorded: £10.00 every quarter on the 10th from February',
  )
})

test('a first payment on the 29th or later is said, and nothing is sent', async () => {
  render(<ContactStandingOrders contactId={'c1' as Id<'contacts'>} />)
  click('Record a standing order')
  await type('Amount', '10')
  await type('First payment', '2026-01-30')
  expect(text()).toContain('pick the 28th or earlier')
  click('Pick a code')
  expect(button('Record').disabled).toBe(true)
})

test('"make this a standing order" opens the form prefilled, the reference empty', async () => {
  writes.record.mockResolvedValue(order())
  const recorded = vi.fn()
  render(
    <RecordStandingOrderDialog
      contactId={'c1' as Id<'contacts'>}
      prefill={{ amount: 2000n, frequency: 'monthly', startsOn: '2026-03-07' }}
      onClose={() => {}}
      onRecorded={recorded}
    />,
  )
  const value = (label: string) =>
    (
      [...document.querySelectorAll('label')]
        .find((l) => l.textContent.startsWith(label))!
        .querySelector('input, select') as HTMLInputElement
    ).value
  expect(value('Amount')).toBe('20.00')
  expect(value('How often')).toBe('monthly')
  expect(value('First payment')).toBe('2026-03-07')
  expect(value('The donor’s reference')).toBe('')
  click('Pick a code')
  await act(async () => button('Record').click())
  expect(recorded).toHaveBeenCalledTimes(1)
})

test('end: asked first, with an optional reason, as the server answers', async () => {
  orders = [order()]
  writes.end.mockResolvedValue(order({ status: 'cancelled' }))
  render(<ContactStandingOrders contactId={'c1' as Id<'contacts'>} />)
  click('End standing order')
  expect(text()).toContain('nothing is expected from today')
  await type('Why', 'Donor stopped it')
  await act(async () => button('End it').click())
  expect(writes.end).toHaveBeenCalledWith(orders[0], 'Donor stopped it')
})

test('a refused end says so and keeps the dialog', async () => {
  orders = [order()]
  writes.end.mockRejectedValue(new Error('boom'))
  render(<ContactStandingOrders contactId={'c1' as Id<'contacts'>} />)
  click('End standing order')
  await act(async () => button('End it').click())
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    'Couldn’t end it',
  )
})

test('home: the standing orders with a missed payment, each to its contact', () => {
  missed = [
    {
      id: 's1',
      contactId: 'c1',
      contactName: 'Jo Giver',
      missedOn: '2026-02-05',
      amount: 1000n,
      frequency: 'monthly',
    },
  ]
  render(<MissedStandingOrders />)
  expect(text()).toContain('Standing orders with a missed payment')
  const link = document.querySelector(
    '[data-testid="missed-standing-orders"] a',
  )!
  expect(link.getAttribute('href')).toBe('/t/alpha/contacts/c1')
  expect(link.parentElement!.textContent).toContain('£10.00 monthly')
})

test('home: nothing at all while none has missed a payment', () => {
  missed = []
  render(<MissedStandingOrders />)
  expect(text()).toBe('')
})

test('from a statement line: the line’s amount, started on or before it, matched in one command', async () => {
  const fromLine = vi.fn().mockResolvedValue({})
  Object.assign(writes, { fromLine })
  const recorded = vi.fn()
  render(
    <RecordStandingOrderDialog
      contactId={'c1' as Id<'contacts'>}
      prefill={{ frequency: 'monthly', startsOn: '2026-03-07' }}
      line={{
        id: 'l1',
        matchVersion: 2,
        amount: 2000n,
        postedOn: '2026-03-07',
      }}
      onClose={() => {}}
      onRecorded={recorded}
    />,
  )
  expect(text()).toContain('Amount: £20.00, the line’s')
  await type('First payment', '2026-03-08')
  expect(text()).toContain('This line is its first payment')
  click('Pick a code')
  expect(button('Record').disabled).toBe(true)
  await type('First payment', '2026-03-07')
  await act(async () => button('Record').click())
  expect(fromLine).toHaveBeenCalledWith(
    { id: 'l1', matchVersion: 2, amount: 2000n, postedOn: '2026-03-07' },
    {
      contact: 'c1',
      frequency: 'monthly',
      dayOfMonth: 7,
      sourceCodeId: 'v1',
    },
  )
  expect(writes.record).not.toHaveBeenCalled()
  expect(text()).toContain('this line matched as its first payment')
  expect(recorded).toHaveBeenCalledTimes(1)
})
