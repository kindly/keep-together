import type { Field } from './api'

/**
 * How long each thing a donor types may be: characters, after trimming.
 * The server's `giving::stripe::prepare_submission` enforces the same
 * (`422 invalid`); keep the two in step.
 */
export const LIMITS: Record<Exclude<Field, 'amount'>, number> = {
  firstName: 200,
  lastName: 200,
  email: 254,
  addressLine1: 200,
  postcode: 20,
}

/**
 * The message for a value over its limit, or null. Characters are counted
 * as the server counts them (code points, so an accented letter or an
 * emoji is one), not as UTF-16 units.
 */
export function tooLong(
  field: Exclude<Field, 'amount'>,
  value: string,
): string | null {
  const max = LIMITS[field]
  return Array.from(value.trim()).length > max
    ? `At most ${max} characters`
    : null
}
