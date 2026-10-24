// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import { declarationWarnings } from '../../convex/giftaid/warnings'
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
}
let declarations: ContactDeclarations | undefined
let canWrite = true
vi.mock('../lib/data', () => ({
  useDeclarations: () => declarations,
  useMembers: () => [{ userId: '1', name: 'Jo Staff' }],
  useGiftAidWrites: () => mutations,
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA' }),
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
