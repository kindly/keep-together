import { ConvexError } from 'convex/values'
import type { AuthErrorData } from '../../convex/lib/authErrors'

export const WRONG_CREDENTIALS = 'Wrong email or password.'
export const ACCOUNT_EXISTS =
  'Could not create an account with that email. If you already have one, sign in instead.'
export const NETWORK =
  'Could not reach the server. Check your connection and try again.'
export const UNEXPECTED = 'Something went wrong, please try again.'

export const weakPasswordMessage = (minLength: number) =>
  `Password must be at least ${minLength} characters.`

/**
 * What the sign-in form shows for an error from Convex Auth's `signIn`.
 * Never the raw message: on a dev deployment it carries the server stack
 * and local file paths, and on production it is a bare "Server Error".
 * Known failures arrive as ConvexErrors coded on the server
 * (convex/lib/authErrors.ts); the only thing matched here is the client's
 * own network failure, which never reaches the server.
 */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as Partial<AuthErrorData> | undefined
    switch (data?.kind) {
      case 'invalidCredentials':
        return WRONG_CREDENTIALS
      case 'accountExists':
        return ACCOUNT_EXISTS
      case 'weakPassword':
        return typeof data.minLength === 'number'
          ? weakPasswordMessage(data.minLength)
          : UNEXPECTED
      default:
        return UNEXPECTED
    }
  }
  const message = err instanceof Error ? err.message : ''
  if (
    message.includes('Connection lost') ||
    (err instanceof TypeError && /fetch|network|load failed/i.test(message))
  ) {
    return NETWORK
  }
  return UNEXPECTED
}
