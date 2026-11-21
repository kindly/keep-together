import { describe, expect, it } from 'vitest'
import { heldPayment } from './held-change'

// A £10-a-month gift on the 1st, as regular-terms.spec.ts sets up.
const upcoming = (changeableFrom: string) =>
  ['2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'].map(
    (chargeDate) => ({ chargeDate, changeable: chargeDate >= changeableFrom }),
  )

describe('the payment a QC change is held for', () => {
  it('on 2026-11-19 skips 1 December, whose change the api sends at once', () => {
    // 1 December is changeable (12 days off) and inside the fortnight a
    // change is sent in: the spec's "first changeable payment" was sent
    // on saving, so nothing was left scheduled.
    expect(heldPayment(upcoming('2026-12-01'), '2026-11-19')).toBe('2027-01-01')
  })

  it('takes the first changeable payment when it is over a fortnight off', () => {
    expect(heldPayment(upcoming('2026-12-01'), '2026-11-15')).toBe('2026-12-01')
  })

  it('leaves a day for a run over midnight: 15 days off is still skipped', () => {
    expect(heldPayment(upcoming('2026-12-01'), '2026-11-16')).toBe('2027-01-01')
    expect(heldPayment(upcoming('2026-12-01'), '2026-11-17')).toBe('2027-01-01')
  })

  it('never takes a payment that is not changeable', () => {
    expect(heldPayment(upcoming('2027-02-01'), '2026-11-01')).toBe('2027-02-01')
  })

  it('says so when no payment is far enough off', () => {
    expect(() => heldPayment(upcoming('2026-12-01'), '2027-03-01')).toThrow(
      /no changeable payment/,
    )
  })
})
