import type { FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import type { api } from '../../convex/_generated/api'
import { normaliseEmail } from '../../convex/contacts/rules'

/** comms:held's answer: the held addresses, keyed by normalised address. */
export type Held = FunctionReturnType<typeof api.comms.suppressions.held>
export type Hold = Held[string]

// Built once: `toLocaleDateString` with options makes one per call.
const ON = new Intl.DateTimeFormat([], {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/**
 * The hold on an email row's address, or undefined. Looked up by address,
 * not row: the hold belongs to the address in this group (ADR 0021), so it
 * shows on every contact using it, and survives removing and re-adding it.
 */
export function holdOn(
  address: string,
  held: Held | undefined,
): Hold | undefined {
  if (!held) return undefined
  const key = normaliseEmail(address)
  return Object.hasOwn(held, key) ? held[key] : undefined
}

/** The line under a held row. */
export function holdLine(hold: Hold): string {
  return `Bounced on ${ON.format(hold.since)}: we won't send to this address`
}

/** A user-facing line for a failed release. */
export function releaseFailure(err: unknown): string {
  if (!(err instanceof ConvexError)) return 'Could not release the address'
  const d = err.data as {
    kind?: string
    reason?: string
    message?: string
    problems?: Array<{ message: string }>
  }
  if (d.kind === 'stale')
    return 'This hold changed just now. Check it, then release again.'
  if (d.kind === 'rejected' && d.reason === 'not_held')
    return 'This address is no longer on hold'
  if (d.kind === 'forbidden') return 'Only admins can release an address'
  if (d.kind === 'invalid')
    return d.problems?.map((p) => p.message).join('; ') ?? 'Invalid note'
  return d.message ?? 'Could not release the address'
}
