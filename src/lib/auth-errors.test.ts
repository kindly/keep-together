import { describe, expect, test } from 'vitest'
import { RustApiError } from './data/rust/client'
import {
  LINK_EXPIRED,
  NETWORK,
  RATE_LIMITED,
  UNEXPECTED,
  WRONG_CODE,
  WRONG_CREDENTIALS,
  authErrorMessage,
  needsStepUp,
} from './auth-errors'

const rejected = (reason: string, message = 'server text') =>
  new RustApiError(422, { kind: 'rejected', reason, message })

describe('authErrorMessage', () => {
  test('coded server refusals', () => {
    expect(authErrorMessage(rejected('invalid_credentials'))).toBe(
      WRONG_CREDENTIALS,
    )
    expect(authErrorMessage(rejected('wrong_code'))).toBe(WRONG_CODE)
    expect(authErrorMessage(rejected('link_expired'))).toBe(LINK_EXPIRED)
    expect(
      authErrorMessage(
        new RustApiError(422, {
          kind: 'invalid',
          problems: [
            {
              field: 'password',
              message: 'Password must be at least 8 characters.',
            },
          ],
        }),
      ),
    ).toBe('Password must be at least 8 characters.')
    expect(
      authErrorMessage(new RustApiError(429, { kind: 'rate_limited' })),
    ).toBe(RATE_LIMITED)
    // Other refusals carry one of the server's own fixed sentences.
    expect(
      authErrorMessage(rejected('last_admin', 'A group needs an admin.')),
    ).toBe('A group needs an admin.')
  })

  test('network failures', () => {
    expect(authErrorMessage(new RustApiError(0, { kind: 'internal' }))).toBe(
      NETWORK,
    )
  })

  test('anything else is generic and never echoes the server text', () => {
    for (const err of [
      new RustApiError(500, { kind: 'internal' }),
      new RustApiError(403, { kind: 'forbidden' }),
      new Error('[Request ID: be396d5b2fcdb708] Server Error'),
      'not an error',
      undefined,
    ]) {
      expect(authErrorMessage(err)).toBe(UNEXPECTED)
    }
  })

  test('step-up', () => {
    expect(
      needsStepUp(new RustApiError(403, { kind: 'step_up_required' })),
    ).toBe(true)
    expect(needsStepUp(new RustApiError(403, { kind: 'forbidden' }))).toBe(
      false,
    )
  })
})
