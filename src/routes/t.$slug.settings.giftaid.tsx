import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useSetClaimsGiftAid } from '../lib/data'
import { claimsGiftAid, useIsAdmin, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/giftaid')({
  component: GiftAidSettings,
})

/**
 * Settings › Gift Aid (Stripe S5): "We claim Gift Aid", on unless a
 * group that isn't a charity switches it off. Off, the donation page
 * offers no Gift Aid and the app shows none of it: the Gift Aid menu, a
 * contact's declarations, a gift's coverage, the tick when recording a
 * gift, HMRC details and the scans. Nothing recorded is changed or
 * removed, and the server's rules stay as they are: switching it back
 * on shows everything again. Admin only.
 */
function GiftAidSettings() {
  const admin = useIsAdmin()
  const tenant = useTenant()
  const save = useSetClaimsGiftAid(tenant)
  const [error, setError] = useState<string | null>(null)
  if (!admin)
    return (
      <p className="text-sm text-neutral-600">
        Whether the group claims Gift Aid is for its admins to say.
      </p>
    )

  // No optimistic update: the switch moves when the server's answer
  // lands in the caller's groups, with the counter the next save needs.
  async function toggle(on: boolean) {
    setError(null)
    const outcome = await save(on)
    if (outcome === 'stale')
      setError('Another admin changed this just now; check it and try again')
    else if (outcome === 'failed') setError('Could not save')
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Gift Aid</h2>
      <div className="flex flex-col gap-1 rounded border border-neutral-200 bg-white px-4 py-3">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            role="switch"
            checked={claimsGiftAid(tenant)}
            onChange={(e) => void toggle(e.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative h-5 w-9 shrink-0 rounded-full bg-neutral-300 transition-colors peer-checked:bg-neutral-900 peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-500 peer-focus-visible:ring-offset-2 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
          />
          <span className="text-sm font-medium">We claim Gift Aid</span>
        </label>
        <p
          data-testid="claims-gift-aid-help"
          className="text-sm text-neutral-600"
        >
          {claimsGiftAid(tenant)
            ? 'On: for a charity or CASC that reclaims tax on its donations. Switch it off if the group isn’t one: the donation page then asks nobody for a Gift Aid declaration, and Gift Aid is hidden across the app.'
            : 'Off: the donation page offers no Gift Aid, and Gift Aid is hidden across the app. Declarations and claims already recorded are kept, and show again if this is switched on.'}
        </p>
        {error && (
          <span role="alert" className="text-sm text-red-700">
            {error}
          </span>
        )}
      </div>
    </section>
  )
}
