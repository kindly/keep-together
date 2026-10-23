// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ContactNumber } from './contact-number'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

const render = (sequence: number | undefined) =>
  act(() => root.render(<ContactNumber sequence={sequence} />))
const button = () => el.querySelector('button')!

test('shows the written number, check digit included', () => {
  render(10001)
  expect(el.querySelector('[data-testid="contact-number"]')?.textContent).toBe(
    '100016',
  )
  expect(button().getAttribute('aria-label')).toBe(
    'copy contact number 100016',
  )
})

test('shows nothing for a contact not yet numbered', () => {
  render(undefined)
  expect(el.textContent).toBe('')
})

test('copy puts the written number on the clipboard', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(10002)
  await act(async () => button().click())
  expect(writeText).toHaveBeenCalledWith('100024')
  expect(button().textContent).toBe('copied')
})

test('without a clipboard (plain http), copy selects the number', async () => {
  vi.stubGlobal('navigator', {})
  render(10001)
  await act(async () => button().click())
  expect(window.getSelection()?.toString()).toBe('100016')
  expect(button().textContent).toBe('press Ctrl+C')
})

test('a refused write selects the number too', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: () => Promise.reject(new Error('denied')) },
  })
  render(10001)
  await act(async () => button().click())
  expect(window.getSelection()?.toString()).toBe('100016')
})
