import type { Auth } from 'convex/server'
import type { Id } from '../_generated/dataModel'

/**
 * @convex-dev/auth's `getAuthUserId`, without importing its server bundle
 * on every domain call (`appSchema.ts` says why): the token's subject is
 * `<userId>|<sessionId>`. `authUser.test.ts` holds it to the library's.
 */
export async function getAuthUserId(ctx: {
  auth: Auth
}): Promise<Id<'users'> | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (identity === null) return null
  return identity.subject.split('|')[0] as Id<'users'>
}
