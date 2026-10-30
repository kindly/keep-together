/**
 * What the bank pages share (bank transfers 6a): how an account's CSV
 * layout reads, and a table of statement lines.
 */
import { formatDay, formatPence } from '../lib/gifts'
import type { BankCsvLayout, BankPreset, PayingInBatch } from '../lib/data'

/** How a layout reads, for the card. */
export function layoutLabel(
  layout: BankCsvLayout | undefined,
  presets: Array<BankPreset>,
): string {
  if (!layout) return 'Not set: chosen at each import'
  if (layout.kind === 'mapping') return 'Columns mapped by hand'
  const p = presets.find((x) => x.id === layout.id)
  if (!p) return 'A preset that no longer exists'
  return `${presetName(p)}${p.verified ? '' : ' (unverified)'}`
}

export const presetName = (p: BankPreset) => `${p.bank}: ${p.export}`

export const formatSortCode = (s: string) =>
  s.length === 6 ? `${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4)}` : s

/** Statement lines: date, amount, payer, reference, description. */
export function LinesTable({
  lines,
  caption,
}: {
  lines: Array<{
    id?: string
    postedOn: string
    amount: bigint
    payer: string
    reference: string
    narrative: string
  }>
  caption: string
}) {
  return (
    <div className="overflow-x-auto rounded border border-neutral-200">
      <table className="min-w-full text-sm">
        <caption className="px-2 py-1 text-left text-xs text-neutral-500">
          {caption}
        </caption>
        <thead className="bg-neutral-50 text-left text-xs text-neutral-600">
          <tr>
            <th scope="col" className="px-2 py-1">
              Date
            </th>
            <th scope="col" className="px-2 py-1 text-right">
              Amount
            </th>
            <th scope="col" className="px-2 py-1">
              Payer
            </th>
            <th scope="col" className="px-2 py-1">
              Reference
            </th>
            <th scope="col" className="px-2 py-1">
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id ?? i} className="border-t border-neutral-100">
              <td className="px-2 py-1 whitespace-nowrap">
                {formatDay(l.postedOn)}
              </td>
              <td className="px-2 py-1 text-right whitespace-nowrap">
                {formatPence(l.amount)}
              </td>
              <td className="px-2 py-1">{l.payer}</td>
              <td className="px-2 py-1">{l.reference}</td>
              <td className="px-2 py-1">{l.narrative}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A batch as a picker or a heading names it: account, slip, when opened. */
export function batchLabel(b: PayingInBatch): string {
  const opened = new Date(b.openedAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })
  return [
    b.accountName || 'Paying-in batch',
    b.slipNumber && `slip ${b.slipNumber}`,
    `opened ${opened}`,
  ]
    .filter(Boolean)
    .join(', ')
}

/** Where a batch stands, in a few words. */
export function batchState(b: PayingInBatch): string {
  if (b.line) return `matched to the line of ${formatDay(b.line.postedOn)}`
  return b.status === 'open' ? 'open' : 'closed, not matched yet'
}
