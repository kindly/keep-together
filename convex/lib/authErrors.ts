import { ConvexError } from 'convex/values'

/**
 * The failures the sign-in form can tell apart. Production deployments
 * redact the message of any plain `Error` to "Server Error", so the codes
 * have to be attached on the server, where the library's message is still
 * readable; the client switches on `kind` only.
 */
export type AuthErrorData =
  | { kind: 'invalidCredentials' }
  | { kind: 'accountExists' }
  | { kind: 'weakPassword'; minLength: number }

/**
 * A @convex-dev/auth error as a coded ConvexError, or the error unchanged
 * if it isn't one we know. The only place that matches library messages;
 * convex/auth.test.ts pins them against the installed version. Unknown
 * email, wrong password and lock-out share one kind so the response never
 * says whether an account exists.
 */
export function toAuthError(err: unknown): unknown {
  if (err instanceof ConvexError || !(err instanceof Error)) return err
  if (
    /\b(InvalidAccountId|InvalidSecret|TooManyFailedAttempts|Invalid credentials)\b/.test(
      err.message,
    )
  ) {
    return new ConvexError<AuthErrorData>({ kind: 'invalidCredentials' })
  }
  if (/Account .* already exists/.test(err.message)) {
    return new ConvexError<AuthErrorData>({ kind: 'accountExists' })
  }
  return err
}

type Authorize = (params: never, ctx: never) => Promise<unknown>

/**
 * Wraps a credentials provider's server-side `authorize` so its failures
 * leave as coded ConvexErrors. Every password failure surfaces there: the
 * password rule, `retrieveAccount` (sign-in) and `createAccount` (sign-up)
 * all run inside it. The real `authorize` lives in the provider's internal
 * `options`, which Convex Auth merges over the top-level stub when it
 * materialises providers (server/provider_utils.js), so that is the one
 * replaced.
 */
export function withAuthErrorCodes<TProvider extends object>(
  provider: TProvider,
): TProvider {
  const { options } = provider as TProvider & {
    options: { authorize: Authorize }
  }
  const inner = options.authorize
  return {
    ...provider,
    options: {
      ...options,
      authorize: async (params: never, ctx: never) => {
        try {
          return await inner(params, ctx)
        } catch (err) {
          throw toAuthError(err)
        }
      },
    },
  }
}
