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
  vi.useRealTimers()
})

const render = (sequence: number | undefined) =>
  act(() => root.render(<ContactNumber sequence={sequence} />))
const button = () => el.querySelector('button')!
const announced = () => el.querySelector('[aria-live="polite"]')!.textContent

test('shows the written number, check digit included', () => {
  render(10001)
  expect(el.querySelector('[data-testid="contact-number"]')?.textContent).toBe(
    '100016',
  )
  expect(button().getAttribute('aria-label')).toBe(
    'copy: contact number 100016',
  )
  expect(announced()).toBe('')
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
  expect(button().getAttribute('aria-label')).toBe(
    'copied: contact number 100024',
  )
  expect(announced()).toBe('contact number 100024 copied')
})

test('without a clipboard (plain http), copy selects the number', async () => {
  vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
  render(10001)
  await act(async () => button().click())
  expect(window.getSelection()?.toString()).toBe('100016')
  expect(button().textContent).toBe('press Ctrl+C')
  expect(button().getAttribute('aria-label')).toBe(
    'press Ctrl+C: contact number 100016',
  )
  expect(announced()).toBe(
    'contact number 100016 selected, press Ctrl+C to copy',
  )
})

test('on a Mac the fallback says ⌘C', async () => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  render(10001)
  await act(async () => button().click())
  expect(button().textContent).toBe('press ⌘C')
  expect(announced()).toBe('contact number 100016 selected, press ⌘C to copy')
})

test('a refused write selects the number too', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: () => Promise.reject(new Error('denied')) },
  })
  render(10001)
  await act(async () => button().click())
  expect(window.getSelection()?.toString()).toBe('100016')
})

test('a repeat click restarts the 2 s reset', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', {
    clipboard: { writeText: () => Promise.resolve() },
  })
  render(10001)
  await act(async () => button().click())
  act(() => vi.advanceTimersByTime(1500))
  await act(async () => button().click())
  act(() => vi.advanceTimersByTime(1500))
  expect(button().textContent).toBe('copied')
  act(() => vi.advanceTimersByTime(600))
  expect(button().textContent).toBe('copy')
  expect(announced()).toBe('')
})
