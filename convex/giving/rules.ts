/**
 * The gift's blocking checks (tier 1, ADR 0015). Pure: no Convex imports
 * except types, so the UI can run them too.
 */
import type { Problem } from '../lib/contracts'
import { invalid } from '../lib/contracts'
import type { GiftPayload } from './validators'

/** Most source codes one gift is split across. */
export const ALLOCATION_LIMIT = 20

/** Longest card reference kept (a receipt or transaction id). */
export const REFERENCE_MAX = 200

/** Whether `value` is a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  )
}

/**
 * Normalise a gift and refuse what can't be stored: an amount of 0 or
 * less, a date that isn't one, allocations missing, not positive or not
 * summing to the amount, or a reference on a cash gift. Mints missing
 * allocation keys; an empty reference is none.
 */
export function prepareGift(p: GiftPayload): GiftPayload {
  const problems: Array<Problem> = []
  const reference = p.reference?.trim() || undefined
  if (p.amount <= 0n) {
    problems.push({ field: 'amount', message: 'The amount must be over £0' })
  }
  if (!isIsoDate(p.receivedOn)) {
    problems.push({ field: 'receivedOn', message: 'Dates are YYYY-MM-DD' })
  }
  if (reference !== undefined && p.method !== 'card') {
    problems.push({
      field: 'reference',
      message: 'Only a card payment has a reference',
    })
  }
  if (reference !== undefined && reference.length > REFERENCE_MAX) {
    problems.push({
      field: 'reference',
      message: `At most ${REFERENCE_MAX} characters`,
    })
  }
  if (p.allocations.length === 0) {
    problems.push({ field: 'allocations', message: 'Pick a source code' })
  } else if (p.allocations.length > ALLOCATION_LIMIT) {
    problems.push({
      field: 'allocations',
      message: `At most ${ALLOCATION_LIMIT} source codes`,
    })
  }
  const allocations = p.allocations.map((a) => ({
    ...a,
    key: a.key || crypto.randomUUID(),
  }))
  const keys = new Set(allocations.map((a) => a.key))
  if (keys.size !== allocations.length) {
    problems.push({ field: 'allocations', message: 'Duplicate row key' })
  }
  if (allocations.some((a) => a.amount <= 0n)) {
    problems.push({
      field: 'allocations',
      message: 'Each share must be over £0',
    })
  }
  const total = allocations.reduce((sum, a) => sum + a.amount, 0n)
  if (allocations.length && total !== p.amount) {
    problems.push({
      field: 'allocations',
      message: 'The shares must add up to the amount',
    })
  }
  if (problems.length) throw invalid(problems)
  return { ...p, reference, allocations }
}

/** Pence as pounds for names and messages: `£20`, `£20.50`, `£1,250`. */
export function formatPence(amount: bigint): string {
  const sign = amount < 0n ? '-' : ''
  const abs = amount < 0n ? -amount : amount
  const pounds = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const pence = abs % 100n
  return `${sign}£${pounds}${pence ? `.${pence.toString().padStart(2, '0')}` : ''}`
}
