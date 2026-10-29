// The twin of the api's one-off cap tests: £1,000 is the most staff take
// once through GoCardless; more is a bank transfer.
import { describe, expect, test } from 'vitest'
import {
  ONE_OFF_MAX,
  ONE_OFF_MAX_MESSAGE,
  oneOffAmountProblem,
} from './one-off'

describe('one-off amount', () => {
  test('a one-off over £1,000 is refused, pointing to a bank transfer', () => {
    expect(oneOffAmountProblem(100_001n)).toBe(ONE_OFF_MAX_MESSAGE)
    expect(ONE_OFF_MAX_MESSAGE).toContain('bank transfer')
  })

  test('£1,000 exactly and anything over £0 is fine', () => {
    expect(oneOffAmountProblem(ONE_OFF_MAX)).toBeNull()
    expect(oneOffAmountProblem(1n)).toBeNull()
    expect(oneOffAmountProblem(0n)).toBe('The amount must be over £0')
  })
})
