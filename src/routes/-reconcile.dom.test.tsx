// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  BankSuggestion,
  LineDetail,
  LineWithSuggestions,
  StatementLine,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'

// Bank transfers 6b part 2: reconcile and a line. Strong suggestions
// pre-ticked, a name never; "Accept ticked" applies only what is ticked
// and shows only the server's answer, a line matched meanwhile said so;
// a split adds up to the line as you type; unmatch says what it does;
// rules; a contact's remembered payers. Never optimistic.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let role: 'admin' | 'staff' | 'viewer' = 'staff'
let lines: Array<LineWithSuggestions> = []
let detail: LineDetail | undefined
let payers: Array<object> = []
let rules: Array<object> = []
let closedBatches: Array<object> = []
const writes = {
  gifts: vi.fn(),
  matchGifts: vi.fn(),
  matchBatch: vi.fn(),
  notDonation: vi.fn(),
  unmatch: vi.fn(),
  accept: vi.fn(),
}
const ruleWrites = { create: vi.fn(), remove: vi.fn() }
const forget = vi.fn()
vi.mock('../lib/data', () => ({
  useBankAccounts: () => ({
    data: [{ id: 'acc1', name: 'CAF current', active: true }],
  }),
  useLines: () => ({ data: lines, error: null, refetch: vi.fn() }),
  useLine: () => ({ data: detail, error: null }),
  useMatchWrites: () => writes,
  useHandTransfers: () => ({ data: [] }),
  useBatches: () => ({ data: closedBatches }),
  useRules: () => ({ data: rules, error: null }),
  useRuleWrites: () => ruleWrites,
  usePayers: () => ({ data: payers }),
  useDonor: () => undefined,
  useForgetPayers: () => forget,
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha', role }),
  useIsAdmin: () => role === 'admin',
  useCanWrite: () => role !== 'viewer',
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ slug: 'alpha', lineId: 'l1' }),
    useSearch: () => ({}),
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
// The record form is its own (standing-orders.dom.test.tsx): here, what
// the line page opens it with.
let opened: Record<string, unknown> | null = null
vi.mock('../components/standing-orders', () => ({
  RecordStandingOrderDialog: (props: Record<string, unknown>) => {
    opened = props
    return <div data-testid="standing-order-dialog" />
  },
}))
vi.mock('../components/source-code-picker', () => ({
  SourceCodePicker: () => null,
  localToday: () => '2026-11-05',
}))

const line = (over: Partial<StatementLine> = {}): StatementLine => ({
  id: 'l1',
  accountId: 'acc1',
  importId: 'i1',
  postedOn: '2026-11-03',
  amount: 6000n,
  payer: 'J BLOGGS',
  reference: '100016',
  narrative: 'J BLOGGS 100016',
  bankId: null,
  state: 'unmatched',
  note: null,
  matchedBy: null,
  matchedAt: null,
  matchVersion: 2,
  ...over,
})

const suggestion = (over: Partial<BankSuggestion> = {}): BankSuggestion => ({
  lineId: 'l1',
  proposal: { kind: 'newGift', contactId: 'c1' },
  contactId: 'c1',
  contactName: 'Jo Bloggs',
  confidence: 'strong',
  reason: 'contact no. 100016 in the reference',
  suggesters: ['contactNumber'],
  ticked: true,
  ...over,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of [
    ...Object.values(writes),
    ...Object.values(ruleWrites),
    forget,
  ])
    f.mockReset()
  role = 'staff'
  lines = []
  detail = undefined
  payers = []
  rules = []
  closedBatches = []
  opened = null
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
const reconcile = () => render(import('./t.$slug.bank.reconcile'))
const linePage = () => render(import('./t.$slug.bank.lines.$lineId'))
const button = (name: string | RegExp, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll('button')].find((b) =>
    typeof name === 'string'
      ? b.textContent === name
      : name.test(b.textContent),
  )
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
const labelled = (text: string) =>
  [...el.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(text))!
    .querySelector('input')!

test('viewers never see statement lines', async () => {
  role = 'viewer'
  await reconcile()
  expect(el.textContent).toBe('Bank statements are for staff and admins.')
  act(() => root.unmount())
  root = createRoot(el)
  await linePage()
  expect(el.textContent).toBe('Bank statements are for staff and admins.')
})

test('strong is pre-ticked, a name never; accept sends only what is ticked', async () => {
  lines = [
    { ...line(), suggestions: [suggestion()] },
    {
      ...line({ id: 'l2', matchVersion: 0, payer: 'A JONES' }),
      suggestions: [
        suggestion({
          lineId: 'l2',
          proposal: { kind: 'newGift', contactId: 'c2' },
          contactName: 'Ann Jones',
          confidence: 'suggested',
          reason: 'the payer’s name only',
          ticked: false,
        }),
      ],
    },
    {
      ...line({ id: 'l3', matchVersion: 5 }),
      suggestions: [
        suggestion({
          lineId: 'l3',
          proposal: { kind: 'notDonation', ruleId: 'r1', note: 'A payout' },
          contactId: null,
          contactName: null,
          reason: 'narrative contains GOCARDLESS',
        }),
      ],
    },
  ]
  let answer!: (v: unknown) => void
  writes.accept.mockReturnValue(new Promise((r) => (answer = r)))
  await reconcile()
  const boxes = [
    ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ]
  expect(boxes.map((b) => b.checked)).toEqual([true, false, true])
  expect(el.textContent).toContain('the payer’s name only')
  // Unticking one leaves it out.
  await act(async () => boxes[2].click())
  await click(button('Accept ticked (1)'))
  expect(writes.accept).toHaveBeenCalledWith([
    {
      lineId: 'l1',
      expected: 2,
      proposal: { kind: 'newGift', contactId: 'c1' },
    },
  ])
  // In flight: disabled, nothing claimed.
  expect(button('Accepting…')?.disabled).toBe(true)
  expect(byTestId('accept-summary')).toBeUndefined()
  await act(async () =>
    answer([
      {
        lineId: 'l1',
        ok: false,
        status: 409,
        error: {
          kind: 'stale',
          contract: 'banking.lineMatch',
          counter: 3,
          current: {},
        },
      },
    ]),
  )
  expect(byTestId('accept-summary')).toBe(
    '0 matched, 1 not: changed meanwhile, reload',
  )
  expect(byTestId('line-outcome')).toBe(
    'Changed meanwhile: someone else matched it. Reload to see.',
  )
})

test('a split adds up to the line as you type; the rest needs a note', async () => {
  detail = { line: line(), gifts: [], batchId: null, suggestions: [] }
  writes.gifts.mockResolvedValue({})
  await linePage()
  expect(byTestId('split-sum')).toBe('The gifts add up to the line, £60.00.')
  // A new person from the payer, then a second gift for someone found.
  await click(button(/^A new person from the payer/))
  expect(labelled('First name').value).toBe('J')
  expect(labelled('Last name').value).toBe('Bloggs')
  await setInput(labelled('Amount (£)'), '40')
  expect(byTestId('split-sum')).toBe(
    '£20.00 of the line is left: it isn’t a donation.',
  )
  await click(button('Split: add another gift'))
  await click(button('Find Dee'))
  const amounts = [...el.querySelectorAll('label')]
    .filter((l) => l.textContent.startsWith('Amount (£)'))
    .map((l) => l.querySelector('input')!)
  expect(amounts[1].value).toBe('20.00')
  await setInput(amounts[1], '15')
  // The rest's problem is beside its field.
  const rest = labelled('What the rest is')
  expect(rest.getAttribute('aria-invalid')).toBe('true')
  expect(
    document.getElementById(rest.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('Say what the rest of the line is (it isn’t a donation)')
  expect(button('Make these gifts')?.disabled).toBe(true)
  await setInput(labelled('What the rest is'), 'Raffle tickets')
  await click(button('Make these gifts'))
  expect(writes.gifts).toHaveBeenCalledWith(
    'l1',
    2,
    [
      {
        contact: {
          kind: 'individual',
          firstName: 'J',
          lastName: 'Bloggs',
          name: '',
        },
        amount: 4000n,
      },
      { contact: 'c7', amount: 1500n },
    ],
    { amount: 500n, note: 'Raffle tickets' },
  )
  // Over the line is said and blocked.
  await setInput(amounts[1], '30')
  expect(byTestId('split-sum')).toBe('The gifts are £10.00 more than the line.')
})

test('a line matched meanwhile is said so; not a donation needs a note', async () => {
  detail = { line: line(), gifts: [], batchId: null, suggestions: [] }
  writes.notDonation.mockRejectedValue(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'banking.lineMatch',
      counter: 3,
      current: {},
    }),
  )
  await linePage()
  await click(button('Not a donation'))
  // Focus goes to the form's heading.
  expect(document.activeElement?.textContent).toBe('Not a donation')
  expect(button('Mark not a donation')?.disabled).toBe(true)
  await setInput(labelled('What it is'), 'A grant')
  await click(button('Mark not a donation'))
  expect(writes.notDonation).toHaveBeenCalledWith('l1', 2, 'A grant')
  expect(el.querySelector('[role="alert"]')?.textContent).toBe(
    'Changed meanwhile: someone else matched this line. It has been read again.',
  )
})

test('unmatch says what it does, then runs against the line’s version', async () => {
  detail = {
    line: line({ state: 'matched', matchVersion: 4 }),
    gifts: [
      {
        id: 'g1',
        contactId: 'c1',
        contactName: 'Jo Bloggs',
        receivedOn: '2026-11-03',
        amount: 4000n,
        status: 'completed',
        fromLine: true,
      },
      {
        id: 'g2',
        contactId: 'c2',
        contactName: 'Dee Donor',
        receivedOn: '2026-11-01',
        amount: 2000n,
        status: 'completed',
        fromLine: false,
      },
    ],
    batchId: null,
    suggestions: [],
  }
  writes.unmatch.mockResolvedValue({})
  await linePage()
  expect(el.textContent).toContain('made from the line')
  expect(el.textContent).toContain('entered by hand')
  await click(button('Unmatch'))
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('The gift made from it is voided.')
  expect(dialog.textContent).toContain(
    'The gift entered by hand is unlinked: “not on a statement yet” again.',
  )
  expect(dialog.textContent).toContain('the next claim repays it')
  expect(writes.unmatch).not.toHaveBeenCalled()
  await click(button('Unmatch', dialog))
  expect(writes.unmatch).toHaveBeenCalledWith('l1', 4)
})

test('rules: added with the field, text and note; deleted after asking', async () => {
  rules = [
    {
      id: 'r1',
      version: 2,
      accountId: null,
      field: 'narrative',
      contains: 'GOCARDLESS',
      note: 'A payout',
      active: true,
    },
  ]
  ruleWrites.create.mockResolvedValue({})
  ruleWrites.remove.mockResolvedValue({})
  await render(import('./t.$slug.bank.rules'))
  expect(el.textContent).toContain(
    'The description contains “GOCARDLESS”, on every account — A payout',
  )
  await setInput(labelled('contains'), 'INTEREST')
  await setInput(labelled('It is'), 'Bank interest')
  await click(button('Add the rule'))
  expect(ruleWrites.create).toHaveBeenCalledWith({
    accountId: null,
    field: 'narrative',
    contains: 'INTEREST',
    note: 'Bank interest',
  })
  await click(button('Delete'))
  await click(button('Delete', document.querySelector('[role="alertdialog"]')!))
  expect(ruleWrites.remove).toHaveBeenCalledWith('r1', 2)
})

test('a contact’s payer details are listed for staff and forgotten after asking', async () => {
  payers = [
    {
      accountId: 'acc1',
      contactId: 'c1',
      payer: 'J BLOGGS',
      reference: 'GIFT',
      lastLineId: 'l1',
      matchedAt: 0,
      accountName: 'CAF current',
    },
  ]
  forget.mockResolvedValue([])
  const { BankPayers } = await import('../components/bank-payers')
  await act(async () => root.render(<BankPayers contactId="c1" />))
  expect(el.textContent).toContain('J BLOGGSGIFTCAF current')
  await click(button('Forget these payer details'))
  await click(button('Forget', document.querySelector('[role="alertdialog"]')!))
  expect(forget).toHaveBeenCalled()
  act(() => root.unmount())
  root = createRoot(el)
  role = 'viewer'
  await act(async () => root.render(<BankPayers contactId="c1" />))
  expect(el.textContent).toBe('')
})

test('a tick follows its suggestion through a refetch, and goes when it does', async () => {
  const jo = suggestion({ ticked: false })
  const sam = suggestion({
    proposal: { kind: 'newGift', contactId: 'c2' },
    contactId: 'c2',
    contactName: 'Sam Smith',
    ticked: false,
    reason: 'a known payer',
  })
  lines = [{ ...line(), suggestions: [jo, sam] }]
  writes.accept.mockResolvedValue([])
  await reconcile()
  const box = (name: string) =>
    [...el.querySelectorAll('label')]
      .find((l) => l.textContent.includes(name))!
      .querySelector('input')!
  await act(async () => box('Sam Smith').click())
  // A colleague's match elsewhere adds a suggestion ranked first.
  const first = suggestion({
    proposal: { kind: 'existingGifts', giftIds: ['g9'] },
    contactId: 'c3',
    contactName: 'Al New',
    ticked: false,
  })
  lines = [{ ...line(), suggestions: [first, jo, sam] }]
  await reconcile()
  expect(box('Sam Smith').checked).toBe(true)
  expect(box('Jo Bloggs').checked).toBe(false)
  await click(button('Accept ticked (1)'))
  expect(writes.accept).toHaveBeenLastCalledWith([
    {
      lineId: 'l1',
      expected: 2,
      proposal: { kind: 'newGift', contactId: 'c2' },
    },
  ])
  // Sam's suggestion gone (a transfer recorded by hand elsewhere): no tick.
  lines = [{ ...line(), suggestions: [first, jo] }]
  await reconcile()
  expect(button('Accept ticked (0)')?.disabled).toBe(true)
})

test('a name alone can’t be ticked for Accept ticked, only matched by hand', async () => {
  lines = [
    {
      ...line(),
      suggestions: [
        suggestion({
          confidence: 'suggested',
          suggesters: ['nameOnly'],
          reason: 'the payer’s name only',
          ticked: true,
        }),
      ],
    },
  ]
  await reconcile()
  expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect(byTestId('name-only')).toContain(
    'A name alone is never accepted in bulk',
  )
  expect(button('Accept ticked (0)')?.disabled).toBe(true)
})

const instalment = suggestion({
  proposal: {
    kind: 'instalment',
    regularGiftId: 'r1',
    scheduledOn: '2026-11-05',
  },
  reason: 'J BLOGGS paid it before; reference SMITH123 matches',
  suggesters: ['standingOrder'],
})
const offer = suggestion({
  proposal: {
    kind: 'newStandingOrder',
    contactId: 'c1',
    frequency: 'monthly',
    dayOfMonth: 3,
    month: null,
  },
  confidence: 'suggested',
  reason: 'Jo Bloggs gave £60.00 a month ago',
  suggesters: ['standingOrderOffer'],
  ticked: false,
})

test('a line: a standing order’s payment says which and why, and is used as it is', async () => {
  detail = {
    line: line(),
    gifts: [],
    batchId: null,
    suggestions: [instalment],
  }
  writes.accept.mockResolvedValue([{ lineId: 'l1', ok: true, line: detail }])
  await linePage()
  const shown = el.querySelector('[aria-label="Suggestions"] li')!.textContent
  expect(shown).toContain('Jo Bloggs’s standing order payment due 5 Nov 2026')
  expect(shown).toContain('J BLOGGS paid it before; reference SMITH123 matches')
  expect(shown).toContain('strong')
  await click(button('Use this'))
  expect(writes.accept).toHaveBeenCalledWith([
    { lineId: 'l1', expected: 2, proposal: instalment.proposal },
  ])
})

test('the offer to make a standing order opens the record form on the line, never accept', async () => {
  detail = {
    line: line(),
    gifts: [],
    batchId: null,
    suggestions: [offer],
  }
  await linePage()
  const shown = el.querySelector('[aria-label="Suggestions"] li')!.textContent
  expect(shown).toContain('Make this a standing order for Jo Bloggs')
  expect(shown).toContain('Jo Bloggs gave £60.00 a month ago')
  expect(button('Use this')).toBeUndefined()
  expect(byTestId('standing-order-dialog')).toBeUndefined()
  await click(button('Set it up…'))
  expect(writes.accept).not.toHaveBeenCalled()
  expect(byTestId('standing-order-dialog')).toBe('')
  // Line mode: the line's amount and date; the offer's frequency; no
  // reference (staff type one; the line's is never taken for it).
  expect(opened).toMatchObject({
    contactId: 'c1',
    prefill: { frequency: 'monthly' },
    line: { id: 'l1', matchVersion: 2, amount: 6000n, postedOn: '2026-11-03' },
  })
  expect(Object.keys(opened!.prefill as object)).toEqual(['frequency'])
  await act(async () => (opened!.onClose as () => void)())
  expect(byTestId('standing-order-dialog')).toBeUndefined()
})

test('a match from a suggestion is announced: the line’s state is a status', async () => {
  detail = { line: line(), gifts: [], batchId: null, suggestions: [instalment] }
  const matched: LineDetail = {
    ...detail,
    line: line({ state: 'matched', matchVersion: 3 }),
    suggestions: [],
  }
  writes.accept.mockImplementation(() => {
    // The answer comes with the refetch: the line is read back matched.
    detail = matched
    return Promise.resolve([{ lineId: 'l1', ok: true, line: matched }])
  })
  await linePage()
  await click(button('Use this'))
  await linePage()
  const state = el.querySelector('[data-testid="line-state"]')!
  expect(state.getAttribute('role')).toBe('status')
  expect(state.textContent).toBe('Matched.')
  expect(byTestId('line-notice')).toBeUndefined()
})

test('a 409 is still said once the refetch shows someone else’s match', async () => {
  detail = { line: line(), gifts: [], batchId: null, suggestions: [instalment] }
  writes.accept.mockImplementation(() => {
    detail = {
      line: line({ state: 'matched', matchVersion: 3 }),
      gifts: [],
      batchId: null,
      suggestions: [],
    }
    return Promise.resolve([
      { lineId: 'l1', ok: false, status: 409, error: null },
    ])
  })
  await linePage()
  await click(button('Use this'))
  await linePage()
  expect(byTestId('line-state')).toBe('Matched.')
  expect(byTestId('line-notice')).toContain('someone else matched this line')
})

test('the record form outlives the refetch, on the line as it was opened', async () => {
  detail = { line: line(), gifts: [], batchId: null, suggestions: [offer] }
  await linePage()
  await click(button('Set it up…'))
  // Matched meanwhile (or by this save): the form stays to say which.
  detail = {
    line: line({ state: 'matched', matchVersion: 3 }),
    gifts: [],
    batchId: null,
    suggestions: [],
  }
  await linePage()
  expect(byTestId('line-state')).toBe('Matched.')
  expect(byTestId('standing-order-dialog')).toBe('')
  expect(opened).toMatchObject({ line: { id: 'l1', matchVersion: 2 } })
  await act(async () => (opened!.onClose as () => void)())
  expect(byTestId('standing-order-dialog')).toBeUndefined()
})

test('reconcile: the offer is its own, not a name-only match, and never tickable', async () => {
  lines = [{ ...line(), suggestions: [offer] }]
  await reconcile()
  expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect(byTestId('name-only')).toBeUndefined()
  expect(byTestId('standing-order-offer')).toContain(
    'Make this a standing order for Jo Bloggs',
  )
  expect(byTestId('standing-order-offer')).toContain('one at a time')
})

test('a batch for the line is chosen by staff, never pre-selected', async () => {
  detail = { line: line(), gifts: [], batchId: null, suggestions: [] }
  await linePage()
  closedBatches = [
    {
      id: 'b1',
      accountId: 'acc1',
      line: null,
      slipNumber: '1',
      bankedOn: '2026-10-01',
      total: 500n,
      lineVersion: 0,
    },
    {
      id: 'b2',
      accountId: 'acc1',
      line: null,
      slipNumber: '2',
      bankedOn: '2026-11-02',
      total: 6000n,
      lineVersion: 4,
    },
  ]
  writes.matchBatch.mockResolvedValue({})
  await linePage()
  await click(button('A paying-in batch'))
  const select = el.querySelector<HTMLSelectElement>(
    'form[aria-label="Match to a paying-in batch"] select',
  )!
  // Nearest first (the £60 slip), but nothing chosen: staff choose.
  expect([...select.options].map((o) => o.value)).toEqual(['', 'b2', 'b1'])
  expect(select.value).toBe('')
  expect(button('Match to this batch')?.disabled).toBe(true)
  await act(async () => {
    select.value = 'b2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(button('Match to this batch'))
  expect(writes.matchBatch).toHaveBeenCalledWith('l1', 2, 'b2', 4)
})

test('the server’s refusals land on their fields: the rest, the sum, an unknown donor', async () => {
  detail = { line: line(), gifts: [], batchId: null, suggestions: [] }
  writes.gifts.mockRejectedValueOnce(
    new RustApiError(422, {
      kind: 'invalid',
      problems: [
        {
          field: 'remainder',
          message: 'Say what the rest was: it isn’t a donation',
        },
        {
          field: 'parts',
          message: 'The parts must add up to the line’s £60 exactly',
        },
      ],
    }),
  )
  await linePage()
  await click(button('Find Dee'))
  await setInput(labelled('Amount (£)'), '50')
  await setInput(labelled('What the rest is'), 'x')
  await click(button('Make the gift'))
  const rest = labelled('What the rest is')
  expect(
    document.getElementById(rest.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('Say what the rest was: it isn’t a donation')
  expect(byTestId('split-refused')).toBe(
    'The parts must add up to the line’s £60 exactly',
  )
  writes.gifts.mockRejectedValueOnce(
    new RustApiError(422, {
      kind: 'rejected',
      reason: 'unknown_contact',
      message: 'Contact must exist',
    }),
  )
  await click(button('Make the gift'))
  const change = button('Change')!
  expect(change.getAttribute('aria-invalid')).toBe('true')
  expect(
    document.getElementById(change.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('Contact must exist')
})
