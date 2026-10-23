// @vitest-environment happy-dom
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DonorInfo } from '../lib/gift-form'
import { GiftForm } from './gift-form'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const record = vi.fn()
let search: unknown
let donor: DonorInfo | null | undefined
const asked: Array<[string, unknown]> = []
vi.mock('convex/react', () => ({
  useMutation: () => record,
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never)
    asked.push([name, args])
    if (args === 'skip') return undefined
    if (name === 'contacts/queries:search') return search
    if (name === 'giving/queries:donor') return donor
    if (name === 'sources/queries:picker')
      return {
        codes: [
          {
            versionId: 'online',
            code: 'Online-Spring-001',
            status: 'current',
          },
        ],
        truncated: false,
      }
    return undefined
  },
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha' }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    className,
  }: {
    children: ReactNode
    params: Record<string, string>
    className?: string
  }) => (
    <a href={`/t/${params.slug}/gifts/${params.giftId}`} className={className}>
      {children}
    </a>
  ),
}))

const row = (
  id: string,
  displayName: string,
  number: number | null = null,
) => ({
  _id: id,
  kind: 'individual',
  displayName,
  sortName: displayName,
  number,
  archived: false,
  email: null,
  fieldOptionIds: [],
})

function jo(over: Partial<DonorInfo> = {}): DonorInfo {
  return {
    id: 'jo',
    kind: 'individual',
    displayName: 'Jo Bloggs',
    firstName: 'Jo',
    lastName: 'Bloggs',
    home: { line1: '', postcode: '' },
    acquisition: {
      versionId: 'street',
      code: 'Street-Wesser-001',
      isActive: true,
    },
    current: null,
    ...over,
  } as DonorInfo
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  record.mockReset()
  asked.length = 0
  search = {
    rows: [row('jo', 'Jo Bloggs'), row('al', 'Al Smith')],
    truncated: false,
    tooBroad: false,
    numberMatch: null,
    invalidNumber: null,
  }
  donor = jo()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  act(() => root.render(<GiftForm />))
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const donorBox = () =>
  el.querySelector<HTMLInputElement>('input[aria-label="Donor"]')!
const options = () => [...el.querySelectorAll('[role="option"]')]
const button = (name: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === name)!
const submit = () =>
  el.querySelector<HTMLButtonElement>('button[type="submit"]')!
const codeShown = () =>
  el.querySelector('[data-testid="source-code"]')!.textContent
const giftAid = () => el.querySelector('[data-testid="gift-aid"]')

/** Set a controlled input's value as typing does. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const labelled = (text: string) =>
  [...el.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith(text))!
    .querySelector('input')!

async function find(text: string) {
  await act(async () => donorBox().focus())
  await type(donorBox(), text)
}
async function pickOption(i: number) {
  await act(async () => (options()[i] as HTMLElement).click())
}
async function click(b: HTMLElement) {
  await act(async () => b.click())
}

test('a number match is listed first and marked, but only a pick chooses it', async () => {
  search = {
    ...(search as object),
    rows: [row('jo', 'Jo Bloggs', 12345), row('al', 'Al Smith')],
    numberMatch: 'jo',
  }
  await find('123455')
  const first = options()[0]
  expect(first.textContent).toContain('contact no. 123455')
  expect(first.className).toContain('bg-emerald')
  // Still searching: nothing picked, no donor read.
  expect(donorBox()).not.toBeNull()
  expect(
    asked.filter(([n, a]) => n === 'giving/queries:donor' && a !== 'skip'),
  ).toEqual([])
  // Then New person / New organisation from the text.
  expect(options().map((o) => o.textContent)).toEqual([
    'Jo Bloggscontact no. 123455',
    'Al Smith',
    'New person “123455”',
    'New organisation “123455”',
  ])
  await pickOption(0)
  expect(el.querySelector('[data-testid="donor"]')!.textContent).toContain(
    'Jo Bloggs',
  )
})

test('picking a contact fills their own code; another code is noted', async () => {
  await find('jo')
  await pickOption(0)
  expect(asked).toContainEqual([
    'giving/queries:donor',
    expect.objectContaining({ contactId: 'jo' }),
  ])
  expect(codeShown()).toContain('Street-Wesser-001')
  await click(el.querySelector('button[aria-label="clear source code"]')!)
  const codeBox = el.querySelector<HTMLInputElement>(
    'input[aria-label="Source code"]',
  )!
  await act(async () => codeBox.focus())
  await click(
    el.querySelector<HTMLElement>(
      '[aria-label="Source code matches"] [role="option"]',
    )!,
  )
  expect(codeShown()).toContain('Online-Spring-001')
  expect(el.textContent).toContain(
    'Differs from Jo’s source, Street-Wesser-001',
  )
})

test('an archived own code leaves the code empty and required', async () => {
  donor = jo({
    acquisition: {
      versionId: 'street',
      code: 'Street-Wesser-001',
      isActive: false,
    } as DonorInfo['acquisition'],
  })
  await find('jo')
  await pickOption(0)
  expect(codeShown()).toBe('No source code.')
  await type(labelled('Amount'), '20')
  await click(submit())
  expect(record).not.toHaveBeenCalled()
  expect(el.textContent).toContain('Pick a source code')
})

test('covered by a declaration: ✓, no tick', async () => {
  donor = jo({
    current: {
      id: 'd1',
      scope: 'futureAndPast4y',
      method: 'paperForm',
      madeOn: '2026-03-03',
    } as DonorInfo['current'],
  })
  await find('jo')
  await pickOption(0)
  expect(giftAid()!.textContent).toBe(
    '✓ Gift Aid: covered by declaration of 3 Mar 2026 (paper form)',
  )
  expect(giftAid()!.querySelector('input')).toBeNull()
})

test('an organisation gets no tick', async () => {
  donor = jo({ kind: 'organization', displayName: 'Acme Ltd' })
  await find('acme')
  await pickOption(0)
  expect(giftAid()!.textContent).toBe(
    'Gift Aid is only for gifts from a person.',
  )
})

test('the tick: staff ticked by default, explained; an address on file is used', async () => {
  donor = jo({ home: { line1: '12 High St', postcode: 'AB1 2CD' } })
  await find('jo')
  await pickOption(0)
  await click(giftAid()!.querySelector('input[type="checkbox"]')!)
  const selects = [...giftAid()!.querySelectorAll('select')]
  expect(selects.map((s) => s.value)).toEqual([
    'futureAndPast4y',
    'staffTickedNoEvidence',
  ])
  expect(
    el.querySelector('[data-testid="tick-method-explained"]')!.textContent,
  ).toMatch(/no signed form.*can’t be claimed until evidence is added/)
  expect(giftAid()!.textContent).toContain(
    'Declared under their home address: 12 High St, AB1 2CD',
  )
  // No address fields to half-type over it.
  expect(giftAid()!.querySelectorAll('input[type="text"]')).toHaveLength(0)
})

test('the tick with no address on file: half typed blocks the save', async () => {
  await find('jo')
  await pickOption(0)
  await type(labelled('Amount'), '20')
  await click(giftAid()!.querySelector('input[type="checkbox"]')!)
  expect(el.textContent).toMatch(/No home address/)
  await type(labelled('House number or name'), '12 High St')
  await click(submit())
  expect(record).not.toHaveBeenCalled()
  expect(el.textContent).toContain('Add the postcode, or clear line 1')
  await type(labelled('Postcode'), 'AB1 2CD')
  record.mockResolvedValue({
    contactId: 'jo',
    giftId: 'g1',
    declarationId: 'd',
  })
  await click(submit())
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({
      home: { line1: '12 High St', postcode: 'AB1 2CD' },
      giftAid: { scope: 'futureAndPast4y', method: 'staffTickedNoEvidence' },
    }),
  )
})

test('a save: one call however many clicks, then cleared for the next, date and method kept', async () => {
  await find('jo')
  await pickOption(0)
  await type(labelled('Amount'), '£12.50')
  await type(labelled('Date received'), '2026-10-20')
  await click(el.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1])
  await type(labelled('Reference'), 'SU-1')
  let resolve!: (v: unknown) => void
  record.mockReturnValue(new Promise((r) => (resolve = r)))
  await act(async () => {
    submit().click()
    submit().click()
  })
  expect(submit().textContent).toBe('Saving…')
  expect(record).toHaveBeenCalledTimes(1)
  const sent = record.mock.calls[0][0]
  expect(sent).toMatchObject({
    tenantId: 'tenantA',
    contact: 'jo',
    amount: 1250n,
    receivedOn: '2026-10-20',
    method: 'card',
    reference: 'SU-1',
    allocations: [{ sourceCodeId: 'street', amount: 1250n }],
  })
  await act(async () =>
    resolve({ contactId: 'jo', giftId: 'g1', declarationId: null }),
  )
  const status = el.querySelector('[role="status"]')!
  expect(status.textContent).toBe('Saved: £12.50 from Jo Bloggs (open)')
  expect(status.querySelector('a')!.getAttribute('href')).toBe(
    '/t/alpha/gifts/g1',
  )
  // Ready for the next: a fresh search, no code, date and method kept.
  expect(donorBox()).not.toBeNull()
  expect(document.activeElement).toBe(donorBox())
  expect(codeShown()).toBe('No source code.')
  expect(labelled('Amount').value).toBe('')
  expect(labelled('Date received').value).toBe('2026-10-20')
  expect(
    el.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked,
  ).toBe(true)
  expect(labelled('Reference').value).toBe('')

  // The next gift gets a new key.
  await find('jo')
  await pickOption(0)
  await type(labelled('Amount'), '5')
  record.mockResolvedValue({
    contactId: 'jo',
    giftId: 'g2',
    declarationId: null,
  })
  await click(submit())
  expect(record.mock.calls[1][0].clientKey).not.toBe(sent.clientKey)
})

test('a failed save keeps the key: the retry that finds it saved says so', async () => {
  await find('jo')
  await pickOption(0)
  await type(labelled('Amount'), '20')
  record.mockRejectedValueOnce(new Error('connection lost'))
  await click(submit())
  expect(el.querySelector('[role="alert"]')!.textContent).toBe(
    'Could not save the gift: try again',
  )
  record.mockRejectedValueOnce(
    new ConvexError({ kind: 'rejected', reason: 'duplicate', message: 'g1' }),
  )
  await click(submit())
  expect(record.mock.calls[1][0].clientKey).toBe(
    record.mock.calls[0][0].clientKey,
  )
  expect(el.querySelector('[role="status"]')!.textContent).toBe(
    'Already saved: £20.00 from Jo Bloggs (open)',
  )
})

test('a new person from the search text, sent in the one save', async () => {
  search = { ...(search as object), rows: [] }
  await find('Sam Jones')
  expect(options().map((o) => o.textContent)).toEqual([
    'New person “Sam Jones”',
    'New organisation “Sam Jones”',
  ])
  await pickOption(0)
  expect(labelled('First name').value).toBe('Sam')
  expect(labelled('Last name').value).toBe('Jones')
  // A new donor has no code of their own.
  expect(codeShown()).toBe('No source code.')
  await click(button('Change'))
  expect(donorBox()).not.toBeNull()
})
