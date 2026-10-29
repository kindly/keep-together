import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  useDirectDebitWrites,
  useGoCardlessStatus,
  useRegularGift,
  useRegularGifts,
} from '../lib/data'
import type {
  DirectDebitPayment,
  RegularGift,
  RegularGiftFrequency,
} from '../lib/data'
import { newKey } from '../lib/contact-form-state'
import {
  DAYS_OF_MONTH,
  PAYMENT_LABELS,
  REGULAR_STATUS_LABELS,
  REGULAR_STATUS_MEANINGS,
  isCollected,
  linkExpired,
  monthName,
  scheduleText,
} from '../lib/domain/direct-debit'
import type { Id } from '../lib/domain/ids'
import { oneOffAmountProblem } from '../lib/domain/one-off'
import { formatDay, formatPence, parsePounds, refusal } from '../lib/gifts'
import { useCanWrite, useTenant } from '../lib/tenant'
import { ConfirmDialog } from './confirm-dialog'
import { SourceCodePicker } from './source-code-picker'
import type { ShownCode } from './source-code-picker'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'

// GoCardless D3 on the contact (factory/plans/gocardless.sv): "Set up
// Direct Debit" and its sign-up link, each regular gift's card (status,
// amount, schedule, mandate, next payments, payment history, cancel),
// and one-off payments both ways: once on the mandate, or an Instant
// Bank Pay link. Nothing here is optimistic (ADR 0025): every figure is
// what the server last said, refetched on its events, and a button is
// held while its request is in flight.

export const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
export const small =
  'rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-50 disabled:opacity-50'
export const primary =
  'rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'

/** What the section says while GoCardless isn't connected. */
export const NOT_CONNECTED =
  'GoCardless isn’t connected: an admin connects it in Settings › GoCardless.'

/**
 * The contact's Direct Debit section: nothing at all while GoCardless is
 * off here. Staff and admins set up and take payments; everyone sees
 * the cards.
 */
export function ContactDirectDebit({
  contactId,
  children,
}: {
  contactId: Id<'contacts'>
  /** More for each card (the terms, from part B). */
  children?: (gift: RegularGift) => ReactNode
}) {
  const status = useGoCardlessStatus()
  const enabled = status?.enabled === true
  const gifts = useRegularGifts(contactId, enabled)
  const canWrite = useCanWrite()
  const [dialog, setDialog] = useState<'setUp' | 'instant' | null>(null)
  if (!enabled) return null
  const connected = status.connected
  return (
    <section aria-labelledby="contact-direct-debit">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="contact-direct-debit" className="text-lg font-medium">
          Direct Debit
        </h2>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={small}
              disabled={!connected}
              onClick={() => setDialog('setUp')}
            >
              Set up Direct Debit
            </button>
            <button
              type="button"
              className={small}
              disabled={!connected}
              onClick={() => setDialog('instant')}
            >
              Instant Bank Pay link
            </button>
          </div>
        )}
      </div>
      {!connected && (
        <p className="mb-2 text-sm text-neutral-600">{NOT_CONNECTED}</p>
      )}
      {gifts === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : gifts.length === 0 ? (
        <p className="text-sm text-neutral-500">No regular gifts yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {gifts.map((g) => (
            <li key={g.id}>
              <RegularGiftCard listed={g} connected={connected}>
                {children}
              </RegularGiftCard>
            </li>
          ))}
        </ul>
      )}
      {dialog === 'setUp' && (
        <SetUpDialog contactId={contactId} onClose={() => setDialog(null)} />
      )}
      {dialog === 'instant' && (
        <InstantPayDialog
          contactId={contactId}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  )
}

const BADGE: Record<RegularGift['status'], string> = {
  pending: 'bg-amber-100 text-amber-900',
  active: 'bg-green-100 text-green-900',
  cancelled: 'bg-neutral-100 text-neutral-600',
  failed: 'bg-red-100 text-red-800',
}

export const isEnded = (g: Pick<RegularGift, 'status'>) =>
  g.status === 'cancelled' || g.status === 'failed'

/** "£12.50 every month on the 1st". */
export function amountText(g: {
  amount: bigint
  frequency: RegularGiftFrequency
  dayOfMonth: number
  month: number | null
}) {
  return `${formatPence(g.amount)} ${scheduleText(g)}`
}

/**
 * One regular gift. The contact's list gives it at once; its own read
 * adds GoCardless's next payments while it is live.
 */
export function RegularGiftCard({
  listed,
  connected,
  children,
}: {
  listed: RegularGift
  connected: boolean
  children?: (gift: RegularGift) => ReactNode
}) {
  // Both refetch on the same events; the single read has the forecast.
  const own = useRegularGift(listed.id, !isEnded(listed))
  const gift = own ?? listed
  const canWrite = useCanWrite()
  const [dialog, setDialog] = useState<'oneOff' | 'cancel' | null>(null)
  const ended = isEnded(gift)
  return (
    <article
      data-testid="regular-gift"
      data-id={gift.id}
      data-status={gift.status}
      aria-label={`Regular gift ${amountText(gift)}`}
      className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-3 text-sm"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          data-testid="regular-gift-amount"
          className="text-base font-medium"
        >
          {amountText(gift)}
        </span>
        <span
          data-testid="regular-gift-status"
          title={REGULAR_STATUS_MEANINGS[gift.status]}
          className={`rounded px-1.5 text-xs ${BADGE[gift.status]}`}
        >
          {REGULAR_STATUS_LABELS[gift.status]}
        </span>
        <span className="text-neutral-600">
          {gift.allocations.length > 1
            ? gift.allocations
                .map((a) => `${a.sourceCode ?? '?'} ${formatPence(a.amount)}`)
                .join(' + ')
            : (gift.sourceCode ?? '?')}
        </span>
      </header>
      {ended && gift.endedReason && (
        <p className="text-neutral-600">
          {gift.endedReason}
          {gift.endedAt !== null &&
            ` (${formatDay(new Date(gift.endedAt).toISOString().slice(0, 10))})`}
        </p>
      )}
      {gift.status === 'pending' && (
        <SignUpLink gift={gift} canWrite={canWrite && connected} />
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-neutral-600">
        <dt>Mandate</dt>
        <dd data-testid="regular-gift-mandate" className="font-mono">
          {gift.mandateId ?? 'not signed yet'}
        </dd>
        {gift.subscriptionId && (
          <>
            <dt>Subscription</dt>
            <dd className="font-mono">{gift.subscriptionId}</dd>
          </>
        )}
      </dl>
      {gift.lastFailure && (
        <p
          role="status"
          className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800"
        >
          The last payment ({formatPence(gift.lastFailure.amount)} on{' '}
          {formatDay(gift.lastFailure.chargeDate)}) failed
          {gift.lastFailure.reason ? `: ${gift.lastFailure.reason}` : '.'}
        </p>
      )}
      {!ended && gift.upcoming.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-neutral-500">
            Next payments
          </h3>
          <ul
            data-testid="regular-gift-upcoming"
            className="flex flex-wrap gap-x-4 gap-y-1"
          >
            {gift.upcoming.slice(0, 3).map((u) => (
              <li key={u.chargeDate}>
                {formatDay(u.chargeDate)} · {formatPence(u.amount)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {children?.(gift)}
      <PaymentHistory payments={gift.payments} />
      {canWrite && !ended && (
        <div className="flex flex-wrap gap-2">
          {gift.status === 'active' && gift.mandateId !== null && (
            <button
              type="button"
              className={small}
              disabled={!connected}
              onClick={() => setDialog('oneOff')}
            >
              Take a one-off payment
            </button>
          )}
          <button
            type="button"
            className={small}
            disabled={!connected}
            onClick={() => setDialog('cancel')}
          >
            Cancel Direct Debit
          </button>
        </div>
      )}
      {dialog === 'oneOff' && (
        <OneOffDialog gift={gift} onClose={() => setDialog(null)} />
      )}
      {dialog === 'cancel' && (
        <CancelDialog gift={gift} onClose={() => setDialog(null)} />
      )}
    </article>
  )
}

/**
 * Every payment GoCardless made on it, newest first, with its status.
 * Only a collected one is money received: the rest are struck through.
 */
export function PaymentHistory({
  payments,
}: {
  payments: ReadonlyArray<DirectDebitPayment>
}) {
  const { slug } = useTenant()
  if (payments.length === 0)
    return <p className="text-xs text-neutral-500">No payments yet.</p>
  return (
    <details>
      <summary className="cursor-pointer text-xs font-medium text-neutral-500">
        Payment history ({payments.length})
      </summary>
      <table
        data-testid="payment-history"
        className="mt-1 w-full text-left text-xs"
      >
        <thead>
          <tr className="text-neutral-500">
            <th className="py-1 pr-3 font-normal">Charge date</th>
            <th className="py-1 pr-3 text-right font-normal">Amount</th>
            <th className="py-1 pr-3 font-normal">Status</th>
            <th className="py-1 font-normal">Gift</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => {
            const collected = isCollected(p.status)
            return (
              <tr
                key={p.id}
                data-payment={p.paymentId}
                data-status={p.status}
                className="border-t border-neutral-100"
              >
                <td className="py-1 pr-3 whitespace-nowrap">
                  {formatDay(p.chargeDate)}
                </td>
                <td
                  className={`py-1 pr-3 text-right ${collected ? '' : 'text-neutral-500 line-through'}`}
                >
                  {formatPence(p.amount)}
                </td>
                <td
                  className={`py-1 pr-3 ${collected ? 'text-green-800' : p.status === 'pending' ? 'text-amber-700' : 'text-red-700'}`}
                >
                  {PAYMENT_LABELS[p.status]}
                  {p.reason && ` (${p.reason})`}
                </td>
                <td className="py-1">
                  {p.giftId && (
                    <Link
                      to="/t/$slug/gifts/$giftId"
                      params={{ slug, giftId: p.giftId }}
                      className="underline"
                    >
                      Open
                    </Link>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </details>
  )
}

/** A link to copy, or to send in an email the donor's address goes in. */
export function CopyLink({
  url,
  label,
  subject,
}: {
  url: string
  label: string
  subject: string
}) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied('yes')
    } catch {
      // No clipboard (plain HTTP, or refused): the field is selectable.
      setCopied('no')
    }
  }
  const mail = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(url)}`
  return (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          aria-label={label}
          value={url}
          onFocus={(e) => e.target.select()}
          className={`${field} min-w-0 flex-1 font-mono text-xs`}
        />
        <button type="button" className={small} onClick={() => void copy()}>
          {copied === 'yes' ? 'Copied' : 'Copy link'}
        </button>
        <a href={mail} className={small}>
          Send by email
        </a>
      </span>
      {copied === 'no' && (
        <p role="alert" className="text-xs text-red-700">
          Couldn’t copy: select the link and copy it.
        </p>
      )}
    </div>
  )
}

/** A pending gift's sign-up link, and a new one once it has run out. */
function SignUpLink({
  gift,
  canWrite,
}: {
  gift: RegularGift
  canWrite: boolean
}) {
  const writes = useDirectDebitWrites()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const expired = linkExpired(gift.flowExpiresAt, new Date())
  async function renew() {
    setBusy(true)
    setError(null)
    try {
      await writes.newLink(gift.id, gift.mandateVersion)
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t make a new link',
          'Changed by someone else just now: it has been read again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1">
      {gift.flowUrl && !expired ? (
        <>
          <p className="text-neutral-700">
            Send the donor this link to set up their Direct Debit
            {gift.flowExpiresAt &&
              ` (it works until ${formatDay(gift.flowExpiresAt.slice(0, 10))})`}
            .
          </p>
          <CopyLink
            url={gift.flowUrl}
            label="Sign-up link"
            subject="Set up your Direct Debit"
          />
        </>
      ) : (
        <p className="text-neutral-700">The sign-up link has run out.</p>
      )}
      {canWrite && (
        <button
          type="button"
          className={`${small} self-start`}
          disabled={busy}
          onClick={() => void renew()}
        >
          New link
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}

/** "Cancel Direct Debit", asked first. */
function CancelDialog({
  gift,
  onClose,
}: {
  gift: RegularGift
  onClose: () => void
}) {
  const writes = useDirectDebitWrites()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await writes.cancel(gift.id, gift.mandateVersion)
      onClose()
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t cancel it',
          'Changed by someone else just now: it has been read again. Check it, then try again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      open
      title="Cancel this Direct Debit?"
      description={`${amountText(gift)}. GoCardless stops collecting and tells the donor. This can’t be undone: a new Direct Debit means signing up again.`}
      confirm={busy ? 'Cancelling…' : 'Cancel Direct Debit'}
      cancel="Keep it"
      confirmDisabled={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </ConfirmDialog>
  )
}

/** A source code as a form holds it: its version id and how it shows. */
export type PickedCode = { id: string; shown: ShownCode }

/** An amount field in pounds, with what's wrong beside it. */
export function AmountField({
  value,
  onChange,
  problem,
  label = 'Amount (£)',
}: {
  value: string
  onChange: (v: string) => void
  problem: string | null
  label?: string
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem ? true : undefined}
        className={`${field} w-32`}
      />
      {problem && (
        <span role="alert" className="text-xs text-red-700">
          {problem}
        </span>
      )}
    </label>
  )
}

/** The amount typed, and what's wrong with it (null once it's fine). */
export function amountProblem(text: string): string | null {
  if (text.trim() === '') return null
  const p = parsePounds(text)
  if (p === null) return 'Type an amount in pounds, like 12.50'
  if (p <= 0n) return 'The amount must be over £0'
  return null
}

/** A dialog's frame: title, what it does, the body, Close. */
export function DialogFrame({
  title,
  description,
  onClose,
  children,
}: {
  title: string
  description: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="md:max-w-lg">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
        <DialogClose className={`${small} self-end`}>Close</DialogClose>
      </DialogContent>
    </Dialog>
  )
}

/** The code picker as these forms use it. */
export function CodeField({
  code,
  onChange,
  label = 'Source code',
}: {
  code: PickedCode | null
  onChange: (c: PickedCode | null) => void
  label?: string
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <SourceCodePicker
        label={label}
        value={code?.shown ?? null}
        onPick={(e) =>
          onChange({ id: e.versionId, shown: { ...e, isActive: true } })
        }
        onClear={() => onChange(null)}
      />
    </div>
  )
}

/**
 * "Set up Direct Debit": amount, how often and on which day, the code
 * that recruited it; then the donor's sign-up link to copy or send.
 */
function SetUpDialog({
  contactId,
  onClose,
}: {
  contactId: Id<'contacts'>
  onClose: () => void
}) {
  const writes = useDirectDebitWrites()
  // One key for the dialog: a retry is the same regular gift.
  const clientKey = useMemo(newKey, [])
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState<RegularGiftFrequency>('monthly')
  const [day, setDay] = useState(1)
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [code, setCode] = useState<PickedCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<RegularGift | null>(null)
  const typed = amountProblem(amount)
  const pence = parsePounds(amount)
  const ready = !typed && pence !== null && code !== null && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      setMade(
        await writes.setUp(contactId, {
          amount: pence,
          frequency,
          dayOfMonth: day,
          ...(frequency === 'yearly' && { month }),
          sourceCodeId: code.id,
          clientKey,
        }),
      )
    } catch (err) {
      setError(refusal(err, 'Couldn’t set it up', 'Changed by someone else'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogFrame
      title="Set up Direct Debit"
      description="GoCardless makes a page for the donor to sign up on. Nothing is collected until their mandate is active."
      onClose={onClose}
    >
      {made ? (
        <div className="flex flex-col gap-2 text-sm">
          <p role="status">
            Ready: {amountText(made)}. Send the donor this link to sign up.
          </p>
          {made.flowUrl && (
            <CopyLink
              url={made.flowUrl}
              label="Sign-up link"
              subject="Set up your Direct Debit"
            />
          )}
        </div>
      ) : (
        <form
          aria-label="Set up Direct Debit"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          <AmountField value={amount} onChange={setAmount} problem={typed} />
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm">
              How often
              <select
                value={frequency}
                onChange={(e) =>
                  setFrequency(e.target.value as RegularGiftFrequency)
                }
                className={field}
              >
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Day of the month
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className={field}
              >
                {DAYS_OF_MONTH.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            {frequency === 'yearly' && (
              <label className="flex flex-col gap-1 text-sm">
                Month
                <select
                  value={month}
                  onChange={(e) => setMonth(Number(e.target.value))}
                  className={field}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {monthName(m)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <CodeField code={code} onChange={setCode} />
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
            {busy ? 'Setting up…' : 'Set up'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}

/** A one-off amount typed, with the £1,000 cap's message. */
function oneOffProblem(text: string): string | null {
  const typed = amountProblem(text)
  if (typed) return typed
  const p = parsePounds(text)
  return p === null ? null : oneOffAmountProblem(p)
}

/**
 * "Take a one-off payment" on an active mandate: GoCardless collects it
 * once; its gift appears (pending) from GoCardless's events. At most
 * £1,000, as the server enforces too.
 */
function OneOffDialog({
  gift,
  onClose,
}: {
  gift: RegularGift
  onClose: () => void
}) {
  const writes = useDirectDebitWrites()
  const clientKey = useMemo(newKey, [])
  const [amount, setAmount] = useState('')
  const [chargeDate, setChargeDate] = useState('')
  const [code, setCode] = useState<PickedCode | null>(
    gift.sourceCode === null
      ? null
      : {
          id: gift.sourceCodeId,
          shown: { code: gift.sourceCode, isActive: true },
        },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{
    chargeDate: string
    amount: bigint
  } | null>(null)
  const problem = oneOffProblem(amount)
  const pence = parsePounds(amount)
  const ready = !problem && pence !== null && code !== null && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const started = await writes.oneOff(gift.id, {
        amount: pence,
        ...(chargeDate && { chargeDate }),
        sourceCodeId: code.id,
        clientKey,
      })
      setDone({ chargeDate: started.chargeDate, amount: pence })
    } catch (err) {
      setError(
        refusal(err, 'Couldn’t take the payment', 'Changed by someone else'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogFrame
      title="Take a one-off payment"
      description="GoCardless collects it once on this donor’s Direct Debit and emails them first. For more than £1,000, ask for a bank transfer."
      onClose={onClose}
    >
      {done ? (
        <p role="status" className="text-sm">
          Asked GoCardless to collect {formatPence(done.amount)} on{' '}
          {formatDay(done.chargeDate)}. Its gift shows as pending until the
          money is collected.
        </p>
      ) : (
        <form
          aria-label="Take a one-off payment"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          <AmountField value={amount} onChange={setAmount} problem={problem} />
          <label className="flex flex-col gap-1 text-sm">
            Charge date (optional: the earliest GoCardless can)
            <input
              type="date"
              value={chargeDate}
              onChange={(e) => setChargeDate(e.target.value)}
              className={`${field} w-44`}
            />
          </label>
          <CodeField code={code} onChange={setCode} />
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
            {busy ? 'Asking GoCardless…' : 'Take payment'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}

/**
 * "Instant Bank Pay link": a page where the donor pays once from their
 * bank, no mandate. At most £1,000; the gift comes from GoCardless's
 * events once they pay.
 */
function InstantPayDialog({
  contactId,
  onClose,
}: {
  contactId: Id<'contacts'>
  onClose: () => void
}) {
  const writes = useDirectDebitWrites()
  const clientKey = useMemo(newKey, [])
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [code, setCode] = useState<PickedCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<{
    url: string
    expires: string | null
  } | null>(null)
  const problem = oneOffProblem(amount)
  const pence = parsePounds(amount)
  const ready = !problem && pence !== null && code !== null && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const made = await writes.instantPayment(contactId, {
        amount: pence,
        sourceCodeId: code.id,
        ...(description.trim() && { description: description.trim() }),
        clientKey,
      })
      setLink({ url: made.flowUrl, expires: made.flowExpiresAt })
    } catch (err) {
      setError(
        refusal(err, 'Couldn’t make the link', 'Changed by someone else'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogFrame
      title="Instant Bank Pay link"
      description="A page where the donor pays once, straight from their bank. The group switches Instant Bank Pay on in GoCardless first. For more than £1,000, ask for a bank transfer."
      onClose={onClose}
    >
      {link ? (
        <div className="flex flex-col gap-2 text-sm">
          <p role="status">
            Send the donor this link
            {link.expires &&
              ` (it works until ${formatDay(link.expires.slice(0, 10))})`}
            . The gift shows once they have paid.
          </p>
          <CopyLink url={link.url} label="Payment link" subject="Your gift" />
        </div>
      ) : (
        <form
          aria-label="Instant Bank Pay link"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          <AmountField value={amount} onChange={setAmount} problem={problem} />
          <label className="flex flex-col gap-1 text-sm">
            What the donor sees (optional)
            <input
              value={description}
              placeholder="Gift of £…"
              onChange={(e) => setDescription(e.target.value)}
              className={`${field} w-72 max-w-full`}
            />
          </label>
          <CodeField code={code} onChange={setCode} />
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
            {busy ? 'Making the link…' : 'Make link'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}
