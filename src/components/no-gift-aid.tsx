import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useGiftAid } from '../lib/gift-aid-shown'
import { useTenant } from '../lib/tenant'

/**
 * A Gift Aid page's content, or a line saying why there is none: in a
 * group that doesn't claim Gift Aid (Settings › Gift Aid; plan stripe.sv,
 * S5) and has no claim or declaration on record, the links to these
 * pages are hidden, but a bookmark still lands on them. A group that has
 * any keeps the pages: what is on record is never hidden (rule 4). With
 * `offering`, the page makes something new (a claim), so it needs the
 * switch on whatever is on record.
 */
export function GiftAidOnly({
  children,
  offering = false,
}: {
  children: ReactNode
  offering?: boolean
}) {
  const { slug } = useTenant()
  const { offered, shown } = useGiftAid()
  if (offering ? offered : shown) return children
  return (
    <main className="mx-auto max-w-lg p-6">
      <p data-testid="no-gift-aid">
        {offering && shown ? (
          <>
            This group no longer claims Gift Aid, so no new claim can be made.
            The claims already made are{' '}
            <Link to="/t/$slug/giftaid" params={{ slug }} className="underline">
              still here
            </Link>
            .{' '}
          </>
        ) : (
          'This group doesn’t claim Gift Aid, so there is nothing here. '
        )}
        An admin can change that in Settings, under Gift Aid.
      </p>
    </main>
  )
}

/**
 * Above Gift Aid's records in a group that has switched it off: they are
 * kept and shown, and nothing new is offered.
 */
export function GiftAidOffNotice({ what }: { what: string }) {
  const { offered } = useGiftAid()
  if (offered) return null
  return (
    <p
      role="status"
      data-testid="gift-aid-off"
      className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 text-sm text-neutral-700"
    >
      This group no longer claims Gift Aid (Settings › Gift Aid). {what}
    </p>
  )
}
