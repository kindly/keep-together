import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ConfirmDialog } from '../components/confirm-dialog'
import { useSetClaimsGiftAid } from '../lib/data'
import { onRecordText, useGiftAidOnRecord } from '../lib/gift-aid-shown'
import { claimsGiftAid, useIsAdmin, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/giftaid')({
  component: GiftAidSettings,
})

/** What switching off stops, whatever is on record. */
const STOPS =
  'the donation page asking donors for a Gift Aid declaration, the Gift Aid tick when recording a gift, recording, editing or scanning declarations (matching scans included), and starting new claims'
/** What stays, once anything is on record. */
const STAYS =
  'the list of claims and each claim’s page (under Gift Aid in the menu), each contact’s declarations, and the claim a gift is in. A claim already started can still be finished, and a declaration can still be cancelled'

/**
 * Settings › Gift Aid (Stripe S5): "We claim Gift Aid", on unless a
 * group that isn't a charity switches it off. Off stops the app offering
 * Gift Aid; it never hides what is on record (rule 4: a claim is a
 * financial record). Before it saves, the switch says what the group
 * holds and what stays visible: with declarations or claims on record
 * those stay; with none, Gift Aid leaves the app entirely.
 * Nothing recorded is changed and the server's rules stay as they are.
 * Admin only.
 */
function GiftAidSettings() {
  const admin = useIsAdmin()
  const tenant = useTenant()
  const on = claimsGiftAid(tenant)
  const save = useSetClaimsGiftAid(tenant)
  const held = useGiftAidOnRecord(tenant.slug, admin)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  if (!admin)
    return (
      <p className="text-sm text-neutral-600">
        Whether the group claims Gift Aid is for its admins to say.
      </p>
    )
  const recorded = held && onRecordText(held)

  // No optimistic update: the switch moves when the server's answer
  // lands in the caller's groups, with the counter the next save needs.
  async function set(to: boolean) {
    setError(null)
    const outcome = await save(to)
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
            checked={on}
            // Off is asked about first; on is nothing to warn of.
            onChange={(e) =>
              e.target.checked ? void set(true) : setAsking(true)
            }
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
          {on
            ? 'On: for a charity or CASC that reclaims tax on its donations. Switch it off if the group isn’t one.'
            : `Off: the app no longer offers Gift Aid (${STOPS}).`}
        </p>
        <p
          data-testid="gift-aid-on-record"
          className="text-sm text-neutral-600"
        >
          {held === undefined
            ? 'Checking what is on record…'
            : recorded
              ? `On record: ${recorded}. ${on ? 'Switching off keeps them in view' : 'They stay in view'}: ${STAYS}.`
              : on
                ? 'Nothing is on record: no declarations and no claims. Switching off hides Gift Aid across the app.'
                : 'Nothing is on record: no declarations and no claims. So Gift Aid is hidden across the app.'}
        </p>
        {error && (
          <span role="alert" className="text-sm text-red-700">
            {error}
          </span>
        )}
      </div>
      <ConfirmDialog
        open={asking}
        title="Stop claiming Gift Aid?"
        description={
          held === undefined
            ? 'Checking what the group has on record…'
            : recorded
              ? `The group has ${recorded} on record. They are kept and stay visible: ${STAYS}. What stops: ${STOPS}. You can switch it back on at any time.`
              : `The group has no declarations and no claims on record, so Gift Aid disappears from the app: its menu, the Gift Aid panel on contacts and on gifts, HMRC details and scans. What stops: ${STOPS}. You can switch it back on at any time.`
        }
        confirm="Switch off"
        cancel="Keep claiming"
        // What is on record is said before it saves, never guessed.
        confirmDisabled={held === undefined}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          void set(false)
        }}
      />
    </section>
  )
}
