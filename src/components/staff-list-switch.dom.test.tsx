// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Tenant } from '../lib/tenant'
import { TenantContext } from '../lib/tenant'
import type * as DataLib from '../lib/data'

// The admin-only "staff can manage …" switch (A3) on the Rust API: it
// shows the group's switch as the server last answered, never moves on
// its own, and says so when another admin got there first.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const save = vi.fn()
vi.mock('../lib/data', async (original) => ({
  ...(await original<typeof DataLib>()),
  useSetStaffCanManage: () => save,
}))

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  _id: 'alpha' as Tenant['_id'],
  slug: 'alpha',
  name: 'Alpha',
  role: 'admin',
  lastUsedAt: null,
  staffCanManageIdentifierTypes: false,
  identifierTypesVersion: null,
  staffCanManageSourceCodes: true,
  sourceCodesVersion: 3,
  staffCanManageFields: false,
  fieldsVersion: null,
  canManageIdentifierTypes: true,
  canManageSourceCodes: true,
  canManageFields: true,
  ...over,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  save.mockReset().mockResolvedValue('saved')
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

async function render(
  t: Tenant,
  kind: 'identifierTypes' | 'sourceCodes' | 'fields',
) {
  const { StaffListSwitch } = await import('./staff-list-switch')
  act(() =>
    root.render(
      <TenantContext.Provider value={t}>
        <StaffListSwitch kind={kind} />
      </TenantContext.Provider>,
    ),
  )
}
const input = () => el.querySelector<HTMLInputElement>('input[role="switch"]')

test('an admin sees the list’s own switch as the group has it', async () => {
  await render(tenant(), 'sourceCodes')
  expect(input()?.checked).toBe(true)
  expect(el.textContent).toContain('Staff can manage source codes')
  await render(tenant(), 'fields')
  expect(input()?.checked).toBe(false)
  expect(el.textContent).toContain('Staff can manage fields')
})

test('staff and viewers see no switch', async () => {
  for (const role of ['staff', 'viewer'] as const) {
    await render(tenant({ role }), 'fields')
    expect(input()).toBeNull()
    expect(el.textContent).toBe('')
  }
})

test('a click asks the server, and the switch waits for its answer', async () => {
  await render(tenant(), 'fields')
  await act(async () => input()!.click())
  expect(save).toHaveBeenCalledExactlyOnceWith('fields', true)
  // Not optimistic: still off until the groups come back saying on.
  expect(input()?.checked).toBe(false)
  expect(el.querySelector('[role="alert"]')).toBeNull()
})

test('a stale save says another admin changed it; a failure says so', async () => {
  save.mockResolvedValueOnce('stale')
  await render(tenant(), 'identifierTypes')
  await act(async () => input()!.click())
  expect(el.querySelector('[role="alert"]')?.textContent).toBe(
    'Another admin changed this just now; check it and try again',
  )
  save.mockResolvedValueOnce('failed')
  await act(async () => input()!.click())
  expect(el.querySelector('[role="alert"]')?.textContent).toBe('Could not save')
})
