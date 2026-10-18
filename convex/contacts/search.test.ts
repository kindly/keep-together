import { describe, expect, test } from 'vitest'
import { fold, normalisePhone, searchRow, searchText } from './search'
import type { SearchChildren, SearchContact } from './search'

const person: SearchContact = {
  kind: 'individual',
  firstName: 'Zoë',
  lastName: 'Ndiaye',
  nickname: 'Zo',
  name: '',
  sortName: 'Ndiaye, Zoë',
}
const none: SearchChildren = {
  emails: [],
  phones: [],
  addresses: [],
  identifiers: [],
  tagNames: [],
}
const words = (text: string) => text.split(' ')

describe('fold', () => {
  test('lowercases and strips accents', () => {
    expect(fold('Zoë Brontë-Ångström')).toBe('zoe bronte-angstrom')
  })
})

describe('normalisePhone', () => {
  test.each([
    ['07700 900123', '07700900123'],
    ['07700900123', '07700900123'],
    ['+44 (0)7700 900123', '07700900123'],
    ['+44 7700 900123', '07700900123'],
    ['0044 7700 900123', '07700900123'],
    ['01452-123456', '01452123456'],
    ['+1 212 555 0100', '12125550100'],
    ['ext', ''],
  ])('%s → %s', (raw, want) => {
    expect(normalisePhone(raw)).toBe(want)
  })
})

describe('searchText', () => {
  test('names: given, family, nickname, sort name; folded', () => {
    expect(words(searchText(person, none)).sort()).toEqual(
      ['zoe', 'ndiaye', 'zo'].sort(),
    )
  })

  test('organisation name', () => {
    const org = {
      ...person,
      kind: 'organization' as const,
      firstName: '',
      lastName: '',
      nickname: '',
      name: 'Riverside Food Bank',
      sortName: 'Riverside Food Bank',
    }
    expect(words(searchText(org, none)).sort()).toEqual([
      'bank',
      'food',
      'riverside',
    ])
  })

  test('emails whole and split at @ and .', () => {
    const w = words(
      searchText(person, { ...none, emails: [' Zoe.N@Example.co.uk '] }),
    )
    expect(w).toEqual(
      expect.arrayContaining([
        'zoe.n@example.co.uk',
        'n',
        'example',
        'co',
        'uk',
      ]),
    )
  })

  test('phones as digits plus the last six', () => {
    const w = words(
      searchText(person, { ...none, phones: ['+44 7700 900123', '999'] }),
    )
    expect(w).toEqual(expect.arrayContaining(['07700900123', '900123', '999']))
  })

  test('postcodes compact and spaced, line 1 and town', () => {
    const w = words(
      searchText(person, {
        ...none,
        addresses: [
          { line1: '12 Mill Lane', town: 'Stroud', postcode: 'GL5 1AB' },
        ],
      }),
    )
    expect(w).toEqual(
      expect.arrayContaining([
        'gl51ab',
        'gl5',
        '1ab',
        '12',
        'mill',
        'lane',
        'stroud',
      ]),
    )
    // A postcode typed without its space gets the spaced form too.
    const compact = words(
      searchText(person, {
        ...none,
        addresses: [{ line1: '', town: '', postcode: 'SW1A1AA' }],
      }),
    )
    expect(compact).toEqual(expect.arrayContaining(['sw1a1aa', 'sw1a', '1aa']))
  })

  test('identifier values and tag names', () => {
    const w = words(
      searchText(person, {
        ...none,
        identifiers: ['CIVI-4471'],
        tagNames: ['Christmas fair'],
      }),
    )
    expect(w).toEqual(
      expect.arrayContaining(['civi-4471', 'christmas', 'fair']),
    )
  })

  test('every word once', () => {
    const text = searchText(person, {
      ...none,
      emails: ['zoe@ndiaye.org'],
      tagNames: ['Zoe'],
    })
    expect(words(text)).toEqual([...new Set(words(text))])
  })
})

describe('searchRow', () => {
  test('carries archived, kind and the distinct normalised phones', () => {
    const row = searchRow(
      { ...person, archived: true },
      { ...none, phones: ['07700 900123', '+44 7700 900123', ''] },
    )
    expect(row.archived).toBe(true)
    expect(row.kind).toBe('individual')
    expect(row.phones).toEqual(['07700900123'])
  })
})
