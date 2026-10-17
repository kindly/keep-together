import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'
import {
  ACCOUNT_EXISTS,
  NETWORK,
  UNEXPECTED,
  WRONG_CREDENTIALS,
  authErrorMessage,
} from './auth-errors'

describe('authErrorMessage', () => {
  test('coded server errors', () => {
    expect(
      authErrorMessage(new ConvexError({ kind: 'invalidCredentials' })),
    ).toBe(WRONG_CREDENTIALS)
    expect(authErrorMessage(new ConvexError({ kind: 'accountExists' }))).toBe(
      ACCOUNT_EXISTS,
    )
    expect(
      authErrorMessage(new ConvexError({ kind: 'weakPassword', minLength: 8 })),
    ).toBe('Password must be at least 8 characters.')
  })

  test('network failures', () => {
    expect(
      authErrorMessage(new Error('Connection lost while action was in flight')),
    ).toBe(NETWORK)
    expect(authErrorMessage(new TypeError('Failed to fetch'))).toBe(NETWORK)
  })

  test('anything else is generic and never echoes the server text', () => {
    for (const err of [
      // Production redacts plain errors to this (docs/spikes/07, item c is dev).
      new Error('[Request ID: be396d5b2fcdb708] Server Error'),
      new Error(
        '[CONVEX A(auth:signIn)] Server Error Uncaught Error: InvalidSecret\n    at retrieveAccount (../home/david/projects/x/node_modules/…)',
      ),
      new ConvexError({ kind: 'somethingElse' }),
      new ConvexError({ kind: 'weakPassword' }),
      new ConvexError('a string payload'),
      'not an error',
      undefined,
    ]) {
      expect(authErrorMessage(err)).toBe(UNEXPECTED)
    }
  })
})
