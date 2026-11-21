// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  DonationPage,
  StripeStatus,
  UnmatchedCardPayment,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'

// Stripe S5's pages: Settings › Card donations (connect through Stripe's
// form and the two ways back, the donation page's link, amounts and
// code) and "Card payments to match" (each reason said plainly, matching,
// setting an outside payment aside and putting it back). Nothing is
// optimistic: a row leaves a list only when the list read again lacks it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let status: StripeStatus | undefined
let search: Record<string, unknown> = {}
let role: 'admin' | 'staff' | 'viewer' = 'admin'
let page: DonationPage | undefined
let queue: Array<UnmatchedCardPayment> | undefined
let aside: Array<UnmatchedCardPayment> | undefined
let moreAside = false
const loadMore = vi.fn()
const polled = vi.fn()
const admin = { connect: vi.fn(), disconnect: vi.fn() }
const savePage = vi.fn()
const writes = { match: vi.fn(), setAside: vi.fn(), putBack: vi.fn() }
const read = <T,>(data: T) => ({
  data,
  error: null,
  refetch: () => Promise.resolve(),
})
vi.mock('../lib/data', () => ({
  useStripeStatus: (poll?: boolean) => {
    polled(poll)
    return status
  },
  useStripeAdmin: () => admin,
  useDonationPage: () => read(page),
  useSaveDonationPage: () => savePage,
  useCardQueue: () => read(queue),
  useCardsSetAside: () => ({
    ...read(aside),
    loadMore: moreAside ? loadMore : null,
    loadingMore: false,
  }),
  useCardQueueWrites: () => writes,
  useAuthState: () => ({ method: 'password' }),
}))
/** "We claim Gift Aid" (Settings): a test switches it off to see what hides. */
const giftAidSwitch = vi.hoisted(() => ({ on: true }))
vi.mock('../lib/tenant', () => ({
  claimsGiftAid: () => giftAidSwitch.on,
  useClaimsGiftAid: () => giftAidSwitch.on,
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
  DonorSearch: ({ onPick }: { onPick: (d: object) => void }) => (
    <button
      type="button"
      onClick={() =>
        onPick({ kind: 'existing', id: 'c7', displayName: 'Dee Donor' })
      }
    >
      Find Dee
    </button>
  ),
}))

const TAKING: StripeStatus = {
  enabled: true,
  mode: 'fake',
  connected: true,
  accountId: 'acct_1',
  connectedAt: Date.UTC(2026, 10, 20, 9),
  connectedBy: 1,
  onboarding: 'complete',
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  requirementsDue: 0,
  disabledReason: null,
  statusAt: Date.UTC(2026, 10, 20, 9),
  failedEvents: 0,
}
const NOT_CONNECTED: StripeStatus = {
  ...TAKING,
  connected: false,
  accountId: null,
  connectedAt: null,
  onboarding: 'none',
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
}
const PAGE: DonationPage = {
  amounts: [1000n, 2500n, 5000n],
  minimum: 200n,
  maximum: 100_000n,
  sourceCodeId: 'v9',
  sourceCode: {
    code: 'Web-Give-001',
    versionId: 'v9',
    detailId: 'd9',
    categoryId: 'c9',
    versionName: '001',
    detailName: 'Give',
    categoryName: 'Web',
    isActive: true,
  },
  version: 4,
  takingDonations: true,
}
const payment = (
  over: Partial<UnmatchedCardPayment> = {},
): UnmatchedCardPayment => ({
  id: 'p1',
  paymentId: 'pi_1',
  amount: 2500n,
  paidOn: '2026-11-18',
  status: 'completed',
  reason: 'ambiguous',
  donor: {
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane@example.org',
    giftAid: true,
    addressLine1: '12 High Street',
    postcode: 'AB1 2CD',
  },
  sourceCodeId: 'v9',
  candidates: [
    { id: 'c1', displayName: 'Jane Smith' },
    { id: 'c2', displayName: 'Janet Smith' },
  ],
  matchVersion: 1,
  dismissed: null,
  dismissedAt: null,
  ...over,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of [...Object.values(admin), ...Object.values(writes), savePage])
    f.mockReset()
  polled.mockReset()
  loadMore.mockReset()
  moreAside = false
  status = TAKING
  search = {}
  role = 'admin'
  page = PAGE
  queue = []
  aside = []
  giftAidSwitch.on = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

async function show(module: Promise<{ Route: unknown }>) {
  const { Route } = await module
  const Page = (Route as { options: { component: ComponentType } }).options
    .component
  await act(async () => root.render(<Page />))
}
const settings = () => show(import('./t.$slug.settings.stripe'))
const queuePage = () => show(import('./t.$slug.stripe.unmatched'))
const button = (name: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (b: HTMLElement | undefined) =>
  act(async () => {
    if (!b) throw new Error('no such button')
    b.click()
  })
const byTestId = (id: string) =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent
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
const input = (name: string) =>
  el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!

// ── Settings › Card donations ─────────────────────────────────────────────

test('settings: admins only; off on this server says so and offers nothing', async () => {
  role = 'staff'
  await settings()
  expect(el.textContent).toBe(
    'Card donations are set up by the group’s admins.',
  )

  role = 'admin'
  status = { ...NOT_CONNECTED, enabled: false, mode: 'off' }
  await settings()
  expect(byTestId('stripe-mode')).toBe(
    'Card donations are switched off on this server.',
  )
  expect(button('Connect Stripe')).toBeUndefined()
  expect(el.querySelector('form')).toBeNull()
})

test('settings: not connected offers Connect Stripe, which goes to Stripe’s form', async () => {
  status = NOT_CONNECTED
  page = {
    ...PAGE,
    sourceCodeId: null,
    sourceCode: null,
    takingDonations: false,
  }
  admin.connect.mockResolvedValue('https://stripe.example/onboarding/x')
  const assign = vi.fn()
  vi.stubGlobal('location', {
    ...window.location,
    assign,
    origin: 'https://keep.example',
  })
  await settings()
  expect(byTestId('stripe-connected')).toBe('Not connected')
  expect(button('Disconnect')).toBeUndefined()
  // No link to share until the page has a code (and Stripe).
  expect(byTestId('give-link')).toBeUndefined()
  expect(byTestId('give-link-missing')).toContain(
    'Choose the page’s source code below and save',
  )
  await click(button('Connect Stripe'))
  expect(admin.connect).toHaveBeenCalledOnce()
  expect(assign).toHaveBeenCalledWith('https://stripe.example/onboarding/x')
  vi.unstubAllGlobals()
})

test('settings: back from Stripe says so and reads the status again; a spent link asks for another', async () => {
  status = { ...TAKING, chargesEnabled: false, payoutsEnabled: false }
  search = { stripe: 'return' }
  await settings()
  // "return" proves nothing: what Stripe decided comes by webhook.
  expect(polled).toHaveBeenLastCalledWith(true)
  expect(byTestId('stripe-outcome')).toContain(
    'What Stripe decided shows below once it tells us',
  )
  expect(byTestId('stripe-connected')).toBe('Stripe is checking')
  status = TAKING
  await settings()
  expect(byTestId('stripe-outcome')).toBe(
    'Back from Stripe: the group can take card donations.',
  )
  expect(byTestId('stripe-connected')).toBe('Taking donations')

  search = { stripe: 'refresh' }
  status = { ...NOT_CONNECTED, connected: true, accountId: 'acct_1' }
  await settings()
  expect(polled).toHaveBeenLastCalledWith(false)
  expect(byTestId('stripe-outcome')).toContain('had expired or been used')
  expect(button('Continue at Stripe')).toBeDefined()
})

test('settings: a failed connect says it didn’t finish, without guessing why', async () => {
  status = NOT_CONNECTED
  admin.connect.mockRejectedValue(
    new RustApiError(503, { kind: 'stripe_unavailable' }),
  )
  await settings()
  await click(button('Connect Stripe'))
  const alert = el.querySelector('[role="alert"]')!.textContent
  expect(alert).toContain('Stripe didn’t complete that')
  expect(alert).toContain('carries on from where it got to')
  expect(alert).not.toContain('isn’t answering')
})

test('settings: disconnecting asks first', async () => {
  admin.disconnect.mockResolvedValue(NOT_CONNECTED)
  await settings()
  await click(button('Disconnect'))
  expect(admin.disconnect).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(
    'The donation page stops taking gifts until Stripe is connected again',
  )
  await click(
    button('Disconnect', document.querySelector('[role="alertdialog"]')!),
  )
  expect(admin.disconnect).toHaveBeenCalledOnce()
})

test('the donation page: its link once it takes donations, and what is missing until then', async () => {
  vi.stubGlobal('location', {
    ...window.location,
    origin: 'https://keep.example',
  })
  await settings()
  expect(byTestId('give-link')).toBe('https://keep.example/give/alpha')
  expect(byTestId('give-link-missing')).toBeUndefined()

  // Stripe not taking payments yet: the link, with the warning.
  status = { ...TAKING, chargesEnabled: false }
  await settings()
  expect(byTestId('give-link')).toBe('https://keep.example/give/alpha')
  expect(byTestId('give-link-missing')).toContain(
    'Stripe isn’t taking payments for the group yet',
  )
  // The code archived since: no link.
  status = TAKING
  page = {
    ...PAGE,
    takingDonations: false,
    sourceCode: { ...PAGE.sourceCode!, isActive: false },
  }
  await settings()
  expect(byTestId('give-link')).toBeUndefined()
  expect(byTestId('give-link-missing')).toContain('source code is archived')
  vi.unstubAllGlobals()
})

test('the donation page: the amounts follow the server’s rules, and a save shows what the server saved', async () => {
  await settings()
  expect(input('amounts.0').value).toBe('10.00')
  expect(input('minimum').value).toBe('2.00')
  expect(button('Web-Give-001')).toBeDefined()
  const save = () => button('Save donation page')!

  // Under £1: said beside the field, and the save is held.
  await type(input('minimum'), '0.50')
  expect(el.querySelector('[data-problem="minimum"]')!.textContent).toBe(
    'The minimum is at least £1.00',
  )
  expect(save().disabled).toBe(true)
  await type(input('minimum'), '3')
  await type(input('amounts.0'), '2.50')
  expect(el.querySelector('[data-problem="amounts.0"]')!.textContent).toBe(
    'Between £3.00 and £1,000.00',
  )
  await type(input('amounts.0'), '15')
  expect(save().disabled).toBe(false)

  // Pence as bigint, against the counter read; nothing says "Saved"
  // before the server answers.
  let answer!: (p: DonationPage) => void
  savePage.mockReturnValue(new Promise<DonationPage>((r) => (answer = r)))
  await click(save())
  expect(savePage).toHaveBeenCalledWith(4, {
    amounts: [1500n, 2500n, 5000n],
    minimum: 300n,
    maximum: 100_000n,
    sourceCodeId: 'v9',
  })
  expect(byTestId('page-saved')).toBeUndefined()
  page = { ...PAGE, amounts: [1500n, 2500n, 5000n], minimum: 300n, version: 5 }
  await act(async () => answer(page!))
  await settings()
  expect(byTestId('page-saved')).toBe('Saved.')
  expect(input('amounts.0').value).toBe('15.00')
  // Typing again: no longer "Saved".
  await type(input('amounts.0'), '16')
  expect(byTestId('page-saved')).toBeUndefined()
})

test('the donation page: another admin’s save is said, and the server’s own refusal lands on its field', async () => {
  await settings()
  await type(input('amounts.0'), '15')
  savePage.mockRejectedValueOnce(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'giving.donationPage',
      counter: 5,
      current: null,
    } as never),
  )
  await click(button('Save donation page'))
  expect(el.querySelector('[role="alert"]')!.textContent).toContain(
    'Another admin changed the donation page just now',
  )
  savePage.mockRejectedValueOnce(
    new RustApiError(422, {
      kind: 'invalid',
      problems: [
        { field: 'maximum', message: 'The maximum is at most £1,000.00' },
      ],
    }),
  )
  await click(button('Save donation page'))
  expect(el.querySelector('[data-problem="maximum"]')!.textContent).toBe(
    'The maximum is at most £1,000.00',
  )
})

// ── Card payments to match ────────────────────────────────────────────────

test('the queue: off on this server says so; empty says so', async () => {
  status = { ...NOT_CONNECTED, enabled: false, mode: 'off' }
  await queuePage()
  expect(el.textContent).toBe('Card donations are switched off on this server.')
  status = TAKING
  await queuePage()
  expect(byTestId('card-queue-empty')).toBe('Nothing to match.')
  // Nothing set aside: no second list.
  expect(el.textContent).not.toContain('Set aside as not donations')
})

test('the queue: every reason is said plainly, with what the donor typed', async () => {
  queue = [
    payment(),
    payment({ id: 'p2', paymentId: 'pi_2', reason: 'name_differs' }),
    payment({ id: 'p3', paymentId: 'pi_3', reason: 'deceased' }),
    payment({ id: 'p4', paymentId: 'pi_4', reason: 'contact_refused' }),
    payment({
      id: 'p5',
      paymentId: 'pi_5',
      reason: 'no_submission',
      donor: null,
      sourceCodeId: null,
      candidates: [],
    }),
  ]
  await queuePage()
  const rows = [...el.querySelectorAll('[data-testid="card-queue"] > li')]
  expect(rows.map((r) => r.getAttribute('data-reason'))).toEqual([
    'ambiguous',
    'name_differs',
    'deceased',
    'contact_refused',
    'no_submission',
  ])
  const says = (i: number) =>
    rows[i].querySelector('[data-testid="card-reason"]')!.textContent
  expect(says(0)).toContain('More than one contact has the email address')
  expect(says(1)).toContain('under a different last name')
  expect(says(2)).toContain('is marked deceased')
  expect(says(3)).toContain('couldn’t be saved as a new contact')
  expect(says(4)).toContain('without coming through the donation page')
  // No raw reason code reaches the page.
  expect(el.textContent).not.toMatch(
    /no_submission|contact_refused|name_differs/,
  )
  expect(rows[0].textContent).toContain('£25.00')
  expect(rows[0].textContent).toContain('Jane Smith · jane@example.org')
  expect(rows[0].textContent).toContain(
    'Ticked, from 12 High Street, AB1 2CD: matching records their declaration',
  )
  // Only a payment that never came through the page can be set aside.
  expect(rows.map((r) => Boolean(button('Not a donation', r)))).toEqual([
    false,
    false,
    false,
    false,
    true,
  ])
  expect(rows[4].querySelector('[data-testid="card-donor"]')).toBeNull()
})

test('the queue: a viewer sees the list and no buttons', async () => {
  role = 'viewer'
  queue = [payment({ reason: 'no_submission', donor: null })]
  aside = [
    payment({
      id: 'p9',
      paymentId: 'pi_9',
      dismissed: 'Stall hire',
      dismissedAt: 1,
    }),
  ]
  await queuePage()
  expect(el.querySelectorAll('[data-testid="card-queue"] > li')).toHaveLength(1)
  expect(el.querySelectorAll('button')).toHaveLength(0)
})

test('matching: a candidate is one click, the page’s code is kept, and the gift exists only once the server says', async () => {
  queue = [payment()]
  await queuePage()
  await click(button('Match to contact'))
  const dialog = document.querySelector('[role="dialog"]')!
  // From the page: its code stands, no picker.
  expect(button('Pick a code', dialog)).toBeUndefined()
  expect(button('Match', dialog)!.disabled).toBe(true)
  await click(button('Janet Smith', dialog))
  expect(byTestId('match-donor')).toBe('Janet Smith')
  let answer!: (g: object) => void
  writes.match.mockReturnValue(new Promise((r) => (answer = r)))
  await click(button('Match', dialog))
  expect(writes.match).toHaveBeenCalledWith(queue[0], 'c2', undefined)
  // In flight: nothing says matched, and the row is still listed.
  expect(dialog.querySelector('[role="status"]')).toBeNull()
  expect(el.querySelectorAll('[data-testid="card-queue"] > li')).toHaveLength(1)
  await act(async () =>
    answer({ _id: 'g7', card: { declarationRefused: 'not_individual' } }),
  )
  expect(dialog.querySelector('[role="status"]')!.textContent).toContain(
    'Matched to Janet Smith',
  )
  expect(dialog.querySelector('a')!.getAttribute('href')).toBe(
    '/t/alpha/gifts/g7',
  )
  // The donor's declaration couldn't be recorded: staff are told now.
  expect(byTestId('declaration-refused')).toContain('isn’t a person')
})

test('matching: an outside payment needs a code; a refusal is shown and nothing is claimed', async () => {
  queue = [
    payment({
      reason: 'no_submission',
      donor: null,
      sourceCodeId: null,
      candidates: [],
    }),
  ]
  await queuePage()
  await click(button('Match to contact'))
  const dialog = document.querySelector('[role="dialog"]')!
  await click(button('Find Dee', dialog))
  expect(button('Match', dialog)!.disabled).toBe(true)
  await click(button('Pick a code', dialog))
  writes.match.mockRejectedValueOnce(
    new RustApiError(422, {
      kind: 'rejected',
      reason: 'archived_contact',
      message: 'This contact is archived: restore it, or choose another',
    }),
  )
  await click(button('Match', dialog))
  expect(writes.match).toHaveBeenCalledWith(queue[0], 'c7', 'v1')
  expect(dialog.querySelector('[role="alert"]')!.textContent).toBe(
    'This contact is archived: restore it, or choose another',
  )
  expect(dialog.querySelector('[role="status"]')).toBeNull()
})

test('matching: a payment someone else dealt with meanwhile is said, not matched twice', async () => {
  queue = [payment()]
  await queuePage()
  await click(button('Match to contact'))
  queue = []
  await queuePage()
  expect(byTestId('match-gone')).toContain(
    'Someone else has dealt with this payment',
  )
  expect(
    button('Match', document.querySelector('[role="dialog"]')!),
  ).toBeUndefined()
})

test('setting aside: a reason is needed, it is never a delete, and it can be put back', async () => {
  const outside = payment({
    reason: 'no_submission',
    donor: null,
    sourceCodeId: null,
    candidates: [],
  })
  queue = [outside]
  await queuePage()
  await click(button('Not a donation'))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('It stays on record with your reason')
  expect(button('Set aside', dialog)!.disabled).toBe(true)
  await type(dialog.querySelector('input')!, '  Stall hire ')
  writes.setAside.mockResolvedValue({})
  await click(button('Set aside', dialog))
  expect(writes.setAside).toHaveBeenCalledWith(outside, 'Stall hire')
  expect(byTestId('set-aside-done')).toContain('Set aside')

  // The lists as the server now has them.
  const held = {
    ...outside,
    matchVersion: 2,
    dismissed: 'Stall hire',
    dismissedAt: Date.UTC(2026, 10, 21),
  }
  queue = []
  aside = [held]
  await queuePage()
  expect(byTestId('card-queue-empty')).toBe('Nothing to match.')
  expect(byTestId('set-aside-reason')).toContain(
    'Stall hire · set aside 21 Nov 2026',
  )
  writes.putBack.mockResolvedValue({})
  await click(button('Put back'))
  expect(writes.putBack).toHaveBeenCalledWith(held)
  // Still listed as set aside until the list read again says otherwise.
  expect(
    el.querySelectorAll('[data-testid="cards-set-aside"] > li'),
  ).toHaveLength(1)
})

test('a group that doesn’t claim Gift Aid isn’t shown "Not ticked", but a tick a donor made is still evidence', async () => {
  giftAidSwitch.on = false
  queue = [
    payment({
      donor: {
        ...payment().donor!,
        giftAid: false,
        addressLine1: '',
        postcode: '',
      },
    }),
    payment({ id: 'p2', paymentId: 'pi_2' }),
  ]
  await queuePage()
  const rows = [...el.querySelectorAll('[data-testid="card-queue"] > li')]
  expect(rows[0].textContent).not.toContain('Gift Aid')
  expect(rows[1].textContent).toContain('Ticked, from 12 High Street')
})

test('the set-aside list offers the older ones while the server has more', async () => {
  aside = [
    payment({
      id: 'p9',
      paymentId: 'pi_9',
      reason: 'no_submission',
      donor: null,
      dismissed: 'Ticket',
      dismissedAt: 1,
    }),
  ]
  await queuePage()
  expect(button('Show older ones')).toBeUndefined()
  moreAside = true
  await queuePage()
  await click(button('Show older ones'))
  expect(loadMore).toHaveBeenCalledOnce()
})

test('the donation page: another admin’s save never replaces what is being typed; it is said, with their version on offer', async () => {
  await settings()
  // Nothing typed: the form simply follows the server.
  page = { ...PAGE, amounts: [1100n, 2500n, 5000n], version: 5 }
  await settings()
  expect(input('amounts.0').value).toBe('11.00')
  expect(byTestId('page-changed')).toBeUndefined()

  // Half way through new amounts when the other admin saves again.
  await type(input('amounts.0'), '17')
  page = { ...PAGE, amounts: [1200n, 2500n, 5000n], version: 6 }
  await settings()
  expect(input('amounts.0').value).toBe('17')
  expect(byTestId('page-changed')).toContain(
    'Another admin saved the donation page while you were editing',
  )
  // Their version, when asked for.
  await click(button('Load their version'))
  expect(input('amounts.0').value).toBe('12.00')
  expect(byTestId('page-changed')).toBeUndefined()
})
