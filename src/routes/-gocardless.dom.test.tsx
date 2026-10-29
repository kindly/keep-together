// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  ExpectedReport,
  GoCardlessStatus,
  UnknownSubscription,
  UnmatchedPayment,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'

// GoCardless D3's pages: Settings › GoCardless (connect, status, the
// way back from GoCardless's consent page, disconnect) and the
// unmatched payments with "Match to contact"; subscriptions set up in
// GoCardless, adopted; the expected vs actual report.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let status: GoCardlessStatus | undefined
let search: Record<string, unknown> = {}
let role: 'admin' | 'staff' | 'viewer' = 'admin'
let unmatched: Array<UnmatchedPayment> | undefined
const admin = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  retryEvents: vi.fn(),
}
const match = vi.fn()
const adopt = vi.fn()
const reportAsked = vi.fn()
let unknown: Array<UnknownSubscription> | undefined
let report: ExpectedReport | undefined
vi.mock('../lib/data', () => ({
  useGoCardlessStatus: () => status,
  useGoCardlessAdmin: () => admin,
  useUnmatchedPayments: () => ({
    data: unmatched,
    error: null,
    refetch: () => Promise.resolve(),
  }),
  useMatchPayment: () => match,
  useUnknownSubscriptions: () => unknown,
  useTermsWrites: () => ({ adopt }),
  useExpectedReport: (from: string, to: string, by: string) => {
    reportAsked(from, to, by)
    return { data: report, error: null, refetch: () => Promise.resolve() }
  },
  useAuthState: () => ({ method: 'password' }),
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha', role }),
  useIsAdmin: () => role === 'admin',
  useCanWrite: () => role !== 'viewer',
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ slug: 'alpha' }),
    useSearch: () => search,
  }),
  useNavigate: () => navigate,
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
vi.mock('../components/source-code-picker', () => ({
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
vi.mock('../components/gift-form', () => ({
  DonorSearch: ({
    existingOnly,
    onPick,
  }: {
    existingOnly?: boolean
    onPick: (d: object) => void
  }) => (
    <button
      type="button"
      data-existing-only={existingOnly}
      onClick={() =>
        onPick({ kind: 'existing', id: 'c7', displayName: 'Dee Debit' })
      }
    >
      Find Dee
    </button>
  ),
}))

const navigate = vi.fn()

const CONNECTED: GoCardlessStatus = {
  enabled: true,
  mode: 'fake',
  connected: true,
  organisationId: 'OR123',
  connectedAt: Date.UTC(2026, 9, 28, 9),
  connectedBy: 1,
  failedEvents: 0,
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of Object.values(admin)) f.mockReset()
  match.mockReset()
  adopt.mockReset()
  reportAsked.mockReset()
  unknown = []
  report = undefined
  status = CONNECTED
  search = {}
  role = 'admin'
  unmatched = []
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

async function page(module: Promise<{ Route: unknown }>) {
  const { Route } = await module
  const Page = (Route as { options: { component: ComponentType } }).options
    .component
  await act(async () => root.render(<Page />))
}
const settings = () => page(import('./t.$slug.settings.gocardless'))
const unmatchedPage = () => page(import('./t.$slug.gocardless.unmatched'))
const button = (name: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (b: HTMLElement | undefined) =>
  act(async () => {
    if (!b) throw new Error('no such button')
    b.click()
  })
const byTestId = (id: string) =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent

test('settings: admins only', async () => {
  role = 'staff'
  await settings()
  expect(el.textContent).toBe(
    'Connecting GoCardless is for the group’s admins.',
  )
})

test('settings: on the fake, said so honestly; connected, with its account', async () => {
  await settings()
  expect(byTestId('gocardless-mode')).toContain('stand-in for GoCardless')
  expect(byTestId('gocardless-mode')).toContain(
    'until there are GoCardless sandbox keys',
  )
  expect(byTestId('gocardless-connected')).toBe('Connected')
  expect(el.textContent).toContain('OR123')
  expect(button('Connect a different account')).toBeDefined()
  expect(button('Disconnect')).toBeDefined()
  expect(
    [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')),
  ).toContain('/t/alpha/gocardless/unmatched')
})

test('settings: not connected says what that means, and offers Connect', async () => {
  status = { ...CONNECTED, connected: false, organisationId: null }
  await settings()
  expect(byTestId('gocardless-connected')).toBe('Not connected')
  expect(el.textContent).toContain('nobody can set up a Direct Debit')
  expect(button('Disconnect')).toBeUndefined()
  admin.connect.mockResolvedValue('https://connect.example/oauth')
  const assign = vi.fn()
  vi.stubGlobal('location', { ...window.location, assign })
  await click(button('Connect GoCardless'))
  expect(assign).toHaveBeenCalledWith('https://connect.example/oauth')
  // Held while the browser leaves.
  expect(button('Connect GoCardless')?.disabled).toBe(true)
  vi.unstubAllGlobals()
})

test('settings: off on this server hides the rest', async () => {
  status = { ...CONNECTED, enabled: false, mode: 'off', connected: false }
  await settings()
  expect(byTestId('gocardless-mode')).toBe(
    'Direct Debit is switched off on this server.',
  )
  expect(button('Connect GoCardless')).toBeUndefined()
})

test('settings: the way back from GoCardless says how it went', async () => {
  search = { gocardless: 'taken' }
  await settings()
  expect(byTestId('gocardless-outcome')).toContain(
    'already connected to another group',
  )
})

test('settings: disconnect asks first; the answer is the server’s status', async () => {
  await settings()
  await click(button('Disconnect'))
  const ask = document.querySelector('[role="alertdialog"]')!
  expect(ask.textContent).toContain('GoCardless keeps collecting')
  expect(admin.disconnect).not.toHaveBeenCalled()
  admin.disconnect.mockResolvedValue({ ...CONNECTED, connected: false })
  await click(button('Disconnect', ask))
  expect(admin.disconnect).toHaveBeenCalledOnce()
})

test('settings: parked events, and Try again', async () => {
  status = { ...CONNECTED, failedEvents: 2 }
  admin.retryEvents.mockResolvedValue(CONNECTED)
  await settings()
  expect(byTestId('gocardless-failed-events')).toBe(
    '2 messages from GoCardless couldn’t be handled.',
  )
  await click(button('Try again'))
  expect(admin.retryEvents).toHaveBeenCalledOnce()
})

const PAYMENT: UnmatchedPayment = {
  id: 'u1',
  paymentId: 'PM77',
  mandateId: 'MD77',
  amount: 2000n,
  chargeDate: '2026-10-20',
  status: 'confirmed',
  reason: null,
  version: 4,
}

test('unmatched: each payment, and nothing to match when there are none', async () => {
  await unmatchedPage()
  expect(byTestId('unmatched-empty')).toBe('Nothing to match.')
  unmatched = [
    PAYMENT,
    { ...PAYMENT, id: 'u2', paymentId: 'PM78', status: 'failed' },
  ]
  await unmatchedPage()
  const rows = [
    ...el.querySelectorAll<HTMLTableRowElement>(
      '[data-testid="unmatched-payments"] tbody tr',
    ),
  ]
  expect(
    rows.map((r) => [
      r.dataset.payment,
      r.cells[1].textContent,
      r.cells[2].textContent,
    ]),
  ).toEqual([
    ['PM77', '£20.00', 'collected'],
    ['PM78', '£20.00', 'failed'],
  ])
  // A failed payment isn't money: struck through.
  expect(rows[1].cells[1].className).toContain('line-through')
  expect(rows[0].cells[1].className).not.toContain('line-through')
})

test('unmatched: a viewer sees the list, not Match', async () => {
  role = 'viewer'
  unmatched = [PAYMENT]
  await unmatchedPage()
  expect(el.textContent).toContain('PM77')
  expect(button('Match to contact')).toBeUndefined()
})

test('unmatched: match to an existing contact and a code, against the version listed', async () => {
  unmatched = [PAYMENT]
  await unmatchedPage()
  await click(button('Match to contact'))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(button('Match', dialog)?.disabled).toBe(true)
  expect(button('Find Dee', dialog)?.dataset.existingOnly).toBe('true')
  await click(button('Find Dee', dialog))
  await click(button('Pick a code', dialog))
  match.mockResolvedValue('g9')
  await act(async () => dialog.querySelector('form')!.requestSubmit())
  expect(match).toHaveBeenCalledWith(PAYMENT, 'c7', 'v1')
  expect(dialog.textContent).toContain('Matched to Dee Debit.')
  expect(dialog.querySelector('a')?.getAttribute('href')).toBe(
    '/t/alpha/gifts/g9',
  )
})

test('unmatched: matched by someone else meanwhile is said plainly', async () => {
  unmatched = [PAYMENT]
  await unmatchedPage()
  await click(button('Match to contact'))
  const dialog = document.querySelector('[role="dialog"]')!
  await click(button('Find Dee', dialog))
  await click(button('Pick a code', dialog))
  match.mockRejectedValue(
    new RustApiError(422, {
      kind: 'rejected',
      code: 'already_matched',
      message: 'This payment has been matched already',
    } as never),
  )
  await act(async () => dialog.querySelector('form')!.requestSubmit())
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
    'This payment has been matched already',
  )
})

test('unmatched: after a 409 the dialog matches against the row read again', async () => {
  unmatched = [PAYMENT]
  await unmatchedPage()
  await click(button('Match to contact'))
  const dialog = () => document.querySelector('[role="dialog"]')!
  await click(button('Find Dee', dialog()))
  await click(button('Pick a code', dialog()))
  match.mockRejectedValueOnce(new RustApiError(409, { kind: 'stale' } as never))
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
    'the list has been read again',
  )
  // The list's refetch brings the payment's new version.
  unmatched = [{ ...PAYMENT, version: 5 }]
  await unmatchedPage()
  match.mockResolvedValueOnce('g9')
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  expect(match.mock.calls[1][0]).toMatchObject({ id: 'u1', version: 5 })
})

test('unmatched: matched by someone else, the dialog says so and offers no Match', async () => {
  unmatched = [PAYMENT]
  await unmatchedPage()
  await click(button('Match to contact'))
  unmatched = []
  await unmatchedPage()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(
    dialog.querySelector('[data-testid="match-gone"]')?.textContent,
  ).toContain('matched this payment already')
  expect(button('Match', dialog)).toBeUndefined()
})

const SUB: UnknownSubscription = {
  subscriptionId: 'SB9',
  mandateId: 'MD1',
  contactId: 'c7',
  payments: 2,
  lastAmount: 500n,
  lastChargeDate: '2026-10-05',
}

test('subscriptions set up elsewhere: listed under the payments, adopted with a code', async () => {
  unknown = [SUB]
  await unmatchedPage()
  const row = el.querySelector('[data-subscription="SB9"]')!
  expect(row.textContent).toContain('£5.00 on 5 Oct 2026')
  expect(row.querySelector('a')?.getAttribute('href')).toBe(
    '/t/alpha/contacts/c7',
  )
  await click(button('Adopt', row))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(button('Adopt', dialog)?.disabled).toBe(true)
  await click(button('Pick a code', dialog))
  adopt.mockResolvedValue({
    id: 'r9',
    contactId: 'c7',
    amount: 500n,
    frequency: 'monthly',
    dayOfMonth: 5,
    month: null,
  })
  await act(async () => dialog.querySelector('form')!.requestSubmit())
  // Adopted: it leaves the list (the last one), and the answer stays.
  unknown = []
  await unmatchedPage()
  expect(el.textContent).not.toContain('Subscriptions set up elsewhere')
  const [subscription, args] = adopt.mock.calls[0] as [
    string,
    { sourceCodeId: string; clientKey: string },
  ]
  expect(subscription).toBe('SB9')
  expect(args.sourceCodeId).toBe('v1')
  expect(args.clientKey).toMatch(/^[0-9a-f]{32}$/)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Adopted: £5.00 every month on the 5th.',
  )
})

test('subscriptions set up elsewhere: none, no section; a viewer can’t adopt', async () => {
  await unmatchedPage()
  expect(el.textContent).not.toContain('Subscriptions set up elsewhere')
  role = 'viewer'
  unknown = [SUB]
  await unmatchedPage()
  expect(el.textContent).toContain('Subscriptions set up elsewhere')
  expect(button('Adopt')).toBeUndefined()
})

const line = (label: string, n: number) => ({
  id: label,
  label,
  expected: BigInt(n),
  received: BigInt(n - 100),
  failed: 100n,
  missing: 0n,
  pending: 0n,
})

test('the report: the last 12 months by code by default; lines, total, upgrades', async () => {
  search = { to: '2026-10' }
  report = {
    from: '2025-11',
    to: '2026-10',
    by: 'code',
    lines: [line('Street-1', 12_000)],
    total: line('', 12_000),
    upgrades: [
      {
        id: 'v2',
        label: 'Phone-1',
        upgrades: 1,
        downgrades: 0,
        annual: 2400n,
        monthly: 200n,
      },
    ],
    notRealised: [],
  }
  await page(import('./t.$slug.reports.expected'))
  expect(reportAsked).toHaveBeenCalledWith('2025-11', '2026-10', 'code')
  const row = el.querySelector('[data-testid="expected-lines"] tbody tr')!
  expect([...row.querySelectorAll('td')].map((c) => c.textContent)).toEqual([
    'Street-1',
    '£120.00',
    '£119.00',
    '£1.00',
    '£0.00',
    '£0.00',
  ])
  expect(
    el.querySelector('[data-testid="expected-total"] td')?.textContent,
  ).toBe('Total')
  expect(
    [...el.querySelectorAll('[data-testid="upgrades"] tbody td')].map(
      (c) => c.textContent,
    ),
  ).toEqual(['Phone-1', '1', '0', '£24.00', '£2.00'])
  expect(el.querySelector('[data-testid="not-realised"]')).toBeNull()
})

test('unmatched: our own match landing never says someone else matched it', async () => {
  unmatched = [PAYMENT]
  await unmatchedPage()
  await click(button('Match to contact'))
  const dialog = () => document.querySelector('[role="dialog"]')!
  await click(button('Find Dee', dialog()))
  await click(button('Pick a code', dialog()))
  let answer!: (id: string) => void
  match.mockReturnValue(new Promise((done) => (answer = done)))
  await act(async () => dialog().querySelector('form')!.requestSubmit())
  // The list's refetch lands first: the row has gone, our answer not yet.
  unmatched = []
  await unmatchedPage()
  expect(dialog().querySelector('[data-testid="match-gone"]')).toBeNull()
  await act(async () => answer('g9'))
  expect(dialog().textContent).toContain('Matched to Dee Debit.')
  expect(dialog().querySelector('[data-testid="match-gone"]')).toBeNull()
})
