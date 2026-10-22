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
const mutation = vi.fn()
const action = vi.fn()
vi.mock('convex/react', () => ({
  useQuery: () => fields,
  useMutation: () => mutation,
  useAction: () => action,
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
  mutation.mockReset().mockResolvedValue(null)
  action.mockReset()
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
  expect(el.textContent).toContain('(1 of 5 in use)')
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
  expect(mutation).toHaveBeenCalledWith({
    tenantId: 'tenantA',
    fieldId: 'f1',
    order: ['South', 'Old', 'North'],
  })
})

test('retire asks first, then shows progress until it ends', async () => {
  let finish: (v: { cleared: number }) => void = () => {}
  action.mockReturnValue(new Promise((r) => (finish = r)))
  render()
  await click(button('retire'))
  expect(action).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('can’t be undone')
  await click(button('Retire field', dialog))
  expect(action).toHaveBeenCalledWith({ tenantId: 'tenantA', id: 'f1' })
  expect(el.textContent).toContain('Retiring Region')
  // The field leaves the list once its slot is free.
  fields = []
  await act(async () => finish({ cleared: 3 }))
  rerender()
  expect(el.textContent).toContain('Retired Region: cleared from 3 contacts.')
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
  expect(mutation).toHaveBeenCalledWith({
    tenantId: 'tenantA',
    id: 'f1',
    expected: 1,
    label: 'Area',
    appliesTo: ['individual'],
    isActive: true,
  })
})

test('five fields: the add form gives way to a note', () => {
  fields = [1, 2, 3, 4, 5].map((n) => ({
    ...REGION,
    _id: `f${n}`,
    label: `F${n}`,
    slot: n,
  })) as unknown as Array<Field>
  render()
  expect(el.querySelector('input[aria-label="New field"]')).toBeNull()
  expect(el.textContent).toContain('All 5 fields are in use')
})
