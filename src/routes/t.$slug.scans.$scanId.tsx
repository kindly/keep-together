import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ScanReview } from '../components/scans'
import { useCanWrite, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/scans/$scanId')({
  component: ReviewScan,
})

/**
 * One scan from "Scans to match", beside the declaration form (g1q5):
 * pick the donor, then a new paper declaration or one of theirs without a
 * scan. Accept or discard goes back to the list.
 */
function ReviewScan() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const { scanId } = Route.useParams()
  const navigate = useNavigate()
  if (!canWrite)
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>Declaration scans are for the group’s staff and admins.</p>
      </main>
    )
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <Link
        to="/t/$slug/scans"
        params={{ slug: tenant.slug }}
        className="self-start text-sm underline"
      >
        ← Scans to match
      </Link>
      <h1 className="text-xl font-semibold">Review scan</h1>
      <ScanReview
        key={scanId}
        scanId={scanId}
        onDone={() =>
          void navigate({ to: '/t/$slug/scans', params: { slug: tenant.slug } })
        }
      />
    </main>
  )
}
