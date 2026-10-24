import { RustApiError } from './data/rust/client'

export const WRONG_CREDENTIALS = 'Wrong email or password.'
export const WRONG_CODE = "That code didn't work. Check it and try again."
export const RATE_LIMITED = 'Too many attempts. Wait a minute and try again.'
export const SESSION_ENDED = 'Your sign-in expired. Start again.'
export const LINK_EXPIRED =
  'This link has expired or was already used. Ask for a new one.'
export const NETWORK =
  'Could not reach the server. Check your connection and try again.'
export const UNEXPECTED = 'Something went wrong, please try again.'

export const weakPasswordMessage = (minLength: number) =>
  `Password must be at least ${minLength} characters.`

/** Known refusals (`rejected.reason`) and what the forms say. */
const REASONS: Record<string, string> = {
  invalid_credentials: WRONG_CREDENTIALS,
  wrong_code: WRONG_CODE,
  link_expired: LINK_EXPIRED,
}

/**
 * What an auth form shows for an error from the Rust API: our own
 * sentences for the refusals we know, the server's sentence for other
 * `rejected` (each is a fixed string of ours, never an error's text), the
 * problems of an `invalid`, and a generic line for anything else.
 */
export function authErrorMessage(err: unknown): string {
  if (!(err instanceof RustApiError)) return UNEXPECTED
  const e = err.error
  if (err.status === 0) return NETWORK
  switch (e.kind) {
    case 'rejected':
      return REASONS[e.reason] ?? e.message
    case 'invalid':
      return e.problems.map((p) => p.message).join(' ') || UNEXPECTED
    case 'rate_limited':
      return RATE_LIMITED
    case 'unauthenticated':
      return SESSION_ENDED
    default:
      return UNEXPECTED
  }
}

/** Whether `err` asks for a step-up before retrying. */
export const needsStepUp = (err: unknown) =>
  err instanceof RustApiError && err.error.kind === 'step_up_required'
