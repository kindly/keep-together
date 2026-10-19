// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Hold } from '../lib/email-hold'
import { EmailHold } from './email-hold'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const release = vi.fn()
vi.mock('convex/react', () => ({ useMutation: () => release }))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA' }),
  useIsAdmin: () => true,
}))

const ADDRESS = 'ada@example.com'
const HOLD: Hold = { reason: 'bounce', since: 1, saveVersion: 2 }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  release.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const render = (hold: Hold | undefined) =>
  act(() => root.render(<EmailHold address={ADDRESS} hold={hold} />))

/** Buttons named `name`, the row's and the dialog's (in a portal). */
const buttons = (name: string) =>
  [...document.querySelectorAll('button')].filter((b) => b.textContent === name)
const dialog = () => document.querySelector('[role="alertdialog"]')
const alertText = () => el.querySelector('[role="alert"]')?.textContent ?? null

async function openDialog() {
  await act(async () => buttons('Release')[0].click())
  expect(dialog()).not.toBeNull()
}

test('the hold going while the dialog is open closes it, and says so', async () => {
  render(HOLD)
  await openDialog()
  render(undefined)
  expect(dialog()).toBeNull()
  expect(alertText()).toBe('This address is no longer on hold')
  expect(release).not.toHaveBeenCalled()
  // Held again: the message was about the old hold.
  render({ ...HOLD, saveVersion: 4 })
  expect(alertText()).toBeNull()
})

test('a double click sends one release, with the hold’s counter', async () => {
  let done!: () => void
  release.mockReturnValue(new Promise<void>((r) => (done = r)))
  render(HOLD)
  await openDialog()
  const confirm = buttons('Release').at(-1)!
  await act(async () => {
    confirm.click()
    confirm.click()
  })
  expect(release).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledWith({
    tenantId: 'tenantA',
    address: ADDRESS,
    expected: 2,
    note: '',
  })
  await act(async () => done())
})

test('not_held after a release is success: no error', async () => {
  release.mockRejectedValue(
    new ConvexError({ kind: 'rejected', reason: 'not_held', message: 'x' }),
  )
  render(HOLD)
  await openDialog()
  await act(async () => buttons('Release').at(-1)!.click())
  expect(alertText()).toBeNull()
})

test('an error clears on retry and when the hold changes', async () => {
  release.mockRejectedValue(new ConvexError({ kind: 'stale', current: 3 }))
  render(HOLD)
  await openDialog()
  await act(async () => buttons('Release').at(-1)!.click())
  expect(alertText()).toMatch(/changed just now/)

  await openDialog()
  expect(alertText()).toBeNull()
  await act(async () => buttons('Release').at(-1)!.click())
  expect(alertText()).toMatch(/changed just now/)

  render({ ...HOLD, saveVersion: 3 })
  expect(alertText()).toBeNull()
})
