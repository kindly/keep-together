// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SourceCodePicker } from './source-code-picker'
import type { PickerEntry, ShownCode } from './source-code-picker'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const CODES = [
  { versionId: 'v1', code: 'Online-Website-001', status: 'current' },
  {
    versionId: 'v2',
    code: 'Event-Gala-2030',
    status: 'notStarted',
    startDate: '2030-01-01',
    description: 'The 2030 gala',
  },
  {
    versionId: 'v3',
    code: 'Event-Gala-2019',
    status: 'ended',
    endDate: '2019-12-31',
  },
] as unknown as Array<PickerEntry>

const useQuery = vi.fn()
vi.mock('convex/react', () => ({
  useQuery: (...args: Array<unknown>) => useQuery(...args),
}))
vi.mock('../lib/tenant', () => ({ useTenant: () => ({ _id: 'tenantA' }) }))

let root: Root
let el: HTMLDivElement
const onPick = vi.fn()
const onClear = vi.fn()
const onSubmit = vi.fn((e: Event) => e.preventDefault())

beforeEach(() => {
  useQuery.mockReset()
  useQuery.mockImplementation((_q: unknown, args: unknown) =>
    args === 'skip' ? undefined : { codes: CODES, truncated: false },
  )
  onPick.mockReset()
  onClear.mockReset()
  onSubmit.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const render = (value: ShownCode | null) =>
  act(() =>
    root.render(
      <form onSubmit={(e) => onSubmit(e.nativeEvent)}>
        <SourceCodePicker value={value} onPick={onPick} onClear={onClear} />
      </form>,
    ),
  )

const input = () => el.querySelector('input')!
const shown = () => el.querySelector('[data-testid="source-code"]')!.textContent
const options = () =>
  [...el.querySelectorAll('[role="option"]')].map((o) => o.textContent)

test('a carried code shows with its archived and date marks, and clears', async () => {
  render({ code: 'Street-Wesser-001', isActive: false, endDate: '2000-01-01' })
  expect(shown()).toContain('Street-Wesser-001')
  expect(shown()).toContain('archived')
  expect(shown()).toContain('ended')
  await act(async () =>
    el.querySelector<HTMLButtonElement>('button[aria-label]')!.click(),
  )
  expect(onClear).toHaveBeenCalledOnce()

  render(null)
  expect(shown()).toBe('No source code.')
})

test('the search runs only while open, and lists codes with their hints', async () => {
  render(null)
  expect(useQuery).toHaveBeenLastCalledWith(expect.anything(), 'skip')
  expect(el.querySelector('[role="listbox"]')).toBeNull()

  await act(async () => input().focus())
  expect(useQuery).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ tenantId: 'tenantA', search: '' }),
  )
  expect(options()).toEqual([
    'Online-Website-001',
    'Event-Gala-2030not startedThe 2030 gala',
    'Event-Gala-2019ended',
  ])
})

test('Enter picks the highlighted code and never submits the form', async () => {
  render(null)
  await act(async () => input().focus())
  const key = (k: string) =>
    act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true }),
      )
    })
  await key('ArrowDown')
  await key('Enter')
  expect(onPick).toHaveBeenCalledWith(CODES[1])
  expect(onSubmit).not.toHaveBeenCalled()
  expect(el.querySelector('[role="listbox"]')).toBeNull()
})

test('a click on an option picks it', async () => {
  render(null)
  await act(async () => input().focus())
  await act(async () =>
    el.querySelectorAll<HTMLElement>('[role="option"]')[2].click(),
  )
  expect(onPick).toHaveBeenCalledWith(CODES[2])
})
