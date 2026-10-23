import { useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { formatDay, formatPence, useMyRecentGifts } from '../lib/gifts'
import type { RecentGift } from '../lib/gifts'
import { useCanWrite } from '../lib/tenant'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

// Where gifts are reached from (cash-gifts step 4): the header's Donations
// menu and the group home page. The record-gift page (step 3) and the gift
// page (step 5) don't exist yet, so "Record a gift" is shown disabled and
// a recent gift isn't a link; those steps turn them into links here.

/** Amount, contact, date; a void gift struck through and marked. */
function GiftSummary({ gift }: { gift: RecentGift }) {
  const isVoid = gift.status === 'void'
  return (
    <span className="flex w-full items-baseline gap-2">
      <span className={isVoid ? 'text-neutral-500 line-through' : ''}>
        {formatPence(gift.amount)}
      </span>
      <span className="min-w-0 flex-1 truncate">{gift.contactName}</span>
      {isVoid && <span className="text-xs text-red-700">void</span>}
      <span className="text-xs whitespace-nowrap text-neutral-500">
        {formatDay(gift.receivedOn)}
      </span>
    </span>
  )
}

/** "Record a gift", disabled until its page exists (step 3). */
export function RecordGiftAction({ className }: { className?: string }) {
  return (
    <span aria-disabled="true" title="Coming soon" className={className}>
      Record a gift
    </span>
  )
}

/** The caller's recent gifts inline, for the home page. */
export function RecentGifts({ tenantId }: { tenantId: Id<'tenants'> }) {
  const gifts = useMyRecentGifts(tenantId)
  if (gifts === undefined)
    return <p className="text-sm text-neutral-500">Loading…</p>
  if (gifts.length === 0)
    return (
      <p className="text-sm text-neutral-500">
        You haven't recorded any gifts yet.
      </p>
    )
  return (
    <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
      {gifts.map((g) => (
        <li key={g._id} className="px-3 py-2 text-sm">
          <GiftSummary gift={g} />
        </li>
      ))}
    </ul>
  )
}

/**
 * The header's Donations ▾: "Record a gift" (staff and admins), then the
 * caller's last 10 gifts. Subscribed only while open.
 */
export function DonationsMenu({ tenantId }: { tenantId: Id<'tenants'> }) {
  const [open, setOpen] = useState(false)
  const canWrite = useCanWrite()
  const gifts = useMyRecentGifts(tenantId, open)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="text-sm whitespace-nowrap hover:underline data-[state=open]:underline">
        Donations ▾
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {canWrite && (
          <>
            <DropdownMenuItem disabled>
              <RecordGiftAction />
              <span className="ml-auto text-xs">coming soon</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>My recent gifts</DropdownMenuLabel>
        {gifts === undefined ? (
          <p className="px-2 py-1.5 text-sm text-neutral-500">Loading…</p>
        ) : gifts.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-neutral-500">None yet.</p>
        ) : (
          gifts.map((g) => (
            <DropdownMenuItem key={g._id}>
              <GiftSummary gift={g} />
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
