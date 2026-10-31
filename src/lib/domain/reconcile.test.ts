import { describe, expect, it } from 'vitest'
import { bulkable, nameOnly, nearestFirst, proposalKey } from './reconcile'

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

  it('a standing order’s payment and a new standing order are known too', () => {
    expect(
      proposalKey({
        kind: 'instalment',
        regularGiftId: 'r1',
        scheduledOn: '2026-11-03',
      }),
    ).toBe('instalment:r1:2026-11-03')
    expect(
      proposalKey({
        kind: 'newStandingOrder',
        contactId: 'c1',
        frequency: 'monthly',
        dayOfMonth: 3,
        month: null,
      }),
    ).toBe('newStandingOrder:c1:monthly:3:')
  })

  it('a standing-order offer is never bulk; its payment is', () => {
    expect(
      bulkable({
        suggesters: ['standingOrder'],
        proposal: {
          kind: 'newStandingOrder',
          contactId: 'c1',
          frequency: 'monthly',
          dayOfMonth: 3,
          month: null,
        },
      }),
    ).toBe(false)
    expect(
      bulkable({
        suggesters: ['standingOrder'],
        proposal: {
          kind: 'instalment',
          regularGiftId: 'r1',
          scheduledOn: '2026-11-03',
        },
      }),
    ).toBe(true)
    expect(
      bulkable({
        suggesters: ['nameOnly'],
        proposal: { kind: 'newGift', contactId: 'c1' },
      }),
    ).toBe(false)
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
