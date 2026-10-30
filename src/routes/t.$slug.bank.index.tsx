import { Link, createFileRoute } from '@tanstack/react-router'
import { useBankAccounts, useBankImports, useBankPresets } from '../lib/data'
import type { BankAccountRow, BankPreset } from '../lib/data'
import { formatSortCode, layoutLabel } from '../components/bank'
import { formatDay } from '../lib/gifts'
import { useCanWrite, useIsAdmin } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/bank/')({
  component: BankPage,
})

const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700'

/**
 * Bank statements (bank transfers 6a): each bank account with its
 * imports, newest first, and "Import a statement". Read-only for now:
 * matching lines to gifts comes with steps 4 and 6b. Staff and admins
 * (viewers never see statement lines, g1q9).
 */
function BankPage() {
  const { slug } = Route.useParams()
  const canWrite = useCanWrite()
  const admin = useIsAdmin()
  const accounts = useBankAccounts(canWrite)
  const presets = useBankPresets(canWrite)
  if (!canWrite)
    return (
      <main className="mx-auto max-w-4xl p-6 text-sm text-neutral-600">
        Bank statements are for staff and admins.
      </main>
    )
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold">Bank statements</h1>
        {accounts.data?.some((a) => a.active) && (
          <Link to="/t/$slug/bank/import" params={{ slug }} className={button}>
            Import a statement
          </Link>
        )}
      </div>
      {accounts.error ? (
        <p role="alert" className="text-sm text-red-700">
          The bank accounts couldn’t load.
        </p>
      ) : accounts.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : accounts.data.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No bank accounts yet.{' '}
          {admin ? (
            <Link
              to="/t/$slug/settings/bank"
              params={{ slug }}
              className="underline"
            >
              Add one in Settings
            </Link>
          ) : (
            'An admin adds them in Settings › Bank accounts.'
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {accounts.data.map((a) => (
            <li key={a.id}>
              <AccountImports
                account={a}
                presets={presets.data?.presets ?? []}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function AccountImports({
  account,
  presets,
}: {
  account: BankAccountRow
  presets: Array<BankPreset>
}) {
  const { slug } = Route.useParams()
  const imports = useBankImports(account.id)
  const details = [
    account.sortCode && formatSortCode(account.sortCode),
    account.accountLast4 && `ending ${account.accountLast4}`,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <section
      aria-label={account.name}
      className="flex flex-col gap-2 rounded border border-neutral-200 p-3"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="font-medium">
          {account.name}
          {!account.active && (
            <span className="ml-2 rounded bg-neutral-100 px-1.5 text-xs font-normal text-neutral-600">
              archived
            </span>
          )}
        </h2>
        {account.active && (
          <Link
            to="/t/$slug/bank/import"
            params={{ slug }}
            search={{ account: account.id }}
            className="text-sm underline"
          >
            Import into {account.name}
          </Link>
        )}
      </div>
      <p className="text-xs text-neutral-500">
        {details && `${details}. `}CSV layout:{' '}
        {layoutLabel(account.csvLayout, presets)}
      </p>
      {imports.error ? (
        <p role="alert" className="text-sm text-red-700">
          The imports couldn’t load.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void imports.refetch()}
          >
            Try again
          </button>
        </p>
      ) : imports.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : imports.data.length === 0 ? (
        <p className="text-sm text-neutral-600">Nothing imported yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Imports into {account.name}</caption>
            <thead className="text-left text-xs text-neutral-600">
              <tr>
                <th scope="col" className="py-1 pr-3">
                  File
                </th>
                <th scope="col" className="py-1 pr-3">
                  Credits from
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  New
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  Already imported
                </th>
                <th scope="col" className="py-1">
                  Imported
                </th>
              </tr>
            </thead>
            <tbody>
              {imports.data.map((i) => (
                <tr key={i.id} className="border-t border-neutral-100">
                  <td className="max-w-56 truncate py-1 pr-3">
                    <Link
                      to="/t/$slug/bank/imports/$importId"
                      params={{ slug, importId: i.id }}
                      className="underline"
                    >
                      {i.fileName}
                    </Link>
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {i.firstDate && i.lastDate
                      ? `${formatDay(i.firstDate)} to ${formatDay(i.lastDate)}`
                      : '—'}
                  </td>
                  <td className="py-1 pr-3 text-right">{i.newLines}</td>
                  <td className="py-1 pr-3 text-right">{i.duplicateLines}</td>
                  <td className="py-1 whitespace-nowrap">
                    {new Date(i.importedAt).toLocaleString('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
