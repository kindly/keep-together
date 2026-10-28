// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../lib/domain/ids'
import type { SourceCodeDescription } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { ContactAcquisition } from './contact-acquisition'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const setAcquisition = vi.fn()
const ENTRY = {
  versionId: 'new' as Id<'sourceCodes'>,
  code: 'Event-Gala-001',
  status: 'current',
}
vi.mock('../lib/data', () => ({
  useSetAcquisition: () => setAcquisition,
  // The picker's search, open or not.
  useSourcePicker: () => ({ codes: [ENTRY], truncated: false }),
}))

const stale = (counter: number) =>
  new RustApiError(409, {
    kind: 'stale',
    contract: 'contacts.acquisition',
    counter,
    current: {},
  })

const described = (versionId: string, code: string) =>
  ({ versionId, code, isActive: true }) as unknown as SourceCodeDescription

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  setAcquisition.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const render = (
  codeId: string | undefined,
  acquisition: SourceCodeDescription | null,
  counter = 1,
) =>
  act(() =>
    root.render(
      <ContactAcquisition
        id={'c1' as Id<'contacts'>}
        counter={counter}
        codeId={codeId as Id<'sourceCodes'> | undefined}
        acquisition={acquisition}
        disabled={false}
      />,
    ),
  )
const shown = () => el.querySelector('[data-testid="source-code"]')!.textContent

const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name)!
/** The clear button, then the confirm's Remove. */
async function remove() {
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>(
        'button[aria-label="clear source code"]',
      )!
      .click(),
  )
  await act(async () => button('Remove').click())
}
async function pickNew() {
  await act(async () => el.querySelector('input')!.focus())
  await act(async () =>
    el.querySelector<HTMLElement>('[role="option"]')!.click(),
  )
}

test('a set code shows no search box; it is replaced by removing, then picking', async () => {
  const old = described('old', 'Street-Alpha-001')
  render('old', old)
  expect(shown()).toContain('Street-Alpha-001')
  expect(el.querySelector('input')).toBeNull()

  setAcquisition.mockResolvedValue({ id: 'c1', counter: 2 })
  await remove()
  expect(setAcquisition).toHaveBeenLastCalledWith(null, 1)
  // Saved, but the page still holds the old description: still saving,
  // and the old code never comes back meanwhile.
  render(undefined, old, 2)
  expect(shown()).not.toContain('Street-Alpha-001')
  expect(shown()).toContain('saving…')
  render(undefined, null, 2)
  expect(shown()).toBe('No source code.')

  setAcquisition.mockResolvedValue({ id: 'c1', counter: 3 })
  await pickNew()
  expect(setAcquisition).toHaveBeenLastCalledWith('new', 2)
  // The root carries the new code before its description loads.
  render('new', null, 3)
  expect(shown()).toContain('Event-Gala-001')
  expect(shown()).toContain('saving…')
  render('new', described('new', 'Event-Gala-001'), 3)
  expect(shown()).not.toContain('saving…')
  expect(
    el.querySelector('button[aria-label="clear source code"]'),
  ).not.toBeNull()
  expect(el.querySelector('input')).toBeNull()
})

test('after a remove, the search box takes focus once it is enabled', async () => {
  render('old', described('old', 'Street-Alpha-001'))
  setAcquisition.mockResolvedValue({ id: 'c1', counter: 2 })
  await remove()
  render(undefined, null, 2)
  expect(document.activeElement).toBe(el.querySelector('input'))
})

test('a code changed under the open confirm: Remove is stale, the new code stays', async () => {
  render('old', described('old', 'Street-Alpha-001'))
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>(
        'button[aria-label="clear source code"]',
      )!
      .click(),
  )
  // Someone else sets another code while the confirm is open.
  render('other', described('other', 'Event-Gala-002'), 2)
  setAcquisition.mockRejectedValue(stale(2))
  await act(async () => button('Remove').click())
  // Sent against the counter the confirm opened on, so the server refuses.
  expect(setAcquisition).toHaveBeenLastCalledWith(null, 1)
  expect(shown()).toContain('Event-Gala-002')
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'Someone else changed the source code',
  )
  expect(document.activeElement).not.toBe(el.querySelector('input'))
})

test('a refused save keeps the code and says why', async () => {
  render('old', described('old', 'Street-Alpha-001'))
  setAcquisition.mockRejectedValue(stale(3))
  await remove()
  expect(shown()).toContain('Street-Alpha-001')
  expect(shown()).not.toContain('saving…')
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'Someone else changed the source code',
  )
})
