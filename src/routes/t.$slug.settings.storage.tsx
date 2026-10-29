import { createFileRoute } from '@tanstack/react-router'
import { ReadRefused } from '../components/claims-ui'
import { ScansToMatchLink } from '../components/scans'
import { useFilesUsage } from '../lib/data'
import { describeUsage } from '../lib/domain/scans'
import { useCanWrite } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/storage')({
  component: Storage,
})

/**
 * Settings › Scans storage (g1q7): how much the declaration scans use.
 * With a cap (`KEEP_FILES_CAP_BYTES`; none by default), how much of it,
 * and past it new scans are refused, with "contact us". Staff and admins.
 */
function Storage() {
  const canWrite = useCanWrite()
  const usage = useFilesUsage(canWrite)
  if (!canWrite)
    return (
      <p className="text-sm">
        Scans storage is for the group’s staff and admins.
      </p>
    )
  return (
    <section className="flex max-w-lg flex-col gap-3">
      <h2 className="text-lg font-medium">Scans storage</h2>
      {usage.error ? (
        <ReadRefused
          error={usage.error}
          retry={usage.refetch}
          forbidden="Scans storage is for the group’s staff and admins."
          failed="Scans storage couldn’t load."
        />
      ) : usage.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <Usage bytes={usage.data.bytes} capBytes={usage.data.capBytes} />
      )}
      <p className="text-sm text-neutral-600">
        Scanned Gift Aid declarations are kept with the group’s records.{' '}
        <ScansToMatchLink className="underline" />.
      </p>
    </section>
  )
}

function Usage(usage: { bytes: number; capBytes: number | null }) {
  const { text, share, level } = describeUsage(usage)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm" data-testid="files-usage">
        {text} used
      </p>
      {share !== null && <Meter share={share} level={level} />}
      {level === 'warn' && (
        <p className="text-sm text-amber-900">
          Nearly full: once it is, new scans are refused. Contact us to make
          room.
        </p>
      )}
      {level === 'full' && (
        <p role="alert" className="text-sm text-red-700">
          Full: new scans are refused. Contact us to make room.
        </p>
      )}
    </div>
  )
}

function Meter({
  share,
  level,
}: {
  share: number
  level: 'ok' | 'warn' | 'full'
}) {
  return (
    <div
      role="meter"
      aria-label="Scans storage used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(share * 100))}
      className="h-2 w-full overflow-hidden rounded bg-neutral-200"
    >
      <div
        className={`h-full ${level === 'ok' ? 'bg-neutral-700' : level === 'warn' ? 'bg-amber-500' : 'bg-red-600'}`}
        style={{ width: `${Math.min(100, share * 100)}%` }}
      />
    </div>
  )
}
