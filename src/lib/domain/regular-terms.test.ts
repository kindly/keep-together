// The twin of `giving::terms_rules`'s tests: the same cases, the same
// answers (ADR 0026).
import { describe, expect, test } from 'vitest'
import {
  annualValue,
  changeKind,
  downgradeSplit,
  expectedPeriods,
  isDueDate,
  monthIndex,
  nextDue,
  splitForCollected,
  termInForce,
  total,
  upgradeSplit,
} from './regular-terms'
import type { Share, Terms } from './regular-terms'

const STREET = 'street'
const TEL = 'telephone'
const s = (sourceCodeId: string, amount: number): Share => ({
  sourceCodeId,
  amount: BigInt(amount),
})
const street10 = [s(STREET, 1000)]

function terms(
  effectiveOn: string,
  amount: number,
  split: Array<Share>,
): Terms {
  return {
    effectiveOn,
    amount: BigInt(amount),
    frequency: 'monthly',
    dayOfMonth: 5,
    month: null,
    split,
  }
}

describe('regular gift terms', () => {
  test('an upgrade gives the difference to the code that won it', () => {
    expect(upgradeSplit(street10, 1200n, TEL)).toEqual([
      s(STREET, 1000),
      s(TEL, 200),
    ])
    expect(upgradeSplit([s(STREET, 1000), s(TEL, 200)], 1500n, TEL)).toEqual([
      s(STREET, 1000),
      s(TEL, 500),
    ])
    expect(upgradeSplit(street10, 1000n, TEL)).toEqual(street10)
  })

  test('a downgrade comes off the newest money first', () => {
    const split = [s(STREET, 1000), s(TEL, 200)]
    expect(downgradeSplit(split, 1100n)).toEqual([s(STREET, 1000), s(TEL, 100)])
    expect(downgradeSplit(split, 800n)).toEqual([s(STREET, 800)])
    expect(downgradeSplit(split, 1000n)).toEqual([s(STREET, 1000)])
  })

  test('a payment copies the split with the newest layer absorbing the difference', () => {
    const split = [s(STREET, 1000), s(TEL, 200)]
    expect(splitForCollected(split, 1000n)).toEqual([s(STREET, 1000)])
    expect(splitForCollected(split, 1300n)).toEqual([
      s(STREET, 1000),
      s(TEL, 300),
    ])
    expect(splitForCollected(split, 1200n)).toEqual(split)
  })

  test('every split sums to its amount', () => {
    const split = [s(STREET, 700), s(TEL, 250), s('mail', 51)]
    for (let a = 1n; a <= 2000n; a++) {
      const up = a > 1001n ? a : 1001n
      const down = a < 1001n ? a : 1001n
      expect(total(upgradeSplit(split, up, TEL))).toBe(up)
      expect(total(downgradeSplit(split, down))).toBe(down)
      const got = splitForCollected(split, a)
      expect(total(got)).toBe(a)
      expect(got.every((x) => x.amount > 0n)).toBe(true)
    }
  })

  test('the row in force includes its effective date', () => {
    const chain = [
      terms('2026-01-05', 1000, street10),
      terms('2026-12-05', 1200, []),
    ]
    expect(termInForce(chain, '2026-01-04')).toBeUndefined()
    expect(termInForce(chain, '2026-12-04')?.amount).toBe(1000n)
    expect(termInForce(chain, '2026-12-05')?.amount).toBe(1200n)
    expect(termInForce(chain, '2027-03-05')?.amount).toBe(1200n)
  })

  test('the change kind is by annual value, then schedule, then split', () => {
    const old = terms('2026-01-05', 1000, street10)
    const up = terms('2026-12-05', 1200, [])
    expect(changeKind(undefined, old)).toBe('setup')
    expect(changeKind(old, up)).toBe('upgrade')
    expect(changeKind(up, old)).toBe('downgrade')
    expect(
      changeKind(old, {
        ...old,
        amount: 12000n,
        frequency: 'yearly',
        month: 3,
      }),
    ).toBe('schedule')
    expect(changeKind(old, { ...old, dayOfMonth: 20 })).toBe('schedule')
    expect(changeKind(old, { ...old, split: [s(TEL, 1000)] })).toBe(
      'reallocation',
    )
    expect(changeKind(old, old)).toBe('unchanged')
    expect(annualValue(200n, 'monthly')).toBe(2400n)
    expect(annualValue(200n, 'yearly')).toBe(200n)
  })

  test('expected periods follow the row in force and stop at cancellation', () => {
    const chain = [
      terms('2026-09-05', 1000, street10),
      terms('2026-12-05', 1200, [s(STREET, 1000), s(TEL, 200)]),
    ]
    const got = expectedPeriods(chain, null, '2026-08-01', '2027-01-31')
    expect(got.map((p) => [p.period, p.amount])).toEqual([
      ['2026-09', 1000n],
      ['2026-10', 1000n],
      ['2026-11', 1000n],
      ['2026-12', 1200n],
      ['2027-01', 1200n],
    ])
    expect(got[3].dueOn).toBe('2026-12-05')
    expect(got[3].row).toBe(1)
    expect(
      expectedPeriods(chain, '2026-11-03', '2026-08-01', '2027-01-31'),
    ).toHaveLength(2)
    const yearly: Array<Terms> = [
      {
        ...terms('2026-03-05', 12000, [s(STREET, 12000)]),
        frequency: 'yearly',
        month: 3,
      },
    ]
    expect(
      expectedPeriods(yearly, null, '2026-01-01', '2028-12-31').map(
        (p) => p.dueOn,
      ),
    ).toEqual(['2026-03-05', '2027-03-05', '2028-03-05'])
  })

  test('a quarterly row is due in its month and every third after', () => {
    const t: Terms = {
      ...terms('2026-02-01', 3000, [s(STREET, 3000)]),
      frequency: 'quarterly',
      dayOfMonth: 10,
      month: 2,
    }
    expect(
      expectedPeriods([t], null, '2026-01-01', '2026-12-31').map((p) => p.dueOn),
    ).toEqual(['2026-02-10', '2026-05-10', '2026-08-10', '2026-11-10'])
    expect(isDueDate(t, '2026-05-12')).toBe(true)
    expect(isDueDate(t, '2026-06-10')).toBe(false)
    expect(annualValue(3000n, 'quarterly')).toBe(12000n)
    expect(nextDue(t, '2026-11-10', 2)).toEqual(['2027-02-10', '2027-05-10'])
  })

  test('next due lists the coming payment dates', () => {
    const t = terms('2026-09-05', 1000, street10)
    expect(nextDue(t, '2026-10-05', 3)).toEqual([
      '2026-11-05',
      '2026-12-05',
      '2027-01-05',
    ])
    expect(nextDue(t, '2026-10-04', 1)).toEqual(['2026-10-05'])
  })

  test('a change starts on one of its payment dates', () => {
    const t = terms('2026-12-05', 1200, [])
    expect(isDueDate(t, '2026-12-05')).toBe(true)
    expect(isDueDate(t, '2026-12-07')).toBe(true)
    expect(isDueDate(t, '2026-12-10')).toBe(false)
    expect(isDueDate(t, '2026-12-04')).toBe(false)
    const yearly: Terms = { ...t, frequency: 'yearly', month: 3 }
    expect(isDueDate(yearly, '2027-03-05')).toBe(true)
    expect(isDueDate(yearly, '2027-04-05')).toBe(false)
    expect(monthIndex('2026/05')).toBeUndefined()
    expect(monthIndex('+026-05')).toBeUndefined()
    expect(monthIndex('2026-05')).toBe(monthIndex('2026-05-01'))
  })
})
