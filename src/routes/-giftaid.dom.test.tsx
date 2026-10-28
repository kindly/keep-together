// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  Claim,
  ClaimPreview,
  ClaimRead,
  ClaimSummary,
  HmrcDetailsView,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'

// The Gift Aid pages (G3): the claims list, a new claim's preview, a
// claim's page with the steps its status allows, and Settings › HMRC
// details. Every figure is the server's; every refusal is shown as the
// server words it; a read that needs a step-up asks for one.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const fill = (to: string, params: Record<string, string> = {}) =>
  to.replace(/\$(\w+)/g, (_, k: string) => params[k])

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ slug: 'a', claimId: 'c1' }),
  }),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string
    params?: Record<string, string>
    children: ReactNode
  }) => <a href={fill(to, params)}>{children}</a>,
  Outlet: () => <div data-testid="outlet" />,
  useNavigate: () => navigate,
}))

const read = <T,>(data: T | undefined, error: unknown = null) =>
  ({
    data,
    error,
    refetch: vi.fn().mockResolvedValue(undefined),
  }) as ClaimRead<T> & { refetch: ReturnType<typeof vi.fn> }

let claims: ReturnType<typeof read<Array<ClaimSummary>>>
let preview: ReturnType<typeof read<ClaimPreview>> & { fetching: boolean }
let claim: ReturnType<typeof read<Claim | null>>
let details: ReturnType<typeof read<HmrcDetailsView>>
const create = vi.fn()
const step = vi.fn()
const saveDetails = vi.fn()
const download = vi.fn()
let role: 'admin' | 'staff' = 'admin'
vi.mock('../lib/data', () => ({
  useClaims: () => claims,
  useClaimPreview: () => preview,
  useClaim: () => claim,
  useHmrcDetails: () => details,
  useCreateClaims: () => create,
  useClaimStep: () => step,
  useSaveHmrcDetails: () => saveDetails,
  downloadClaim: (...a: Array<unknown>) => download(...a),
  useAuthState: () => ({ method: 'totp' }),
  useSignInSteps: () => ({}),
}))
vi.mock('../components/source-code-picker', () => ({
  localToday: () => '2026-10-28',
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'a', role }),
  useIsAdmin: () => role === 'admin',
}))

const totals = (over = {}) => ({
  lines: 2,
  donations: 3000n,
  reclaim: 750n,
  adjustment: 0n,
  net: 750n,
  ...over,
})

function makeClaim(over: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    number: 4,
    status: 'draft',
    periodEnd: '2026-10-28',
    earliestDate: '2026-01-02',
    totals: totals(),
    submittedOn: null,
    hmrcReference: null,
    paidOn: null,
    paidAmount: null,
    rejectedReason: null,
    createdBy: 1,
    createdAt: Date.UTC(2026, 9, 28),
    statusVersion: 5,
    lines: [
      {
        key: 'l1',
        giftId: 'g1',
        declarationId: 'd1',
        contactId: 'p1',
        title: 'Ms',
        firstName: 'Jo',
        lastName: 'Bloggs',
        house: '12',
        postcode: 'AB1 2CD',
        overseas: false,
        receivedOn: '2026-01-02',
        amount: 2000n,
        reclaim: 500n,
      },
    ],
    adjustments: [],
    voidedGifts: [],
    ...over,
  }
}

function makePreview(over: Partial<ClaimPreview> = {}): ClaimPreview {
  return {
    periodEnd: '2026-10-28',
    today: '2026-10-28',
    claimableFrom: '2022-10-28',
    lines: makeClaim().lines,
    adjustments: [],
    excluded: [
      {
        giftId: 'g9',
        contactId: 'p9',
        contactName: 'Pat Nopost',
        receivedOn: '2026-03-03',
        amount: 1500n,
        reasons: ['No postcode', 'No house name or number'],
      },
    ],
    tooOld: 0,
    totals: totals(),
    claims: 1,
    ...over,
  }
}

const rejected = (reason: string, message: string) =>
  new RustApiError(422, { kind: 'rejected', reason, message })

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  role = 'admin'
  claims = read<Array<ClaimSummary>>([])
  preview = Object.assign(read(makePreview()), { fetching: false })
  claim = read<Claim | null>(makeClaim())
  details = read<HmrcDetailsView>(undefined)
  for (const f of [create, step, saveDetails, download, navigate])
    f.mockReset().mockResolvedValue(undefined)
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
const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (b: HTMLElement) => act(async () => b.click())
async function type(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const labelled = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(label))!
    .querySelector<HTMLInputElement>('input, textarea, select')!
const alert = () => el.querySelector('[role="alert"]')?.textContent
const links = () =>
  [...el.querySelectorAll('a')].map((a) => [
    a.textContent.trim(),
    a.getAttribute('href'),
  ])

// ── layout ─────────────────────────────────────────────────────────────────

test('the Gift Aid pages are for admins: anyone else is told, not shown', async () => {
  role = 'staff'
  await page(import('./t.$slug.giftaid'))
  expect(el.textContent).toContain(
    'Gift Aid claims are for the group’s admins.',
  )
  expect(el.querySelector('[data-testid="outlet"]')).toBeNull()
  role = 'admin'
  await page(import('./t.$slug.giftaid'))
  expect(el.querySelector('[data-testid="outlet"]')).not.toBeNull()
})

// ── list ───────────────────────────────────────────────────────────────────

test('the list: number, period, status, gifts, reclaim and dates, each opening its claim', async () => {
  claims = read<Array<ClaimSummary>>([
    {
      ...makeClaim({
        status: 'paid',
        submittedOn: '2026-10-01',
        hmrcReference: 'X1',
        paidOn: '2026-10-20',
        paidAmount: 750n,
      }),
    },
  ])
  await page(import('./t.$slug.giftaid.index'))
  const row = el.querySelector('[data-testid="claim-row"]')!
  expect(row.textContent).toContain('Claim 4')
  expect(row.textContent).toContain('2 Jan 2026 – 28 Oct 2026')
  expect(row.textContent).toContain('Paid')
  expect(row.textContent).toContain('£7.50')
  expect(row.textContent).toContain('submitted 1 Oct 2026')
  expect(row.textContent).toContain('paid 20 Oct 2026')
  expect(links()).toContainEqual(['Claim 4', '/t/a/giftaid/c1'])
  expect(links()).toContainEqual(['New claim', '/t/a/giftaid/new'])
})

test('a read that needs a step-up asks for one, then reads again', async () => {
  claims = read<Array<ClaimSummary>>(
    undefined,
    new RustApiError(403, { kind: 'step_up_required' }),
  )
  await page(import('./t.$slug.giftaid.index'))
  expect(el.querySelector('[aria-label="Confirm it\'s you"]')).not.toBeNull()
  expect(el.textContent).not.toContain('Loading')
})

test('a forbidden read says the claims are for admins', async () => {
  claims = read<Array<ClaimSummary>>(
    undefined,
    new RustApiError(403, { kind: 'forbidden' }),
  )
  await page(import('./t.$slug.giftaid.index'))
  expect(alert()).toContain('Only admins can see Gift Aid claims.')
})

// ── new claim ──────────────────────────────────────────────────────────────

test('the preview: totals, reclaim, and each gift left out with its reasons and links to fix it', async () => {
  await page(import('./t.$slug.giftaid.new'))
  expect(labelled(el, 'End date').value).toBe('2026-10-28')
  expect(el.querySelector('[data-testid="preview-lines"]')?.textContent).toBe(
    '2',
  )
  expect(el.querySelector('[data-testid="preview-reclaim"]')?.textContent).toBe(
    '£7.50',
  )
  expect(el.textContent).toContain('This makes one claim')
  const left = el.querySelector('[data-testid="excluded"]')!
  expect(left.textContent).toContain('No postcode')
  expect(left.textContent).toContain('No house name or number')
  expect(links()).toContainEqual(['Pat Nopost', '/t/a/contacts/p9'])
  expect(links()).toContainEqual(['£15.00 on 3 Mar 2026', '/t/a/gifts/g9'])
})

test('Refresh reads the preview again (after a fix)', async () => {
  await page(import('./t.$slug.giftaid.new'))
  await click(button(el, 'Refresh')!)
  expect(preview.refetch).toHaveBeenCalledOnce()
})

test('over 1,000 gifts: how many claims it makes, adjustments due, the four-year limit', async () => {
  preview = Object.assign(
    read(
      makePreview({
        claims: 2,
        tooOld: 3,
        totals: totals({ adjustment: 125n, net: 625n }),
        adjustments: [
          {
            giftId: 'g0',
            originalClaimId: 'c0',
            amount: 125n,
            reason: 'Entered twice',
          },
        ],
      }),
    ),
    { fetching: false },
  )
  await page(import('./t.$slug.giftaid.new'))
  expect(el.textContent).toContain('This makes 2 claims')
  expect(button(el, 'Create 2 claims')).toBeDefined()
  expect(el.textContent).toContain('Entered twice')
  expect(el.textContent).toContain('−£1.25')
  expect(el.textContent).toContain(
    'Gifts received before 28 Oct 2022 are past HMRC’s four-year limit (3 unclaimed gifts).',
  )
})

test('Create sends the preview shown and opens the new claim', async () => {
  create.mockResolvedValue([makeClaim({ id: 'new1' })])
  await page(import('./t.$slug.giftaid.new'))
  await click(button(el, 'Create claim')!)
  expect(create).toHaveBeenCalledWith(preview.data)
  expect(navigate).toHaveBeenCalledWith({
    to: '/t/$slug/giftaid/$claimId',
    params: { slug: 'a', claimId: 'new1' },
  })
})

test('a changed preview is refused in the server’s words and read again', async () => {
  create.mockRejectedValue(
    rejected(
      'preview_changed',
      'The eligible gifts changed since the preview: check it again',
    ),
  )
  await page(import('./t.$slug.giftaid.new'))
  await click(button(el, 'Create claim')!)
  expect(alert()).toBe(
    'The eligible gifts changed since the preview: check it again',
  )
  expect(preview.refetch).toHaveBeenCalledOnce()
  expect(navigate).not.toHaveBeenCalled()
})

test('nothing to claim: said, and Create is off', async () => {
  preview = Object.assign(
    read(makePreview({ lines: [], totals: totals({ lines: 0 }) })),
    { fetching: false },
  )
  await page(import('./t.$slug.giftaid.new'))
  expect(el.textContent).toContain('No gift can be claimed up to 28 Oct 2026.')
  expect(button(el, 'Create claim')!.disabled).toBe(true)
})

test('a create that needs a step-up asks, and goes through once confirmed', async () => {
  create.mockRejectedValueOnce(
    new RustApiError(403, { kind: 'step_up_required' }),
  )
  await page(import('./t.$slug.giftaid.new'))
  await click(button(el, 'Create claim')!)
  expect(el.querySelector('[aria-label="Confirm it\'s you"]')).not.toBeNull()
  expect(alert()).toBeUndefined()
})

// ── one claim ──────────────────────────────────────────────────────────────

test('a draft: Mark ready confirms first; no downloads until it is ready', async () => {
  await page(import('./t.$slug.giftaid.$claimId'))
  expect(el.querySelector('h1')?.textContent).toContain('Gift Aid claim 4')
  expect(el.textContent).toContain(
    'Mark the claim ready to download its schedule for HMRC.',
  )
  expect(button(el, 'Schedule (Excel)')).toBeUndefined()
  await click(button(el, 'Mark ready')!)
  expect(step).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('can no longer be deleted')
  await click(button(dialog, 'Mark ready')!)
  expect(step).toHaveBeenCalledWith(5, { status: 'ready' })
})

test('deleting a draft goes back to the list', async () => {
  step.mockResolvedValue(null)
  await page(import('./t.$slug.giftaid.$claimId'))
  await click(button(el, 'Delete draft')!)
  const dialog = document.querySelector('[role="alertdialog"]')!
  await click(button(dialog, 'Delete draft')!)
  expect(step).toHaveBeenCalledWith(5, { status: 'deleted' })
  expect(navigate).toHaveBeenCalledWith({
    to: '/t/$slug/giftaid',
    params: { slug: 'a' },
  })
})

test('a draft with a voided gift says to delete it; Mark ready’s refusal is shown', async () => {
  claim = read<Claim | null>(makeClaim({ voidedGifts: ['g1'] }))
  step.mockRejectedValue(
    rejected(
      'voided_gifts',
      "1 of this claim's gifts was voided since it was made: delete this draft and claim again",
    ),
  )
  await page(import('./t.$slug.giftaid.$claimId'))
  expect(el.textContent).toContain(
    '1 gift in this claim was voided since it was made: delete this draft and make a new claim.',
  )
  await click(button(el, 'Mark ready')!)
  await click(
    button(document.querySelector('[role="alertdialog"]')!, 'Mark ready')!,
  )
  expect(alert()).toContain('delete this draft and claim again')
})

test('ready: downloads, and Mark submitted with the date and HMRC reference', async () => {
  claim = read<Claim | null>(makeClaim({ status: 'ready' }))
  await page(import('./t.$slug.giftaid.$claimId'))
  await click(button(el, 'Schedule (Excel)')!)
  await click(button(el, 'Schedule (LibreOffice)')!)
  await click(button(el, 'Claim XML')!)
  expect(download.mock.calls).toEqual([
    ['a', 'c1', 'excel'],
    ['a', 'c1', 'libreoffice'],
    ['a', 'c1', 'xml'],
  ])
  await click(button(el, 'Mark submitted')!)
  const form = el.querySelector('form[aria-label="Mark submitted"]')!
  expect(labelled(form, 'Submitted on').value).toBe('2026-10-28')
  await type(labelled(form, 'HMRC reference'), ' X123 ')
  await act(async () => (form as HTMLFormElement).requestSubmit())
  expect(step).toHaveBeenCalledWith(5, {
    status: 'submitted',
    submittedOn: '2026-10-28',
    hmrcReference: 'X123',
  })
})

test('a refused download is said plainly (missing HMRC details)', async () => {
  claim = read<Claim | null>(makeClaim({ status: 'ready' }))
  download.mockRejectedValue(
    rejected(
      'missing_hmrc_details',
      'Set the group’s HMRC details first: HMRC reference',
    ),
  )
  await page(import('./t.$slug.giftaid.$claimId'))
  await click(button(el, 'Claim XML')!)
  expect(alert()).toBe('Set the group’s HMRC details first: HMRC reference')
})

test('submitted: Mark paid with the amount (the net by default) in pence', async () => {
  claim = read<Claim | null>(
    makeClaim({
      status: 'submitted',
      submittedOn: '2026-10-01',
      hmrcReference: 'X123',
    }),
  )
  await page(import('./t.$slug.giftaid.$claimId'))
  expect(
    el.querySelector('[data-testid="claim-progress"]')?.textContent,
  ).toContain('1 Oct 2026, HMRC reference X123')
  await click(button(el, 'Mark paid')!)
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="Mark paid"]',
  )!
  expect(labelled(form, 'Amount HMRC paid').value).toBe('7.50')
  await type(labelled(form, 'Amount HMRC paid'), 'seven')
  await act(async () => form.requestSubmit())
  expect(form.querySelector('[role="alert"]')?.textContent).toBe(
    'Enter the amount in pounds, like 656.25',
  )
  expect(step).not.toHaveBeenCalled()
  await type(labelled(form, 'Amount HMRC paid'), '£1,234.5')
  await act(async () => form.requestSubmit())
  expect(step).toHaveBeenCalledWith(5, {
    status: 'paid',
    paidOn: '2026-10-28',
    paidAmount: 123450n,
  })
})

test('reject: with a reason; a later claim’s repayment refuses it, said as the server says', async () => {
  claim = read<Claim | null>(makeClaim({ status: 'submitted' }))
  step.mockRejectedValue(
    rejected(
      'adjusted_later',
      'Claim 5 pays back a gift of this one, so it tells HMRC this claim stood: reject or delete claim 5 first',
    ),
  )
  await page(import('./t.$slug.giftaid.$claimId'))
  await click(button(el, 'Reject')!)
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="Reject claim"]',
  )!
  await type(labelled(form, 'Why HMRC rejected it'), 'Wrong reference')
  await act(async () => form.requestSubmit())
  expect(step).toHaveBeenCalledWith(5, {
    status: 'rejected',
    reason: 'Wrong reference',
  })
  expect(alert()).toContain('reject or delete claim 5 first')
})

test('a stale step says someone else changed the claim', async () => {
  step.mockRejectedValue(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'giftaid.claimStatus',
      counter: 6,
      current: {},
    }),
  )
  await page(import('./t.$slug.giftaid.$claimId'))
  await click(button(el, 'Mark ready')!)
  await click(
    button(document.querySelector('[role="alertdialog"]')!, 'Mark ready')!,
  )
  expect(alert()).toContain('Someone else changed this claim just now')
})

test('paid: no steps left; rejected: its downloads are marked superseded', async () => {
  claim = read<Claim | null>(
    makeClaim({ status: 'paid', paidOn: '2026-10-20', paidAmount: 750n }),
  )
  await page(import('./t.$slug.giftaid.$claimId'))
  expect(el.textContent).toContain('£7.50 on 20 Oct 2026')
  for (const name of ['Mark ready', 'Mark submitted', 'Mark paid', 'Reject'])
    expect(button(el, name)).toBeUndefined()
  expect(button(el, 'Schedule (Excel)')).toBeDefined()

  claim = read<Claim | null>(
    makeClaim({ status: 'rejected', rejectedReason: 'Wrong reference' }),
  )
  await page(import('./t.$slug.giftaid.$claimId'))
  expect(el.textContent).toContain('Wrong reference')
  expect(el.textContent).toContain('these files are superseded')
})

test('an unknown claim says so', async () => {
  claim = read<Claim | null>(null)
  await page(import('./t.$slug.giftaid.$claimId'))
  expect(el.textContent).toContain('No such claim.')
})

// ── HMRC details ───────────────────────────────────────────────────────────

const view = (over: Partial<HmrcDetailsView> = {}): HmrcDetailsView => ({
  version: 2,
  warnings: [],
  hmrcReference: 'AB12345',
  regulator: 'ccew',
  regulatorNumber: '1234567',
  officialTitle: '',
  officialFirstName: 'Jo',
  officialLastName: 'Treasurer',
  officialPostcode: 'AB1 2CD',
  officialPhone: '01234 567890',
  ...over,
})

test('HMRC details: the form shows them and their warnings, and saves against the version', async () => {
  details = read(
    view({
      warnings: [
        {
          anchor: 'hmrcReference',
          label: 'HMRC reference',
          message: 'HMRC’s references look like AB12345',
        },
      ],
      hmrcReference: 'nope',
    }),
  )
  await page(import('./t.$slug.settings.hmrc'))
  expect(
    el.querySelector('[data-testid="hmrc-warnings"]')?.textContent,
  ).toContain('HMRC reference: HMRC’s references look like AB12345')
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="HMRC details"]',
  )!
  expect(labelled(form, 'Regulator').value).toBe('ccew')
  await type(labelled(form, 'HMRC charity reference'), 'AB12345')
  await act(async () => form.requestSubmit())
  expect(saveDetails).toHaveBeenCalledWith(2, {
    hmrcReference: 'AB12345',
    regulator: 'ccew',
    regulatorNumber: '1234567',
    officialTitle: '',
    officialFirstName: 'Jo',
    officialLastName: 'Treasurer',
    officialPostcode: 'AB1 2CD',
    officialPhone: '01234 567890',
  })
  expect(el.textContent).toContain('Saved.')
})

test('HMRC details: a stale save is said and the details read again', async () => {
  details = read(view())
  saveDetails.mockRejectedValue(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'giftaid.hmrcDetails',
      counter: 3,
      current: {},
    }),
  )
  await page(import('./t.$slug.settings.hmrc'))
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="HMRC details"]',
  )!
  await act(async () => form.requestSubmit())
  expect(alert()).toContain('Someone else saved these details just now')
  expect(details.refetch).toHaveBeenCalledOnce()
})

test('HMRC details are for admins', async () => {
  role = 'staff'
  details = read(view())
  await page(import('./t.$slug.settings.hmrc'))
  expect(el.textContent).toContain(
    'The group’s HMRC details are for its admins.',
  )
  expect(el.querySelector('form')).toBeNull()
})
