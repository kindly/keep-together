import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ConfirmDialog } from '../components/confirm-dialog'
import { ReadRefused, useStepUp } from '../components/claims-ui'
import { pagesText } from '../components/scans'
import { localToday } from '../components/source-code-picker'
import { useDeletableScans, useScanWrites } from '../lib/data'
import type { DeletableScan } from '../lib/data'
import { formatDay, refusal } from '../lib/gifts'
import { useIsAdmin, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/scans/deletable')({
  component: Deletable,
})

/**
 * "Scans that can be deleted" (g1q9): accepted scans whose declaration
 * has covered no gift for 7 years (HMRC 3.30: kept while it covers
 * donations, then counted from the last). Nothing is deleted
 * automatically: an admin deletes the images from here, a sign-in
 * within the hour; the scan's row stays as the audit record.
 */
function Deletable() {
  const admin = useIsAdmin()
  const report = useDeletableScans(localToday())
  if (!admin)
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>This report is for the group’s admins.</p>
      </main>
    )
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">Scans that can be deleted</h1>
      <p className="text-sm text-neutral-600">
        Declarations that have covered no gift for 7 years. Deleting removes the
        images; a record that the scan existed, and who deleted it, stays.
      </p>
      {report.error ? (
        <ReadRefused error={report.error} retry={report.refetch} />
      ) : report.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : report.data.length === 0 ? (
        <p className="text-sm text-neutral-600">None.</p>
      ) : (
        <Rows rows={report.data} />
      )}
    </main>
  )
}

function Rows({ rows }: { rows: Array<DeletableScan> }) {
  const { slug } = useTenant()
  const writes = useScanWrites()
  const stepUp = useStepUp()
  const [confirming, setConfirming] = useState<DeletableScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(row: DeletableScan) {
    setError(null)
    setBusy(true)
    try {
      await stepUp.run(async () => {
        await writes.deleteImages(row.scan)
      })
    } catch (err) {
      setError(
        refusal(
          err,
          'Could not delete the images',
          'This scan changed just now: the report has been read again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {stepUp.form}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-neutral-500">
              <th className="py-2 pr-3 font-normal">Contact</th>
              <th className="py-2 pr-3 font-normal">Declaration made</th>
              <th className="py-2 pr-3 font-normal">Last gift covered</th>
              <th className="py-2 pr-3 font-normal">Scan</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.scan.id}
                data-testid="deletable-scan"
                className="border-b border-neutral-100"
              >
                <td className="py-2 pr-3">
                  <Link
                    to="/t/$slug/contacts/$contactId"
                    params={{ slug, contactId: r.contactId }}
                    className="underline"
                  >
                    Open contact
                  </Link>
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {formatDay(r.declarationMadeOn)}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {r.lastCoveredOn ? formatDay(r.lastCoveredOn) : 'none'}
                </td>
                <td className="py-2 pr-3">{pagesText(r.scan.pages.length)}</td>
                <td className="py-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(r)}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
                  >
                    Delete images
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirming !== null}
        title="Delete this scan’s images?"
        description="They can’t be brought back. The record that the declaration had a scan, and that you deleted it, stays."
        confirm="Delete images"
        cancel="Keep them"
        onConfirm={() => {
          const row = confirming
          setConfirming(null)
          if (row) void run(row)
        }}
        onCancel={() => setConfirming(null)}
      />
    </>
  )
}
