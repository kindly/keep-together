// ADR 0025's "never optimistic" in the SPA: only a completed gift is
// money received, as `giving::RECEIVED` says on the server.
import { describe, expect, test } from 'vitest'
import type { GiftStatus } from '../data/rust-types/GiftStatus'
import {
  STATUS_LABELS,
  bankNote,
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

describe('bankNote (ADR 0027)', () => {
  const gift = {
    method: 'cheque' as const,
    status: 'pending' as GiftStatus,
    notOnAStatement: false,
    payingInBatchId: null as string | null,
  }
  test('a transfer by hand not on a statement yet', () => {
    expect(
      bankNote({
        ...gift,
        method: 'bank_transfer',
        status: 'completed',
        notOnAStatement: true,
      })?.short,
    ).toBe('not on a statement yet')
    expect(
      bankNote({ ...gift, method: 'bank_transfer', status: 'completed' }),
    ).toBeNull()
  })
  test('a cheque: pending in a batch or not, bounced, cleared', () => {
    expect(bankNote({ ...gift, payingInBatchId: 'b1' })?.long).toBe(
      'Pending until its paying-in batch is matched to a statement line.',
    )
    expect(bankNote(gift)?.short).toBe('pending: not cleared')
    expect(bankNote({ ...gift, status: 'failed' })?.short).toBe('bounced')
    expect(bankNote({ ...gift, status: 'completed' })).toBeNull()
    expect(bankNote({ ...gift, method: 'cash' })).toBeNull()
  })
})
