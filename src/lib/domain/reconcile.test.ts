import { describe, expect, it } from 'vitest'
import { nameOnly, nearestFirst, proposalKey } from './reconcile'

describe('reconcile rules', () => {
  it('a suggestion is known by what it does, not where it is', () => {
    expect(proposalKey({ kind: 'newGift', contactId: 'c1' })).toBe('newGift:c1')
    expect(proposalKey({ kind: 'existingGifts', giftIds: ['g2', 'g1'] })).toBe(
      proposalKey({ kind: 'existingGifts', giftIds: ['g1', 'g2'] }),
    )
    expect(proposalKey({ kind: 'notDonation', ruleId: 'r1', note: 'x' })).toBe(
      'notDonation:r1',
    )
  })

  it('a name alone is never bulk', () => {
    expect(nameOnly({ suggesters: ['nameOnly'] })).toBe(true)
    expect(nameOnly({ suggesters: ['nameOnly', 'contactNumber'] })).toBe(false)
    expect(nameOnly({ suggesters: [] })).toBe(false)
  })

  it('nearest by amount, then date', () => {
    const items = [
      { id: 'far', amount: 500n, date: '2026-11-03' },
      { id: 'exact-late', amount: 7000n, date: '2026-11-20' },
      { id: 'exact-near', amount: 7000n, date: '2026-11-04' },
      { id: 'close', amount: 6900n, date: '2026-11-03' },
    ]
    expect(
      nearestFirst(items, { amount: 7000n, date: '2026-11-03' }, (i) => i).map(
        (i) => i.id,
      ),
    ).toEqual(['exact-near', 'exact-late', 'close', 'far'])
  })
})
