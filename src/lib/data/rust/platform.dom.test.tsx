// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Tenant } from '../../tenant'
import { queryClient } from './hooks'
import { keys } from './keys'
import { useOpened, useSetStaffCanManage } from './platform'

// The control plane's two writes (A3): what they send, and that the
// caller's groups are refetched only when something changed.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const calls: Array<{ url: string; method: string; body: unknown }> = []
let answer: () => Response
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status })

let root: Root
let el: HTMLDivElement
let invalidate: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    })
    return Promise.resolve(answer())
  })
  invalidate = vi
    .spyOn(queryClient, 'invalidateQueries')
    .mockResolvedValue(undefined)
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
  invalidate.mockRestore()
})

function hook<T>(use: () => T): T {
  let out: T | undefined
  function Probe() {
    out = use()
    return null
  }
  act(() => root.render(<Probe />))
  return out!
}

const tenant = {
  slug: 'alpha',
  fieldsVersion: 4,
  sourceCodesVersion: null,
} as Tenant

test('opened posts the slug, and refetches the groups only when recorded', async () => {
  const opened = hook(useOpened)
  answer = () => json(200, { lastUsedAt: null })
  await opened('alpha')
  expect(calls).toEqual([
    { url: '/api/groups/alpha/opened', method: 'POST', body: {} },
  ])
  expect(invalidate).not.toHaveBeenCalled()
  answer = () => json(200, { lastUsedAt: 1234 })
  await opened('alpha')
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: keys.groups })
})

test('a switch sends its own counter, null before any save', async () => {
  const set = hook(() => useSetStaffCanManage(tenant))
  answer = () => json(200, { id: 'p', counter: 5 })
  expect(await set('fields', false)).toBe('saved')
  expect(await set('sourceCodes', true)).toBe('saved')
  expect(calls).toEqual([
    {
      url: '/api/t/alpha/preferences/fields',
      method: 'POST',
      body: { expected: 4, staffCanManage: false },
    },
    {
      url: '/api/t/alpha/preferences/sourceCodes',
      method: 'POST',
      body: { expected: null, staffCanManage: true },
    },
  ])
  expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.groups })
})

test('stale and refused saves are told apart, and refetch the groups', async () => {
  const set = hook(() => useSetStaffCanManage(tenant))
  answer = () =>
    json(409, {
      kind: 'stale',
      contract: 'tenantPreferences.fields',
      counter: 5,
      current: { staffCanManageFields: true },
    })
  expect(await set('fields', true)).toBe('stale')
  answer = () => json(403, { kind: 'forbidden' })
  expect(await set('fields', true)).toBe('failed')
  expect(invalidate).toHaveBeenCalledTimes(2)
})
