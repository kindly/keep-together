/**
 * What the reconcile pages share (bank transfers 6b): a statement line's
 * heading, what a suggestion would do and why, and a refusal said as the
 * server says it.
 */
import type { BankSuggestion, StatementLine } from '../lib/data'
import { RustApiError, describe } from '../lib/data/rust/client'
import { formatDay, formatPence } from '../lib/gifts'

/** "3 Nov 2026 · £25.00 · J BLOGGS · 100016 GIFT". */
export function LineHeading({ line }: { line: StatementLine }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="whitespace-nowrap text-neutral-600">
        {formatDay(line.postedOn)}
      </span>
      <span className="font-medium whitespace-nowrap">
        {formatPence(line.amount)}
      </span>
      {line.payer && <span>{line.payer}</span>}
      {line.reference && (
        <span className="text-neutral-600">{line.reference}</span>
      )}
      {line.narrative &&
        line.narrative !== line.payer &&
        line.narrative !== `${line.payer} ${line.reference}`.trim() && (
          <span className="text-xs text-neutral-500">{line.narrative}</span>
        )}
    </span>
  )
}

/** What accepting a suggestion would do, in words. */
export function proposalText(s: BankSuggestion): string {
  const who = s.contactName ?? 'a contact'
  switch (s.proposal.kind) {
    case 'newGift':
      return `A gift from ${who}`
    case 'existingGifts':
      return `The gift${s.proposal.giftIds.length === 1 ? '' : 's'} already entered for ${who}`
    case 'notDonation':
      return `Not a donation: ${s.proposal.note}`
  }
}

export function ConfidenceBadge({ s }: { s: BankSuggestion }) {
  return s.confidence === 'strong' ? (
    <span className="rounded bg-emerald-100 px-1.5 text-xs text-emerald-900">
      strong
    </span>
  ) : (
    <span className="rounded bg-neutral-100 px-1.5 text-xs text-neutral-700">
      suggested
    </span>
  )
}

/**
 * A refused match, said plainly: someone else's change first (reload),
 * then the server's own words.
 */
export function matchRefusal(err: unknown): string {
  if (!(err instanceof RustApiError)) return 'Something went wrong: try again'
  const e = err.error
  if (e.kind === 'stale')
    return 'Changed meanwhile: someone else matched this line. It has been read again.'
  if (e.kind === 'invalid' && e.problems.length)
    return e.problems.map((p) => p.message).join('; ')
  return describe(e)
}
