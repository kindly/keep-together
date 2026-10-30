import { describe, expect, it } from 'vitest'
import {
  columnLabel,
  emptyPicks,
  headerIsData,
  mappingOf,
  missing,
} from './bank-mapping'
import type { MappingPicks } from './bank-mapping'

const lloydsHeader = [
  'Transaction Date',
  'Transaction Type',
  'Sort Code',
  'Account Number',
  'Transaction Description',
  'Debit Amount',
  'Credit Amount',
  'Balance',
  '',
]

const lloydsPicks: MappingPicks = {
  ...emptyPicks(),
  date: 0,
  amount: { kind: 'paidInOut', paidIn: 6, paidOut: 5 },
  narrative: [4],
}

describe('bank column mapping', () => {
  it('needs a date and the amount columns', () => {
    expect(missing(emptyPicks())).toEqual([
      'the date column',
      'the amount column',
    ])
    expect(mappingOf(emptyPicks(), lloydsHeader)).toBeNull()
    expect(missing(lloydsPicks)).toEqual([])
  })

  it('goes by header text when every picked column has its own name', () => {
    expect(mappingOf(lloydsPicks, lloydsHeader)).toEqual({
      header: { kind: 'find' },
      date: { name: 'Transaction Date' },
      amount: {
        kind: 'paidInOut',
        paidIn: { name: 'Credit Amount' },
        paidOut: { name: 'Debit Amount' },
      },
      narrative: [{ name: 'Transaction Description' }],
    })
  })

  it('goes by position, skipping the rows above, when a name is blank or repeated', () => {
    const header = ['Date', 'Narrative', 'Narrative', 'Amount']
    const picks: MappingPicks = {
      ...emptyPicks(),
      headerRow: 2,
      date: 0,
      amount: { kind: 'signed', column: 3 },
      narrative: [1, 2],
    }
    expect(mappingOf(picks, header)).toEqual({
      header: { kind: 'skip', rows: 3 },
      date: { index: 0 },
      amount: { kind: 'signed', column: { index: 3 } },
      narrative: [{ index: 1 }, { index: 2 }],
    })
  })

  it('a file with no header row goes by position from line 1', () => {
    const picks: MappingPicks = {
      ...emptyPicks(),
      headerRow: null,
      date: 0,
      amount: { kind: 'signed', column: 2 },
      narrative: [1],
    }
    // Line 1's cells are distinct and non-empty, but they are data.
    expect(mappingOf(picks, ['02/11/2026', 'J SMITH', '25.00'])).toEqual({
      header: { kind: 'skip', rows: 0 },
      date: { index: 0 },
      amount: { kind: 'signed', column: { index: 2 } },
      narrative: [{ index: 1 }],
    })
  })

  it('matches names ignoring case and spacing, as the server does', () => {
    const header = ['Date', ' date ', 'Amount']
    const picks: MappingPicks = {
      ...emptyPicks(),
      date: 0,
      amount: { kind: 'signed', column: 2 },
    }
    expect(mappingOf(picks, header)?.header).toEqual({ kind: 'skip', rows: 1 })
  })

  it('a header row whose amount is money is a transaction', () => {
    const picks: MappingPicks = {
      ...emptyPicks(),
      date: 0,
      amount: { kind: 'paidInOut', paidIn: 2, paidOut: 3 },
    }
    expect(headerIsData(picks, ['02/11/2026', '', '25.00', ''])).toBe(true)
    expect(headerIsData(picks, ['Date', 'Payer', 'In', 'Out'])).toBe(false)
    for (const cell of ['12', '-1,234.56', '£5.00 CR', '(3.00)'])
      expect(headerIsData(picks, ['d', '', cell, '']), cell).toBe(true)
    // No header row: nothing is taken for one.
    expect(headerIsData({ ...picks, headerRow: null }, ['', '', '25.00'])).toBe(
      false,
    )
  })

  it('labels columns by letter and name', () => {
    expect(columnLabel(0, ['Date'])).toBe('A: Date')
    expect(columnLabel(27, [])).toBe('AB')
  })
})
