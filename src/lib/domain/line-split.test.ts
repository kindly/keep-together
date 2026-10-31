import { describe, expect, it } from 'vitest'
import {
  payerAsPerson,
  remainderOf,
  splitIssues,
  splitProblems,
} from './line-split'

const found = { kind: 'existing' } as const

describe('splitting a statement line', () => {
  it('the parts and the rest add up to the line exactly', () => {
    expect(remainderOf(6000n, [5000n, null])).toBe(1000n)
    expect(remainderOf(6000n, [5000n, 2000n])).toBe(-1000n)
    expect(remainderOf(6000n, [])).toBe(6000n)
  })

  it('says what keeps a split from saving', () => {
    const ok = { amount: 3000n, donor: found }
    expect(splitProblems(6000n, [ok, ok], '')).toEqual([])
    expect(splitProblems(6000n, [ok], '')).toEqual([
      'Say what the rest of the line is (it isn’t a donation)',
    ])
    expect(splitProblems(6000n, [ok], 'Raffle tickets')).toEqual([])
    expect(
      splitProblems(6000n, [ok, { amount: 4000n, donor: null }], ''),
    ).toEqual([
      'Gift 2: choose the donor',
      'The gifts add up to more than the line',
    ])
    expect(splitProblems(6000n, [{ amount: 0n, donor: found }], 'x')).toEqual([
      'Gift: an amount over £0',
    ])
    expect(splitProblems(6000n, [], '')).toContain('Add at least one gift')
  })

  it('each problem is beside its field, a new person’s names included', () => {
    const issues = splitIssues(
      6000n,
      [
        {
          amount: 4000n,
          donor: {
            kind: 'new',
            contactKind: 'individual',
            firstName: '',
            lastName: 'Smith',
            name: '',
          },
        },
        { amount: null, donor: found },
      ],
      '',
    )
    expect(issues.parts).toEqual([
      { donor: 'A new person needs a first and a last name' },
      { amount: 'An amount over £0' },
    ])
    expect(issues.rest).toBe(
      'Say what the rest of the line is (it isn’t a donation)',
    )
    expect(issues.total).toBeUndefined()
  })

  it('a payer name as a person to start from', () => {
    expect(payerAsPerson('J BLOGGS')).toEqual({
      firstName: 'J',
      lastName: 'Bloggs',
    })
    expect(payerAsPerson('MARY ANN SMITH')).toEqual({
      firstName: 'Mary Ann',
      lastName: 'Smith',
    })
    expect(payerAsPerson('SMITH')).toEqual({ firstName: '', lastName: 'Smith' })
    expect(payerAsPerson('  ')).toEqual({ firstName: '', lastName: '' })
  })
})
