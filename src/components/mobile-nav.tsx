import {
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { ChevronDownIcon, MenuIcon, XIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { FEATURES, useAuthState, useSignOut } from '../lib/data'
import { useTenant } from '../lib/tenant'
import {
  DONATIONS,
  GIFT_AID,
  GiftAidEntryLink,
  GiftLink,
  RecordGiftAction,
  UnmatchedAction,
  useDonations,
  useGiftAidEntries,
} from './gift-nav'
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
  const { open, onOpenChange, follow, navigated } = useDrawerEntry()

  return (
    <div className="mx-auto flex items-center gap-1 px-2 py-1 md:hidden">
      <Sheet open={open} onOpenChange={onOpenChange}>
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
          // Closed by a navigation: the new page's own focus (an autofocus
          // field) wins over the Menu button.
          onCloseAutoFocus={(e) => navigated.current && e.preventDefault()}
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
              {...follow}
            >
              Home
            </Link>
            <Link
              to="/t/$slug/contacts"
              params={{ slug }}
              className={item}
              {...follow}
            >
              Contacts
            </Link>
            {FEATURES.gifts && <Donations follow={follow} />}
            {FEATURES.gifts && <GiftAid follow={follow} />}
            {FEATURES.settings && (
              <Link
                to="/t/$slug/settings"
                params={{ slug }}
                className={item}
                {...follow}
              >
                Settings
              </Link>
            )}
            <Account follow={follow} />
          </nav>
        </SheetContent>
      </Sheet>
      <Link
        to="/t/$slug"
        params={{ slug }}
        className="flex min-h-11 min-w-0 items-center truncate font-medium hover:underline"
      >
        {tenant.name}
      </Link>
    </div>
  )
}

type DrawerState = { mobileNav?: string }
/** A drawer link's props: it closes the drawer and takes its entry. */
type Follow = { replace: boolean; onClick: () => void }
let opened = 0

/**
 * The drawer as a history entry, so the back gesture closes it and stays
 * on the page. Opening pushes an entry for the same URL marked with this
 * opening's id; the drawer is open while that entry is current. Back pops
 * it (closing the drawer); a link in the drawer replaces it (`replace`),
 * so the page it opens takes the drawer's place in history (and closes
 * the drawer at once, before that page mounts and autofocuses); any other
 * navigation (a search change too) leaves it, and the drawer closes. Esc,
 * the overlay, Close and widening to md unwind the entry, past any
 * blocker: it is the same page. `navigated` says whether the last close
 * came from a navigation.
 */
function useDrawerEntry() {
  const router = useRouter()
  const navigate = useNavigate()
  const marker = useRouterState({
    select: (s) => (s.location.state as DrawerState).mobileNav,
  })
  const href = useRouterState({ select: (s) => s.location.href })
  const [open, setOpen] = useState(false)
  // This opening's id, whether its entry has been current, and the push.
  const entry = useRef<{
    id: string
    reached: boolean
    pushed: Promise<void>
  } | null>(null)
  const navigated = useRef(false)
  const at = useRef(href)
  const onEntry = entry.current !== null && marker === entry.current.id

  /**
   * `unwind`: Esc, the overlay, Close, widening; `back`: the entry was
   * popped, same page; `navigated`: another page took its place.
   */
  const closeBy = (how: 'unwind' | 'back' | 'navigated') => {
    navigated.current = how === 'navigated'
    setOpen(false)
    const left = entry.current
    entry.current = null
    if (how !== 'unwind' || !left) return
    void left.pushed.then(() => {
      const state = router.state.location.state as DrawerState
      if (state.mobileNav === left.id)
        router.history.back({ ignoreBlocker: true })
    })
  }

  // Leaving the entry, or the URL changing under it, is a navigation.
  useEffect(() => {
    const e = entry.current
    if (!e) return
    if (marker === e.id) e.reached = true
    else if (e.reached) closeBy(at.current === href ? 'back' : 'navigated')
  }, [marker])
  useEffect(() => {
    if (at.current !== href && entry.current) closeBy('navigated')
    at.current = href
  }, [href])
  useEffect(() => {
    const wide = window.matchMedia(WIDE)
    const onChange = () => wide.matches && entry.current && closeBy('unwind')
    wide.addEventListener('change', onChange)
    return () => wide.removeEventListener('change', onChange)
  }, [])

  const onOpenChange = (next: boolean) => {
    if (!next) return closeBy('unwind')
    const id = `${Date.now()}-${++opened}`
    navigated.current = false
    setOpen(true)
    entry.current = {
      id,
      reached: false,
      pushed: navigate({
        to: '.',
        search: true,
        hash: true,
        state: (s) => ({ ...s, mobileNav: id }) as typeof s,
        resetScroll: false,
        ignoreBlocker: true,
      }),
    }
  }
  const follow: Follow = {
    replace: onEntry,
    onClick: () => closeBy('navigated'),
  }
  return { open, onOpenChange, follow, navigated }
}

/** The Donations section's open state, kept for the session. */
const DONATIONS_OPEN = 'keep:mobile-nav:donations'
function stored(): boolean | null {
  try {
    const v = sessionStorage.getItem(DONATIONS_OPEN)
    return v === null ? null : v === 'open'
  } catch {
    return null
  }
}
function store(open: boolean) {
  try {
    sessionStorage.setItem(DONATIONS_OPEN, open ? 'open' : 'closed')
  } catch {
    // Storage refused (a private window): open state lasts this drawer.
  }
}

/**
 * The Donations menu, flattened into a section that opens in place:
 * Record a gift (staff and admins), then the caller's recent gifts, under
 * the header's labels. Collapsed until opened, then as last left this
 * session; open on a donations page (a gift, or recording one). The gifts
 * are fetched only while it is open.
 */
/**
 * Gift Aid's entries under a heading, flat: the claims, "Scans to match",
 * the "can be deleted" report. Not the stack sitting: on a phone it would
 * show the phone a QR code of itself.
 */
function GiftAid({ follow }: { follow: Follow }) {
  const entries = useGiftAidEntries().filter((e) => e.key !== 'stack')
  if (entries.length === 0) return null
  return (
    <section aria-label={GIFT_AID.label}>
      <p className={heading}>{GIFT_AID.label}</p>
      {entries.map((e) => (
        <GiftAidEntryLink
          key={e.key}
          entry={e}
          className={`${item} pl-6`}
          {...follow}
        />
      ))}
    </section>
  )
}

function Donations({ follow }: { follow: Follow }) {
  const { slug } = useTenant()
  const onDonations = useRouterState({
    select: (s) =>
      s.location.pathname.startsWith(`/t/${slug}/gifts/`) ||
      s.location.pathname.startsWith(`/t/${slug}/gocardless/`),
  })
  const [open, setOpen] = useState(() => onDonations || stored() === true)
  useEffect(() => {
    if (onDonations) store(true)
  }, [onDonations])
  const { canWrite, directDebit, gifts } = useDonations(open)
  const id = useId()
  const toggle = () => {
    store(!open)
    setOpen(!open)
  }
  return (
    <section
      aria-label={DONATIONS.label}
      className="my-1 border-y border-neutral-200 py-1"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className={`${item} w-full justify-between text-left`}
      >
        {DONATIONS.label}
        <ChevronDownIcon
          aria-hidden="true"
          className={`size-4 text-neutral-500 motion-safe:transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div id={id} hidden={!open} className="pl-3">
        {canWrite && <RecordGiftAction className={item} {...follow} />}
        {directDebit && <UnmatchedAction className={item} {...follow} />}
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
              {...follow}
            />
          ))
        )}
      </div>
    </section>
  )
}

/** At the bottom: who is signed in, their account page, and Sign out. */
function Account({ follow }: { follow: Follow }) {
  const email = useAuthState()?.email
  const signOut = useSignOut()
  const navigate = useNavigate()
  return (
    <div className="mt-auto border-t border-neutral-200 pt-2">
      <Link
        to="/account"
        className={`${item} flex-col items-start`}
        {...follow}
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
        onClick={() =>
          void signOut().then(() =>
            navigate({ to: '/', replace: follow.replace }),
          )
        }
        className={`${item} w-full text-left text-neutral-600`}
      >
        Sign out
      </button>
    </div>
  )
}
