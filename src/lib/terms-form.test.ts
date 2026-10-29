// "Change amount or schedule" (regular-gift terms step 6): what the
// dialog proposes, on the TS twin of `giving::terms_rules`.
import { describe, expect, test } from 'vitest'
import type { ChainRow } from './terms-form'
import {
  addDays,
  effectiveOptions,
  liveChain,
  proposedSplit,
  rowBefore,
  sameSchedule,
  splitProblem,
} from './terms-form'

const row = (over: Partial<ChainRow>): ChainRow => ({
  id: 'r1',
  effectiveOn: '2026-01-01',
  amount: 1000n,
  frequency: 'monthly',
  dayOfMonth: 1,
  month: null,
  status: 'applied',
  allocations: [{ sourceCodeId: 'street', amount: 1000n }],
  ...over,
})

describe('the chain a change reads', () => {
  test('withdrawn rows and the row being edited are left out', () => {
    const chain = liveChain([
      row({}),
      row({ id: 'r2', effectiveOn: '2026-06-01', status: 'withdrawn' }),
      row({ id: 'r3', effectiveOn: '2026-12-01', status: 'scheduled' }),
    ])
    expect(chain.map((t) => t.effectiveOn)).toEqual([
      '2026-01-01',
      '2026-12-01',
    ])
    expect(
      liveChain([row({}), row({ id: 'r3', effectiveOn: '2026-12-01' })], 'r3'),
    ).toHaveLength(1)
  })

  test('the row before a date is the last one strictly before it', () => {
    const chain = liveChain([
      row({}),
      row({ id: 'r2', effectiveOn: '2026-06-01', amount: 1200n }),
    ])
    expect(rowBefore(chain, '2026-06-01')?.effectiveOn).toBe('2026-01-01')
    expect(rowBefore(chain, '2026-07-01')?.amount).toBe(1200n)
    expect(rowBefore(chain, '')?.amount).toBe(1200n)
    expect(rowBefore(chain, '2025-12-01')).toBeUndefined()
  })
})

describe('the proposed split', () => {
  const street = [{ sourceCodeId: 'street', amount: 1000n }]

  test('an upgrade: the difference to the code that won it, a new last layer', () => {
    expect(proposedSplit(street, 1200n, 'phone')).toEqual([
      { sourceCodeId: 'street', amount: 1000n },
      { sourceCodeId: 'phone', amount: 200n },
    ])
  })

  test('a downgrade comes off the newest money first', () => {
    const upgraded = [...street, { sourceCodeId: 'phone', amount: 200n }]
    expect(proposedSplit(upgraded, 1100n, null)).toEqual([
      { sourceCodeId: 'street', amount: 1000n },
      { sourceCodeId: 'phone', amount: 100n },
    ])
    expect(proposedSplit(upgraded, 800n, null)).toEqual([
      { sourceCodeId: 'street', amount: 800n },
    ])
  })
})

describe('the payment a change starts on', () => {
  const upcoming = [
    { chargeDate: '2026-11-02', changeable: false },
    { chargeDate: '2026-12-01', changeable: true },
    { chargeDate: '2027-01-04', changeable: true },
  ]
  const monthly1 = { frequency: 'monthly', dayOfMonth: 1, month: null } as const

  test('same schedule: GoCardless’s next payments still far enough off', () => {
    expect(
      effectiveOptions({
        schedule: monthly1,
        same: true,
        upcoming,
        today: '2026-10-29',
      }),
    ).toEqual(['2026-12-01', '2027-01-04'])
  })

  test('a new day: the new schedule’s dates from the first changeable payment', () => {
    expect(
      effectiveOptions({
        schedule: { frequency: 'monthly', dayOfMonth: 15, month: null },
        same: false,
        upcoming,
        today: '2026-10-29',
        count: 3,
      }),
    ).toEqual(['2026-12-15', '2027-01-15', '2027-02-15'])
  })

  test('yearly: only its month', () => {
    expect(
      effectiveOptions({
        schedule: { frequency: 'yearly', dayOfMonth: 5, month: 3 },
        same: false,
        upcoming,
        today: '2026-10-29',
        count: 2,
      }),
    ).toEqual(['2027-03-05', '2028-03-05'])
  })

  test('an edited row keeps its own date while it still fits', () => {
    expect(
      effectiveOptions({
        schedule: monthly1,
        same: true,
        upcoming,
        today: '2026-10-29',
        own: '2027-02-01',
      }),
    ).toEqual(['2026-12-01', '2027-01-04', '2027-02-01'])
  })

  test('schedules compare month only when yearly', () => {
    expect(sameSchedule(monthly1, { ...monthly1, month: 4 })).toBe(true)
    expect(
      sameSchedule(
        { frequency: 'yearly', dayOfMonth: 1, month: 3 },
        { frequency: 'yearly', dayOfMonth: 1, month: 4 },
      ),
    ).toBe(false)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('an edited split', () => {
  test('must add up to the new amount, every line a code and over £0', () => {
    expect(
      splitProblem(
        [
          { sourceCodeId: 'street', amount: 1000n },
          { sourceCodeId: 'phone', amount: 200n },
        ],
        1200n,
      ),
    ).toBeNull()
    expect(
      splitProblem([{ sourceCodeId: 'street', amount: 1000n }], 1200n),
    ).toBe('The split must add up to the new amount')
    expect(splitProblem([{ sourceCodeId: '', amount: 1200n }], 1200n)).toBe(
      'Pick a code for every line',
    )
    expect(
      splitProblem(
        [
          { sourceCodeId: 'street', amount: 1200n },
          { sourceCodeId: 'phone', amount: 0n },
        ],
        1200n,
      ),
    ).toBe('Every line needs an amount over £0')
    expect(splitProblem([], 1200n)).toBe('The split needs at least one code')
  })
})
