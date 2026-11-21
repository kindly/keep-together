import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { ReadRefused } from '../components/claims-ui'
import {
  CodeField,
  DialogFrame,
  field,
  primary,
  small,
} from '../components/direct-debit'
import type { PickedCode } from '../components/direct-debit'
import { DonorSearch } from '../components/gift-form'
import {
  useCardQueue,
  useCardQueueWrites,
  useCardsSetAside,
  useStripeStatus,
} from '../lib/data'
import type { UnmatchedCardPayment } from '../lib/data'
import {
  REASON_LABELS,
  REASON_MEANINGS,
  declarationRefusedText,
} from '../lib/domain/card-payments'
import { STATUS_LABELS, isReceived } from '../lib/domain/gift-status'
import type { DonorChoice } from '../lib/gift-form'
import { formatDay, formatPence, refusal } from '../lib/gifts'
import { useCanWrite, useClaimsGiftAid, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/stripe/unmatched')({
  component: CardPaymentsToMatch,
})

const AT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })

type Picked = { id: string; displayName: string }

/**
 * Card payments to match (Stripe S5): payments Stripe says were paid
 * that couldn't be tied to a contact, so they have no gift yet, newest
 * first, each with why and what its donor typed. Staff and admins match
 * each to its contact, which makes the gift (and the donor's Gift Aid
 * declaration if they ticked it) with Stripe's amount, date and status.
 * A payment that never came through the donation page can be set aside
 * with a reason instead, and put back; nothing is ever deleted. Viewers
 * see the lists. Nothing here is optimistic: a row leaves a list when
 * the server says so.
 */
function CardPaymentsToMatch() {
  const status = useStripeStatus()
  if (status === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (!status.enabled)
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>Card donations are switched off on this server.</p>
      </main>
    )
  return <Lists />
}

function Lists() {
  const queue = useCardQueue()
  const aside = useCardsSetAside()
  const canWrite = useCanWrite()
  // By id: each dialog reads its row from the list, so a list read again
  // (after a 409) gives it the current counter.
  const [matching, setMatching] = useState<string | null>(null)
  const [setting, setSetting] = useState<string | null>(null)
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Card payments to match</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Card payments Stripe took for the group that couldn’t be tied to a
          contact, so they aren’t gifts yet. Match each to its donor to record
          its gift.
        </p>
      </header>
      {queue.error ? (
        <ReadRefused
          error={queue.error}
          retry={queue.refetch}
          forbidden="Card payments are for the group’s members."
          failed="The card payments couldn’t load."
        />
      ) : queue.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : queue.data.length === 0 ? (
        <p data-testid="card-queue-empty" className="text-sm text-neutral-500">
          Nothing to match.
        </p>
      ) : (
        <ul data-testid="card-queue" className="flex flex-col gap-3">
          {queue.data.map((p) => (
            <li
              key={p.id}
              data-payment={p.paymentId}
              data-reason={p.reason}
              className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-3 text-sm"
            >
              <PaymentLine payment={p} />
              <p>
                <span className="rounded bg-amber-100 px-1.5 text-amber-900">
                  {REASON_LABELS[p.reason]}
                </span>
              </p>
              <p data-testid="card-reason" className="text-neutral-600">
                {REASON_MEANINGS[p.reason]}
              </p>
              <Typed payment={p} />
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={small}
                    onClick={() => setMatching(p.id)}
                  >
                    Match to contact
                  </button>
                  {p.reason === 'no_submission' && (
                    <button
                      type="button"
                      className={small}
                      onClick={() => setSetting(p.id)}
                    >
                      Not a donation
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <SetAside list={aside} canWrite={canWrite} />
      {matching && queue.data && (
        <MatchDialog
          id={matching}
          payment={queue.data.find((p) => p.id === matching)}
          onClose={() => setMatching(null)}
        />
      )}
      {setting && queue.data && (
        <SetAsideDialog
          payment={queue.data.find((p) => p.id === setting)}
          onClose={() => setSetting(null)}
        />
      )}
    </main>
  )
}

/** Date, amount, what its gift's status would be, Stripe's id. */
function PaymentLine({ payment: p }: { payment: UnmatchedCardPayment }) {
  const received = isReceived(p.status)
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span
        className={`font-medium ${received ? '' : 'text-neutral-500 line-through'}`}
      >
        {formatPence(p.amount)}
      </span>
      <span>{p.paidOn ? formatDay(p.paidOn) : 'No date'}</span>
      {!received && (
        <span className="text-xs text-red-700">{STATUS_LABELS[p.status]}</span>
      )}
      <span className="font-mono text-xs text-neutral-500">{p.paymentId}</span>
    </p>
  )
}

/** What the donor typed on the donation page, when there is any. */
function Typed({ payment: p }: { payment: UnmatchedCardPayment }) {
  const claims = useClaimsGiftAid()
  if (!p.donor) return null
  const d = p.donor
  return (
    <dl
      data-testid="card-donor"
      className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1"
    >
      <dt className="text-neutral-500">Donor typed</dt>
      <dd>
        {d.firstName} {d.lastName} · {d.email}
      </dd>
      {/* What they ticked is the evidence, shown whatever the switch
          says now; a group that never claimed has none. */}
      {(d.giftAid || claims) && (
        <>
          <dt className="text-neutral-500">Gift Aid</dt>
          <dd>
            {d.giftAid
              ? `Ticked, from ${d.addressLine1}, ${d.postcode}: matching records their declaration`
              : 'Not ticked'}
          </dd>
        </>
      )}
    </dl>
  )
}

/** The contact, and the code when the payment has none: its gift is made. */
function MatchDialog({
  id,
  payment: listed,
  onClose,
}: {
  id: string
  /** As the list now has it; gone once matched or set aside (by anyone). */
  payment: UnmatchedCardPayment | undefined
  onClose: () => void
}) {
  // The row as first opened, for the description once it has gone.
  const [opened] = useState(listed)
  const { slug } = useTenant()
  const { match } = useCardQueueWrites()
  const [donor, setDonor] = useState<Picked | null>(null)
  const [code, setCode] = useState<PickedCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{
    giftId: string
    declarationRefused: string | null
  } | null>(null)
  const payment = listed ?? opened
  // A payment from the page keeps the page's code; one from elsewhere
  // has none, and staff choose.
  const needsCode = payment?.sourceCodeId === null
  const ready =
    listed !== undefined &&
    donor !== null &&
    (!needsCode || code !== null) &&
    !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const gift = await match(
        listed,
        donor.id,
        needsCode ? code?.id : undefined,
      )
      setMade({
        giftId: gift._id,
        declarationRefused: gift.card?.declarationRefused ?? null,
      })
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t match it',
          'Someone else matched or changed this payment just now: the list has been read again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!payment) return null
  return (
    <DialogFrame
      title="Match to contact"
      description={`${formatPence(payment.amount)}${payment.paidOn ? ` on ${formatDay(payment.paidOn)}` : ''} (${payment.paymentId}). Its gift takes Stripe’s amount, date and status.`}
      onClose={onClose}
      busy={busy}
    >
      {made ? (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <p>
            Matched to {donor?.displayName}.{' '}
            <Link
              to="/t/$slug/gifts/$giftId"
              params={{ slug, giftId: made.giftId }}
              className="underline"
            >
              Open the gift
            </Link>
          </p>
          {made.declarationRefused && (
            <p
              data-testid="declaration-refused"
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900"
            >
              {declarationRefusedText(made.declarationRefused)}
            </p>
          )}
        </div>
      ) : // Gone while our own match is in flight is our match landing.
      listed === undefined && !busy ? (
        <p role="status" data-testid="match-gone" className="text-sm">
          Someone else has dealt with this payment already: it is no longer
          listed.
        </p>
      ) : (
        <form
          aria-label="Match to contact"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          {payment.candidates.length > 0 && !donor && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">
                Contacts with the donor’s email address
              </span>
              <ul className="flex flex-wrap gap-2">
                {payment.candidates.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      data-candidate={c.id}
                      className={small}
                      onClick={() => setDonor(c)}
                    >
                      {c.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={`${id}-donor`}>Contact</label>
            {donor ? (
              <span className="flex items-baseline gap-2">
                <span data-testid="match-donor">{donor.displayName}</span>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setDonor(null)}
                >
                  Change
                </button>
              </span>
            ) : (
              <DonorSearch
                id={`${id}-donor`}
                existingOnly
                onPick={(d: DonorChoice) =>
                  d.kind === 'existing' &&
                  setDonor({ id: d.id, displayName: d.displayName })
                }
              />
            )}
          </div>
          {needsCode && <CodeField code={code} onChange={setCode} />}
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!ready}
            className={`${primary} self-start`}
          >
            {busy ? 'Matching…' : 'Match'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}

/** "Not a donation": why, then it leaves the queue for the list below. */
function SetAsideDialog({
  payment: listed,
  onClose,
}: {
  payment: UnmatchedCardPayment | undefined
  onClose: () => void
}) {
  const [opened] = useState(listed)
  const { setAside } = useCardQueueWrites()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const payment = listed ?? opened
  const ready = listed !== undefined && reason.trim() !== '' && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await setAside(listed, reason.trim())
      setDone(true)
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t set it aside',
          'Someone else matched or changed this payment just now: the list has been read again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!payment) return null
  return (
    <DialogFrame
      title="Not a donation"
      description={`${formatPence(payment.amount)}${payment.paidOn ? ` on ${formatDay(payment.paidOn)}` : ''} (${payment.paymentId}). It leaves this list and makes no gift. It stays on record with your reason, and can be put back.`}
      onClose={onClose}
      busy={busy}
    >
      {done ? (
        <p role="status" data-testid="set-aside-done" className="text-sm">
          Set aside. It is listed under “Set aside as not donations”.
        </p>
      ) : listed === undefined && !busy ? (
        <p role="status" data-testid="match-gone" className="text-sm">
          Someone else has dealt with this payment already: it is no longer
          listed.
        </p>
      ) : (
        <form
          aria-label="Not a donation"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-sm">
            What it was for
            <input
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Stall hire, ticket sale, a test payment…"
              className={field}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!ready}
            className={`${primary} self-start`}
          >
            {busy ? 'Setting aside…' : 'Set aside'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}

/** The payments set aside, each with why and when, and "Put back". */
function SetAside({
  list,
  canWrite,
}: {
  list: ReturnType<typeof useCardsSetAside>
  canWrite: boolean
}) {
  const { putBack } = useCardQueueWrites()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Nothing to say until there is one: most groups never set one aside.
  if (list.error || !list.data || list.data.length === 0) return null

  async function back(p: UnmatchedCardPayment) {
    setBusy(p.id)
    setError(null)
    try {
      await putBack(p)
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t put it back',
          'Someone else changed this payment just now: the lists have been read again',
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="set-aside" className="flex flex-col gap-2">
      <h2 id="set-aside" className="font-medium">
        Set aside as not donations
      </h2>
      <p className="text-sm text-neutral-600">
        Payments on the group’s Stripe account that someone here said weren’t
        donations. They have no gift.
      </p>
      <ul data-testid="cards-set-aside" className="flex flex-col gap-2">
        {list.data.map((p) => (
          <li
            key={p.id}
            data-payment={p.paymentId}
            className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-3 text-sm"
          >
            <PaymentLine payment={p} />
            <p data-testid="set-aside-reason" className="text-neutral-700">
              {p.dismissed}
              {p.dismissedAt !== null && (
                <span className="text-neutral-500">
                  {' '}
                  · set aside {AT.format(p.dismissedAt)}
                </span>
              )}
            </p>
            {canWrite && (
              <button
                type="button"
                disabled={busy !== null}
                className={`${small} self-start`}
                onClick={() => void back(p)}
              >
                {busy === p.id ? 'Putting back…' : 'Put back'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  )
}
