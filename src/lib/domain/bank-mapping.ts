/**
 * Column mapping for a bank's CSV (bank transfers 6a): what staff pick on
 * the mapping screen, turned into the `ColumnMapping` the server reads
 * with (`server/crates/banking/src/csv.rs`). Columns go by their header
 * text when every picked one has a distinct, non-empty name, so a bank
 * that reorders its columns still reads; otherwise every column goes by
 * position and the rows above the data are skipped. A file with no header
 * row goes by position, from line 1. Header text is
 * matched as the server matches it: ignoring case and whitespace runs.
 */
import type { BankColumn } from '../data/rust-types/BankColumn'
import type { BankColumnMapping } from '../data/rust-types/BankColumnMapping'

/** What the mapping screen picks: column positions (0-based). */
export type MappingPicks = {
  /**
   * Which preview row (0-based, in file order) holds the column names;
   * null: the file has none, and its data starts on line 1.
   */
  headerRow: number | null
  date: number | null
  /** One signed column, or money in and money out. */
  amount:
    | { kind: 'signed'; column: number | null }
    | { kind: 'paidInOut'; paidIn: number | null; paidOut: number | null }
  payer: number | null
  reference: number | null
  narrative: Array<number>
  bankId: number | null
}

export const emptyPicks = (): MappingPicks => ({
  headerRow: 0,
  date: null,
  amount: { kind: 'signed', column: null },
  payer: null,
  reference: null,
  narrative: [],
  bankId: null,
})

/** Header text as the server compares it. */
export const headerKey = (cell: string) =>
  cell.trim().split(/\s+/).join(' ').toLowerCase()

/** What is still missing before the picks make a mapping. */
export function missing(p: MappingPicks): Array<string> {
  const out: Array<string> = []
  if (p.date === null) out.push('the date column')
  if (p.amount.kind === 'signed' && p.amount.column === null)
    out.push('the amount column')
  if (
    p.amount.kind === 'paidInOut' &&
    (p.amount.paidIn === null || p.amount.paidOut === null)
  )
    out.push('the money in and money out columns')
  return out
}

/**
 * The mapping, or null while something required is missing. `header` is
 * the header row's cells.
 */
export function mappingOf(
  p: MappingPicks,
  header: Array<string>,
): BankColumnMapping | null {
  if (missing(p).length > 0 || p.date === null) return null
  const picked = [
    p.date,
    ...(p.amount.kind === 'signed'
      ? [p.amount.column]
      : [p.amount.paidIn, p.amount.paidOut]),
    p.payer,
    p.reference,
    ...p.narrative,
    p.bankId,
  ].filter((i): i is number => i !== null)
  const keys = header.map(headerKey)
  const byName =
    p.headerRow !== null &&
    picked.every((i) => {
      const k = keys[i] ?? ''
      return k !== '' && keys.filter((other) => other === k).length === 1
    })
  const col = (i: number): BankColumn =>
    byName ? { name: (header[i] ?? '').trim() } : { index: i }
  const opt = (i: number | null) => (i === null ? undefined : col(i))
  const amount =
    p.amount.kind === 'signed'
      ? { kind: 'signed' as const, column: col(p.amount.column ?? 0) }
      : {
          kind: 'paidInOut' as const,
          paidIn: col(p.amount.paidIn ?? 0),
          paidOut: col(p.amount.paidOut ?? 0),
        }
  return {
    header: byName
      ? { kind: 'find' }
      : { kind: 'skip', rows: p.headerRow === null ? 0 : p.headerRow + 1 },
    date: col(p.date),
    amount,
    payer: opt(p.payer),
    reference: opt(p.reference),
    narrative: p.narrative.map(col),
    bankId: opt(p.bankId),
  }
}

/** Money as a statement writes it (`12`, `-1,234.56`, `£5.00 CR`), as
 * `banking::money` reads it, near enough to tell a number from a name. */
const MONEY =
  /^[-+(]?\s*£?\s*-?\d{1,3}(?:,\d{3})*(?:\d*)(?:\.\d+)?\)?\s*(?:CR|DR)?-?$/i

/**
 * Whether the row picked as the header is a transaction: its amount
 * cell is money. The server refuses that mapping (its line 1 credit would
 * be lost); the screen says so first.
 */
export function headerIsData(p: MappingPicks, header: Array<string>): boolean {
  if (p.headerRow === null) return false
  const amounts =
    p.amount.kind === 'signed'
      ? [p.amount.column]
      : [p.amount.paidIn, p.amount.paidOut]
  return amounts.some((i) => i !== null && MONEY.test((header[i] ?? '').trim()))
}

/** A column's label on the mapping screen: its letter and header text. */
export function columnLabel(i: number, header: Array<string>): string {
  let n = i
  let letter = ''
  do {
    letter = String.fromCharCode(65 + (n % 26)) + letter
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  const name = (header[i] ?? '').trim()
  return name ? `${letter}: ${name}` : letter
}
