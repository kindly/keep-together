import { describe, expect, test } from 'vitest'
import {
  fold,
  matchesAll,
  normalisePhone,
  parseSearch,
  searchRow,
  searchText,
} from './search'
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
      'riversidefoodbank',
    ])
  })

  test('names also joined: hyphens, apostrophes, multi-word family names', () => {
    const named = (lastName: string, firstName = 'Ann') =>
      words(
        searchText(
          { ...person, firstName, lastName, nickname: '', sortName: '' },
          none,
        ),
      )
    expect(named('Smith-Jones')).toEqual(
      expect.arrayContaining(['smith-jones', 'smithjones']),
    )
    expect(named("O'Brien")).toEqual(expect.arrayContaining(['obrien']))
    expect(named('O’Brien')).toEqual(expect.arrayContaining(['obrien']))
    expect(named('de la Cruz')).toEqual(
      expect.arrayContaining(['de', 'la', 'cruz', 'delacruz']),
    )
    expect(named('van der Berg')).toEqual(
      expect.arrayContaining(['vanderberg']),
    )
    expect(named("Mary-Jane O'Neil-Ward", '')).toEqual(
      expect.arrayContaining(['maryjane', 'oneilward', 'maryjaneoneilward']),
    )
  })

  test('a joined form that is short or already a word adds nothing', () => {
    expect(
      words(searchText({ ...person, nickname: "J'" }, none)).sort(),
    ).toEqual(['j\'', 'ndiaye', 'zoe'].sort())
    const text = searchText(
      { ...person, lastName: 'Smith-Jones', nickname: 'smithjones' },
      none,
    )
    expect(words(text)).toEqual([...new Set(words(text))])
  })

  test('the sort name is not joined', () => {
    expect(words(searchText(person, none))).not.toContain('ndiayezoe')
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

  test('identifier values', () => {
    const w = words(
      searchText(person, { ...none, identifiers: ['CIVI-4471', 'Gala 2024'] }),
    )
    expect(w).toEqual(expect.arrayContaining(['civi-4471', 'gala', '2024']))
  })

  test('every word once', () => {
    const text = searchText(person, {
      ...none,
      emails: ['zoe@ndiaye.org'],
      identifiers: ['Zoe'],
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

describe('parseSearch', () => {
  test('a phone-shaped entry is one normalised number', () => {
    expect(parseSearch(' +44 (0)7700 900-123 ')).toEqual({
      terms: ['07700900123'],
      phone: '07700900123',
    })
    expect(parseSearch('900123')).toEqual({
      terms: ['900123'],
      phone: '900123',
    })
  })

  test('short numbers and everything else are folded words', () => {
    expect(parseSearch('69003')).toEqual({ terms: ['69003'], phone: null })
    expect(parseSearch('Zoë  N@Example')).toEqual({
      terms: ['zoe', 'n', 'example'],
      phone: null,
    })
    expect(parseSearch('@@')).toEqual({ terms: [], phone: null })
  })

  test('at most 16 terms', () => {
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    expect(parseSearch(many).terms).toHaveLength(16)
  })
})

describe('matchesAll', () => {
  const text = searchText(person, {
    ...none,
    emails: ['zoe.n@example.co.uk'],
    addresses: [{ line1: '12 Mill Lane', town: 'Stroud', postcode: 'GL5 1AB' }],
  })
  test('every term, the last as a prefix', () => {
    expect(matchesAll(text, ['ndiaye', 'stro'])).toBe(true)
    expect(matchesAll(text, ['nd', 'stroud'])).toBe(false)
    expect(matchesAll(text, ['ndiaye', 'london'])).toBe(false)
    expect(matchesAll(text, ['zoe', 'n', 'example'])).toBe(true)
    expect(matchesAll(text, ['gl5', '1ab'])).toBe(true)
    expect(matchesAll(text, [])).toBe(false)
  })

  test('a joined name matches however it is typed', () => {
    const t = (lastName: string) =>
      searchText({ ...person, lastName, sortName: '' }, none)
    const q = (typed: string) => parseSearch(typed).terms
    for (const typed of ['smith-jones', 'smith jones', 'smithjones', 'smithj']) {
      expect(matchesAll(t('Smith-Jones'), q(typed)), typed).toBe(true)
    }
    for (const typed of ["o'brien", 'o’brien', 'obrien', 'o brien', 'obr']) {
      expect(matchesAll(t('O’Brien'), q(typed)), typed).toBe(true)
    }
    for (const typed of ['de la cruz', 'delacruz', 'zoe delac']) {
      expect(matchesAll(t('de la Cruz'), q(typed)), typed).toBe(true)
    }
    expect(matchesAll(t('Smith-Jones'), q('smithjonas'))).toBe(false)
  })
})
