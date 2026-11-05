// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { billingRequestSays, caughtUpSays } from './gocardless-diagnosis'

// The sandbox spec's failure messages (qc/gocardless-diagnosis.ts): a
// catch-up that read nothing says whose side it is on.

const caught = {
  read: 0,
  missed: 0,
  since: '2026-11-04T09:10:52.123Z',
  newestEventAt: null as string | null,
  checkedAt: '2026-11-04T10:12:50.000Z',
}

describe('caughtUpSays', () => {
  test('events read: just the counts and the window', () => {
    expect(caughtUpSays({ ...caught, read: 12, missed: 3 })).toBe(
      'it read 12 events since 2026-11-04T09:10:52.123Z, 3 missed',
    )
  })

  test('nothing read, newest event before the window: GoCardless made none', () => {
    const out = caughtUpSays({
      ...caught,
      newestEventAt: '2026-11-02T10:19:30.000Z',
    })
    expect(out).toContain('newest event for the account is from 2026-11-02T10:19:30.000Z')
    expect(out).toContain('has made no events since')
    expect(out).toContain('this server’s clock: 2026-11-04T10:12:50.000Z')
    expect(out).toMatch(/GoCardless’s side\)$/)
  })

  test('nothing read and no events at all: GoCardless’s side', () => {
    expect(caughtUpSays(caught)).toMatch(/lists no events at all.*GoCardless’s side/)
  })

  test('nothing read, yet a newer event inside the window: our side', () => {
    const out = caughtUpSays({
      ...caught,
      newestEventAt: '2026-11-04T10:11:00.000Z',
    })
    expect(out).toContain('inside the read')
    expect(out).toMatch(/our side\)$/)
  })
})

describe('billingRequestSays', () => {
  const peek = {
    id: 'BR1',
    status: 'fulfilled',
    amount: null,
    chargeDate: null,
    nextPossibleChargeDate: null,
    upcomingPayments: [],
    payments: [],
    mandateId: 'MD1' as string | null,
    mandateStatus: 'pending_submission' as string | null,
  }

  test('fulfilled: its mandate and the mandate’s status', () => {
    expect(billingRequestSays(peek)).toBe(
      'GoCardless has the billing request BR1 fulfilled, its mandate MD1 pending_submission',
    )
  })

  test('not fulfilled: no mandate', () => {
    expect(
      billingRequestSays({
        ...peek,
        status: 'pending',
        mandateId: null,
        mandateStatus: null,
      }),
    ).toBe('GoCardless has the billing request BR1 pending, with no mandate')
  })
})
