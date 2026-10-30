import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ReadRefused } from '../components/claims-ui'
import { useExpectedReport } from '../lib/data'
import type { ExpectedGrouping, ReportLine } from '../lib/data'
import { monthIndex, monthLabel } from '../lib/domain/regular-terms'
import { formatDay, formatPence } from '../lib/gifts'
import { useTenant } from '../lib/tenant'

type Search = { from?: string; to?: string; by?: ExpectedGrouping }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const BYS: ReadonlyArray<ExpectedGrouping> = ['code', 'detail', 'category']

export const Route = createFileRoute('/t/$slug/reports/expected')({
  component: ExpectedReportPage,
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.from === 'string' && MONTH.test(s.from) && { from: s.from }),
    ...(typeof s.to === 'string' && MONTH.test(s.to) && { to: s.to }),
    ...(BYS.includes(s.by as ExpectedGrouping) && {
      by: s.by as ExpectedGrouping,
    }),
  }),
})

const BY_LABELS: Record<ExpectedGrouping, string> = {
  code: 'Source code',
  detail: 'Detail',
  category: 'Category',
}

/** This month, `YYYY-MM`, in the browser's time zone. */
function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** The 12 months to `to`: the report's default range. */
export function defaultRange(to: string): { from: string; to: string } {
  return { from: monthLabel((monthIndex(to) ?? 0) - 11), to }
}

/**
 * Expected vs actual and upgrades (regular-gift terms step 6, from
 * `giving::expected`): per code (or detail, or category) over a range of
 * months, what the regular gifts' terms expected against what was
 * received, failed, missing or still to come; then the upgrades and
 * downgrades credited to each code, valued a year at a time, and the
 * upgrades that never collected. Any member.
 */
function ExpectedReportPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const range = defaultRange(search.to ?? thisMonth())
  const from = search.from ?? range.from
  const to = search.to ?? range.to
  const by = search.by ?? 'code'
  const report = useExpectedReport(from, to, by)
  const set = (next: Search) =>
    void navigate({
      to: '.',
      search: (s: Search) => ({ ...s, ...next }),
      replace: true,
    })
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Expected vs actual</h1>
        <p className="mt-1 text-sm text-neutral-600">
          What regular gifts should have brought in, by their terms in force
          each month, against what was collected. Only collected money counts as
          received.
        </p>
      </header>
      <form
        aria-label="Report range"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="flex flex-col gap-1 text-sm">
          From
          <input
            type="month"
            value={from}
            onChange={(e) =>
              MONTH.test(e.target.value) && set({ from: e.target.value })
            }
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          To
          <input
            type="month"
            value={to}
            onChange={(e) =>
              MONTH.test(e.target.value) && set({ to: e.target.value })
            }
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          By
          <select
            value={by}
            onChange={(e) => set({ by: e.target.value as ExpectedGrouping })}
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            {BYS.map((b) => (
              <option key={b} value={b}>
                {BY_LABELS[b]}
              </option>
            ))}
          </select>
        </label>
      </form>
      {report.error ? (
        <ReadRefused
          error={report.error}
          retry={report.refetch}
          failed="The report couldn’t load."
        />
      ) : report.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <Report report={report.data} by={by} />
      )}
    </main>
  )
}

const num = 'py-1 pr-3 text-right tabular-nums'

function LineRow({ line, label }: { line: ReportLine; label: string }) {
  return (
    <>
      <td className="py-1 pr-3">{label}</td>
      <td className={num}>{formatPence(line.expected)}</td>
      <td className={num}>{formatPence(line.received)}</td>
      <td className={num}>{formatPence(line.failed)}</td>
      <td className={num}>{formatPence(line.missing)}</td>
      <td className={num}>{formatPence(line.pending)}</td>
    </>
  )
}

function Report({
  report,
  by,
}: {
  report: NonNullable<ReturnType<typeof useExpectedReport>['data']>
  by: ExpectedGrouping
}) {
  const { slug } = useTenant()
  return (
    <>
      <section aria-labelledby="expected-lines" className="overflow-x-auto">
        <h2 id="expected-lines" className="mb-2 text-lg font-medium">
          Expected against received
        </h2>
        {report.lines.length === 0 ? (
          <p data-testid="expected-empty" className="text-sm text-neutral-500">
            Nothing expected in these months.
          </p>
        ) : (
          <table
            data-testid="expected-lines"
            className="w-full text-left text-sm"
          >
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th className="py-2 pr-3 font-normal">{BY_LABELS[by]}</th>
                <th className="py-2 pr-3 text-right font-normal">Expected</th>
                <th className="py-2 pr-3 text-right font-normal">Received</th>
                <th className="py-2 pr-3 text-right font-normal">Failed</th>
                <th className="py-2 pr-3 text-right font-normal">Missing</th>
                <th className="py-2 pr-3 text-right font-normal">
                  Pending or to come
                </th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((l) => (
                <tr
                  key={l.id ?? ''}
                  data-line={l.label}
                  className="border-b border-neutral-100"
                >
                  <LineRow line={l} label={l.label} />
                </tr>
              ))}
              <tr data-testid="expected-total" className="font-medium">
                <LineRow line={report.total} label="Total" />
              </tr>
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="upgrades" className="overflow-x-auto">
        <h2 id="upgrades" className="mb-2 text-lg font-medium">
          Upgrades and downgrades
        </h2>
        <p className="mb-2 text-sm text-neutral-600">
          Credited to the code that won each change, from its first payment
          collected at the new amount. A year’s worth: a monthly change × 12.
        </p>
        {report.upgrades.length === 0 ? (
          <p className="text-sm text-neutral-500">None in these months.</p>
        ) : (
          <table data-testid="upgrades" className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th className="py-2 pr-3 font-normal">Code</th>
                <th className="py-2 pr-3 text-right font-normal">Upgrades</th>
                <th className="py-2 pr-3 text-right font-normal">Downgrades</th>
                <th className="py-2 pr-3 text-right font-normal">A year</th>
                <th className="py-2 pr-3 text-right font-normal">A month</th>
              </tr>
            </thead>
            <tbody>
              {report.upgrades.map((u) => (
                <tr
                  key={u.id ?? ''}
                  data-line={u.label}
                  className="border-b border-neutral-100"
                >
                  <td className="py-1 pr-3">{u.label}</td>
                  <td className={num}>{u.upgrades}</td>
                  <td className={num}>{u.downgrades}</td>
                  <td className={num}>{formatPence(u.annual)}</td>
                  <td className={num}>{formatPence(u.monthly)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {report.notRealised.length > 0 && (
        <section aria-labelledby="not-realised" className="overflow-x-auto">
          <h2 id="not-realised" className="mb-2 text-lg font-medium">
            Not realised
          </h2>
          <p className="mb-2 text-sm text-neutral-600">
            Upgrades taking effect in these months that haven’t collected at the
            new amount.
          </p>
          <table
            data-testid="not-realised"
            className="w-full text-left text-sm"
          >
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th className="py-2 pr-3 font-normal">From</th>
                <th className="py-2 pr-3 font-normal">Code</th>
                <th className="py-2 pr-3 text-right font-normal">A year</th>
                <th className="py-2 pr-3 font-normal" />
              </tr>
            </thead>
            <tbody>
              {report.notRealised.map((n) => (
                <tr key={n.termId} className="border-b border-neutral-100">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {formatDay(n.effectiveOn)}
                  </td>
                  <td className="py-1 pr-3">{n.changeCode ?? 'not coded'}</td>
                  <td className={num}>{formatPence(n.annual)}</td>
                  <td className="py-1 pr-3">
                    <Link
                      to="/t/$slug/contacts/$contactId"
                      params={{ slug, contactId: n.contactId }}
                      className="underline"
                    >
                      Contact
                    </Link>
                    {n.ended && (
                      <span className="ml-2 text-xs text-neutral-500">
                        ended
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}
