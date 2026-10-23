import { describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import {
  coveringDeclaration,
  covers,
  currentOf,
  isIsoDate,
  openAt,
  prepareCancellation,
  prepareDeclaration,
  yearsBefore,
} from './rules'
import type { DeclarationWindow } from './rules'
import { declarationWarnings } from './warnings'

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
  test('isIsoDate accepts real calendar dates only', () => {
    expect(isIsoDate('2026-03-03')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2025-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-04-31')).toBe(false)
    expect(isIsoDate('2026-3-3')).toBe(false)
    expect(isIsoDate('')).toBe(false)
  })

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

describe('prepare', () => {
  const payload = {
    contactId: 'c' as Id<'contacts'>,
    scope: 'future' as const,
    madeOn: ' 2026-03-03 ',
    method: 'paperForm' as const,
    firstName: '  Jo ',
    lastName: 'Bloggs',
    addressLine1: ' 12   High St ',
    postcode: 'sw1a 1aa',
  }

  test('tidies the snapshot and upper-cases the postcode', () => {
    expect(prepareDeclaration(payload)).toEqual({
      ...payload,
      madeOn: '2026-03-03',
      firstName: 'Jo',
      addressLine1: '12 High St',
      postcode: 'SW1A 1AA',
    })
  })

  test('refuses a bad date, a thisGift with no gift, a gift on an enduring scope', () => {
    expect(() =>
      prepareDeclaration({ ...payload, madeOn: '2026-02-30' }),
    ).toThrow()
    expect(() =>
      prepareDeclaration({ ...payload, scope: 'thisGift' }),
    ).toThrow()
    expect(() =>
      prepareDeclaration({ ...payload, contributionId: GIFT }),
    ).toThrow()
  })

  test('cancellation: blanks absent, a real date, a note only with a date', () => {
    expect(prepareCancellation({ cancelledFrom: ' ', note: '' })).toEqual({
      cancelledFrom: undefined,
      note: undefined,
    })
    expect(() => prepareCancellation({ cancelledFrom: '2026-02-30' })).toThrow()
    expect(() => prepareCancellation({ note: 'phoned' })).toThrow()
  })
})

describe('warnings', () => {
  const full = {
    method: 'paperForm' as const,
    firstName: 'Jo',
    lastName: 'Bloggs',
    addressLine1: '12',
    postcode: 'SW1A 1AA',
  }

  test('none for a complete written declaration', () => {
    expect(declarationWarnings(full)).toEqual([])
  })

  test('missing address, missing name, oral', () => {
    expect(
      declarationWarnings({ ...full, postcode: '' }).map((w) => w.anchor),
    ).toEqual(['postcode'])
    expect(
      declarationWarnings({ ...full, addressLine1: '', postcode: '' }).map(
        (w) => w.anchor,
      ),
    ).toEqual(['addressLine1'])
    expect(
      declarationWarnings({ ...full, lastName: '' }).map((w) => w.anchor),
    ).toEqual(['lastName'])
    expect(
      declarationWarnings({ ...full, method: 'oral' }).map((w) => w.anchor),
    ).toEqual(['method'])
  })
})
