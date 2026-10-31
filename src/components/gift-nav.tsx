import { Link, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import type { ComponentProps } from 'react'
import { formatDay, formatPence, useMyRecentGifts } from '../lib/gifts'
import type { RecentGift } from '../lib/gifts'
import { FEATURES, useGoCardlessStatus } from '../lib/data'
import { STATUS_LABELS, isReceived } from '../lib/domain/gift-status'
import { useCanWrite, useIsAdmin, useTenant } from '../lib/tenant'
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

/**
 * Amount, contact, date; a gift that isn't money received struck through
 * and marked with its status.
 */
function GiftSummary({ gift }: { gift: RecentGift }) {
  const received = isReceived(gift.status)
  return (
    <span className="flex w-full items-baseline gap-2">
      <span className={received ? '' : 'text-neutral-500 line-through'}>
        {formatPence(gift.amount)}
      </span>
      <span className="min-w-0 flex-1 truncate">{gift.contactName}</span>
      {gift.notOnAStatement && (
        <span className="text-xs text-amber-700">not on a statement yet</span>
      )}
      {!received && (
        <span className="text-xs text-red-700">
          {STATUS_LABELS[gift.status]}
        </span>
      )}
      <span className="text-xs whitespace-nowrap text-neutral-500">
        {formatDay(gift.receivedOn)}
      </span>
    </span>
  )
}

// What the Donations entries say: the header's menu and the mobile drawer
// list the same ones, from here and `useDonations`.
export const DONATIONS = {
  label: 'Donations',
  record: 'Record a gift',
  recent: 'My recent gifts',
  unmatched: 'Unmatched payments',
  bank: 'Bank statements',
  batches: 'Paying-in batches',
  reconcile: 'Reconcile',
  expected: 'Expected vs actual',
  loading: 'Loading…',
  none: 'None yet.',
} as const

type AnchorProps = Omit<ComponentProps<'a'>, 'href' | 'children'> & {
  /** Replace the current history entry (the mobile drawer's). */
  replace?: boolean
}

// What the Gift Aid entries say: the header's menu and the mobile drawer
// list the same ones, from here and `useGiftAidEntries`.
export const GIFT_AID = {
  label: 'Gift Aid',
  claims: 'Claims',
  scans: 'Scans to match',
  stack: 'Scan a stack with phone',
  deletable: 'Scans that can be deleted',
} as const

type GiftAidEntry = {
  key: keyof typeof GIFT_AID
  to: '/t/$slug/giftaid' | '/t/$slug/scans' | '/t/$slug/scans/deletable'
  search?: { sitting: true }
}

/**
 * The Gift Aid entries the caller has: the claims (G3, admins only, as
 * every claims route is), "Scans to match" and a stack sitting (staff and
 * admins, declaration scans g2q3), and the "can be deleted" report
 * (admins). None for a viewer.
 */
export function useGiftAidEntries(): Array<GiftAidEntry> {
  const admin = useIsAdmin()
  const canWrite = useCanWrite()
  if (!canWrite) return []
  return [
    ...(admin && FEATURES.giftAidClaims
      ? [{ key: 'claims', to: '/t/$slug/giftaid' } as const]
      : []),
    { key: 'scans', to: '/t/$slug/scans' },
    { key: 'stack', to: '/t/$slug/scans', search: { sitting: true } },
    ...(admin
      ? [{ key: 'deletable', to: '/t/$slug/scans/deletable' } as const]
      : []),
  ]
}

/** One Gift Aid entry as a link; other props pass through. */
export function GiftAidEntryLink({
  entry,
  activeProps,
  ...props
}: AnchorProps & {
  entry: GiftAidEntry
  activeProps?: { className?: string }
}) {
  const tenant = useTenant()
  return (
    <Link
      to={entry.to}
      params={{ slug: tenant.slug }}
      search={entry.search ?? {}}
      activeProps={activeProps}
      activeOptions={{ includeSearch: true, exact: entry.key !== 'claims' }}
      {...props}
    >
      {GIFT_AID[entry.key]}
    </Link>
  )
}

/**
 * The header's Gift Aid ▾: the caller's entries; nothing with none. On
 * a Gift Aid page (claims or scans) it is marked, as a link to it was.
 */
export function GiftAidMenu() {
  const entries = useGiftAidEntries()
  const { slug } = useTenant()
  const here = useRouterState({
    select: (s) =>
      [`/t/${slug}/giftaid`, `/t/${slug}/scans`].some(
        (p) =>
          s.location.pathname === p || s.location.pathname.startsWith(`${p}/`),
      ),
  })
  if (entries.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-current={here || undefined}
        className="text-sm whitespace-nowrap hover:underline data-[current]:font-medium data-[current]:underline data-[state=open]:underline"
      >
        {GIFT_AID.label} <span aria-hidden="true">▾</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {entries.map((e) => (
          <DropdownMenuItem key={e.key} asChild>
            <GiftAidEntryLink entry={e} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Who may record a gift, whether the Direct Debit work lists are theirs
 * (staff and admins, while GoCardless is on here) and its report
 * (everyone, while it is on), and the caller's
 * last 10 gifts: fetched only while `open` (undefined until then, and
 * while loading).
 */
export function useDonations(open: boolean) {
  const canWrite = useCanWrite()
  const enabled = useGoCardlessStatus()?.enabled === true
  return {
    canWrite,
    directDebit: enabled && canWrite,
    report: enabled,
    gifts: useMyRecentGifts(open),
  }
}

/** "Expected vs actual": the regular gifts' report (terms step 6). */
export function ExpectedReportAction(props: AnchorProps) {
  const tenant = useTenant()
  return (
    <Link
      to="/t/$slug/reports/expected"
      params={{ slug: tenant.slug }}
      {...props}
    >
      {DONATIONS.expected}
    </Link>
  )
}

/** "Bank statements": the accounts' imports (staff and admins). */
export function BankStatementsAction(props: AnchorProps) {
  const tenant = useTenant()
  return (
    <Link to="/t/$slug/bank" params={{ slug: tenant.slug }} {...props}>
      {DONATIONS.bank}
    </Link>
  )
}

/** "Reconcile": statement lines to match (staff and admins). */
export function ReconcileAction(props: AnchorProps) {
  const tenant = useTenant()
  return (
    <Link
      to="/t/$slug/bank/reconcile"
      params={{ slug: tenant.slug }}
      {...props}
    >
      {DONATIONS.reconcile}
    </Link>
  )
}

/** "Paying-in batches": cash and cheques paid in together. */
export function BatchesAction(props: AnchorProps) {
  const tenant = useTenant()
  return (
    <Link to="/t/$slug/bank/batches" params={{ slug: tenant.slug }} {...props}>
      {DONATIONS.batches}
    </Link>
  )
}

/** "Unmatched payments" (GoCardless): payments to match to a contact. */
export function UnmatchedAction(props: AnchorProps) {
  const tenant = useTenant()
  return (
    <Link
      to="/t/$slug/gocardless/unmatched"
      params={{ slug: tenant.slug }}
      {...props}
    >
      {DONATIONS.unmatched}
    </Link>
  )
}

/**
 * "Record a gift": the record-gift page (step 3). Other props pass
 * through, as a menu item's do (asChild).
 */
export function RecordGiftAction(props: AnchorProps) {
  const tenant = useTenant()
  return (
    <Link to="/t/$slug/gifts/new" params={{ slug: tenant.slug }} {...props}>
      {DONATIONS.record}
    </Link>
  )
}

/** One recent gift, linking to its page; other props pass through. */
export function GiftLink({
  gift,
  ...props
}: AnchorProps & { gift: RecentGift }) {
  const tenant = useTenant()
  return (
    <Link
      to="/t/$slug/gifts/$giftId"
      params={{ slug: tenant.slug, giftId: gift._id }}
      {...props}
    >
      <GiftSummary gift={gift} />
    </Link>
  )
}

/** The caller's recent gifts inline, for the home page. */
export function RecentGifts() {
  const gifts = useMyRecentGifts()
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
          <GiftLink gift={g} className="block px-3 py-2 hover:bg-neutral-50" />
        </li>
      ))}
    </ul>
  )
}

/**
 * The header's Donations ▾: "Record a gift", "Bank statements" and, with GoCardless on,
 * "Unmatched payments" (staff and admins); "Expected vs actual" (with
 * GoCardless on); then the caller's last 10 gifts. Fetched only while
 * open.
 */
export function DonationsMenu() {
  const [open, setOpen] = useState(false)
  const { canWrite, directDebit, report, gifts } = useDonations(open)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="text-sm whitespace-nowrap hover:underline data-[state=open]:underline">
        {DONATIONS.label} <span aria-hidden="true">▾</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {canWrite && (
          <>
            <DropdownMenuItem asChild>
              <RecordGiftAction />
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <BankStatementsAction />
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <ReconcileAction />
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <BatchesAction />
            </DropdownMenuItem>
            {directDebit && (
              <DropdownMenuItem asChild>
                <UnmatchedAction />
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        {report && (
          <>
            <DropdownMenuItem asChild>
              <ExpectedReportAction />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>{DONATIONS.recent}</DropdownMenuLabel>
        {/* Only menu items inside role=menu: the states are disabled ones. */}
        {gifts === undefined ? (
          <DropdownMenuItem disabled>{DONATIONS.loading}</DropdownMenuItem>
        ) : gifts.length === 0 ? (
          <DropdownMenuItem disabled>{DONATIONS.none}</DropdownMenuItem>
        ) : (
          gifts.map((g) => (
            <DropdownMenuItem key={g._id} asChild>
              <GiftLink gift={g} />
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
