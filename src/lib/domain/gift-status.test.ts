// ADR 0025's "never optimistic" in the SPA: only a completed gift is
// money received, as `giving::RECEIVED` says on the server.
import { describe, expect, test } from 'vitest'
import type { GiftStatus } from '../data/rust-types/GiftStatus'
import {
  STATUS_LABELS,
  isProviderStatus,
  isReceived,
  receivedTotal,
} from './gift-status'

const ALL = Object.keys(STATUS_LABELS) as Array<GiftStatus>

describe('gift status', () => {
  test('only completed is money received', () => {
    expect(ALL.filter(isReceived)).toEqual(['completed'])
  })

  test('staff set completed and void; the rest are the provider’s', () => {
    expect(ALL.filter((s) => !isProviderStatus(s)).sort()).toEqual([
      'completed',
      'void',
    ])
  })

  test('a total counts only money received', () => {
    const gifts = ALL.map((status, i) => ({
      status,
      amount: BigInt(100 * (i + 1)),
    }))
    const completed = gifts.find((g) => g.status === 'completed')!
    expect(receivedTotal(gifts)).toBe(completed.amount)
    expect(receivedTotal([])).toBe(0n)
  })
})
