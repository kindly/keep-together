import { getAuthUserId as library } from '@convex-dev/auth/server'
import type { Auth, UserIdentity } from 'convex/server'
import { describe, expect, test } from 'vitest'
import { getAuthUserId } from './authUser'

const ctx = (identity: Partial<UserIdentity> | null) => ({
  auth: { getUserIdentity: async () => identity } as unknown as Auth,
})

describe('getAuthUserId', () => {
  test.each([
    ['signed out', null],
    ['user and session', { subject: 'k17abc|k57def' }],
    ['no session part', { subject: 'k17abc' }],
    ['empty subject', { subject: '' }],
  ])('matches @convex-dev/auth: %s', async (_, identity) => {
    expect(await getAuthUserId(ctx(identity))).toEqual(
      await library(ctx(identity) as never),
    )
  })
})
