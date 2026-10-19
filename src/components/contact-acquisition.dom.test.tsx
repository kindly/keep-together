// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import type { SourceCodeDescription } from '../../convex/sources/code'
import { ContactAcquisition } from './contact-acquisition'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const setAcquisition = vi.fn()
const ENTRY = {
  versionId: 'new' as Id<'sourceCodes'>,
  code: 'Event-Gala-001',
  status: 'current',
}
vi.mock('convex/react', () => ({
  useConvex: () => ({ prewarmQuery: () => {} }),
  useMutation: () => setAcquisition,
  // The picker's search, open or not.
  useQuery: () => ({ codes: [ENTRY], truncated: false }),
}))
vi.mock('../lib/tenant', () => ({ useTenant: () => ({ _id: 'tenantA' }) }))
vi.mock('./contact-history', () => ({
  useHistoryHold: () => ({ hold: () => {}, release: () => {} }),
}))

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

test('after a save, the old code never shows while the new one loads', async () => {
  const old = described('old', 'Street-Alpha-001')
  render('old', old)
  expect(shown()).toContain('Street-Alpha-001')

  setAcquisition.mockResolvedValue({ id: 'c1', counter: 2 })
  await act(async () => el.querySelector('input')!.focus())
  await act(async () =>
    el.querySelector<HTMLElement>('[role="option"]')!.click(),
  )
  expect(setAcquisition).toHaveBeenCalledWith(
    expect.objectContaining({ expected: 1, codeId: 'new' }),
  )
  // Saved: the root carries the new code, but the page still holds the
  // old description. The pick stays on screen, still saving.
  render('new', old, 2)
  expect(shown()).toContain('Event-Gala-001')
  expect(shown()).toContain('saving…')
  // The description catches up: the saved code, with its clear button.
  render('new', described('new', 'Event-Gala-001'), 2)
  expect(shown()).toContain('Event-Gala-001')
  expect(shown()).not.toContain('saving…')
  expect(
    el.querySelector('button[aria-label="clear source code"]'),
  ).not.toBeNull()
})

test('a refused save drops the pick and says why', async () => {
  const { ConvexError } = await import('convex/values')
  render('old', described('old', 'Street-Alpha-001'))
  setAcquisition.mockRejectedValue(
    new ConvexError({ kind: 'stale', current: 3 }),
  )
  await act(async () => el.querySelector('input')!.focus())
  await act(async () =>
    el.querySelector<HTMLElement>('[role="option"]')!.click(),
  )
  expect(shown()).toContain('Street-Alpha-001')
  expect(shown()).not.toContain('saving…')
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'Someone else changed the source code',
  )
})
