import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ScanThumb, ScanWithPhone, pagesText } from '../components/scans'
import { ReadRefused } from '../components/claims-ui'
import { useMembers, useScanInbox } from '../lib/data'
import { useCanWrite, useIsAdmin, useTenant } from '../lib/tenant'

type Search = { sitting?: boolean }

export const Route = createFileRoute('/t/$slug/scans/')({
  component: ScansToMatch,
  // The Gift Aid menu's "Scan a stack" opens the sitting on arrival.
  validateSearch: (s: Record<string, unknown>): Search =>
    s.sitting === true || s.sitting === 'true' ? { sitting: true } : {},
})

const AT = new Intl.DateTimeFormat([], {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/**
 * "Scans to match" (g1q4): every draft scan in the group, oldest first,
 * whoever scanned it, each to review beside its declaration; and "Scan a
 * stack with phone", a sitting whose scans all land here (g2q3). Staff
 * and admins; a viewer is told.
 */
function ScansToMatch() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const admin = useIsAdmin()
  const { sitting } = Route.useSearch()
  const navigate = useNavigate()
  if (!canWrite)
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>Declaration scans are for the group’s staff and admins.</p>
      </main>
    )
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Scans to match</h1>
        <div className="flex flex-wrap items-baseline gap-3">
          {admin && (
            <Link
              to="/t/$slug/scans/deletable"
              params={{ slug: tenant.slug }}
              className="text-sm underline"
            >
              Scans that can be deleted
            </Link>
          )}
          <ScanWithPhone
            purpose="stack"
            label="Scan a stack with phone"
            initialOpen={sitting === true}
            onClose={() =>
              sitting &&
              void navigate({
                to: '/t/$slug/scans',
                params: { slug: tenant.slug },
                search: {},
                replace: true,
              })
            }
            className="rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700"
          />
        </div>
      </header>
      <Inbox />
    </main>
  )
}

function Inbox() {
  const { slug } = useTenant()
  const inbox = useScanInbox()
  const members = useMembers()
  const name = (id: number | null) =>
    id === null
      ? ''
      : (members?.find((m) => String(m.userId) === String(id))?.name ?? '…')
  if (inbox.error)
    return <ReadRefused error={inbox.error} retry={inbox.refetch} />
  if (inbox.data === undefined)
    return <p className="text-sm text-neutral-500">Loading…</p>
  if (inbox.data.length === 0)
    return (
      <p className="text-sm text-neutral-600">
        Nothing to match. Scans that aren’t matched to a declaration when they
        arrive wait here.
      </p>
    )
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
      {inbox.data.map((s) => (
        <li
          key={s.id}
          data-testid="inbox-scan"
          className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-2 text-xs"
        >
          <ScanThumb scan={s} />
          <span>{pagesText(s.pages.length)}</span>
          <span className="text-neutral-600">
            {AT.format(s.scannedAt)}
            {s.scannedBy !== null && `, ${name(s.scannedBy)}`}
          </span>
          <Link
            to="/t/$slug/scans/$scanId"
            params={{ slug, scanId: s.id }}
            className="self-start rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
            aria-label={`Review scan of ${AT.format(s.scannedAt)}`}
          >
            Review
          </Link>
        </li>
      ))}
    </ul>
  )
}
