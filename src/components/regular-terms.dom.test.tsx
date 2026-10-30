// @vitest-environment happy-dom
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ExpectedPeriodRow, RegularGift, Term } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { RegularGiftTerms } from './regular-terms'

// Regular-gift terms on the card (regular-gift terms step 6): "Change
// amount or schedule" with its code, effective payment and split from
// the TS twin; the history; a scheduled change edited or withdrawn;
// "change not coded" and its picker; the last 12 periods. Staff and
// admins change; viewers don't. Nothing is optimistic.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let canWrite = true
let periods: Array<ExpectedPeriodRow> | undefined
const expectedRead = vi.fn()
const writes = {
  change: vi.fn(),
  edit: vi.fn(),
  withdraw: vi.fn(),
  code: vi.fn(),
  adopt: vi.fn(),
}
vi.mock('../lib/data', () => ({
  useExpectedPeriods: (id: string, enabled: boolean) => {
    if (enabled) expectedRead(id)
    return enabled ? periods : undefined
  },
  useTermsWrites: () => writes,
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
// Each picker as one button: picks PHONE-1 (version v2).
vi.mock('./source-code-picker', () => ({
  localToday: () => '2026-10-29',
  SourceCodePicker: ({
    label,
    value,
    onPick,
  }: {
    label: string
    value: { code: string } | null
    onPick: (e: { versionId: string; code: string }) => void
  }) => (
    <button
      type="button"
      data-picker={label}
      onClick={() => onPick({ versionId: 'v2', code: 'PHONE-1' })}
    >
      {`${label}: ${value ? value.code : 'none'}`}
    </button>
  ),
}))

function term(over: Partial<Term>): Term {
  return {
    id: 't0',
    regularGiftId: 'r1',
    effectiveFrom: '2026-01-01',
    appliesFrom: null,
    effectiveOn: '2026-01-01',
    amount: 1000n,
    frequency: 'monthly',
    dayOfMonth: 1,
    month: null,
    allocations: [
      { key: 'a0', sourceCodeId: 'v1', sourceCode: 'STREET-1', amount: 1000n },
    ],
    note: null,
    origin: 'setup',
    status: 'applied',
    subscriptionId: 'SB1',
    sentAt: null,
    syncError: null,
    changeCodeId: null,
    changeCode: null,
    changeKind: 'setup',
    uncoded: false,
    enteredBy: 1,
    enteredAt: 0,
    termsVersion: 0,
    syncVersion: 0,
    codeVersion: 0,
    ...over,
  }
}

function gift(over: Partial<RegularGift> = {}): RegularGift {
  const terms = over.terms ?? [term({})]
  return {
    id: 'r1',
    contactId: 'c1',
    amount: 1000n,
    frequency: 'monthly',
    dayOfMonth: 1,
    month: null,
    sourceCodeId: 'v1',
    sourceCode: 'STREET-1',
    allocations: terms[0].allocations,
    status: 'active',
    endedReason: null,
    endedAt: null,
    billingRequestId: null,
    flowUrl: null,
    flowExpiresAt: null,
    mandateId: 'MD1',
    subscriptionId: 'SB1',
    enteredBy: 1,
    enteredAt: 0,
    setupVersion: 0,
    mandateVersion: 0,
    terms,
    scheduled: null,
    changeNotCoded: false,
    upcoming: [
      { chargeDate: '2026-11-02', amount: 1000n, changeable: false },
      { chargeDate: '2026-12-01', amount: 1000n, changeable: true },
      { chargeDate: '2027-01-04', amount: 1000n, changeable: true },
    ],
    lastFailure: null,
    payments: [],
    connected: true,
    ...over,
  }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of Object.values(writes)) f.mockReset().mockResolvedValue(gift())
  expectedRead.mockReset()
  canWrite = true
  periods = []
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

const render = (g: RegularGift) =>
  act(() => root.render(<RegularGiftTerms gift={g} />))
const button = (name: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (b: Element | undefined | null) =>
  act(async () => {
    if (!b) throw new Error('no such button')
    ;(b as HTMLElement).click()
  })
async function type(input: HTMLInputElement | null | undefined, value: string) {
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
async function choose(
  select: HTMLSelectElement | null | undefined,
  value: string,
) {
  if (!select) throw new Error('no such select')
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const dialog = () => document.querySelector('[role="dialog"]')!
const labelled = <T extends Element>(text: string, tag: string) =>
  [...dialog().querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(text))
    ?.querySelector<T & Element>(tag) as T | null
const amount = () => labelled<HTMLInputElement>('New amount', 'input')
const starts = () => labelled<HTMLSelectElement>('Starts with', 'select')
const byTestId = (id: string) =>
  dialog().querySelector(`[data-testid="${id}"]`)?.textContent
const submitButton = () => button('Schedule change', dialog())

test('a viewer sees the terms, never the change button', () => {
  canWrite = false
  render(
    gift({
      terms: [
        term({}),
        term({
          id: 't1',
          effectiveFrom: '2026-12-01',
          effectiveOn: '2026-12-01',
          amount: 1200n,
          status: 'scheduled',
          changeKind: 'upgrade',
        }),
      ],
    }),
  )
  expect(button('Change amount or schedule')).toBeUndefined()
  expect(button('Edit')).toBeUndefined()
  expect(el.querySelector('[data-testid="terms-history"]')).not.toBeNull()
})

test('an upgrade: the difference to the code that won it, annualised, from a payment GoCardless can still change', async () => {
  render(gift())
  await click(button('Change amount or schedule'))
  // Only the payments far enough off.
  expect([...starts()!.options].map((o) => o.value)).toEqual([
    '',
    '2026-12-01',
    '2027-01-04',
  ])
  await type(amount(), '12')
  await choose(starts(), '2026-12-01')
  expect(byTestId('change-kind')).toBe('Upgrade')
  expect(byTestId('change-annual')).toBe(' · +£24.00 a year')
  expect(byTestId('change-problem')).toBe('Pick the code that won the upgrade')
  expect(submitButton()?.disabled).toBe(true)
  await click(dialog().querySelector('[data-picker="Code that won it"]'))
  expect(byTestId('change-split')).toBe(
    'Split: STREET-1 £10.00 + PHONE-1 £2.00',
  )
  expect(submitButton()?.disabled).toBe(false)
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  const [id, args] = writes.change.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ]
  expect(id).toBe('r1')
  expect(args).toMatchObject({
    effectiveFrom: '2026-12-01',
    amount: 1200n,
    frequency: 'monthly',
    dayOfMonth: 1,
    changeCodeId: 'v2',
  })
  // The server moves the split itself: none sent.
  expect(args.allocations).toBeUndefined()
  expect(args.clientKey).toMatch(/^[0-9a-f]{32}$/)
})

test('a downgrade comes off the newest money first', async () => {
  const upgraded = term({
    id: 't1',
    effectiveFrom: '2026-06-01',
    effectiveOn: '2026-06-01',
    amount: 1200n,
    changeKind: 'upgrade',
    origin: 'staff',
    changeCodeId: 'v2',
    changeCode: 'PHONE-1',
    allocations: [
      { key: 'a0', sourceCodeId: 'v1', sourceCode: 'STREET-1', amount: 1000n },
      { key: 'a1', sourceCodeId: 'v2', sourceCode: 'PHONE-1', amount: 200n },
    ],
  })
  render(gift({ amount: 1200n, terms: [term({}), upgraded] }))
  await click(button('Change amount or schedule'))
  await type(amount(), '9.50')
  await choose(starts(), '2026-12-01')
  expect(byTestId('change-kind')).toBe('Downgrade')
  expect(byTestId('change-annual')).toBe(' · −£30.00 a year')
  expect(byTestId('change-split')).toBe('Split: STREET-1 £9.50')
  expect(submitButton()?.disabled).toBe(false)
})

test('a new day offers the new schedule’s dates; a new frequency needs its split', async () => {
  render(gift())
  await click(button('Change amount or schedule'))
  await type(amount(), '10')
  await choose(labelled<HTMLSelectElement>('Day of the month', 'select'), '15')
  expect([...starts()!.options].map((o) => o.value).slice(0, 3)).toEqual([
    '',
    '2026-12-15',
    '2027-01-15',
  ])
  await choose(starts(), '2026-12-15')
  expect(byTestId('change-kind')).toBe('New schedule')
  await choose(labelled<HTMLSelectElement>('How often', 'select'), 'yearly')
  await choose(labelled<HTMLSelectElement>('Month', 'select'), '3')
  await choose(starts(), '2027-03-15')
  expect(byTestId('change-problem')).toBe(
    'A new frequency needs its split: edit the split',
  )
  await click(button('Edit split', dialog()))
  await type(
    dialog().querySelector<HTMLInputElement>(
      '[data-testid="split-line"] input',
    ),
    '120',
  )
  await type(amount(), '120')
  expect(byTestId('split-total')).toBe('Adds up to £120.00 of £120.00')
  expect(byTestId('change-problem')).toBeUndefined()
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(writes.change.mock.calls[0][1]).toMatchObject({
    effectiveFrom: '2027-03-15',
    amount: 12_000n,
    frequency: 'yearly',
    month: 3,
    dayOfMonth: 15,
    allocations: [{ sourceCodeId: 'v1', amount: 12_000n }],
  })
})

test('an edited split must add up to the new amount', async () => {
  render(gift())
  await click(button('Change amount or schedule'))
  await type(amount(), '12')
  await choose(starts(), '2026-12-01')
  await click(button('Edit split', dialog()))
  await click(dialog().querySelector('[data-picker="Code that won it"]'))
  const lines = dialog().querySelectorAll('[data-testid="split-line"]')
  // The upgrade's £2 layer, its code not picked yet.
  expect(byTestId('change-problem')).toBe('Pick a code for every line')
  await click(lines[1].querySelector('[data-picker="Code 2"]'))
  await type(lines[1].querySelector('input'), '1')
  expect(byTestId('change-problem')).toBe(
    'The split must add up to the new amount',
  )
  expect(submitButton()?.disabled).toBe(true)
  await type(lines[0].querySelector('input'), '11')
  expect(submitButton()?.disabled).toBe(false)
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(writes.change.mock.calls[0][1]).toMatchObject({
    allocations: [
      { sourceCodeId: 'v1', amount: 1100n },
      { sourceCodeId: 'v2', amount: 100n },
    ],
  })
})

const SCHEDULED = term({
  id: 't1',
  effectiveFrom: '2026-12-01',
  effectiveOn: '2026-12-01',
  amount: 1200n,
  status: 'scheduled',
  origin: 'staff',
  changeKind: 'upgrade',
  changeCodeId: 'v3',
  changeCode: 'MAIL-1',
  termsVersion: 2,
  codeVersion: 1,
  allocations: [
    { key: 'a0', sourceCodeId: 'v1', sourceCode: 'STREET-1', amount: 1000n },
    { key: 'a1', sourceCodeId: 'v3', sourceCode: 'MAIL-1', amount: 200n },
  ],
})

test('a scheduled change: shown, withdrawn after asking, against its version', async () => {
  render(gift({ terms: [term({}), SCHEDULED], scheduled: SCHEDULED }))
  const shown = el.querySelector('[data-testid="scheduled-change"]')!
  expect(shown.textContent).toContain(
    'Upgrade from 1 Dec 2026: £12.00 every month on the 1st (STREET-1 £10.00 + MAIL-1 £2.00).',
  )
  await click(button('Withdraw change', shown))
  const ask = document.querySelector('[role="alertdialog"]')!
  expect(writes.withdraw).not.toHaveBeenCalled()
  await click(button('Withdraw change', ask))
  expect(writes.withdraw).toHaveBeenCalledWith('r1', 't1', 2)
})

test('editing a scheduled change sends its versions; a new code needs the code version', async () => {
  render(gift({ terms: [term({}), SCHEDULED], scheduled: SCHEDULED }))
  await click(button('Edit change'))
  expect(amount()?.value).toBe('12.00')
  expect(starts()?.value).toBe('2026-12-01')
  await type(amount(), '13')
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(writes.edit).toHaveBeenCalledOnce()
  const [, termId, args] = writes.edit.mock.calls[0] as [
    string,
    string,
    Record<string, unknown>,
  ]
  expect(termId).toBe('t1')
  expect(args).toMatchObject({ expected: 2, amount: 1300n, changeCodeId: 'v3' })
  // The code is the same: no code version sent; the split is moved by
  // the server, as for a new change.
  expect(args.codeExpected).toBeUndefined()
  expect(args.allocations).toBeUndefined()
  // A new code: its version goes too. Its own split, edited, keeps its keys.
  writes.edit.mockClear()
  await click(button('Edit change'))
  await click(dialog().querySelector('[data-picker="Code that won it"]'))
  await click(button('Edit split', dialog()))
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(writes.edit.mock.calls[0][2]).toMatchObject({
    changeCodeId: 'v2',
    codeExpected: 1,
    allocations: [
      { key: 'a0', sourceCodeId: 'v1', amount: 1000n },
      { key: 'a1', sourceCodeId: 'v3', amount: 200n },
    ],
  })
})

test('a refused change says why, and nothing is shown as saved', async () => {
  writes.change.mockRejectedValue(new Error('down'))
  render(gift())
  await click(button('Change amount or schedule'))
  await type(amount(), '9')
  await choose(starts(), '2026-12-01')
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    'Couldn’t save the change',
  )
  expect(el.querySelector('[data-testid="scheduled-change"]')).toBeNull()
})

test('change not coded: flagged, and the code picked for that row', async () => {
  const fromGc = term({
    id: 't2',
    effectiveFrom: '2026-11-02',
    effectiveOn: '2026-11-02',
    amount: 1500n,
    origin: 'gocardless',
    changeKind: 'upgrade',
    uncoded: true,
    codeVersion: 4,
    note: 'changed in GoCardless',
  })
  render(gift({ terms: [term({}), fromGc], changeNotCoded: true }))
  const flag = el.querySelector('[data-testid="change-not-coded"]')!
  expect(flag.textContent).toContain('Change not coded')
  await click(button('Pick code', flag))
  await click(dialog().querySelector('[data-picker="Code that won it"]'))
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(writes.code).toHaveBeenCalledWith('r1', 't2', 4, 'v2')
})

test('the last 12 periods: read once opened, each with what happened', async () => {
  periods = [
    {
      period: '2026-09',
      dueOn: '2026-09-01',
      expected: 1000n,
      split: [{ sourceCodeId: 'v1', amount: 1000n }],
      termId: 't0',
      status: 'collected',
      giftId: 'g9',
      amount: 1000n,
    },
    {
      period: '2026-10',
      dueOn: '2026-10-01',
      expected: 1000n,
      split: [{ sourceCodeId: 'v1', amount: 1000n }],
      termId: 't0',
      status: 'failed',
      giftId: 'g10',
      amount: 1000n,
    },
  ]
  render(gift())
  expect(expectedRead).not.toHaveBeenCalled()
  const details = [...el.querySelectorAll('details')].find((d) =>
    d.textContent.startsWith('Expected vs actual'),
  )!
  await act(async () => {
    details.open = true
    details.dispatchEvent(new Event('toggle'))
  })
  expect(expectedRead).toHaveBeenCalledWith('r1')
  const rows = [
    ...el.querySelectorAll<HTMLTableRowElement>(
      '[data-testid="expected-periods"] tbody tr',
    ),
  ]
  expect(rows.map((r) => [r.dataset.period, r.cells[2].textContent])).toEqual([
    ['2026-10', 'Failed (arrears)'],
    ['2026-09', 'Collected'],
  ])
})

const stale = () => new RustApiError(409, { kind: 'stale' } as never)

test('a 409 on withdraw: the retry sends the row’s counter as read again', async () => {
  const g = gift({ terms: [term({}), SCHEDULED], scheduled: SCHEDULED })
  render(g)
  await click(button('Withdraw change'))
  writes.withdraw.mockRejectedValueOnce(stale())
  await click(
    button('Withdraw change', document.querySelector('[role="alertdialog"]')!),
  )
  expect(writes.withdraw).toHaveBeenLastCalledWith('r1', 't1', 2)
  // The chain read again: someone edited the change (terms version 3).
  const edited = { ...SCHEDULED, termsVersion: 3, amount: 1300n }
  render({ ...g, terms: [term({}), edited], scheduled: edited })
  await click(
    button('Withdraw change', document.querySelector('[role="alertdialog"]')!),
  )
  expect(writes.withdraw).toHaveBeenLastCalledWith('r1', 't1', 3)
})

test('a 409 on edit or code: the retry sends the current counters, the typing kept', async () => {
  const g = gift({ terms: [term({}), SCHEDULED], scheduled: SCHEDULED })
  render(g)
  await click(button('Edit change'))
  await type(amount(), '13')
  writes.edit.mockRejectedValueOnce(stale())
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  const moved = { ...SCHEDULED, termsVersion: 5 }
  render({ ...g, terms: [term({}), moved], scheduled: moved })
  expect(amount()?.value).toBe('13')
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(writes.edit.mock.calls[1][2]).toMatchObject({
    expected: 5,
    amount: 1300n,
  })
  act(() => root.unmount())
  root = createRoot(el)
  render(g)
  await click(el.querySelector('summary'))
  await click(button('Change code'))
  await click(dialog().querySelector('[data-picker="Code that won it"]'))
  writes.code.mockRejectedValueOnce(stale())
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  const recoded = { ...SCHEDULED, codeVersion: 7 }
  render({ ...g, terms: [term({}), recoded], scheduled: recoded })
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(writes.code).toHaveBeenLastCalledWith('r1', 't1', 7, 'v2')
})

test('a change sent to GoCardless meanwhile can no longer be edited, and says so', async () => {
  const g = gift({ terms: [term({}), SCHEDULED], scheduled: SCHEDULED })
  render(g)
  await click(button('Edit change'))
  expect(button('Save change', dialog())).toBeDefined()
  const sent = { ...SCHEDULED, status: 'sent' as const }
  render({ ...g, terms: [term({}), sent], scheduled: sent })
  expect(
    dialog().querySelector('[data-testid="term-unchangeable"]'),
  ).not.toBeNull()
  expect(dialog().textContent).toContain('sent to GoCardless meanwhile')
  expect(button('Save change', dialog())).toBeUndefined()
})

test('an upgrade with an edited split still needs the code that won it, as the server says', async () => {
  render(gift())
  await click(button('Change amount or schedule'))
  await type(amount(), '12')
  await choose(starts(), '2026-12-01')
  await click(button('Edit split', dialog()))
  const lines = dialog().querySelectorAll('[data-testid="split-line"]')
  await click(lines[1].querySelector('[data-picker="Code 2"]'))
  expect(byTestId('change-problem')).toBe('Pick the code that won the upgrade')
  expect(submitButton()?.disabled).toBe(true)
})
