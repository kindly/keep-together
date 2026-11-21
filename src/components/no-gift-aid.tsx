import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useGiftAid } from '../lib/gift-aid-shown'
import { useTenant } from '../lib/tenant'

/**
 * A Gift Aid page's content, or a line saying why there is none: in a
 * group that doesn't claim Gift Aid (Settings › Gift Aid; plan stripe.sv,
 * S5) and has no claim or declaration on record, the links to these
 * pages are hidden, but a bookmark still lands on them. A group that has
 * any keeps the pages: what is on record is never hidden (rule 4). While
 * what it holds is being read the page says "Loading…", and if that read
 * fails it says so with a retry: never "nothing here" on a guess.
 * With `offering` (what the page would make, in words), the page needs
 * the switch on whatever is on record.
 */
export function GiftAidOnly({
  children,
  offering,
}: {
  children: ReactNode
  /** "no new claim can be made": the page makes something new. */
  offering?: string
}) {
  const { slug } = useTenant()
  const { offered, shown, unknown, retry } = useGiftAid()
  if (offering ? offered : shown) return children
  if (unknown === 'loading')
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (unknown === 'failed')
    return (
      <main className="mx-auto max-w-lg p-6">
        <p role="alert" data-testid="gift-aid-unknown" className="text-sm">
          Couldn’t check what Gift Aid records the group has, so this page can’t
          be shown yet.{' '}
          <button type="button" className="underline" onClick={retry}>
            Try again
          </button>
        </p>
      </main>
    )
  return (
    <main className="mx-auto max-w-lg p-6">
      <p data-testid="no-gift-aid">
        {offering && shown ? (
          <>
            This group no longer claims Gift Aid, so {offering}. What is already
            on record is{' '}
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
