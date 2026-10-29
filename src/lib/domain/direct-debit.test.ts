// How the Direct Debit screens name what GoCardless says (D3).
import { describe, expect, test } from 'vitest'
import type { DirectDebitPaymentStatus } from '../data/rust-types/DirectDebitPaymentStatus'
import {
  PAYMENT_LABELS,
  isCollected,
  linkExpired,
  ordinal,
  scheduleText,
} from './direct-debit'

describe('payments', () => {
  test('only a collected payment is money received', () => {
    const all = Object.keys(PAYMENT_LABELS) as Array<DirectDebitPaymentStatus>
    expect(all.filter(isCollected)).toEqual(['confirmed'])
    expect(PAYMENT_LABELS.confirmed).toBe('collected')
    expect(PAYMENT_LABELS.chargedBack).toBe('charged back')
  })
})

describe('schedule', () => {
  test('ordinals, the teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '28th',
    ])
  })

  test('monthly and yearly in words', () => {
    expect(
      scheduleText({ frequency: 'monthly', dayOfMonth: 1, month: null }),
    ).toBe('every month on the 1st')
    expect(scheduleText({ frequency: 'yearly', dayOfMonth: 5, month: 3 })).toBe(
      'every year on 5th March',
    )
  })
})

test('a sign-up link runs out at its expiry, not before', () => {
  const at = '2026-11-05T10:00:00Z'
  expect(linkExpired(at, new Date('2026-11-05T09:59:59Z'))).toBe(false)
  expect(linkExpired(at, new Date('2026-11-05T10:00:00Z'))).toBe(true)
  expect(linkExpired(null, new Date())).toBe(false)
})
