/**
 * Contact numbers (plan: factory/plans/contact-numbers.sv). Each contact
 * gets a sequence number, per tenant, from FIRST_NUMBER up, handed out in
 * creation order: a higher number means a newer contact. It is written
 * with a Luhn check digit (`formatNumber`), which isn't stored.
 *
 * The number is system-owned: no contract payload or create argument
 * carries it. The details contract's create branch takes it from the
 * sequence, and nothing changes it afterwards (`writers.test.ts` lists
 * every write to `contacts`).
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

/**
 * What a search entry says about contact numbers, spaces and hyphens
 * ignored: five digits are a sequence typed without its check digit, six
 * whose last digit checks are a written number (both `{ sequence }`, with
 * `written` telling them apart: a bare five digits is the weaker signal),
 * and six whose last digit doesn't check are `{ invalid, hint }`, the hint
 * for the list to show (g2q2). Anything else, including a sequence below
 * FIRST_NUMBER, isn't a number: null. Exact only, never a prefix (g2q4).
 *
 * Only sequences up to 99999 can be typed: from 100000 a written number
 * is seven digits, which this reads as null, so those contacts aren't
 * found by number. Far off for a small group (g1q3); widening it means
 * telling a seven-digit number from a phone fragment.
 */
export function parseNumber(
  term: string,
):
  | { sequence: number; written: boolean }
  | { invalid: true; hint: string }
  | null {
  const digits = term.replace(/[\s-]/g, '')
  if (!/^\d{5,6}$/.test(digits)) return null
  const sequence = Number(digits.slice(0, 5))
  if (sequence < FIRST_NUMBER) return null
  if (digits.length === 5) return { sequence, written: false }
  if (checkDigit(sequence) === Number(digits[5])) {
    return { sequence, written: true }
  }
  return {
    invalid: true,
    hint: `${digits} isn’t a valid contact number. Check the last digit.`,
  }
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
 * n - 1. The details contract's create branch takes one, after its
 * duplicate check, so every number taken goes on a contact. Within one
 * mutation the row's patches commit as one write, so a batch of creates
 * conflicts with other creates no more than a single one does.
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
  if (!Number.isInteger(sequence.next) || sequence.next < FIRST_NUMBER) {
    throw new Error(`takeNumbers: sequence at ${sequence.next}`)
  }
  await db.patch('contactNumberSequences', sequence._id, {
    next: sequence.next + n,
  })
  return sequence.next
}

/**
 * `takeNumbers` with its own read of the sequence, for numbering contacts
 * that already exist (the backfill): the caller must put every number of
 * the block on a contact in the same mutation. Creates never call it.
 */
export async function allocateNumbers(
  db: ScopedDatabaseWriter,
  n: number,
): Promise<number> {
  return takeNumbers(db, await readSequence(db), n)
}
