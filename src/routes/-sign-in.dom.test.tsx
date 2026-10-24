// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { RustApiError } from '../lib/data/rust/client'
import type { AuthState } from '../lib/data'

// The sign-in page's steps (A4): password, the code, setting up a second
// step, and the recovery codes, which stay on screen until acknowledged
// even though the session is already signed in.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const navigated: Array<string> = []
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({ options }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  Navigate: ({ to }: { to: string }) => {
    navigated.push(to)
    return null
  },
}))

const state = vi.hoisted(() => ({
  current: undefined as AuthState | undefined,
  notice: null as string | null,
}))
const steps = vi.hoisted(() => ({
  signIn: vi.fn(),
  secondFactor: vi.fn(),
  sendCode: vi.fn(),
  enrolTotp: vi.fn(),
  enrolEmail: vi.fn(),
  confirmEnrolment: vi.fn(),
  stepUp: vi.fn(),
  acceptInvite: vi.fn(),
}))
vi.mock('../lib/data', () => ({
  useAuthState: () => state.current,
  useSignInNotice: () => state.notice,
  useSignInSteps: () => steps,
  useSignOut: () => vi.fn(),
}))

const { Route } = await import('./sign-in')
const SignIn = (Route as unknown as { options: { component: ComponentType } })
  .options.component

let root: Root
let el: HTMLElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  navigated.length = 0
  state.notice = null
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const render = () => act(() => root.render(<SignIn />))
const as = (stage: AuthState['stage'], extra: Partial<AuthState> = {}) => {
  state.current = {
    stage,
    email: 'ann@example.org',
    method: null,
    stepUpUntil: null,
    needsEmailCode: false,
    ...extra,
  }
}

function fill(placeholder: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  )!
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const button = (name: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === name)!

async function click(name: string) {
  await act(async () => {
    button(name).click()
    await Promise.resolve()
  })
}

async function submit() {
  await act(async () => {
    el.querySelector('form')!.requestSubmit()
    await new Promise((r) => setTimeout(r, 0))
  })
}

test('signed out: the password form, and our message for a wrong one', async () => {
  as('signed_out', { email: null })
  steps.signIn.mockRejectedValue(
    new RustApiError(422, {
      kind: 'rejected',
      reason: 'invalid_credentials',
      message: 'server text',
    }),
  )
  render()
  fill('Email', 'ann@example.org')
  fill('Password', 'hunter22')
  await submit()
  expect(steps.signIn).toHaveBeenCalledWith('ann@example.org', 'hunter22')
  expect(el.textContent).toContain('Wrong email or password.')
  expect(el.textContent).not.toContain('server text')
})

test('the second step names where the code went', () => {
  as('second_factor', { method: 'email' })
  render()
  expect(el.textContent).toContain(
    "We've emailed a 6-digit code to ann@example.org",
  )
  expect(button('Send a new code')).toBeTruthy()
  as('second_factor', { method: 'totp' })
  render()
  expect(el.textContent).toContain('authenticator app')
})

test('enrolling shows the QR code, then the recovery codes until acknowledged', async () => {
  as('enrol')
  const done = vi.fn(async () => {
    as('signed_in')
  })
  steps.enrolTotp.mockResolvedValue({
    secret: 'ABCDEF',
    url: 'otpauth://totp/x',
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  })
  steps.confirmEnrolment.mockResolvedValue({
    recoveryCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'],
    done,
  })
  render()
  await click('Use an authenticator app')
  expect(el.querySelector('img')!.getAttribute('src')).toMatch(
    /^data:image\/svg\+xml;utf8,/,
  )
  expect(el.textContent).toContain('ABCDEF')
  fill('Code', '123456')
  await submit()
  expect(steps.confirmEnrolment).toHaveBeenCalledWith(
    'totp',
    '123456',
    undefined,
  )
  expect(el.textContent).toContain('aaaaa-bbbbb')
  expect(done).not.toHaveBeenCalled()
  expect(navigated).toEqual([])
  await click("I've saved them")
  expect(done).toHaveBeenCalled()
})

test('signed in: on to the group', () => {
  as('signed_in')
  render()
  expect(navigated).toEqual(['/'])
})

// S1 review M5: past the address's sign-in limit the server answers
// check_email; the same email and password go again with the emailed code.
test('check your email: the code goes with the same email and password', async () => {
  as('signed_out', { email: null })
  steps.signIn.mockResolvedValueOnce({
    stage: 'check_email',
    email: 'ann@example.org',
    method: null,
    stepUpUntil: null,
    needsEmailCode: false,
  })
  render()
  fill('Email', 'ann@example.org')
  fill('Password', 'a-long-password')
  await submit()
  expect(el.textContent).toContain("we've emailed it a 6-digit code")
  fill('Emailed code', '123456')
  await submit()
  expect(steps.signIn).toHaveBeenLastCalledWith(
    'ann@example.org',
    'a-long-password',
    '123456',
  )
})

// S1 review M1: a sign-in ended by too many wrong codes says why.
test('why the last sign-in ended is shown over the password form', () => {
  as('signed_out', { email: null })
  state.notice = 'Too many wrong codes. Sign in again.'
  render()
  expect(el.querySelector('[role=alert]')!.textContent).toBe(
    'Too many wrong codes. Sign in again.',
  )
})

// S1 review M7: after a 2FA reset, the emailed code goes with the app's.
test('enrolling after a reset asks for the emailed code too', async () => {
  as('enrol', { needsEmailCode: true })
  steps.enrolTotp.mockResolvedValue({
    secret: 'ABCDEF',
    url: 'otpauth://totp/x',
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  })
  steps.confirmEnrolment.mockResolvedValue({ recoveryCodes: [], done: vi.fn() })
  render()
  expect(el.textContent).toContain('emailed you a code')
  await click('Use an authenticator app')
  fill("The app's code", '111111')
  fill('The emailed code', '222222')
  await submit()
  expect(steps.confirmEnrolment).toHaveBeenCalledWith(
    'totp',
    '111111',
    '222222',
  )
})
