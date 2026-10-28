import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { MenuIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { FEATURES, useAuthState, useSignOut } from '../lib/data'
import { useTenant } from '../lib/tenant'
import { DONATIONS, GiftLink, RecordGiftAction, useDonations } from './gift-nav'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet'

// Phones (below `md`): the header is a Menu button and the group's name;
// the button opens a drawer from the left with every destination the
// desktop header has, the Donations menu flattened into it, then the
// account and Sign out. The router marks the current page
// (aria-current="page"), which `item` styles.

const item =
  'flex min-h-11 items-center rounded px-3 py-2 hover:bg-neutral-100 aria-[current=page]:bg-neutral-100 aria-[current=page]:font-medium'
const heading = 'px-3 pt-4 pb-1 text-xs text-neutral-500'

/** The drawer closes at `md` and up, where the header has the full nav. */
const WIDE = '(min-width: 48rem)'

export function MobileNav() {
  const tenant = useTenant()
  const slug = tenant.slug
  const [open, setOpen] = useState(false)
  // A navigation the drawer didn't make (the back gesture) closes it too.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    const wide = window.matchMedia(WIDE)
    const onChange = () => wide.matches && setOpen(false)
    wide.addEventListener('change', onChange)
    return () => wide.removeEventListener('change', onChange)
  }, [])
  const close = () => setOpen(false)

  return (
    <div className="mx-auto flex items-center gap-1 px-2 py-1 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          aria-label="Menu"
          className="flex size-11 items-center justify-center rounded hover:bg-neutral-100"
        >
          <MenuIcon aria-hidden="true" className="size-6" />
        </SheetTrigger>
        <SheetContent
          side="left"
          aria-describedby={undefined}
          className="md:hidden"
          overlayClassName="md:hidden"
        >
          <div className="flex items-center gap-2 border-b border-neutral-200 py-1 pr-1 pl-4">
            <SheetTitle className="min-w-0 flex-1 truncate">
              {tenant.name}
            </SheetTitle>
            <SheetClose
              aria-label="Close menu"
              className="flex size-11 items-center justify-center rounded hover:bg-neutral-100"
            >
              <XIcon aria-hidden="true" className="size-5" />
            </SheetClose>
          </div>
          <nav aria-label="Menu" className="flex flex-1 flex-col p-2">
            <Link
              to="/t/$slug"
              params={{ slug }}
              activeOptions={{ exact: true }}
              className={item}
              onClick={close}
            >
              Home
            </Link>
            <Link
              to="/t/$slug/contacts"
              params={{ slug }}
              className={item}
              onClick={close}
            >
              Contacts
            </Link>
            {FEATURES.gifts && <Donations onClick={close} />}
            {FEATURES.settings && (
              <Link
                to="/t/$slug/settings"
                params={{ slug }}
                className={item}
                onClick={close}
              >
                Settings
              </Link>
            )}
            <Account onClick={close} />
          </nav>
        </SheetContent>
      </Sheet>
      <Link
        to="/t/$slug"
        params={{ slug }}
        className="min-w-0 truncate font-medium hover:underline"
      >
        {tenant.name}
      </Link>
    </div>
  )
}

/**
 * The Donations menu, flattened: Record a gift (staff and admins), then
 * the caller's recent gifts, under the header's labels. The drawer's
 * content is mounted only while it is open, so they're fetched only then.
 */
function Donations({ onClick }: { onClick: () => void }) {
  const { canWrite, gifts } = useDonations(true)
  return (
    <Section title={DONATIONS.label}>
      {canWrite && <RecordGiftAction className={item} onClick={onClick} />}
      <p className={heading}>{DONATIONS.recent}</p>
      {gifts === undefined ? (
        <p className="px-3 py-2 text-sm text-neutral-500">
          {DONATIONS.loading}
        </p>
      ) : gifts.length === 0 ? (
        <p className="px-3 py-2 text-sm text-neutral-500">{DONATIONS.none}</p>
      ) : (
        gifts.map((g) => (
          <GiftLink
            key={g._id}
            gift={g}
            className={`${item} text-sm`}
            onClick={onClick}
          />
        ))
      )}
    </Section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="my-1 border-y border-neutral-200 py-1"
    >
      <h2 className="px-3 pt-2 pb-1 text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}

/** At the bottom: who is signed in, their account page, and Sign out. */
function Account({ onClick }: { onClick: () => void }) {
  const email = useAuthState()?.email
  const signOut = useSignOut()
  const navigate = useNavigate()
  return (
    <div className="mt-auto border-t border-neutral-200 pt-2">
      <Link
        to="/account"
        className={`${item} flex-col items-start`}
        onClick={onClick}
      >
        <span>Your account</span>
        {email && (
          <span className="max-w-full truncate text-xs text-neutral-500">
            {email}
          </span>
        )}
      </Link>
      <button
        type="button"
        onClick={() => {
          onClick()
          void signOut().then(() => navigate({ to: '/' }))
        }}
        className={`${item} w-full text-left text-neutral-600`}
      >
        Sign out
      </button>
    </div>
  )
}
