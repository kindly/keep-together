/**
 * Contact numbers (plan: factory/plans/contact-numbers.sv). Each contact
 * gets a sequence number, per tenant, from FIRST_NUMBER up, handed out in
 * creation order: a higher number means a newer contact. It is written
 * with a Luhn check digit (`formatNumber`), which isn't stored.
 *
 * The number is system-owned: no contract payload carries it. The details
 * contract's create branch sets it, and nothing changes it afterwards.
 *
 * One `contactNumberSequences` row per tenant holds the next number, in
 * its own table so only creates conflict on it (a counter on `tenants`
 * would conflict with every function that reads the tenant). Every write
 * to that table is here (`writers.test.ts` holds the line).
 */
import type { Doc } from '../_generated/dataModel'
import type { ScopedDatabaseReader, ScopedDatabaseWriter } from '../lib/tenancy'

/** A tenant's first contact number. */
export const FIRST_NUMBER = 10001

/**
 * The Luhn check digit for `sequence`: catches every single wrong digit
 * and every swap of two neighbouring digits except 09↔90.
 */
export function checkDigit(sequence: number): number {
  const digits = String(sequence)
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    // Doubled: the rightmost digit, then every second one leftwards.
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}

/** The number as staff see and write it: the sequence and its check digit. */
export function formatNumber(sequence: number): string {
  return `${sequence}${checkDigit(sequence)}`
}

/** The tenant's sequence row, or null before its first allocation. */
export function readSequence(
  db: ScopedDatabaseReader,
): Promise<Doc<'contactNumberSequences'> | null> {
  return db.query('contactNumberSequences').withIndex('by_tenant').unique()
}

/**
 * Take the next `n` numbers from `sequence` (what `readSequence` returned
 * in this transaction) and return the first: the block is first … first +
 * n - 1, in the order the caller creates its contacts. A batch takes its
 * block once, so the row is written once per batch, not once per contact.
 */
export async function takeNumbers(
  db: ScopedDatabaseWriter,
  sequence: Doc<'contactNumberSequences'> | null,
  n: number,
): Promise<number> {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`takeNumbers: ${n} is not a positive count`)
  }
  if (!sequence) {
    await db.insert('contactNumberSequences', { next: FIRST_NUMBER + n })
    return FIRST_NUMBER
  }
  await db.patch('contactNumberSequences', sequence._id, {
    next: sequence.next + n,
  })
  return sequence.next
}

/** `takeNumbers` with its own read of the sequence. */
export async function allocateNumbers(
  db: ScopedDatabaseWriter,
  n: number,
): Promise<number> {
  return takeNumbers(db, await readSequence(db), n)
}
