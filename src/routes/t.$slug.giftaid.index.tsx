import { Link, createFileRoute } from '@tanstack/react-router'
import { ReadRefused, StatusBadge, claimPeriod } from '../components/claims-ui'
import { useClaims } from '../lib/data'
import type { ClaimSummary } from '../lib/data'
import { formatDay, formatPence } from '../lib/gifts'
import { useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/giftaid/')({
  component: Claims,
})

/**
 * The Gift Aid page: the group's claims, newest first, each opening its
 * page, and "New claim". Every figure is the server's (rule 4).
 */
function Claims() {
  const { slug } = useTenant()
  const claims = useClaims()
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Gift Aid claims</h1>
        <Link
          to="/t/$slug/giftaid/new"
          params={{ slug }}
          className="rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700"
        >
          New claim
        </Link>
      </header>
      {claims.error ? (
        <ReadRefused error={claims.error} retry={claims.refetch} />
      ) : claims.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : claims.data.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No claims yet. “New claim” shows which gifts can be claimed.
        </p>
      ) : (
        <ClaimTable claims={claims.data} />
      )}
    </main>
  )
}

/** A claim's dates so far: made, submitted, paid. */
function claimDates(c: ClaimSummary): string {
  return [
    `made ${MADE.format(c.createdAt)}`,
    c.submittedOn && `submitted ${formatDay(c.submittedOn)}`,
    c.paidOn && `paid ${formatDay(c.paidOn)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

const MADE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

function ClaimTable({ claims }: { claims: Array<ClaimSummary> }) {
  const { slug } = useTenant()
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-neutral-500">
            <th className="py-2 pr-3 font-normal">Claim</th>
            <th className="py-2 pr-3 font-normal">Period</th>
            <th className="py-2 pr-3 font-normal">Status</th>
            <th className="py-2 pr-3 text-right font-normal">Gifts</th>
            <th className="py-2 pr-3 text-right font-normal">Reclaim</th>
            <th className="py-2 font-normal">Dates</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => (
            <tr
              key={c.id}
              data-testid="claim-row"
              className="border-b border-neutral-100"
            >
              <td className="py-2 pr-3">
                <Link
                  to="/t/$slug/giftaid/$claimId"
                  params={{ slug, claimId: c.id }}
                  className="underline"
                >
                  Claim {c.number}
                </Link>
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">{claimPeriod(c)}</td>
              <td className="py-2 pr-3">
                <StatusBadge status={c.status} />
              </td>
              <td className="py-2 pr-3 text-right">{c.totals.lines}</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap">
                {formatPence(c.totals.reclaim)}
              </td>
              <td className="py-2 whitespace-nowrap text-neutral-600">
                {claimDates(c)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
