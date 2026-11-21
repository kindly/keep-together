/**
 * Pounds and pence on the donor's page. Money is integer pence, held as
 * `bigint` and never passed through a float (CLAUDE.md rule 7). The same
 * rules as the app's `#/lib/gifts` (`parsePounds`, `formatPence`), copied
 * because this page shares none of the app's bundle.
 */

/**
 * What a donor typed as an amount in pounds, as pence: "20", "20.5",
 * "£1,250.00". Null for anything else (a third decimal, a letter, a minus
 * sign, empty).
 */
export function parsePounds(text: string): bigint | null {
  const m = /^£?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/.exec(
    text.trim().replace(/\s+/g, ''),
  )
  if (!m) return null
  // Optional groups that didn't take part are undefined.
  const [, whole, fraction] = m as Array<string | undefined>
  if (whole === undefined && fraction === undefined) return null
  const pounds = BigInt((whole ?? '0').replace(/,/g, ''))
  const pence = BigInt((fraction ?? '0').padEnd(2, '0'))
  return pounds * 100n + pence
}

/** Pence as a donor reads them: "£25", "£2.50", "£1,000". */
export function formatPence(pence: bigint): string {
  const pounds = (pence / 100n).toString().replace(/\B(?=(\d{3})+$)/g, ',')
  const rest = pence % 100n
  return rest === 0n
    ? `£${pounds}`
    : `£${pounds}.${rest.toString().padStart(2, '0')}`
}

/** The wire's pence (a JSON number, always a whole one) as `bigint`. */
export function fromWire(pence: number): bigint {
  return BigInt(Math.trunc(pence))
}

/**
 * Pence for the wire. The page's amounts are at most the server's
 * ceiling (£1,000), far inside what a JSON number holds exactly.
 */
export function toWire(pence: bigint): number {
  return Number(pence)
}

/** 25% of the gift, rounded down to a penny: what Gift Aid adds. */
export function giftAidOn(pence: bigint): bigint {
  return pence / 4n
}
