import { ConvexError } from 'convex/values'
import type { AuthErrorData } from './authErrors'

/**
 * The sign-up password rule, shared by convex/auth.ts (enforces it) and the
 * sign-in form (states it). Same minimum as Convex Auth's default, made
 * explicit so the UI can say it and the server can refuse it with a stable
 * code instead of a plain `Error("Invalid password")`.
 */
export const PASSWORD_MIN_LENGTH = 8

export function validatePassword(password: string | undefined): void {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    throw new ConvexError<AuthErrorData>({
      kind: 'weakPassword',
      minLength: PASSWORD_MIN_LENGTH,
    })
  }
}
