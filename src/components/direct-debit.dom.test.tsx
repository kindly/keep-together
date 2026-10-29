// @vitest-environment happy-dom
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  DirectDebitPayment,
  GoCardlessStatus,
  RegularGift,
} from '../lib/data'
import type { Id } from '../lib/domain/ids'
import { ONE_OFF_MAX_MESSAGE } from '../lib/domain/one-off'
import { ContactDirectDebit } from './direct-debit'

// GoCardless D3 on the contact: the Direct Debit section, a regular
// gift's card and its payment history, "Set up Direct Debit", one-offs
// both ways (with the £1,000 cap in the form) and cancelling. Nothing is
// optimistic: what shows is what the server answered.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let status: GoCardlessStatus | undefined
let gifts: Array<RegularGift> | undefined
let canWrite = true
const writes = {
  setUp: vi.fn(),
  newLink: vi.fn(),
  cancel: vi.fn(),
  oneOff: vi.fn(),
  instantPayment: vi.fn(),
}
vi.mock('../lib/data', () => ({
  useGoCardlessStatus: () => status,
  useRegularGifts: () => gifts,
  // GoCardless's forecast: none (the list's upcoming stands).
  useRegularGiftForecast: () => undefined,
  useDirectDebitWrites: () => writes,
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

const CONNECTED: GoCardlessStatus = {
  enabled: true,
  mode: 'fake',
  connected: true,
  organisationId: 'OR1',
  connectedAt: 0,
  connectedBy: 1,
  failedEvents: 0,
}

function payment(over: Partial<DirectDebitPayment>): DirectDebitPayment {
  return {
    id: 'p',
    paymentId: 'PM1',
    amount: 1250n,
    chargeDate: '2026-10-01',
    scheduledOn: '2026-10-01',
    status: 'confirmed',
    reason: null,
    giftId: 'g1',
    ...over,
  }
}

function gift(over: Partial<RegularGift> = {}): RegularGift {
  return {
    id: 'r1',
    contactId: 'c1',
    amount: 1250n,
    frequency: 'monthly',
    dayOfMonth: 1,
    month: null,
    sourceCodeId: 'v1',
    sourceCode: 'STREET-1',
    allocations: [
      { key: 'a', sourceCodeId: 'v1', sourceCode: 'STREET-1', amount: 1250n },
    ],
    status: 'active',
    endedReason: null,
    endedAt: null,
    billingRequestId: 'BRQ1',
    flowUrl: null,
    flowExpiresAt: null,
    mandateId: 'MD1',
    subscriptionId: 'SB1',
    enteredBy: 1,
    enteredAt: 0,
    setupVersion: 0,
    mandateVersion: 3,
    terms: [],
    scheduled: null,
    changeNotCoded: false,
    upcoming: [{ chargeDate: '2026-11-02', amount: 1250n, changeable: true }],
    lastFailure: null,
    payments: [],
    connected: true,
    ...over,
  }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of Object.values(writes)) f.mockReset()
  status = CONNECTED
  gifts = []
  canWrite = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

const render = () =>
  act(() =>
    root.render(<ContactDirectDebit contactId={'c1' as Id<'contacts'>} />),
  )
const button = (name: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (b: HTMLElement | undefined) =>
  act(async () => {
    if (!b) throw new Error('no such button')
    b.click()
  })
async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('no such input')
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const dialog = () => document.querySelector('[role="dialog"]')!
const amountInput = () =>
  [...dialog().querySelectorAll('label')]
    .find((l) => l.textContent.startsWith('Amount'))
    ?.querySelector('input') ?? null
const submit = () =>
  act(async () => dialog().querySelector('form')!.requestSubmit())

test('nothing at all while GoCardless is off here', () => {
  status = { ...CONNECTED, enabled: false, mode: 'off', connected: false }
  render()
  expect(el.textContent).toBe('')
})

test('not connected: the set-up and payment buttons are held, and why', () => {
  status = { ...CONNECTED, connected: false }
  gifts = [gift()]
  render()
  expect(button('Set up Direct Debit')?.disabled).toBe(true)
  expect(button('Instant Bank Pay link')?.disabled).toBe(true)
  expect(button('Take a one-off payment')?.disabled).toBe(true)
  expect(el.textContent).toContain('GoCardless isn’t connected')
})

test('a viewer sees the cards and none of the actions', () => {
  canWrite = false
  gifts = [gift()]
  render()
  expect(el.querySelector('[data-testid="regular-gift"]')).not.toBeNull()
  expect(button('Set up Direct Debit')).toBeUndefined()
  expect(button('Take a one-off payment')).toBeUndefined()
  expect(button('Cancel Direct Debit')).toBeUndefined()
})

test('the card: amount, schedule, status, mandate and next payments', () => {
  gifts = [gift()]
  render()
  const card = el.querySelector('[data-testid="regular-gift"]')!
  expect(
    card.querySelector('[data-testid="regular-gift-amount"]')?.textContent,
  ).toBe('£12.50 every month on the 1st')
  expect(
    card.querySelector('[data-testid="regular-gift-status"]')?.textContent,
  ).toBe('Active')
  expect(card.textContent).toContain('STREET-1')
  expect(card.textContent).toContain('MD1')
  expect(
    card.querySelector('[data-testid="regular-gift-upcoming"]')?.textContent,
  ).toBe('2 Nov 2026 · £12.50')
})

test('payment history: every attempt with its status; only a collected one reads as money', () => {
  gifts = [
    gift({
      payments: [
        payment({ id: 'p4', paymentId: 'PM4', status: 'pending' }),
        payment({ id: 'p3', paymentId: 'PM3', status: 'chargedBack' }),
        payment({
          id: 'p2',
          paymentId: 'PM2',
          status: 'failed',
          reason: 'insufficient funds',
        }),
        payment({ id: 'p1', paymentId: 'PM1', status: 'confirmed' }),
        payment({ id: 'p0', paymentId: 'PM0', status: 'cancelled' }),
      ],
    }),
  ]
  render()
  const rows = [
    ...el.querySelectorAll<HTMLTableRowElement>(
      '[data-testid="payment-history"] tbody tr',
    ),
  ]
  const shown = rows.map((r) => [
    r.dataset.payment,
    r.cells[2].textContent,
    r.cells[1].className.includes('line-through'),
  ])
  expect(shown).toEqual([
    ['PM4', 'pending', true],
    ['PM3', 'charged back', true],
    ['PM2', 'failed (insufficient funds)', true],
    ['PM1', 'collected', false],
    ['PM0', 'cancelled', true],
  ])
  expect(rows[3].querySelector('a')?.getAttribute('href')).toBe(
    '/t/alpha/gifts/g1',
  )
})

test('a pending gift shows its sign-up link to copy or send', () => {
  gifts = [
    gift({
      status: 'pending',
      mandateId: null,
      flowUrl: 'https://pay.example/flow/1',
      flowExpiresAt: '2999-01-01T00:00:00Z',
    }),
  ]
  render()
  const link = el.querySelector<HTMLInputElement>(
    'input[aria-label="Sign-up link"]',
  )
  expect(link?.value).toBe('https://pay.example/flow/1')
  expect(
    el.querySelector('a[href^="mailto:"]')?.getAttribute('href'),
  ).toContain(encodeURIComponent('https://pay.example/flow/1'))
  expect(button('Take a one-off payment')).toBeUndefined()
})

test('set up: the regular gift as the server made it, the button held meanwhile', async () => {
  let answer!: (g: RegularGift) => void
  writes.setUp.mockReturnValue(new Promise((done) => (answer = done)))
  render()
  await click(button('Set up Direct Debit'))
  expect(button('Set up', dialog())?.disabled).toBe(true)
  await type(amountInput(), '12.50')
  await click(button('Pick a code', dialog()))
  expect(button('Set up', dialog())?.disabled).toBe(false)
  await submit()
  expect(button('Setting up…', dialog())?.disabled).toBe(true)
  const [contactId, args] = writes.setUp.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ]
  expect(contactId).toBe('c1')
  expect(args).toMatchObject({
    amount: 1250n,
    frequency: 'monthly',
    dayOfMonth: 1,
    sourceCodeId: 'v1',
  })
  expect(args.clientKey).toMatch(/^[0-9a-f]{32}$/)
  // No card until the server has answered.
  expect(el.querySelector('[data-testid="regular-gift"]')).toBeNull()
  await act(async () =>
    answer(
      gift({
        status: 'pending',
        flowUrl: 'https://pay.example/flow/2',
      }),
    ),
  )
  expect(dialog().textContent).toContain('Ready: £12.50 every month on the 1st')
  expect(
    dialog().querySelector<HTMLInputElement>('input[aria-label="Sign-up link"]')
      ?.value,
  ).toBe('https://pay.example/flow/2')
})

test('a one-off over £1,000 is refused in the form: ask for a bank transfer', async () => {
  gifts = [gift()]
  render()
  await click(button('Take a one-off payment'))
  await type(amountInput(), '1000.01')
  expect(dialog().textContent).toContain(ONE_OFF_MAX_MESSAGE)
  expect(button('Take payment', dialog())?.disabled).toBe(true)
  await type(amountInput(), '1000')
  expect(dialog().textContent).not.toContain(ONE_OFF_MAX_MESSAGE)
  writes.oneOff.mockResolvedValue({
    requestId: 'k',
    paymentId: 'PM9',
    amount: 100_000,
    status: 'pending_submission',
    chargeDate: '2026-11-04',
  })
  await submit()
  expect(writes.oneOff.mock.calls[0][0]).toBe('r1')
  expect(writes.oneOff.mock.calls[0][1]).toMatchObject({
    amount: 100_000n,
    sourceCodeId: 'v1',
  })
  expect(dialog().textContent).toContain(
    'Asked GoCardless to collect £1,000.00 on 4 Nov 2026',
  )
})

test('an Instant Bank Pay link: the same cap, then the link to send', async () => {
  render()
  await click(button('Instant Bank Pay link'))
  await click(button('Pick a code', dialog()))
  await type(amountInput(), '1500')
  expect(dialog().textContent).toContain(ONE_OFF_MAX_MESSAGE)
  expect(button('Make link', dialog())?.disabled).toBe(true)
  await type(amountInput(), '25')
  writes.instantPayment.mockResolvedValue({
    requestId: 'k',
    billingRequestId: 'BRQ9',
    amount: 2500,
    flowUrl: 'https://pay.example/ibp/9',
    flowExpiresAt: null,
  })
  await submit()
  expect(writes.instantPayment.mock.calls[0][1]).toMatchObject({
    amount: 2500n,
    sourceCodeId: 'v1',
  })
  expect(
    dialog().querySelector<HTMLInputElement>('input[aria-label="Payment link"]')
      ?.value,
  ).toBe('https://pay.example/ibp/9')
  expect(dialog().textContent).toContain('this link to pay £25.00')
})

test('cancel asks first, then cancels against the mandate version shown', async () => {
  gifts = [gift()]
  writes.cancel.mockResolvedValue(gift({ status: 'cancelled' }))
  render()
  await click(button('Cancel Direct Debit'))
  const ask = document.querySelector('[role="alertdialog"]')!
  expect(ask.textContent).toContain('Cancel this Direct Debit?')
  expect(writes.cancel).not.toHaveBeenCalled()
  await click(button('Cancel Direct Debit', ask))
  expect(writes.cancel).toHaveBeenCalledWith('r1', 3)
})

test('a one-off retried after a failure: the same key only if nothing changed; the amount shown is the server’s', async () => {
  gifts = [gift()]
  render()
  await click(button('Take a one-off payment'))
  await type(amountInput(), '100')
  writes.oneOff.mockRejectedValueOnce(new Error('GoCardless down'))
  await submit()
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    'Couldn’t take the payment',
  )
  // The same request again: the same key (GoCardless takes it once).
  writes.oneOff.mockRejectedValueOnce(new Error('GoCardless down'))
  await submit()
  const keys = () =>
    writes.oneOff.mock.calls.map(
      (c) => (c[1] as { clientKey: string }).clientKey,
    )
  expect(keys()[1]).toBe(keys()[0])
  // Changed: a new key, so the server doesn't send the first request.
  await type(amountInput(), '50')
  writes.oneOff.mockResolvedValueOnce({
    requestId: 'k',
    paymentId: 'PM9',
    amount: 5000,
    status: 'pending_submission',
    chargeDate: '2026-11-04',
  })
  await submit()
  expect(keys()[2]).not.toBe(keys()[0])
  expect(writes.oneOff.mock.calls[2][1]).toMatchObject({ amount: 5000n })
  expect(dialog().textContent).toContain('collect £50.00 on 4 Nov 2026')
})

test('the one-off says what the server asked GoCardless for, not what was typed', async () => {
  gifts = [gift()]
  render()
  await click(button('Take a one-off payment'))
  await type(amountInput(), '50')
  writes.oneOff.mockResolvedValue({
    requestId: 'k',
    paymentId: 'PM9',
    amount: 10_000,
    status: 'pending_submission',
    chargeDate: '2026-11-04',
  })
  await submit()
  expect(dialog().textContent).toContain('collect £100.00')
  expect(dialog().textContent).not.toContain('£50.00')
})

test('a dialog stays open while its request is in flight: the link is never lost', async () => {
  let answer!: (l: object) => void
  writes.instantPayment.mockReturnValue(new Promise((done) => (answer = done)))
  render()
  await click(button('Instant Bank Pay link'))
  await click(button('Pick a code', dialog()))
  await type(amountInput(), '25')
  await submit()
  const close = button('Close', dialog())!
  expect(close.disabled).toBe(true)
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () =>
    answer({
      requestId: 'k',
      billingRequestId: 'BRQ9',
      amount: 2500,
      flowUrl: 'https://pay.example/ibp/9',
      flowExpiresAt: null,
    }),
  )
  expect(
    dialog().querySelector<HTMLInputElement>('input[aria-label="Payment link"]')
      ?.value,
  ).toBe('https://pay.example/ibp/9')
})

test('an amount’s problem describes the field, politely, outside its name', async () => {
  gifts = [gift()]
  render()
  await click(button('Take a one-off payment'))
  await type(amountInput(), '1500')
  const input = amountInput()!
  const problem = document.getElementById(
    input.getAttribute('aria-describedby')!,
  )!
  expect(problem.textContent).toBe(ONE_OFF_MAX_MESSAGE)
  expect(problem.getAttribute('aria-live')).toBe('polite')
  expect(problem.getAttribute('role')).toBeNull()
  expect(input.closest('label')?.textContent).toBe('Amount (£)')
})
