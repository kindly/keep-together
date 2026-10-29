import { Link } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { encode } from 'uqr'
import {
  endScanPairingNow,
  fetchContactSnapshot,
  scanLink,
  scanPageUrl,
  useContactSearch,
  useDeclarationScans,
  useEndScanPairing,
  useMembers,
  useScan,
  useScanInbox,
  useScanPairing,
  useScanWrites,
  useStartScanPairing,
} from '../lib/data'
import type {
  DeclarationDetails,
  ScanPairingView,
  ScanPurpose,
  ScanView,
} from '../lib/data'
import type { DeclarationScope } from '../lib/data/rust-types/DeclarationScope'
import type { Id } from '../lib/domain/ids'
import {
  MAX_PAGES,
  canMerge,
  endsIn,
  linkState,
  matchable,
  movePage,
} from '../lib/domain/scans'
import { HMRC_MODEL_WORDING_VERSION } from '../lib/domain/warnings'
import {
  SCOPE_LABELS,
  describeDeclaration,
  useDeclarations,
} from '../lib/giftaid'
import type { Declaration } from '../lib/giftaid'
import { formatDay, refusal } from '../lib/gifts'
import { useCanWrite, useTenant } from '../lib/tenant'
import { useStepUp } from './claims-ui'
import { ConfirmDialog } from './confirm-dialog'
import { localToday } from './source-code-picker'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'

// Declaration scans on the laptop (plan declaration-scans, step 4): a
// sitting's QR code and its live stack, the side-by-side review that
// matches a scan to a declaration, and the "scan held" line on a
// declaration. Staff and admins only, but the line: a viewer sees
// "✓ scan held" and when, nothing of the image (g2q1).

const AT = new Intl.DateTimeFormat([], {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const small =
  'rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50'
const primary =
  'rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'

/** A scan's write refused, as one line. */
const scanRefusal = (err: unknown, fallback: string) =>
  refusal(
    err,
    fallback,
    'Someone else changed this scan just now: it has been read again. Check it, then try again',
  )

/** "2 pages", "1 page". */
export const pagesText = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`

/** Who did it, by user id: "…" while the members load. */
function useName() {
  const members = useMembers()
  return (userId: number | null | undefined) =>
    members === undefined
      ? '…'
      : (members.find((m) => String(m.userId) === String(userId))?.name ??
        'someone no longer in the group')
}

/** A QR code for `value`, drawn as SVG (black on white, a quiet zone). */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: 2 })
  const path = data
    .flatMap((row, y) =>
      row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : '')),
    )
    .join('')
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-56 bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  )
}

// ── a sitting ──────────────────────────────────────────────────────────────

/**
 * "Scan with phone": opens the sitting (a pairing, its QR code and its
 * stack). Staff and admins; nothing for a viewer. `contactId`: the
 * contact on screen, whose declarations a scan is matched to by default.
 * `resume`: a pairing this tab started before (the stack page keeps it
 * in its URL), shown again instead of starting a second; `onStarted`
 * hears each new one.
 */
export function ScanWithPhone({
  purpose,
  contactId,
  label = 'Scan with phone',
  initialOpen = false,
  resume,
  onStarted,
  onClose,
  className = small,
}: {
  purpose: ScanPurpose
  contactId?: Id<'contacts'>
  label?: string
  initialOpen?: boolean
  resume?: string
  onStarted?: (pairingId: string) => void
  onClose?: () => void
  className?: string
}) {
  const canWrite = useCanWrite()
  const [open, setOpen] = useState(initialOpen)
  if (!canWrite) return null
  return (
    <>
      <button
        type="button"
        className={`${className} self-start`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && (
        <ScanSitting
          purpose={purpose}
          contactId={contactId}
          resume={resume}
          onStarted={onStarted}
          onClose={() => {
            setOpen(false)
            onClose?.()
          }}
        />
      )}
    </>
  )
}

type Started = { id: string; path: string | null }

/**
 * A sitting in a dialog: it starts a pairing as it opens (after "Confirm
 * it's you" when the sign-in is over an hour old), then shows the QR code
 * and the link to copy, whether a phone holds it and when it ends, and
 * the scans as they arrive (each `declaration_scans` event refetches
 * them). "Review" opens one beside the declaration form, in place.
 *
 * The link never outlives the dialog: "Done" ends it and stays open
 * saying so if that fails; leaving the dialog any other way (the page
 * navigated away, the tab closed or reloaded) ends it with a `keepalive`
 * request; a start that answers after the dialog has gone is ended at
 * once. A click outside doesn't close it (a stray one mid-stack would cut
 * the phone off); Esc while reviewing goes back to the stack. Unmatched
 * scans wait in "Scans to match".
 */
function ScanSitting({
  purpose,
  contactId,
  resume,
  onStarted,
  onClose,
}: {
  purpose: ScanPurpose
  contactId?: Id<'contacts'>
  resume?: string
  onStarted?: (pairingId: string) => void
  onClose: () => void
}) {
  const { slug } = useTenant()
  const start = useStartScanPairing()
  const end = useEndScanPairing()
  const stepUp = useStepUp()
  const [started, setStarted] = useState<Started | null>(
    resume ? { id: resume, path: null } : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [notStarted, setNotStarted] = useState(false)
  const [closing, setClosing] = useState(false)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const pairing = useScanPairing(started?.id ?? null).data
  // What the cleanup and `pagehide` end: the pairing this dialog holds,
  // until it is known to have ended.
  const live = useRef<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    live.current =
      started && pairing?.endedAt === null ? started.id : live.current
    if (pairing && pairing.endedAt !== null && live.current === pairing.id)
      live.current = null
  }, [started, pairing])
  useEffect(() => {
    mounted.current = true
    const leave = () => {
      if (live.current) endScanPairingNow(slug, live.current)
      live.current = null
    }
    window.addEventListener('pagehide', leave)
    return () => {
      mounted.current = false
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [slug])

  function begin() {
    setError(null)
    setNotStarted(false)
    let got = false
    stepUp
      .run(async () => {
        const s = await start(purpose)
        got = true
        if (!mounted.current) {
          // Closed while it started: nobody will see its code.
          endScanPairingNow(slug, s.pairing.id)
          return
        }
        live.current = s.pairing.id
        setStarted({ id: s.pairing.id, path: s.path })
        onStarted?.(s.pairing.id)
      })
      .then(() => {
        // "Confirm it's you" was cancelled: say so, and offer it again.
        if (!got && mounted.current) setNotStarted(true)
      })
      .catch((err: unknown) =>
        setError(refusal(err, 'Could not start scanning: try again', '')),
      )
  }
  // Once per sitting: React's development double mount keeps the ref.
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || resume) return
    asked.current = true
    begin()
  }, [])

  /** End the shown link, if live, then start a new one. */
  async function restart() {
    if (live.current && !(await endLink())) return
    setStarted(null)
    begin()
  }
  /** End the live link; false (the error shown) if the server refused. */
  async function endLink(): Promise<boolean> {
    const id = live.current
    if (!id) return true
    try {
      await end(id)
      live.current = null
      return true
    } catch (err) {
      setError(
        refusal(
          err,
          'Could not end the link, so the phone may still send scans: try Done again',
          '',
        ),
      )
      return false
    }
  }
  async function done() {
    setClosing(true)
    const ended = await endLink()
    setClosing(false)
    if (ended) onClose()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && void done()}>
      <DialogContent
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (!reviewing) return
          e.preventDefault()
          setReviewing(null)
        }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <DialogTitle>
            {reviewing ? 'Review scan' : 'Scan with phone'}
          </DialogTitle>
          <button
            type="button"
            className={small}
            disabled={closing}
            onClick={() => void done()}
          >
            Done
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {reviewing ? (
          <>
            <button
              type="button"
              className={`${small} self-start`}
              onClick={() => setReviewing(null)}
            >
              ← Back to this sitting’s scans
            </button>
            <ScanReview
              scanId={reviewing}
              contactId={contactId}
              onDone={() => setReviewing(null)}
            />
          </>
        ) : (
          <>
            {stepUp.form}
            {notStarted && (
              <p className="flex flex-wrap items-baseline gap-2 text-sm">
                Scanning didn’t start: confirm it’s you to show the code.
                <button type="button" className={small} onClick={begin}>
                  Try again
                </button>
              </p>
            )}
            {started && (
              <SittingLink
                path={started.path}
                pairing={pairing}
                onRestart={() => void restart()}
              />
            )}
            {/* On the record-gift page the declaration doesn't exist
                until the gift is saved: its scans are matched after. */}
            {pairing && (
              <SittingStack
                pairing={pairing}
                onReview={purpose === 'gift' ? undefined : setReviewing}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Re-renders every `ms`, for "ends in 14 min". */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

const LINK_STATE = {
  waiting: 'Waiting for the phone.',
  connected: '✓ A phone is connected.',
  ended: 'This link has ended.',
} as const

/**
 * The QR code and the link (to copy into a phone's browser by hand), and
 * where the link stands. The token is in the link's fragment: never sent
 * to the server in a page request. `path` is null for a sitting resumed
 * after a reload: its code was shown once and isn't kept. Only a change
 * of state is announced, not the minutes ticking down.
 */
function SittingLink({
  path,
  pairing,
  onRestart,
}: {
  path: string | null
  pairing: ScanPairingView | undefined
  onRestart: () => void
}) {
  const now = useNow(30_000)
  const linkId = useId()
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const state = pairing ? linkState(pairing, now) : null
  const announce = (
    <p role="status" className="sr-only">
      {state && LINK_STATE[state.kind]}
    </p>
  )
  if (state?.kind === 'ended' || (state && path === null))
    return (
      <div className="flex flex-col gap-2 text-sm text-neutral-700">
        {announce}
        <p data-testid="scan-link-state">
          {state.kind === 'ended'
            ? 'This link has ended.'
            : 'This sitting’s code was shown before the page reloaded and can’t be shown again.'}{' '}
          Its scans are below.
        </p>
        <button
          type="button"
          className={`${small} self-start`}
          onClick={onRestart}
        >
          Start a new link
        </button>
      </div>
    )
  if (path === null) return <p className="text-sm text-neutral-500">Loading…</p>
  const link = scanLink(path)
  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied('yes')
    } catch {
      // No clipboard (plain HTTP, or refused): the field is selectable.
      setCopied('no')
    }
  }
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <QrCode value={link} label="QR code to open the camera page on a phone" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
        <p>
          Point the phone’s camera at the code and open the link. No sign-in is
          needed on the phone; only that phone can use the link.
        </p>
        <div className="flex flex-col gap-1 text-xs text-neutral-600">
          <label htmlFor={linkId}>Or open this link on the phone</label>
          <span className="flex gap-2">
            <input
              id={linkId}
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
              className={`${field} min-w-0 flex-1 font-mono text-xs`}
            />
            <button type="button" className={small} onClick={() => void copy()}>
              {copied === 'yes' ? 'Copied' : 'Copy link'}
            </button>
          </span>
          {copied === 'no' && (
            <p role="alert">Couldn’t copy: select the link and copy it.</p>
          )}
        </div>
        {announce}
        <p data-testid="scan-link-state" className="text-neutral-700">
          {state === null
            ? 'Starting…'
            : state.kind === 'connected'
              ? `${LINK_STATE.connected} The link ends ${endsIn(state.endsAt, now)} if nothing is sent.`
              : `${LINK_STATE.waiting} The link ends ${endsIn(state.endsAt, now)}.`}
        </p>
      </div>
    </div>
  )
}

/** The sitting's scans, oldest first, each to review. */
function SittingStack({
  pairing,
  onReview,
}: {
  pairing: ScanPairingView
  onReview?: (id: string) => void
}) {
  const scans = pairing.scans
  return (
    <section
      aria-label="Scans from this sitting"
      className="flex flex-col gap-2"
    >
      <h3 className="text-sm font-medium">
        Scans from this sitting{scans.length > 0 && ` (${scans.length})`}
      </h3>
      {/* Always mounted, so the first scan is announced as it comes. */}
      <p aria-live="polite" className="sr-only">
        {scans.length > 0 &&
          `${scans.length} ${scans.length === 1 ? 'scan' : 'scans'} received`}
      </p>
      {scans.length === 0 ? (
        <p className="text-sm text-neutral-500">
          None yet: they appear here as the phone sends them.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {scans.map((s) => (
            <li
              key={s.id}
              data-testid="sitting-scan"
              className="flex w-36 flex-col gap-1 rounded border border-neutral-200 bg-white p-2 text-xs"
            >
              <ScanThumb scan={s} />
              <span>{pagesText(s.pages.length)}</span>
              <ScanStatusLine scan={s} />
              {s.status === 'draft' && onReview && (
                <button
                  type="button"
                  className={small}
                  onClick={() => onReview(s.id)}
                >
                  Review
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A scan's first page, small; nothing once its images have gone. */
export function ScanThumb({ scan }: { scan: ScanView }) {
  const { slug } = useTenant()
  const first = scan.pages.at(0)
  if (!first || scan.imageDeletedAt !== null)
    return (
      <span className="flex h-24 items-center justify-center bg-neutral-100 text-neutral-500">
        No image
      </span>
    )
  return (
    <img
      src={scanPageUrl(slug, scan.id, Number(first.pageNo), first.id)}
      alt=""
      loading="lazy"
      className="h-24 w-full border border-neutral-200 bg-neutral-100 object-contain"
    />
  )
}

/** "Matched", "Discarded: reason", nothing for a draft. */
function ScanStatusLine({ scan }: { scan: ScanView }) {
  if (scan.status === 'accepted')
    return <span className="text-green-800">✓ Matched</span>
  if (scan.status === 'discarded')
    return (
      <span className="text-neutral-500">
        Discarded{scan.discardReason ? `: ${scan.discardReason}` : ''}
      </span>
    )
  return null
}

// ── review ─────────────────────────────────────────────────────────────────

/**
 * One scan beside the declaration it evidences (g1q5): its pages on the
 * left (reorder, remove, add another scan's pages while it's a draft),
 * on the right the contact, then either a new paper declaration (its
 * date, scope and the name and address it was made under) or one of the
 * contact's paper declarations that has no scan yet. "Accept" saves both
 * in one go (the new declaration and the match, or neither); "Discard"
 * keeps the row and deletes the images after 30 days.
 */
export function ScanReview({
  scanId,
  contactId,
  onDone,
}: {
  scanId: string
  contactId?: Id<'contacts'>
  onDone: () => void
}) {
  const scan = useScan(scanId)
  if (scan.isPending)
    return <p className="text-sm text-neutral-500">Loading…</p>
  if (scan.error)
    return (
      <p role="alert" className="text-sm text-red-700">
        {refusal(scan.error, 'Could not read the scan', '')}
      </p>
    )
  if (scan.data === null) return <p className="text-sm">No such scan.</p>
  const s = scan.data
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <ScanPages scan={s} editable={s.status === 'draft'} />
      <div className="flex flex-col gap-4">
        <ScanFacts scan={s} />
        {s.status === 'draft' ? (
          <MatchForm scan={s} contactId={contactId} onDone={onDone} />
        ) : (
          <p className="text-sm">
            <ScanStatusLine scan={s} />
          </p>
        )}
      </div>
    </div>
  )
}

function ScanFacts({ scan }: { scan: ScanView }) {
  const name = useName()
  return (
    <p className="text-sm text-neutral-700">
      {pagesText(scan.pages.length)}, scanned {AT.format(scan.scannedAt)}
      {scan.scannedBy !== null && ` by ${name(scan.scannedBy)}`}
      {scan.via === 'phone' ? ' via phone pairing' : ' on a signed-in phone'}.
    </p>
  )
}

/**
 * A scan's pages, large, in order; while a draft (`editable`) each can
 * move or go, and another draft's pages can be added after them.
 */
export function ScanPages({
  scan,
  editable,
}: {
  scan: ScanView
  editable: boolean
}) {
  const { slug } = useTenant()
  const writes = useScanWrites()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const order = scan.pages.map((p) => p.id)
  async function reorder(next: Array<string>) {
    setError(null)
    setSaving(true)
    try {
      await writes.reorder(scan, next)
    } catch (err) {
      setError(scanRefusal(err, 'Could not change the pages'))
    } finally {
      setSaving(false)
    }
  }
  if (scan.imageDeletedAt !== null)
    return (
      <p className="text-sm text-neutral-600">
        This scan’s images were deleted {formatDay(isoDay(scan.imageDeletedAt))}
        .
      </p>
    )
  const count = scan.pages.length
  return (
    <section aria-label="Pages" className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {scan.pages.map((p, i) => {
          const url = scanPageUrl(slug, scan.id, Number(p.pageNo), p.id)
          const which = `page ${i + 1} of ${count}`
          return (
            <li key={p.id} className="flex flex-col gap-1">
              <a href={url} target="_blank" rel="noopener">
                <img
                  src={url}
                  alt={`Scan, ${which}`}
                  width={Number(p.width)}
                  height={Number(p.height)}
                  className="h-auto w-full border border-neutral-200 bg-neutral-100"
                />
              </a>
              {editable && count > 1 && (
                <div className="flex gap-2">
                  <span className="text-xs text-neutral-500">Page {i + 1}</span>
                  <button
                    type="button"
                    className={small}
                    disabled={saving || i === 0}
                    aria-label={`Move ${which} up`}
                    onClick={() => void reorder(movePage(order, i, -1))}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className={small}
                    disabled={saving || i === count - 1}
                    aria-label={`Move ${which} down`}
                    onClick={() => void reorder(movePage(order, i, 1))}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    className={small}
                    disabled={saving}
                    aria-label={`Remove ${which}`}
                    onClick={() =>
                      void reorder(order.filter((id) => id !== p.id))
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      {editable && <MergeFrom scan={scan} />}
    </section>
  )
}

/** The local day of an instant, YYYY-MM-DD (not UTC's: 00:30 BST is today). */
const isoDay = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * "Add pages from another scan": a form's later pages sent as a scan of
 * their own (g1q3). The other draft's pages go after these, and it is
 * discarded as merged. Only drafts whose pages fit (6 in all).
 */
function MergeFrom({ scan }: { scan: ScanView }) {
  const inbox = useScanInbox().data
  const writes = useScanWrites()
  const [from, setFrom] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const others = (inbox ?? []).filter(
    (s) =>
      s.id !== scan.id &&
      s.imageDeletedAt === null &&
      canMerge(scan.pages.length, s.pages.length),
  )
  if (scan.pages.length >= MAX_PAGES || others.length === 0) return null
  async function merge(e: FormEvent) {
    e.preventDefault()
    const other = others.find((s) => s.id === from)
    if (!other) return
    setError(null)
    setSaving(true)
    try {
      await writes.merge(scan, other)
      setFrom('')
    } catch (err) {
      setError(scanRefusal(err, 'Could not add the pages'))
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      onSubmit={(e) => void merge(e)}
      aria-label="Add pages from another scan"
      className="flex flex-wrap items-end gap-2"
    >
      <label className="flex flex-col gap-1 text-xs">
        Add pages from another scan
        <select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className={field}
        >
          <option value="">Choose a scan…</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {pagesText(s.pages.length)}, scanned {AT.format(s.scannedAt)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={small} disabled={saving || !from}>
        Add pages
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-red-700">
          {error}
        </p>
      )}
    </form>
  )
}

type NewDeclaration = DeclarationDetails & {
  scope: DeclarationScope
  madeOn: string
}

/**
 * The right-hand side: whose declaration, which one (or a new one), and
 * Accept or Discard.
 */
function MatchForm({
  scan,
  contactId: given,
  onDone,
}: {
  scan: ScanView
  contactId?: Id<'contacts'>
  onDone: () => void
}) {
  const writes = useScanWrites()
  const [contact, setContact] = useState<{
    id: Id<'contacts'>
    name: string | null
  } | null>(given ? { id: given, name: null } : null)
  const [choice, setChoice] = useState<string>('new')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<NewDeclaration | null>(null)

  async function accept(e: FormEvent) {
    e.preventDefault()
    if (!contact) return setError('Choose whose declaration this is')
    if (choice === 'new' && !draft) return
    if (choice === 'new' && !draft!.madeOn)
      return setError('Enter the date written on the form')
    setError(null)
    setSaving(true)
    try {
      await writes.accept(
        scan,
        contact.id,
        choice === 'new'
          ? {
              kind: 'new',
              declaration: {
                contactId: contact.id,
                scope: draft!.scope,
                madeOn: draft!.madeOn,
                method: 'paperForm',
                wordingVersion: HMRC_MODEL_WORDING_VERSION,
                firstName: draft!.firstName,
                lastName: draft!.lastName,
                addressLine1: draft!.addressLine1,
                postcode: draft!.postcode,
              },
            }
          : { kind: 'existing', declarationId: choice },
      )
      onDone()
    } catch (err) {
      setError(scanRefusal(err, 'Could not accept the scan'))
    } finally {
      setSaving(false)
    }
  }
  async function discard() {
    setError(null)
    setSaving(true)
    try {
      await writes.discard(scan, reason.trim() || undefined)
      onDone()
    } catch (err) {
      setError(scanRefusal(err, 'Could not discard the scan'))
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      onSubmit={(e) => void accept(e)}
      aria-label="Match the scan"
      className="flex flex-col gap-3"
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Whose declaration</legend>
        {contact ? (
          <p className="flex items-baseline gap-2 text-sm">
            {contact.name ? (
              <span>{contact.name}</span>
            ) : (
              <span>The contact on this page</span>
            )}
            {!given && (
              <button
                type="button"
                className={small}
                onClick={() => {
                  setContact(null)
                  setChoice('new')
                  setDraft(null)
                }}
              >
                Change
              </button>
            )}
          </p>
        ) : (
          <ContactPicker
            onPick={(id, name) => {
              setContact({ id, name })
              setChoice('new')
              setDraft(null)
            }}
          />
        )}
      </fieldset>
      {contact && (
        <DeclarationChoice
          key={contact.id}
          contactId={contact.id}
          choice={choice}
          onChoice={setChoice}
          draft={draft}
          onDraft={setDraft}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={primary}
          disabled={saving || !contact || (choice === 'new' && !draft)}
        >
          Accept
        </button>
        <button
          type="button"
          className={small}
          disabled={saving}
          onClick={() => setDiscarding(true)}
        >
          Discard
        </button>
      </div>
      <ConfirmDialog
        open={discarding}
        title="Discard this scan?"
        description="It leaves Scans to match. Its row stays (who discarded it and when) and its images are deleted after 30 days."
        confirm="Discard"
        cancel="Keep it"
        onConfirm={() => {
          setDiscarding(false)
          void discard()
        }}
        onCancel={() => setDiscarding(false)}
      >
        <label className="flex flex-col gap-1 text-sm">
          Why (optional)
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={field}
          />
        </label>
      </ConfirmDialog>
    </form>
  )
}

/**
 * A contact by name or number, for a scan from "Scans to match". Only a
 * person can make a Gift Aid declaration (HMRC 3.6.7).
 */
function ContactPicker({
  onPick,
}: {
  onPick: (id: Id<'contacts'>, name: string) => void
}) {
  const [text, setText] = useState('')
  const term = text.trim()
  const found = useContactSearch(term ? { search: term } : 'skip')
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs">
        Find the donor by name or number
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={field}
        />
      </label>
      {term &&
        (found === undefined ? (
          <p className="text-xs text-neutral-500">Searching…</p>
        ) : found.rows.length === 0 ? (
          <p className="text-xs text-neutral-500">No contact matches.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100 rounded border border-neutral-200 bg-white">
            {found.rows.slice(0, 8).map((row) => (
              <li key={row._id}>
                <button
                  type="button"
                  disabled={row.kind !== 'individual'}
                  onClick={() => onPick(row._id, row.displayName)}
                  className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-sm hover:bg-neutral-50 disabled:text-neutral-400"
                >
                  <span className="flex-1">{row.displayName}</span>
                  <span className="text-xs text-neutral-500">
                    {row.kind === 'individual'
                      ? `#${row.number}`
                      : 'an organisation: no Gift Aid'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}

/**
 * "New paper declaration" (prefilled with the contact's name and home
 * address now, as a declaration made today would snapshot them) or one
 * of the contact's paper declarations without a scan.
 */
function DeclarationChoice({
  contactId,
  choice,
  onChoice,
  draft,
  onDraft,
}: {
  contactId: Id<'contacts'>
  choice: string
  onChoice: (choice: string) => void
  draft: NewDeclaration | null
  onDraft: (draft: NewDeclaration) => void
}) {
  const { slug } = useTenant()
  const data = useDeclarations(contactId)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const today = localToday()
    fetchContactSnapshot(slug, contactId, today)
      .then((snapshot) => {
        if (live)
          // No date until it is read off the form: the date decides which
          // gifts it covers (rule 1), so today is never assumed.
          onDraft({ ...snapshot, scope: 'futureAndPast4y', madeOn: '' })
      })
      .catch(() => {
        if (live) setError('Could not read the contact’s name and address')
      })
    return () => {
      live = false
    }
  }, [slug, contactId])
  const papers = (data?.declarations ?? []).filter(
    (d) => d.method === 'paperForm' && d.voidedAt === undefined,
  )
  const set = (patch: Partial<NewDeclaration>) =>
    draft && onDraft({ ...draft, ...patch })
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">Which declaration</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="declaration"
          checked={choice === 'new'}
          onChange={() => onChoice('new')}
        />
        A new paper declaration
      </label>
      {choice === 'new' &&
        (draft ? (
          <div className="ml-6 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              Date on the form
              <input
                type="date"
                required
                value={draft.madeOn}
                max={localToday()}
                onChange={(e) => set({ madeOn: e.target.value })}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Covers
              <select
                value={draft.scope}
                onChange={(e) =>
                  set({ scope: e.target.value as DeclarationScope })
                }
                className={field}
              >
                {/* "This gift only" needs its gift: not a form on its own. */}
                {(['futureAndPast4y', 'future'] as const).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                ['firstName', 'First name'],
                ['lastName', 'Last name'],
                ['addressLine1', 'House number or name'],
                ['postcode', 'Postcode'],
              ] as const
            ).map(([f, text]) => (
              <label key={f} className="flex flex-col gap-1 text-xs">
                {text}
                <input
                  value={draft[f]}
                  onChange={(e) => set({ [f]: e.target.value })}
                  className={field}
                />
              </label>
            ))}
            <p className="col-span-2 text-xs text-neutral-500">
              As written on the form: the name and home address it was made
              under, and its date.
            </p>
          </div>
        ) : error ? (
          <p role="alert" className="ml-6 text-xs text-red-700">
            {error}
          </p>
        ) : (
          <p className="ml-6 text-xs text-neutral-500">Loading…</p>
        ))}
      {papers.map((d) => (
        <ExistingOption
          key={d._id}
          declaration={d}
          checked={choice === d._id}
          onChoose={() => onChoice(d._id)}
        />
      ))}
      {data !== undefined && papers.length === 0 && (
        <p className="text-xs text-neutral-500">
          No paper declarations recorded for this contact yet.
        </p>
      )}
    </fieldset>
  )
}

/** One existing paper declaration; disabled once it holds a scan. */
function ExistingOption({
  declaration: d,
  checked,
  onChoose,
}: {
  declaration: Declaration
  checked: boolean
  onChoose: () => void
}) {
  const held = useDeclarationScans(d._id)?.held.length
  const ok = matchable(d, held)
  return (
    <label
      className={`flex items-center gap-2 text-sm ${ok ? '' : 'text-neutral-400'}`}
    >
      <input
        type="radio"
        name="declaration"
        checked={checked}
        disabled={!ok}
        onChange={onChoose}
      />
      The {describeDeclaration(d)}
      {held !== undefined && held > 0 && ' (already has a scan)'}
    </label>
  )
}

// ── on a declaration ───────────────────────────────────────────────────────

/**
 * Under a declaration: "✓ scan held" and when, for anyone who can see
 * the declaration (g2q1); staff and admins can open the scan.
 */
export function DeclarationScanLine({
  declarationId,
}: {
  declarationId: string
}) {
  const data = useDeclarationScans(declarationId)
  const [open, setOpen] = useState<ScanView | null>(null)
  if (!data || data.held.length === 0) return null
  return (
    <div data-testid="scan-held" className="flex flex-col gap-1 text-xs">
      {data.held.map((h) => {
        const scan = data.scans?.find((s) => s.id === h.id)
        return (
          <p key={h.id} className="flex flex-wrap items-baseline gap-2">
            <span className="text-green-800">
              ✓ Scan held, scanned {formatDay(isoDay(h.scannedAt))}
              {!h.imagesHeld && ' (its images were deleted)'}
            </span>
            {scan && h.imagesHeld && (
              <button
                type="button"
                className="text-neutral-600 underline"
                onClick={() => setOpen(scan)}
              >
                View scan
              </button>
            )}
          </p>
        )
      })}
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent>
            <div className="flex items-baseline justify-between gap-2">
              <DialogTitle>Declaration scan</DialogTitle>
              <DialogClose className={small}>Close</DialogClose>
            </div>
            <DialogDescription asChild>
              <div>
                <ScanFacts scan={open} />
              </div>
            </DialogDescription>
            <div className="max-w-2xl">
              <ScanPages scan={open} editable={false} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

/** A link to "Scans to match", for pages that point there. */
export function ScansToMatchLink({ className }: { className?: string }) {
  const { slug } = useTenant()
  return (
    <Link to="/t/$slug/scans" params={{ slug }} className={className}>
      Scans to match
    </Link>
  )
}
