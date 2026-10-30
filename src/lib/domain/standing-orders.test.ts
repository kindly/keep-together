// The standing-order form's pure rules, in step with
// `giving::regular::schedule_problems` (days 1–28; quarterly and yearly
// take their month).
import { expect, test } from 'vitest'
import {
  nextDue,
  scheduleOf,
  startProblem,
  termInForce,
} from './standing-orders'

test('a first payment date gives the day, and the month unless monthly', () => {
  expect(scheduleOf('2026-02-10', 'monthly')).toEqual({
    dayOfMonth: 10,
    month: null,
  })
  expect(scheduleOf('2026-02-10', 'quarterly')).toEqual({
    dayOfMonth: 10,
    month: 2,
  })
  expect(scheduleOf('2026-11-03', 'yearly')).toEqual({
    dayOfMonth: 3,
    month: 11,
  })
})

test('a first payment falls on days 1 to 28', () => {
  expect(startProblem('2026-02-28')).toBeNull()
  expect(startProblem('2026-01-29')).toMatch(/28th or earlier/)
  expect(startProblem('')).toMatch(/Pick the date/)
})

test('the row in force is the last started, never a withdrawn one', () => {
  const chain = [
    { id: 'a', effectiveOn: '2026-01-01', status: 'applied' },
    { id: 'b', effectiveOn: '2026-06-01', status: 'applied' },
    { id: 'c', effectiveOn: '2026-03-01', status: 'withdrawn' },
  ]
  expect(termInForce(chain, '2026-04-01')?.id).toBe('a')
  expect(termInForce(chain, '2026-07-01')?.id).toBe('b')
  expect(termInForce(chain, '2025-12-01')?.id).toBe('a')
})

test('next due is the first upcoming payment from today', () => {
  const rows = [
    { dueOn: '2026-01-05', status: 'missing' },
    { dueOn: '2026-02-05', status: 'upcoming' },
  ]
  expect(nextDue(rows, '2026-01-20')).toBe('2026-02-05')
  expect(nextDue(rows, '2026-02-06')).toBeNull()
})
