// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../lib/domain/ids'
import type { GiftView as Gift } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'

// The gift page (cash gifts step 5): someone else's edit while the form is
// open merges in field by field and moves `expected`, so typed changes
// survive and Save goes through; Void and Unvoid each confirm first.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ slug: 'a', giftId: 'g1' }),
  }),
  Link: ({
    children,
    params,
    ...rest
  }: {
    children: ReactNode
    params?: Record<string, string>
  }) => (
    <a data-claim={params?.claimId} {...rest}>
      {children}
    </a>
  ),
}))

const mutations: Record<string, ReturnType<typeof vi.fn>> = {
  save: vi.fn(),
  setStatus: vi.fn(),
}
let gift: Gift
const nameChecked = vi.fn()
let members: Array<{ userId: string; name: string }> | undefined
let claimList: Array<{ id: string; number: number; status: string }> | undefined
vi.mock('../lib/data', () => ({
  FEATURES: { giftAidClaims: true },
  useClaims: (enabled: boolean) => ({
    data: enabled ? claimList : undefined,
  }),
  useGift: () => gift,
  useMembers: () => members,
  useDeclarations: () => ({ declarations: [], currentId: null }),
  useGiftWrites: () => mutations,
  useNameChecked: () => nameChecked,
  useBatch: (id: string | null) => ({
    data: id === null ? undefined : { batch: { status: batchStatus } },
  }),
}))
let batchStatus: 'open' | 'closed' = 'open'
vi.mock('../components/contact-history', () => ({
  useHistoryMoments: () => ({ moments: [], loading: false, error: null }),
  MomentList: () => null,
}))
vi.mock('../components/source-code-picker', () => ({
  SourceCodePicker: ({ value }: { value: { code: string } | null }) => (
    <span data-testid="picker">{value?.code}</span>
  ),
  localToday: () => '2026-10-23',
}))
let admin = true
/** "We claim Gift Aid" (Settings): a test switches it off to see what hides. */
const giftAidSwitch = vi.hoisted(() => ({ on: true }))
vi.mock('../lib/tenant', () => ({
  // On, as every group is unless it says otherwise.
  claimsGiftAid: () => giftAidSwitch.on,
  useClaimsGiftAid: () => giftAidSwitch.on,
  useTenant: () => ({ _id: 'tenantA', slug: 'a' }),
  useCanWrite: () => true,
  useIsAdmin: () => admin,
}))

const { Route } = await import('./t.$slug.gifts.$giftId')
const GiftPage = (Route as unknown as { options: { component: ComponentType } })
  .options.component

function makeGift(over: Partial<Gift> = {}): Gift {
  return {
    _id: 'g1' as Id<'contributions'>,
    _creationTime: 0,
    contactId: 'c1' as Id<'contacts'>,
    contact: { kind: 'individual', displayName: 'Jo Bloggs' },
    receivedOn: '2026-10-01',
    amount: 2000n,
    method: 'cash',
    status: 'completed',
    voidReason: null,
    claimId: null,
    giftVersion: 1,
    statusVersion: 0,
    enteredBy: 1,
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
  members = [{ userId: '1', name: 'Jo Staff' }]
  claimList = [{ id: 'claim7', number: 7, status: 'submitted' }]
  admin = true
  batchStatus = 'open'
  nameChecked.mockReset().mockResolvedValue(undefined)
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

const render = () => act(() => root.render(<GiftPage />))
const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === name)!
const click = (b: HTMLElement) => act(async () => b.click())
async function type(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const set = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
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
  expect(mutations.save).toHaveBeenCalledWith(
    2,
    expect.objectContaining({ receivedOn: '2026-10-05', amount: 2500n }),
  )
})

test('a save refused as stale keeps the typed changes and retries once their version arrives', async () => {
  render()
  await click(button(el, 'Edit'))
  await type(input('Amount'), '25')
  const save = mutations.save
  save.mockRejectedValueOnce(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'giving.gift',
      counter: 2,
      current: {},
    }),
  )
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
    2,
    expect.objectContaining({ method: 'card', amount: 2500n }),
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
  expect(mutations.save).not.toHaveBeenCalled()
})

test('"12 50" is asked about, never saved as £1,250 (as on the record page)', async () => {
  render()
  await click(button(el, 'Edit'))
  await type(input('Amount'), '12 50')
  await act(async () => form().requestSubmit())
  expect(form().querySelector('[role="alert"]')?.textContent).toBe(
    'Is that pounds and pence? Write it like 12.50, with no spaces',
  )
  await type(input('Amount'), '90071992547409.92')
  await act(async () => form().requestSubmit())
  expect(form().querySelector('[role="alert"]')?.textContent).toBe(
    'That amount is too large',
  )
  expect(mutations.save).not.toHaveBeenCalled()
})

test('Unvoid confirms first, as Void does', async () => {
  gift = makeGift({ status: 'void', statusVersion: 3 })
  render()
  await click(button(el, 'Unvoid'))
  const setStatus = mutations.setStatus
  expect(setStatus).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('Unvoid this gift?')
  await click(button(dialog, 'Unvoid'))
  expect(setStatus).toHaveBeenCalledWith(3, 'completed', undefined)
})

// G3: a gift in a Gift Aid claim.

const dialog = () => document.querySelector('[role="alertdialog"]')!
const badge = () => el.querySelector('[data-testid="claim-badge"]')

test('a claimed gift says which claim (a link, for an admin) and why it is locked', async () => {
  gift = makeGift({ claimId: 'claim7' })
  render()
  expect(badge()?.textContent).toBe('Claimed in claim 7')
  expect(badge()?.getAttribute('data-claim')).toBe('claim7')
  expect(el.querySelector('[data-testid="claim-lock"]')?.textContent).toContain(
    'its amount, date and donor can’t change',
  )
  await click(button(el, 'Edit'))
  expect(form().textContent).toContain(
    'This gift is in a Gift Aid claim: its amount and date can’t change.',
  )
})

test('staff see that a gift is claimed, without the claim (the claims are admin only)', () => {
  admin = false
  gift = makeGift({ claimId: 'claim7' })
  render()
  expect(badge()?.textContent).toBe('Claimed for Gift Aid')
})

test('voiding a claimed gift needs a reason, and sends it', async () => {
  gift = makeGift({ claimId: 'claim7', statusVersion: 4 })
  render()
  await click(button(el, 'Void'))
  expect(dialog().textContent).toContain(
    'the next claim pays its Gift Aid back',
  )
  const confirm = button(dialog(), 'Void')
  expect(confirm.disabled).toBe(true)
  const box = dialog().querySelector('textarea')!
  await type(box, '  Entered twice ')
  expect(confirm.disabled).toBe(false)
  await click(confirm)
  expect(mutations.setStatus).toHaveBeenCalledWith(4, 'void', 'Entered twice')
})

test('an unclaimed gift voids with an optional reason', async () => {
  render()
  await click(button(el, 'Void'))
  expect(dialog().textContent).toContain('Reason (optional)')
  await click(button(dialog(), 'Void'))
  expect(mutations.setStatus).toHaveBeenCalledWith(0, 'void', undefined)
})

test('a claimed gift voided since: its reason shows, and it has no Unvoid', () => {
  gift = makeGift({
    claimId: 'claim7',
    status: 'void',
    voidReason: 'Entered twice',
  })
  render()
  expect(el.querySelector('[data-testid="void-reason"]')?.textContent).toBe(
    ' Why: Entered twice',
  )
  expect(button(el, 'Unvoid')).toBeUndefined()
  expect(el.querySelector('[data-testid="claim-lock"]')?.textContent).toContain(
    'can’t be un-voided',
  )
})

test('the server’s refusal of a claimed gift’s void is shown as it says it', async () => {
  gift = makeGift({ claimId: 'claim7' })
  mutations.setStatus.mockRejectedValue(
    new RustApiError(422, {
      kind: 'rejected',
      reason: 'void_reason_required',
      message: 'This gift is in a Gift Aid claim: say why it is void.',
    }),
  )
  render()
  await click(button(el, 'Void'))
  await type(dialog().querySelector('textarea')!, 'x')
  await click(button(dialog(), 'Void'))
  expect(el.querySelector('[role="alert"]')?.textContent).toBe(
    'This gift is in a Gift Aid claim: say why it is void.',
  )
})

test('a gift voided out of a draft claim: the draft is held back, no repayment promised', async () => {
  claimList = [{ id: 'claim7', number: 7, status: 'draft' }]
  gift = makeGift({ claimId: 'claim7' })
  render()
  await click(button(el, 'Void'))
  expect(dialog().textContent).toContain(
    'It is in draft claim 7: it stays on record but counts for nothing, and that claim can’t be marked ready until it’s deleted',
  )
  expect(dialog().textContent).not.toContain('pays its Gift Aid back')
  await act(async () => root.unmount())
  root = createRoot(el)
  gift = makeGift({ claimId: 'claim7', status: 'void', voidReason: 'x' })
  render()
  const lock = el.querySelector('[data-testid="claim-lock"]')!.textContent
  expect(lock).toContain('Voided while claim 7 is a draft')
  expect(lock).toContain('deleting it lets this gift go')
})

test('staff, who can’t see the claim, are told both cases', () => {
  admin = false
  gift = makeGift({ claimId: 'claim7', status: 'void' })
  render()
  expect(el.querySelector('[data-testid="claim-lock"]')?.textContent).toBe(
    'Voided while in a Gift Aid claim: it can’t be un-voided while the claim holds it. If the claim has gone to HMRC, the next claim pays the tax back.',
  )
})

// ADR 0025: every payment attempt is a gift; one that isn't money
// received shows as what it is, never as money in.

test('a pending Direct Debit gift shows as pending, struck through, not claimable yet', () => {
  gift = makeGift({
    method: 'direct_debit',
    status: 'pending',
    provider: 'gocardless',
    voidReason: 'Not collected yet (GoCardless)',
  })
  render()
  const status = el.querySelector('[data-testid="gift-status"]')!
  expect(status.textContent).toBe('pending')
  expect(el.querySelector('h1 .line-through')?.textContent).toBe('£20.00')
  expect(el.textContent).toContain('Pending: not collected yet.')
  expect(el.querySelector('[data-testid="gift-coverage"]')?.textContent).toBe(
    'None until the money is received',
  )
})

test('a charged-back gift says so and why; staff may still void it', async () => {
  gift = makeGift({
    method: 'direct_debit',
    status: 'charged_back',
    provider: 'gocardless',
    voidReason: 'Charged back (GoCardless): disputed',
    statusVersion: 4,
  })
  render()
  expect(el.querySelector('[data-testid="gift-status"]')?.textContent).toBe(
    'charged back',
  )
  expect(el.querySelector('[data-testid="void-reason"]')?.textContent).toBe(
    ' Why: Charged back (GoCardless): disputed',
  )
  expect(button(el, 'Unvoid')).toBeUndefined()
  await click(button(el, 'Void'))
  expect(dialog().textContent).toContain('Void this gift?')
})

test('unvoiding a provider gift gives it its payment’s status', async () => {
  gift = makeGift({
    method: 'direct_debit',
    status: 'void',
    provider: 'gocardless',
    statusVersion: 2,
  })
  render()
  await click(button(el, 'Unvoid'))
  expect(dialog().textContent).toContain('It takes its payment’s status again')
})

// Bank transfers 6b: the bank methods by hand.

test('a transfer by hand says it is not on a statement yet', () => {
  gift = makeGift({ method: 'bank_transfer', notOnAStatement: true })
  render()
  expect(el.querySelector('[data-testid="gift-bank-note"]')?.textContent).toBe(
    'Not on a statement yet: it counts, and no statement line is matched to it so far.',
  )
  expect(button(el, 'Mark bounced')).toBeUndefined()
})

test('a cheque outside a batch: mark it cleared, or bounced, confirmed first', async () => {
  gift = makeGift({ method: 'cheque', status: 'pending', statusVersion: 1 })
  render()
  expect(el.querySelector('[data-testid="gift-bank-note"]')?.textContent).toBe(
    'Pending until it clears: mark it cleared once the bank has the money.',
  )
  await click(button(el, 'Mark cleared'))
  expect(dialog().textContent).toContain('Mark this cheque cleared?')
  await click(button(dialog(), 'Mark cleared'))
  expect(mutations.setStatus).toHaveBeenCalledWith(1, 'completed', undefined)
  await click(button(el, 'Mark bounced'))
  expect(dialog().textContent).toContain('Mark this cheque bounced?')
  await click(button(dialog(), 'Mark bounced'))
  expect(mutations.setStatus).toHaveBeenLastCalledWith(1, 'failed', undefined)
})

test('a cheque in a batch clears with its batch: no Mark cleared, and a link to it', () => {
  gift = makeGift({
    method: 'cheque',
    status: 'pending',
    payingInBatchId: 'b1',
  })
  render()
  expect(el.querySelector('[data-testid="gift-bank-note"]')?.textContent).toBe(
    'Pending until its paying-in batch is matched to a statement line.',
  )
  expect(button(el, 'Mark cleared')).toBeUndefined()
  expect(button(el, 'Mark bounced')).toBeDefined()
  expect(el.textContent).toContain('See the batch')
})

test('a gift in a closed batch holds Edit and Void, and says to reopen it; a cheque still bounces', () => {
  gift = makeGift({
    method: 'cheque',
    status: 'pending',
    payingInBatchId: 'b1',
  })
  batchStatus = 'closed'
  render()
  expect(el.querySelector('[data-testid="gift-slip-held"]')?.textContent).toBe(
    'In a closed paying-in batch: reopen it first to edit or void this gift.',
  )
  expect(button(el, 'Edit').disabled).toBe(true)
  expect(button(el, 'Void').disabled).toBe(true)
  expect(button(el, 'Mark bounced').disabled).toBe(false)
})

test('a gift in an open batch can be edited and voided', () => {
  gift = makeGift({ payingInBatchId: 'b1' })
  render()
  expect(el.querySelector('[data-testid="gift-slip-held"]')).toBeNull()
  expect(button(el, 'Edit').disabled).toBe(false)
  expect(button(el, 'Void').disabled).toBe(false)
})

// ── a card gift from the donation page (Stripe S5) ────────────────────────

const cardGift = (card: Partial<NonNullable<Gift['card']>> = {}) =>
  makeGift({
    method: 'card',
    provider: 'stripe',
    providerPaymentId: 'pi_1',
    card: {
      id: 'p1',
      paymentId: 'pi_1',
      amount: 2000n,
      refundedAmount: 0n,
      dispute: null,
      fromPage: true,
      firstNameTyped: null,
      partialRefundClaimed: false,
      declarationRefused: null,
      matchVersion: 3,
      ...card,
    },
  })

test('a card gift says it came from the donation page, and a gift by hand has no card section', async () => {
  await render()
  expect(el.querySelector('[data-testid="gift-card"]')).toBeNull()
  expect(el.textContent).toContain('Cash')

  gift = cardGift({ refundedAmount: 500n })
  await render()
  const card = el.querySelector('[data-testid="gift-card"]')!
  expect(card.textContent).toContain('Given by card on the donation page')
  expect(card.textContent).toContain('pi_1')
  expect(card.textContent).toContain('£5.00 of £20.00 refunded')
  // Not "Card (separate reader)": that is a gift keyed in by staff.
  expect(el.textContent).toContain('Card (donation page)')
  expect(el.textContent).not.toContain('separate reader')
  expect(el.querySelector('[data-testid="card-first-name"]')).toBeNull()
})

test('first name differs: the typed name is shown, and "Name checked" clears it only on the server’s word', async () => {
  gift = cardGift({ firstNameTyped: 'Jane' })
  await render()
  const mark = () => el.querySelector('[data-testid="card-first-name"]')
  expect(mark()!.textContent).toContain(
    'the donor typed “Jane”, and this contact is Jo Bloggs',
  )
  // What staff can do today, said plainly; the move isn't built.
  expect(mark()!.textContent).toContain('void it with a reason')
  expect(mark()!.textContent).toContain('isn’t built yet')
  const check = [...mark()!.querySelectorAll('button')][0]
  expect(check.textContent).toBe('Name checked: it’s the right person')

  // Refused (someone else changed it): said, and the mark stays.
  nameChecked.mockRejectedValueOnce(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'giving.stripePaymentMatch',
      counter: 4,
      current: null,
    } as never),
  )
  await click(check)
  expect(nameChecked).toHaveBeenLastCalledWith('p1', 3)
  expect(el.querySelector('[role="alert"]')!.textContent).toContain(
    'Someone else changed this gift’s payment just now',
  )
  expect(mark()).not.toBeNull()

  // Accepted: still shown until the gift itself reads without it (never
  // optimistic); then gone.
  await click([...mark()!.querySelectorAll('button')][0])
  expect(nameChecked).toHaveBeenCalledTimes(2)
  expect(mark()).not.toBeNull()
  gift = cardGift()
  await render()
  expect(mark()).toBeNull()
})

test('a refused declaration and a part refund on a claimed gift are said plainly', async () => {
  gift = cardGift({
    declarationRefused: 'not_individual',
    partialRefundClaimed: true,
    refundedAmount: 500n,
  })
  await render()
  expect(
    el.querySelector('[data-testid="card-declaration-refused"]')!.textContent,
  ).toContain('this contact isn’t a person, so no declaration was recorded')
  expect(
    el.querySelector('[data-testid="card-partial-refund"]')!.textContent,
  ).toContain('the group kept £15.00')
})

test('a group that doesn’t claim Gift Aid sees no coverage and no declaration note on a gift', async () => {
  await render()
  expect(el.querySelector('[data-testid="gift-coverage"]')).not.toBeNull()
  giftAidSwitch.on = false
  gift = cardGift({ declarationRefused: 'not_individual' })
  await render()
  expect(el.querySelector('[data-testid="gift-coverage"]')).toBeNull()
  expect(el.textContent).not.toContain('Gift Aid')
  expect(
    el.querySelector('[data-testid="card-declaration-refused"]'),
  ).toBeNull()
  // The card section itself stays: it is about the payment.
  expect(el.querySelector('[data-testid="gift-card"]')).not.toBeNull()
})
