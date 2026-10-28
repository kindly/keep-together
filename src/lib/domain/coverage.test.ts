// Ported from the Convex era's giftaid rules tests (tag `convex-final`):
// the coverage cases the SPA's copy of the rules must keep agreeing on.
import { describe, expect, test } from 'vitest'
import type { Id } from './ids'
import {
  coveringDeclaration,
  covers,
  currentOf,
  openAt,
  yearsBefore,
} from './coverage'
import type { DeclarationWindow } from './coverage'

const GIFT = 'gift1' as Id<'contributions'>
const OTHER_GIFT = 'gift2' as Id<'contributions'>
const MADE = '2026-03-03'

const decl = (
  scope: DeclarationWindow['scope'],
  extra: Partial<DeclarationWindow> = {},
): DeclarationWindow => ({
  scope,
  madeOn: MADE,
  ...(scope === 'thisGift' ? { contributionId: GIFT } : {}),
  ...extra,
})

describe('dates', () => {
  test('yearsBefore: same day; 29 Feb with no such day becomes 1 Mar', () => {
    expect(yearsBefore('2026-03-03', 4)).toBe('2022-03-03')
    expect(yearsBefore('2028-02-29', 4)).toBe('2024-02-29')
    expect(yearsBefore('2024-02-29', 1)).toBe('2023-03-01')
    expect(yearsBefore('2026-12-31', 4)).toBe('2022-12-31')
  })

})

// The plan's truth table: each scope against gift dates around its window,
// and cancellation on, before and after the gift date.
describe('coverage', () => {
  const at = (date: string, contributionId?: Id<'contributions'>) => ({
    date,
    contributionId,
  })

  test.each([
    // scope, gift date, covered
    ['futureAndPast4y', '2022-03-02', false], // a day before madeOn − 4y
    ['futureAndPast4y', '2022-03-03', true], // exactly madeOn − 4y
    ['futureAndPast4y', '2024-01-01', true],
    ['futureAndPast4y', MADE, true],
    ['futureAndPast4y', '2030-01-01', true],
    ['future', '2026-03-02', false],
    ['future', MADE, true],
    ['future', '2030-01-01', true],
  ] as const)('%s covers a gift of %s: %s', (scope, date, covered) => {
    expect(covers(decl(scope), at(date))).toBe(covered)
  })

  test('thisGift covers its own gift only, whatever the date', () => {
    expect(covers(decl('thisGift'), at(MADE, GIFT))).toBe(true)
    expect(covers(decl('thisGift'), at('2020-01-01', GIFT))).toBe(true)
    expect(covers(decl('thisGift'), at(MADE, OTHER_GIFT))).toBe(false)
    expect(covers(decl('thisGift'), at(MADE))).toBe(false)
    // A thisGift declaration without its gift (never stored) covers nothing.
    expect(
      covers({ scope: 'thisGift', madeOn: MADE }, at(MADE, undefined)),
    ).toBe(false)
  })

  test.each(['future', 'futureAndPast4y'] as const)(
    '%s made with a gift covers that gift even before its window; no other gift',
    (scope) => {
      const madeWith = decl(scope, { contributionId: GIFT })
      // Back-dated gift entered today: before madeOn − 4y and before madeOn.
      expect(covers(madeWith, at('2020-01-01', GIFT))).toBe(true)
      expect(covers(madeWith, at('2020-01-01', OTHER_GIFT))).toBe(false)
      expect(covers(madeWith, at('2020-01-01'))).toBe(false)
      // The window is unchanged for every other gift.
      expect(covers(madeWith, at(MADE, OTHER_GIFT))).toBe(true)
      expect(coveringDeclaration([madeWith], at('2020-01-01', GIFT))).toBe(
        madeWith,
      )
      // Cancelled on or before its gift's date: not covered.
      expect(
        covers(
          decl(scope, { contributionId: GIFT, cancelledFrom: '2020-01-01' }),
          at('2020-01-01', GIFT),
        ),
      ).toBe(false)
      expect(covers({ ...madeWith, voidedAt: 1 }, at('2020-01-01', GIFT))).toBe(
        false,
      )
    },
  )

  test.each(['thisGift', 'future', 'futureAndPast4y'] as const)(
    '%s: cancellation before or on the gift date removes coverage; after keeps it',
    (scope) => {
      const gift = at('2026-06-01', GIFT)
      expect(covers(decl(scope), gift)).toBe(true)
      expect(covers(decl(scope, { cancelledFrom: '2026-05-31' }), gift)).toBe(
        false,
      )
      expect(covers(decl(scope, { cancelledFrom: '2026-06-01' }), gift)).toBe(
        false,
      )
      expect(covers(decl(scope, { cancelledFrom: '2026-06-02' }), gift)).toBe(
        true,
      )
    },
  )

  test.each(['thisGift', 'future', 'futureAndPast4y'] as const)(
    '%s: voided covers nothing, past or future, and is never current or open',
    (scope) => {
      const voided = decl(scope, { voidedAt: 1 })
      for (const date of ['2022-03-03', MADE, '2030-01-01']) {
        expect(covers(voided, at(date, GIFT))).toBe(false)
      }
      expect(coveringDeclaration([voided], at(MADE, GIFT))).toBeNull()
      expect(currentOf([voided], MADE)).toBeNull()
      expect(openAt(voided, MADE)).toBe(false)
    },
  )

  test('a later declaration covers again after a cancellation', () => {
    const chain = [
      decl('future', { madeOn: '2020-01-01', cancelledFrom: '2022-01-01' }),
      decl('future', { madeOn: '2024-01-01' }),
    ]
    expect(coveringDeclaration(chain, at('2021-06-01'))).toBe(chain[0])
    expect(coveringDeclaration(chain, at('2023-06-01'))).toBeNull()
    expect(coveringDeclaration(chain, at('2025-06-01'))).toBe(chain[1])
  })

  test('of several, the one made last is reported', () => {
    const chain = [
      decl('future', { madeOn: '2020-01-01' }),
      decl('futureAndPast4y', { madeOn: '2024-01-01' }),
    ]
    expect(coveringDeclaration(chain, at('2025-01-01'))).toBe(chain[1])
    expect(coveringDeclaration(chain, at('2020-06-01'))).toBe(chain[1])
    expect(coveringDeclaration(chain, at('2020-01-01'))).toBe(chain[1])
    expect(coveringDeclaration(chain, at('2019-12-31'))).toBeNull()
  })

  test('current: enduring and in force today; thisGift never', () => {
    expect(currentOf([decl('thisGift')], MADE)).toBeNull()
    expect(currentOf([decl('future')], MADE)).not.toBeNull()
    expect(currentOf([decl('future')], '2026-03-02')).toBeNull()
    expect(
      currentOf([decl('future', { cancelledFrom: MADE })], MADE),
    ).toBeNull()
    // A cancellation dated later doesn't apply yet.
    expect(
      currentOf([decl('future', { cancelledFrom: '2027-01-01' })], MADE),
    ).not.toBeNull()
  })

  test('openAt: made by the date and not already cancelled on or before it', () => {
    expect(openAt(decl('future'), MADE)).toBe(true)
    expect(openAt(decl('future'), '2026-03-02')).toBe(false)
    expect(openAt(decl('future', { cancelledFrom: '2026-04-01' }), MADE)).toBe(
      true,
    )
    expect(openAt(decl('future', { cancelledFrom: MADE }), MADE)).toBe(false)
  })
})
