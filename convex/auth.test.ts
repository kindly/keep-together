import { convexTest } from 'convex-test'
import type { TestConvex } from 'convex-test'
import { beforeEach, describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'
import { modules } from '../test/fixture'
import { PASSWORD_MIN_LENGTH } from './lib/password'

/**
 * auth:signIn failures come back as coded ConvexErrors
 * (convex/lib/authErrors.ts), so the form never depends on a message that
 * production redacts. Asserting the kinds here also pins the library
 * messages toAuthError matches: a @convex-dev/auth upgrade that changes
 * them fails this test. Each case fails before tokens are issued, so no
 * auth keys are needed. Auth is not tenant-scoped, so there is no second
 * tenant to isolate.
 */
let t: TestConvex<typeof schema>

const signIn = (params: Record<string, string>) =>
  t.action(api.auth.signIn, { provider: 'password', params }).then(
    () => null,
    (e: unknown) => e as Error & { data?: unknown },
  )

beforeEach(async () => {
  t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'a@example.com' })
    // Not a real scrypt hash, so no password matches it.
    await ctx.db.insert('authAccounts', {
      userId,
      provider: 'password',
      providerAccountId: 'a@example.com',
      secret: 'not-a-hash',
    })
  })
})

describe('auth:signIn errors', () => {
  test('a short sign-up password is refused with a stable code', async () => {
    const err = await signIn({
      flow: 'signUp',
      email: 'b@example.com',
      password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1),
    })
    expect(err?.data).toEqual({
      kind: 'weakPassword',
      minLength: PASSWORD_MIN_LENGTH,
    })
    const accounts = await t.run((ctx) =>
      ctx.db.query('authAccounts').collect(),
    )
    expect(accounts.map((a) => a.providerAccountId)).toEqual(['a@example.com'])
  })

  test('a missing password is refused with the same code', async () => {
    const err = await signIn({ flow: 'signUp', email: 'b@example.com' })
    expect(err?.data).toEqual({
      kind: 'weakPassword',
      minLength: PASSWORD_MIN_LENGTH,
    })
  })

  test('a password of exactly the minimum length passes the rule', async () => {
    // Fails later (no auth keys in tests), but not on the password rule.
    const err = await signIn({
      flow: 'signUp',
      email: 'b@example.com',
      password: 'x'.repeat(PASSWORD_MIN_LENGTH),
    })
    expect(err?.data).toBeUndefined()
  })

  test('wrong password', async () => {
    const err = await signIn({
      flow: 'signIn',
      email: 'a@example.com',
      password: 'wrong-password',
    })
    expect(err?.data).toEqual({ kind: 'invalidCredentials' })
  })

  test('unknown email', async () => {
    const err = await signIn({
      flow: 'signIn',
      email: 'nobody@example.com',
      password: 'wrong-password',
    })
    expect(err?.data).toEqual({ kind: 'invalidCredentials' })
  })

  test('sign-up with an existing email', async () => {
    const err = await signIn({
      flow: 'signUp',
      email: 'a@example.com',
      password: 'long-enough-1',
    })
    expect(err?.data).toEqual({ kind: 'accountExists' })
  })
})
