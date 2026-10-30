import { Link, createFileRoute } from '@tanstack/react-router'
import { LinesTable } from '../components/bank'
import { useBankAccounts, useBankImport } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { formatDay } from '../lib/gifts'
import { useCanWrite } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/bank/imports/$importId')({
  component: ImportDetailPage,
})

/**
 * One statement import (bank transfers 6a): the file, its date range and
 * counts, and the lines it brought, as the bank wrote them. Read-only:
 * matching lines comes with steps 4 and 6b.
 */
function ImportDetailPage() {
  const { slug, importId } = Route.useParams()
  const canWrite = useCanWrite()
  const detail = useBankImport(importId)
  const accounts = useBankAccounts(canWrite)
  if (!canWrite)
    return (
      <main className="mx-auto max-w-4xl p-6 text-sm text-neutral-600">
        Bank statements are for staff and admins.
      </main>
    )
  const d = detail.data
  const account = accounts.data?.find((a) => a.id === d?.accountId)
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <Link
        to="/t/$slug/bank"
        params={{ slug }}
        className="text-sm text-neutral-600 underline"
      >
        Bank statements
      </Link>
      {detail.error ? (
        <p role="alert" className="text-sm text-red-700">
          {detail.error instanceof RustApiError &&
          detail.error.error.kind === 'not_found'
            ? 'No such import.'
            : 'The import couldn’t load.'}
        </p>
      ) : d === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold break-words">
              {d.import.fileName}
            </h1>
            <p className="text-sm text-neutral-600">
              {[
                account && `Into ${account.name}`,
                d.import.firstDate &&
                  d.import.lastDate &&
                  `credits from ${formatDay(d.import.firstDate)} to ${formatDay(d.import.lastDate)}`,
                `imported ${new Date(d.import.importedAt).toLocaleString(
                  'en-GB',
                  { dateStyle: 'medium', timeStyle: 'short' },
                )}`,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
            <p className="mt-1 text-sm font-medium">
              {d.import.newLines} new, {d.import.duplicateLines} already
              imported
            </p>
          </div>
          {d.lines.length === 0 ? (
            <p className="text-sm text-neutral-600">
              Nothing new came with this file: every line was already imported.
            </p>
          ) : (
            <LinesTable lines={d.lines} caption="Lines this import added" />
          )}
        </>
      )}
    </main>
  )
}
