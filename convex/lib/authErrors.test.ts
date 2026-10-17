import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'
import { toAuthError, withAuthErrorCodes } from './authErrors'

const kindOf = (e: unknown) =>
  e instanceof ConvexError ? (e.data as { kind: string }).kind : undefined

// As an action sees them: errors from the nested auth:store mutation are
// prefixed by the runtime.
const wrapped = (detail: string) => new Error(`Uncaught Error: ${detail}`)

describe('toAuthError', () => {
  test('sign-in failures share one kind', () => {
    for (const code of [
      'InvalidSecret',
      'InvalidAccountId',
      'TooManyFailedAttempts',
      'Invalid credentials',
    ]) {
      expect(kindOf(toAuthError(new Error(code)))).toBe('invalidCredentials')
      expect(kindOf(toAuthError(wrapped(code)))).toBe('invalidCredentials')
    }
  })

  test('existing account', () => {
    expect(
      kindOf(toAuthError(wrapped('Account a@example.com already exists'))),
    ).toBe('accountExists')
  })

  test('ConvexErrors and unknown errors pass through unchanged', () => {
    const coded = new ConvexError({ kind: 'weakPassword', minLength: 8 })
    const unknown = new Error('Missing `flow` param')
    expect(toAuthError(coded)).toBe(coded)
    expect(toAuthError(unknown)).toBe(unknown)
    expect(toAuthError('a string')).toBe('a string')
  })
})

describe('withAuthErrorCodes', () => {
  const provider = (authorize: () => Promise<unknown>) =>
    withAuthErrorCodes({
      id: 'password',
      authorize: async () => null,
      options: { authorize, crypto: 'kept' },
    })

  test('replaces options.authorize and keeps the rest', async () => {
    const p = provider(async () => ({ userId: 'u' }))
    expect(p.id).toBe('password')
    expect(p.options.crypto).toBe('kept')
    expect(await p.options.authorize()).toEqual({ userId: 'u' })
  })

  test('codes known failures and rethrows the rest', async () => {
    const bad = provider(async () => {
      throw new Error('InvalidSecret')
    })
    await expect(bad.options.authorize()).rejects.toMatchObject({
      data: { kind: 'invalidCredentials' },
    })
    const odd = new Error('something else')
    await expect(
      provider(async () => {
        throw odd
      }).options.authorize(),
    ).rejects.toBe(odd)
  })
})
