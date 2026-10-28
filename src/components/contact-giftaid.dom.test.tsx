// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../lib/domain/ids'
import { declarationWarnings } from '../lib/domain/warnings'
import { RustApiError } from '../lib/data/rust/client'
import type { ContactDeclarations, Declaration } from '../lib/giftaid'
import { ContactGiftAid } from './contact-giftaid'

// The contact page's Gift Aid panel (cash gifts step 5): declarations as
// made, their warnings, the derived "covered today" line, and the two
// writes, each refused for a viewer.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mutations: Record<string, ReturnType<typeof vi.fn>> = {
  cancel: vi.fn(),
  voidDeclaration: vi.fn(),
  saveDetails: vi.fn(),
}
const snapshot = vi.fn()
const historyOf = vi.fn()
let declarations: ContactDeclarations | undefined
let canWrite = true
vi.mock('../lib/data', () => ({
  useDeclarations: () => declarations,
  useMembers: () => [{ userId: '1', name: 'Jo Staff' }],
  useGiftAidWrites: () => mutations,
  fetchContactSnapshot: (...args: Array<unknown>) => snapshot(...args),
  useDeclarationHistory: (id: string, enabled: boolean) =>
    enabled ? historyOf(id) : undefined,
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha' }),
  useCanWrite: () => canWrite,
}))

type Row = Omit<Declaration, 'contactId' | 'warnings'>
function declaration(over: Partial<Row>): Declaration {
  const d = {
    _id: 'd1' as Id<'giftAidDeclarations'>,
    scope: 'futureAndPast4y',
    madeOn: '2026-03-03',
    method: 'paperForm',
    wordingVersion: 'hmrc-2016-04',
    firstName: 'Jo',
    lastName: 'Bloggs',
    addressLine1: '1 High St',
    postcode: 'AB1 2CD',
    enteredBy: 1,
    enteredAt: 0,
    declarationVersion: 0,
    cancellationVersion: 0,
    voidVersion: 0,
    detailsVersion: 0,
    ...over,
  } as Row
  return {
    ...d,
    contactId: 'c1' as Id<'contacts'>,
    warnings: d.voidedAt === undefined ? declarationWarnings(d) : [],
  }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const m of Object.values(mutations)) m.mockReset().mockResolvedValue({})
  snapshot.mockReset()
  historyOf.mockReset()
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
  act(() => root.render(<ContactGiftAid contactId={'c1' as Id<'contacts'>} />))
const cards = () => [...el.querySelectorAll('[data-testid="declaration"]')]
const buttons = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].filter((b) => b.textContent === name)
const click = (b: HTMLElement) => act(async () => b.click())
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
const submit = (form: HTMLFormElement) => act(async () => form.requestSubmit())

test('each declaration with its method, wording, snapshot and warnings', () => {
  declarations = {
    declarations: [
      declaration({
        _id: 'd3' as Id<'giftAidDeclarations'>,
        method: 'staffTickedNoEvidence',
        madeOn: '2026-05-01',
        scope: 'future',
        addressLine1: '',
        postcode: '',
      }),
      declaration({
        _id: 'd2' as Id<'giftAidDeclarations'>,
        method: 'oral',
        madeOn: '2026-04-01',
        cancelledFrom: '2026-06-01',
        cancellationNote: 'phoned',
      }),
      declaration({
        voidedAt: Date.UTC(2026, 9, 1),
        voidedBy: 1,
        voidReason: 'wrong person',
      }),
    ],
    currentId: 'd3' as Id<'giftAidDeclarations'>,
  }
  render()
  expect(el.textContent).toContain(
    '✓ A gift made today is covered by the declaration of 1 May 2026 (ticked by staff, no evidence yet).',
  )
  const [staff, oral, voided] = cards()
  expect(staff.textContent).toContain('This and future gifts')
  expect(staff.textContent).toContain('current')
  expect(staff.textContent).toContain('No evidence yet:')
  expect(staff.textContent).toContain('Home address:')
  expect(staff.textContent).toContain('Made asJo Bloggs')
  expect(oral.textContent).toContain('Made orally:')
  expect(oral.textContent).toContain('cancelled from 1 Jun 2026')
  expect(oral.textContent).toContain('Cancellationphoned')
  expect(oral.textContent).toContain('Wordinghmrc-2016-04')
  expect(oral.textContent).toContain('Made asJo Bloggs, 1 High St, AB1 2CD')
  // Voided: marked, its reason and who, no warnings, no actions.
  expect(voided.textContent).toContain('made in error')
  expect(voided.textContent).toContain('wrong person (Jo Staff,')
  expect(voided.querySelector('.bg-amber-50')).toBeNull()
  expect(buttons(voided, 'Mark made in error')).toHaveLength(0)
  expect(buttons(el, 'Record cancellation')).toHaveLength(1)
})

test('no declaration in force, nothing to cancel', () => {
  declarations = {
    declarations: [declaration({ cancelledFrom: '2026-04-01' })],
    currentId: null,
  }
  render()
  expect(el.textContent).toContain('No declaration covers a gift made today.')
  expect(buttons(el, 'Record cancellation')).toHaveLength(0)
})

test('a viewer sees them but changes nothing', () => {
  canWrite = false
  declarations = { declarations: [declaration({})], currentId: null }
  render()
  expect(buttons(el, 'Mark made in error')).toHaveLength(0)
  expect(buttons(el, 'Edit details')).toHaveLength(0)
  expect(buttons(el, 'Record cancellation')).toHaveLength(0)
})

test('Mark made in error needs a reason, then a confirm', async () => {
  declarations = { declarations: [declaration({})], currentId: null }
  render()
  await click(buttons(cards()[0], 'Mark made in error')[0])
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="Mark made in error"]',
  )!
  await submit(form)
  expect(form.querySelector('[role="alert"]')?.textContent).toBe(
    'Say why the declaration was made in error',
  )
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  await type(form.querySelector('input')!, 'wrong person')
  await submit(form)
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain("This can't be undone")
  const run = mutations.voidDeclaration
  expect(run).not.toHaveBeenCalled()
  await click(buttons(dialog, 'Mark made in error')[0])
  expect(run).toHaveBeenCalledWith('d1', 'wrong person')
})

test('each Mark made in error says which declaration it is for', () => {
  declarations = {
    declarations: [
      declaration({ _id: 'd2' as Id<'giftAidDeclarations'>, method: 'oral' }),
      declaration({}),
      declaration({ _id: 'd0' as Id<'giftAidDeclarations'> }),
    ],
    currentId: null,
  }
  render()
  expect(
    buttons(el, 'Mark made in error').map((b) => b.getAttribute('aria-label')),
  ).toEqual([
    'Mark made in error: declaration of 3 Mar 2026 (made orally)',
    'Mark made in error: declaration of 3 Mar 2026 (paper form), 2 of 3',
    'Mark made in error: declaration of 3 Mar 2026 (paper form), 3 of 3',
  ])
})

test('an opened form takes the focus', async () => {
  declarations = { declarations: [declaration({})], currentId: null }
  render()
  await click(buttons(el, 'Record cancellation')[0])
  expect(document.activeElement?.getAttribute('type')).toBe('date')
  await click(buttons(cards()[0], 'Mark made in error')[0])
  expect(
    document.activeElement?.closest('form')?.getAttribute('aria-label'),
  ).toBe('Mark made in error')
})

test('a cancellation from a later date can still be moved earlier', async () => {
  declarations = {
    declarations: [declaration({ cancelledFrom: '2999-01-01' })],
    currentId: 'd1' as Id<'giftAidDeclarations'>,
  }
  render()
  await click(buttons(el, 'Record cancellation')[0])
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="Record cancellation"]',
  )!
  expect(form.textContent).toContain(
    'A cancellation already recorded for a later date is moved to this one.',
  )
  await submit(form)
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Cancel the declaration in force on',
  )
})

test('a date no declaration was in force on is refused before any confirm', async () => {
  declarations = { declarations: [declaration({})], currentId: null }
  render()
  await click(buttons(el, 'Record cancellation')[0])
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="Record cancellation"]',
  )!
  await type(form.querySelector('input')!, '2026-01-01')
  await submit(form)
  expect(form.querySelector('[role="alert"]')?.textContent).toBe(
    'No declaration was in force on that date',
  )
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(mutations.cancel).not.toHaveBeenCalled()
})

test('Record cancellation confirms, sends the date and note, and shows a refusal', async () => {
  declarations = {
    declarations: [
      declaration({
        _id: 'd2' as Id<'giftAidDeclarations'>,
        madeOn: '2026-04-01',
      }),
      declaration({}),
    ],
    currentId: null,
  }
  render()
  await click(buttons(el, 'Record cancellation')[0])
  const form = el.querySelector<HTMLFormElement>(
    'form[aria-label="Record cancellation"]',
  )!
  const [date, note] = [...form.querySelectorAll('input')]
  await type(date, '2026-09-01')
  await type(note, ' donor phoned ')
  const run = mutations.cancel
  const confirmed = async () => {
    await submit(form)
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(run).not.toHaveBeenCalledTimes(2)
    await click(buttons(dialog, 'Record cancellation')[0])
  }
  run.mockRejectedValueOnce(
    new RustApiError(422, {
      kind: 'invalid',
      problems: [
        {
          field: 'cancelledFrom',
          message: 'No declaration was in force on that date',
        },
      ],
    }),
  )
  await submit(form)
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain(
    'Cancel the 2 declarations in force on 1 Sept 2026?',
  )
  expect(dialog.textContent).toContain('This ends every declaration open on')
  expect(dialog.textContent).toContain("This can't be undone")
  expect(run).not.toHaveBeenCalled()
  await click(buttons(dialog, 'Record cancellation')[0])
  expect(run).toHaveBeenCalledWith('2026-09-01', 'donor phoned')
  expect(form.querySelector('[role="alert"]')?.textContent).toBe(
    'No declaration was in force on that date',
  )
  // Saved: the form closes.
  await confirmed()
  expect(el.querySelector('form[aria-label="Record cancellation"]')).toBeNull()
})

const detailsForm = () =>
  el.querySelector<HTMLFormElement>('form[aria-label="Edit details"]')!
const inputs = (form: HTMLFormElement) => [...form.querySelectorAll('input')]

test('Edit details: prefilled from the snapshot, saves with its counter, closes once confirmed', async () => {
  declarations = {
    declarations: [
      declaration({ addressLine1: '', postcode: '', detailsVersion: 2 }),
    ],
    currentId: null,
  }
  render()
  const edit = buttons(cards()[0], 'Edit details')[0]
  expect(edit.getAttribute('aria-label')).toBe(
    'Edit details: declaration of 3 Mar 2026 (paper form)',
  )
  await click(edit)
  const form = detailsForm()
  expect(inputs(form).map((i) => i.value)).toEqual(['Jo', 'Bloggs', '', ''])
  expect(document.activeElement).toBe(inputs(form)[0])
  // Nothing changed: nothing to save.
  expect(buttons(form, 'Save details')[0].disabled).toBe(true)
  await type(inputs(form)[2], '3 Mill Lane')
  await type(inputs(form)[3], 'LS1 1AA')
  await submit(form)
  expect(mutations.saveDetails).toHaveBeenCalledWith('d1', 2, {
    firstName: 'Jo',
    lastName: 'Bloggs',
    addressLine1: '3 Mill Lane',
    postcode: 'LS1 1AA',
  })
  expect(el.querySelector('form[aria-label="Edit details"]')).toBeNull()
})

test("Edit details fills from the contact's current name and address", async () => {
  declarations = { declarations: [declaration({})], currentId: null }
  snapshot.mockResolvedValue({
    firstName: 'Joanna',
    lastName: 'Bloggs',
    addressLine1: '3 Mill Lane',
    postcode: 'LS1 1AA',
  })
  render()
  await click(buttons(cards()[0], 'Edit details')[0])
  const form = detailsForm()
  await click(buttons(form, 'Use the contact’s current name and address')[0])
  expect(snapshot).toHaveBeenCalledWith('alpha', 'c1', expect.any(String))
  expect(inputs(form).map((i) => i.value)).toEqual([
    'Joanna',
    'Bloggs',
    '3 Mill Lane',
    'LS1 1AA',
  ])
  // Not saved until Save details.
  expect(mutations.saveDetails).not.toHaveBeenCalled()
})

test('Edit details stale: keeps what was typed, takes the rest from the server, retries from its counter', async () => {
  declarations = {
    declarations: [declaration({ addressLine1: '' })],
    currentId: null,
  }
  render()
  await click(buttons(cards()[0], 'Edit details')[0])
  const form = detailsForm()
  await type(inputs(form)[2], '3 Mill Lane')
  mutations.saveDetails.mockRejectedValueOnce(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'giftaid.declarationDetails',
      counter: 1,
      current: {
        firstName: 'Joe',
        lastName: 'Bloggs',
        addressLine1: '',
        postcode: 'ZZ1 1ZZ',
      },
    }),
  )
  await submit(form)
  expect(form.querySelector('[role="alert"]')?.textContent).toBe(
    'Someone changed these details just now: check them, then save again',
  )
  expect(inputs(form).map((i) => i.value)).toEqual([
    'Joe',
    'Bloggs',
    '3 Mill Lane',
    'ZZ1 1ZZ',
  ])
  await submit(form)
  expect(mutations.saveDetails).toHaveBeenLastCalledWith('d1', 1, {
    firstName: 'Joe',
    lastName: 'Bloggs',
    addressLine1: '3 Mill Lane',
    postcode: 'ZZ1 1ZZ',
  })
})

test('a voided declaration has no Edit details', () => {
  declarations = {
    declarations: [declaration({ voidedAt: 1, voidedBy: 1, voidReason: 'x' })],
    currentId: null,
  }
  render()
  expect(buttons(el, 'Edit details')).toHaveLength(0)
})

test('details changes: who, when, old → new, read only once opened', async () => {
  declarations = {
    declarations: [
      declaration({ detailsVersion: 1 }),
      declaration({ _id: 'd0' as Id<'giftAidDeclarations'> }),
    ],
    currentId: null,
  }
  historyOf.mockReturnValue({
    edits: [
      {
        revisionId: 7,
        at: Date.UTC(2026, 9, 25, 12),
        actor: 1,
        source: 'ui',
        changes: [
          { field: 'addressLine1', from: '', to: '3 Mill Lane' },
          { field: 'postcode', from: '', to: 'LS1 1AA' },
        ],
      },
    ],
    more: false,
  })
  render()
  // Never changed: no toggle.
  expect(buttons(cards()[1], 'Details changes')).toHaveLength(0)
  expect(historyOf).not.toHaveBeenCalled()
  await click(buttons(cards()[0], 'Details changes')[0])
  expect(historyOf).toHaveBeenCalledWith('d1')
  const text = el.querySelector('[data-testid="details-changes"]')!.textContent
  expect(text).toContain('Jo Staff, ')
  expect(text).toContain(
    'House number or name (blank) → 3 Mill Lane; Postcode (blank) → LS1 1AA',
  )
})
