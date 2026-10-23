import { createFileRoute } from '@tanstack/react-router'
import { GiftForm } from '../components/gift-form'
import { LeaveGuard } from '../components/leave-guard'
import { useCanWrite, useTenant } from '../lib/tenant'
import { UnsavedWorkProvider, useUnsavedWork } from '../lib/unsaved'

export const Route = createFileRoute('/t/$slug/gifts/new')({
  component: RecordGift,
})

/**
 * Record a gift by hand (cash gifts step 3): staff and admins only
 * (g1q10). Leaving with a half-entered gift asks first.
 */
function RecordGift() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const work = useUnsavedWork()
  if (!canWrite) {
    return (
      <main className="mx-auto max-w-2xl p-6 text-sm text-neutral-600">
        You have view-only access to {tenant.name}, so you can’t record gifts.
      </main>
    )
  }
  return (
    <UnsavedWorkProvider work={work}>
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="mb-6 text-xl font-semibold">Record a gift</h1>
        {/* Keyed so nothing of one group's form carries to another. */}
        <GiftForm key={tenant._id} />
      </main>
      <LeaveGuard work={work} />
    </UnsavedWorkProvider>
  )
}
