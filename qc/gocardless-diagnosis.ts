import type { QcCaughtUp } from '../src/lib/data/rust-types/QcCaughtUp'
import type { QcPeek } from '../src/lib/data/rust-types/QcPeek'

// What the GoCardless sandbox spec (flows/gocardless-sandbox.spec.ts)
// says when a wait runs out: what the catch-up read, and whose side a
// read of nothing is on, so the failure explains itself without the
// server's logs or GoCardless's dashboard.

/**
 * The catch-up's answer, in words. A read of nothing is set against
 * GoCardless's newest event for the account: older than the read's
 * start (or none at all), GoCardless made no events, which is its side;
 * inside the read, the catch-up missed them, which is ours.
 */
export function caughtUpSays(c: QcCaughtUp): string {
  const read = `it read ${c.read} events since ${c.since}, ${c.missed} missed`
  if (c.read > 0) return read
  const newest = c.newestEventAt
  if (newest === null)
    return `${read}; GoCardless lists no events at all for the account (GoCardless’s side)`
  if (Date.parse(newest) < Date.parse(c.since))
    return (
      `${read}; GoCardless’s newest event for the account is from ${newest}, ` +
      `before the read began (this server’s clock: ${c.checkedAt}): GoCardless ` +
      `has made no events since, so neither a webhook nor the catch-up could ` +
      `bring one (GoCardless’s side)`
    )
  return (
    `${read}; yet GoCardless’s newest event for the account is from ${newest}, ` +
    `inside the read (this server’s clock: ${c.checkedAt}): the catch-up ` +
    `missed it (our side)`
  )
}

/** A billing request as GoCardless has it, with the mandate it made. */
export function billingRequestSays(p: QcPeek): string {
  const made =
    p.mandateId === null
      ? 'with no mandate'
      : `its mandate ${p.mandateId} ${p.mandateStatus ?? 'of no status'}`
  return `GoCardless has the billing request ${p.id} ${p.status}, ${made}`
}
