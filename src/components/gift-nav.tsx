import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { formatDay, formatPence, useMyRecentGifts } from '../lib/gifts'
import type { RecentGift } from '../lib/gifts'
import { useCanWrite, useTenant } from '../lib/tenant'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

// Where gifts are reached from (cash-gifts step 4): the header's Donations
// menu and the group home page: "Record a gift" (step 3) and each recent
// gift, linking to its page (step 5).

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

/** "Record a gift": the record-gift page (step 3). */
export function RecordGiftAction({ className }: { className?: string }) {
  const tenant = useTenant()
  return (
    <Link
      to="/t/$slug/gifts/new"
      params={{ slug: tenant.slug }}
      className={className}
    >
      Record a gift
    </Link>
  )
}

/** The caller's recent gifts inline, for the home page. */
export function RecentGifts({ tenantId }: { tenantId: Id<'tenants'> }) {
  const tenant = useTenant()
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
        <li key={g._id} className="text-sm">
          <Link
            to="/t/$slug/gifts/$giftId"
            params={{ slug: tenant.slug, giftId: g._id }}
            className="block px-3 py-2 hover:bg-neutral-50"
          >
            <GiftSummary gift={g} />
          </Link>
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
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const gifts = useMyRecentGifts(tenantId, open)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="text-sm whitespace-nowrap hover:underline data-[state=open]:underline">
        Donations <span aria-hidden="true">▾</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {canWrite && (
          <>
            <DropdownMenuItem asChild>
              <Link to="/t/$slug/gifts/new" params={{ slug: tenant.slug }}>
                Record a gift
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>My recent gifts</DropdownMenuLabel>
        {/* Only menu items inside role=menu: the states are disabled ones. */}
        {gifts === undefined ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : gifts.length === 0 ? (
          <DropdownMenuItem disabled>None yet.</DropdownMenuItem>
        ) : (
          gifts.map((g) => (
            <DropdownMenuItem key={g._id} asChild>
              <Link
                to="/t/$slug/gifts/$giftId"
                params={{ slug: tenant.slug, giftId: g._id }}
              >
                <GiftSummary gift={g} />
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
