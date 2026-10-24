// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Field } from '../lib/field-settings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const opt = (id: string, position: number, over = {}) => ({
  _id: id,
  fieldId: 'f1',
  label: id,
  position,
  isActive: true,
  used: false,
  saveVersion: 0,
  ...over,
})

const REGION = {
  _id: 'f1',
  label: 'Region',
  appliesTo: ['individual', 'organization', 'household'],
  isActive: true,
  retiring: false,
  slot: 1,
  saveVersion: 0,
  options: [
    opt('North', 0, { used: true }),
    opt('Old', 1, { isActive: false }),
    opt('South', 2),
  ],
  deletable: false,
} as unknown as Field

let fields: Array<Field> | undefined
const writes = {
  createField: vi.fn(),
  saveField: vi.fn(),
  deleteField: vi.fn(),
  addOption: vi.fn(),
  saveOption: vi.fn(),
  deleteOption: vi.fn(),
  reorder: vi.fn(),
  retire: vi.fn(),
}
vi.mock('../lib/data', () => ({
  useFields: () => fields,
  useFieldWrites: () => writes,
  useFollowRetires: () => {},
  preloadFields: () => {},
  useSetStaffCanManage: () => async () => {},
}))
let canManage = true
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA' }),
  useCanManageList: () => canManage,
  useIsAdmin: () => false,
  cachedTenant: () => null,
}))

// The page component, from the route module (not exported on its own).
let Page: ComponentType
let root: Root
let el: HTMLDivElement

beforeEach(async () => {
  const { Route } = await import('./t.$slug.settings.fields')
  Page = Route.options.component as ComponentType
  fields = [REGION]
  canManage = true
  for (const write of Object.values(writes))
    write.mockReset().mockResolvedValue(null)
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

const render = () => act(() => root.render(<Page />))
const rerender = render
const options = () =>
  [...el.querySelectorAll('[data-testid="field-option"]')].map(
    (o) => o.textContent,
  )
const button = (text: string, scope: ParentNode = el) =>
  [...scope.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === text,
  )!
const click = (b: HTMLElement) => act(async () => b.click())

test('loading, then the fields with archived options hidden', () => {
  fields = undefined
  render()
  expect(el.textContent).toContain('Loading…')
  fields = [REGION]
  rerender()
  expect(el.textContent).toContain('Region')
  expect(el.textContent).toContain('(1 of 200 in use)')
  expect(options()).toHaveLength(2)
  expect(el.textContent).toContain('Show archived (1)')
})

test('reading only: no add form and no row actions', () => {
  canManage = false
  render()
  expect(el.querySelector('input[aria-label="New field"]')).toBeNull()
  expect(el.textContent).not.toContain('retire')
  expect(el.textContent).not.toContain('rename')
})

test('a used option and a used field cannot be deleted', () => {
  render()
  const rows = [...el.querySelectorAll('[data-testid="field-option"]')]
  expect(button('delete', rows[0]).disabled).toBe(true)
  expect(button('delete', rows[1]).disabled).toBe(false)
  const header = el.querySelector('[data-testid="field"]')!.firstElementChild!
  expect(button('delete', header).disabled).toBe(true)
})

test('moving an option sends the whole order, archived ones included', async () => {
  render()
  await click(el.querySelector('[aria-label="Move South up"]')!)
  expect(writes.reorder).toHaveBeenCalledWith('f1', ['South', 'Old', 'North'])
})

test('retire asks first, then shows progress until it ends', async () => {
  let finish: (v: { phase: string }) => void = () => {}
  writes.retire.mockReturnValue(new Promise((r) => (finish = r)))
  render()
  await click(button('retire'))
  expect(writes.retire).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('can’t be undone')
  await click(button('Retire field', dialog))
  expect(writes.retire).toHaveBeenCalledWith('f1')
  expect(el.textContent).toContain('Retiring Region')
  // Started: the card shows it running, not an error, until the field
  // leaves the list (an event or the poll), which says it is done.
  await act(async () => finish({ phase: 'retiring' }))
  expect(el.textContent).toContain('Retiring Region')
  expect(el.querySelector('[role=alert]')).toBeNull()
  fields = []
  rerender()
  expect(el.textContent).toContain('Region has been retired')
})

test('a field retiring elsewhere offers to carry on', () => {
  fields = [{ ...REGION, isActive: false, retiring: true }]
  render()
  expect(el.textContent).toContain('Region is being retired')
  expect(button('Continue retiring')).toBeTruthy()
  expect(button('edit')).toBeUndefined()
})

test('an open editor merges a save made elsewhere', async () => {
  render()
  await click(button('edit'))
  const input = el.querySelector<HTMLInputElement>(
    'input[aria-label="Label of Region"]',
  )!
  await act(async () => {
    // React tracks the value itself: set it the way typing does.
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'Area')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // They narrowed the kinds and renamed it to something else.
  fields = [
    { ...REGION, label: 'Zone', appliesTo: ['individual'], saveVersion: 1 },
  ]
  rerender()
  const label = el.querySelector<HTMLInputElement>(
    'input[aria-label="Label of Zone"]',
  )!
  expect(label.value).toBe('Area')
  expect(el.textContent).toContain('changed by someone else to “Zone”')
  const kinds = [
    ...label.form!.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ].map((i) => i.checked)
  expect(kinds).toEqual([true, false, false])
  await click(button('Save', label.form!))
  expect(writes.saveField).toHaveBeenCalledWith('f1', 1, {
    label: 'Area',
    appliesTo: ['individual'],
    isActive: true,
  })
})

test('every place taken: the add form gives way to a note', () => {
  // No options: 200 cards render quickly.
  fields = Array.from({ length: 200 }, (_, n) => ({
    ...REGION,
    options: [],
    _id: `f${n}`,
    label: `F${n}`,

  })) as unknown as Array<Field>
  render()
  expect(el.querySelector('input[aria-label="New field"]')).toBeNull()
  expect(el.textContent).toContain('All 200 fields are in use')
})

const withOptions = (...labels: Array<string>) =>
  ({
    ...REGION,
    deletable: true,
    options: labels.map((l, i) => opt(l, i)),
  }) as unknown as Field
const press = async (label: string) => {
  const b = el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  b.focus()
  await click(b)
}
const focused = () => document.activeElement?.getAttribute('aria-label')
const announced = () => el.querySelector('[aria-live="polite"]')!.textContent

test('a move keeps focus on the moved option, and says where it went', async () => {
  let done: (v: null) => void = () => {}
  writes.reorder.mockReturnValueOnce(new Promise((r) => (done = r)))
  fields = [withOptions('Bronze', 'Silver', 'Gold')]
  render()
  await press('Move Bronze down')
  // Pressed again before the move shows: ignored, the button stays usable.
  expect(
    el.querySelector<HTMLButtonElement>('[aria-label="Move Bronze down"]')!
      .disabled,
  ).toBe(false)
  await press('Move Bronze down')
  expect(writes.reorder).toHaveBeenCalledTimes(1)
  fields = [withOptions('Silver', 'Bronze', 'Gold')]
  rerender()
  await act(async () => done(null))
  expect(focused()).toBe('Move Bronze down')
  expect(announced()).toBe('Bronze, position 2 of 3')
  // To the end: its down arrow is off, so focus goes to up.
  await press('Move Bronze down')
  fields = [withOptions('Silver', 'Gold', 'Bronze')]
  rerender()
  expect(focused()).toBe('Move Bronze up')
  expect(announced()).toBe('Bronze, position 3 of 3')
})

test('a retire elsewhere closes open editors, with a note', async () => {
  render()
  await click(button('edit'))
  const south = [...el.querySelectorAll('[data-testid="field-option"]')][1]
  await click(button('rename', south))
  expect(el.querySelector('input[aria-label="Rename South"]')).toBeTruthy()
  fields = [{ ...REGION, isActive: false, retiring: true, saveVersion: 1 }]
  rerender()
  expect(el.querySelector('input[aria-label="Label of Region"]')).toBeNull()
  expect(el.querySelector('input[aria-label="Rename South"]')).toBeNull()
  expect(el.textContent).toContain('Your edit was closed unsaved')
  expect(el.textContent).toContain('Your rename was closed unsaved')
})

test('archiving an option asks first', async () => {
  render()
  const south = [...el.querySelectorAll('[data-testid="field-option"]')][1]
  await click(button('archive', south))
  expect(writes.saveOption).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('Contacts that have it keep it')
  await click(button('Archive', dialog))
  expect(writes.saveOption).toHaveBeenCalledWith('South', 0, {
    fieldId: 'f1',
    label: 'South',
    position: 2,
    isActive: false,
  })
})

test('an open option rename keeps its field shown when the field is archived', async () => {
  render()
  const south = [...el.querySelectorAll('[data-testid="field-option"]')][1]
  await click(button('rename', south))
  fields = [{ ...REGION, isActive: false, saveVersion: 1 }]
  rerender()
  expect(el.querySelector('input[aria-label="Rename South"]')).toBeTruthy()
  expect(el.textContent).toContain('Archived while this was open')
})

test('a field retired elsewhere leaves a notice', () => {
  fields = [{ ...REGION, isActive: false, retiring: true }]
  render()
  fields = []
  rerender()
  expect(el.textContent).toContain(
    'Region has been retired: its values are cleared',
  )
})
