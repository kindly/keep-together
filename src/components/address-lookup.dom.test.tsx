// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { LookupAddress, LookupOutcome } from '../lib/data'

// The contact form's "Find address": a postcode, a list, a pick that
// fills the row; a sentence for each way it can't; hidden for viewers and
// when the deployment has no lookup.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const env = vi.hoisted(() => ({
  on: true,
  canWrite: true,
  lookup: vi.fn<(postcode: string) => Promise<LookupOutcome>>(),
}))
vi.mock('../lib/data', () => ({
  useAddressLookupOn: () => env.on,
  useAddressLookup: () => env.lookup,
}))
vi.mock('../lib/tenant', () => ({ useCanWrite: () => env.canWrite }))

const { FindAddress } = await import('./address-lookup')

const ADDRESSES: Array<LookupAddress> = [
  {
    line1: '1 Test Street',
    line2: '',
    line3: '',
    town: 'Fakebury',
    postcode: 'ID1 1QD',
  },
  {
    line1: 'Flat 3',
    line2: '4 Test Street',
    line3: '',
    town: 'Fakebury',
    postcode: 'ID1 1QD',
  },
]

let root: Root
let el: HTMLDivElement
const onPick = vi.fn()
beforeEach(() => {
  env.on = true
  env.canWrite = true
  env.lookup.mockReset()
  onPick.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const render = (postcode = '') =>
  act(() => root.render(<FindAddress postcode={postcode} onPick={onPick} />))
const button = (name: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === name)
const postcodeInput = () =>
  el.querySelector<HTMLInputElement>('input[aria-label="Postcode to look up"]')!

/** Set a React-controlled input's value as typing would. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function search(outcome: LookupOutcome, postcode = 'id1 1qd') {
  env.lookup.mockResolvedValue(outcome)
  render()
  await act(async () => button('Find address')!.click())
  act(() => type(postcodeInput(), postcode))
  await act(async () => button('Find')!.click())
}

test('hidden when the deployment has no lookup, and for viewers', () => {
  env.on = false
  render()
  expect(el.textContent).toBe('')
  env.on = true
  env.canWrite = false
  render()
  expect(el.textContent).toBe('')
  env.canWrite = true
  render()
  expect(button('Find address')).toBeTruthy()
})

test('finds, lists and fills the picked address', async () => {
  await search({ kind: 'found', addresses: ADDRESSES })
  expect(env.lookup).toHaveBeenCalledWith('id1 1qd')
  const items = [
    ...el.querySelectorAll('[aria-label="Addresses found"] button'),
  ]
  expect(items.map((b) => b.textContent)).toEqual([
    '1 Test Street, Fakebury, ID1 1QD',
    'Flat 3, 4 Test Street, Fakebury, ID1 1QD',
  ])
  await act(async () => (items[1] as HTMLButtonElement).click())
  expect(onPick).toHaveBeenCalledWith(ADDRESSES[1])
  // Closed again, ready for another.
  expect(button('Find address')).toBeTruthy()
})

test('starts from the row’s postcode', async () => {
  render('KT1 1AA')
  await act(async () => button('Find address')!.click())
  expect(postcodeInput().value).toBe('KT1 1AA')
})

test.each([
  [{ kind: 'none' } as const, 'No addresses for that postcode'],
  [{ kind: 'unavailable' } as const, 'Lookup unavailable: type the address'],
  [{ kind: 'cap' } as const, 'Lookups used up this month: type the address'],
  [
    {
      kind: 'invalid',
      message: 'Enter a UK postcode, like SW1A 1AA.',
    } as const,
    'Enter a UK postcode, like SW1A 1AA.',
  ],
])('%o says so and fills nothing', async (outcome, sentence) => {
  await search(outcome)
  expect(el.querySelector('[role="status"]')!.textContent).toBe(sentence)
  expect(el.querySelector('[aria-label="Addresses found"]')).toBeNull()
  expect(onPick).not.toHaveBeenCalled()
})

test('Enter looks up instead of submitting the contact form', async () => {
  env.lookup.mockResolvedValue({ kind: 'found', addresses: ADDRESSES })
  const submit = vi.fn((e: Event) => e.preventDefault())
  const form = document.createElement('form')
  form.addEventListener('submit', submit)
  el.replaceWith(form)
  form.append(el)
  render()
  await act(async () => button('Find address')!.click())
  act(() => type(postcodeInput(), 'ID1 1QD'))
  await act(async () =>
    postcodeInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ),
  )
  expect(env.lookup).toHaveBeenCalledWith('ID1 1QD')
  expect(submit).not.toHaveBeenCalled()
  form.remove()
})
