// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import type { AuthState } from '../lib/data'

// KEEP_AUTH_POLICY=relaxed: a banner on every page (it sits in the root
// layout), signed out included; nothing under strict or while loading.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const state = vi.hoisted(() => ({
  current: undefined as AuthState | undefined,
}))
vi.mock('../lib/data', () => ({ useAuthState: () => state.current }))

const { RelaxedBanner } = await import('./relaxed-banner')

const signedOut = (policy: AuthState['policy']): AuthState => ({
  stage: 'signed_out',
  email: null,
  method: null,
  stepUpUntil: null,
  needsEmailCode: false,
  policy,
})

test.each([
  [undefined, false],
  [signedOut('strict'), false],
  [signedOut('relaxed'), true],
  [{ ...signedOut('relaxed'), stage: 'signed_in' as const }, true],
])('banner for %o: %s', (current, shown) => {
  state.current = current
  const el = document.createElement('div')
  const root = createRoot(el)
  act(() => root.render(<RelaxedBanner />))
  expect(el.textContent).toBe(shown ? 'Relaxed sign-in: not for real data' : '')
  act(() => root.unmount())
})
