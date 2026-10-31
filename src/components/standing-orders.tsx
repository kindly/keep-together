import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  useMissedStandingOrders,
  useStandingOrderWrites,
  useStandingOrders,
} from '../lib/data'
import type { RegularGiftFrequency, StandingOrder } from '../lib/data'
import { scheduleText } from '../lib/domain/direct-debit'
import type { Id } from '../lib/domain/ids'
import {
  STANDING_EXPECTED_LABELS,
  lineSchedule,
  scheduleOf,
  startProblem,
  termInForce,
} from '../lib/domain/standing-orders'
import { formatDay, formatPence, parsePounds, refusal } from '../lib/gifts'
import { useRequestKey } from '../lib/request-key'
import { RustApiError } from '../lib/data/rust/client'
import { useCanWrite, useTenant } from '../lib/tenant'
import {
  AmountField,
  CodeField,
  DialogFrame,
  amountProblem,
  field,
  primary,
  small,
} from './direct-debit'

// Standing orders on the contact (bank transfers 6b part 3, plan
// factory/plans/bank-transfers.sv g1q4, g2q1–g2q3): "Record a standing
// order", each one's card (its terms, the next payment due, a missed
// payment's flag, expected vs actual), and ending one. The donor set it up
// in their own bank, so nothing here reaches GoCardless. Never optimistic
// (ADR 0025): every figure is what the server last said, and a button is
// held while its request is in flight.

type PickedCode = Parameters<typeof CodeField>[0]['code']

const today = () => new Date().toISOString().slice(0, 10)

/** What the record form starts from ("make this a standing order"). */
export type StandingOrderPrefill = {
  amount?: bigint
  frequency?: RegularGiftFrequency
  startsOn?: string
}

/** The contact's standing orders: every member reads; staff and admins record and end. */
export function ContactStandingOrders({
  contactId,
}: {
  contactId: Id<'contacts'>
}) {
  const orders = useStandingOrders(contactId)
  const canWrite = useCanWrite()
  const [recording, setRecording] = useState(false)
  return (
    <section aria-labelledby="contact-standing-orders">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="contact-standing-orders" className="text-lg font-medium">
          Standing orders
        </h2>
        {canWrite && (
          <button
            type="button"
            className={small}
            onClick={() => setRecording(true)}
          >
            Record a standing order
          </button>
        )}
      </div>
      {orders === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-neutral-500">No standing orders.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((so) => (
            <li key={so.id}>
              <StandingOrderCard so={so} />
            </li>
          ))}
        </ul>
      )}
      {recording && (
        <RecordStandingOrderDialog
          contactId={contactId}
          onClose={() => setRecording(false)}
        />
      )}
    </section>
  )
}

/**
 * "Record a standing order" (g2q3): the amount, how often, the first
 * payment's date (its day, and its month when quarterly or yearly), the
 * reference the donor's bank shows (optional), and the code. Prefilled by
 * "make this a standing order" from a statement line; the reference is
 * never taken from the line.
 */
export function RecordStandingOrderDialog({
  contactId,
  prefill,
  line,
  onClose,
  onRecorded,
}: {
  contactId: Id<'contacts'>
  prefill?: StandingOrderPrefill
  /**
   * "Make this a standing order" from this statement line: its amount is
   * the line's, it is the first payment (so on or before the line's
   * date), and the line is matched to it in the same command.
   */
  line?: { id: string; matchVersion: number; amount: bigint; postedOn: string }
  onClose: () => void
  onRecorded?: (so: StandingOrder | null) => void
}) {
  const writes = useStandingOrderWrites()
  const keyFor = useRequestKey()
  const given = line?.amount ?? prefill?.amount
  const [amount, setAmount] = useState(
    given === undefined ? '' : (Number(given) / 100).toFixed(2),
  )
  const [frequency, setFrequency] = useState<RegularGiftFrequency>(
    prefill?.frequency ?? 'monthly',
  )
  const [startsOn, setStartsOn] = useState(prefill?.startsOn ?? '')
  const [reference, setReference] = useState('')
  const [code, setCode] = useState<PickedCode>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The server's 422s, by field: each shows on its own field.
  const [problems, setProblems] = useState<Partial<Record<string, string>>>({})
  const [made, setMade] = useState<string | null>(null)
  // A field changed: its server error no longer speaks for it.
  const edited = (...fields: Array<string>) =>
    setProblems((p) =>
      Object.fromEntries(
        Object.entries(p).filter(([f]) => !fields.includes(f)),
      ),
    )
  const typed = amountProblem(amount) ?? problems.amount ?? null
  const pence = parsePounds(amount)
  // From a line, the first payment is the line itself, built as the
  // server builds it (review soui M1): nothing to pick.
  const fromLine = line ? lineSchedule(line.postedOn, frequency) : null
  const start = fromLine
    ? null
    : startsOn === ''
      ? null
      : startProblem(startsOn)
  const schedule = fromLine
    ? { dayOfMonth: fromLine.dayOfMonth, month: fromLine.month }
    : startsOn !== '' && !start
      ? scheduleOf(startsOn, frequency)
      : null
  const startShown =
    start ?? problems.startsOn ?? problems.dayOfMonth ?? problems.month ?? null
  const ready =
    !amountProblem(amount) &&
    pence !== null &&
    schedule !== null &&
    code !== null &&
    !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    setProblems({})
    try {
      if (line) {
        await writes.fromLine(line, {
          contact: contactId,
          frequency,
          dayOfMonth: schedule.dayOfMonth,
          ...(schedule.month !== null && { month: schedule.month }),
          sourceCodeId: code.id,
          ...(reference.trim() !== '' && {
            bankReference: reference.trim(),
          }),
        })
        setMade('Recorded, and this line matched as its first payment.')
        onRecorded?.(null)
      } else {
        const asked = {
          amount: pence,
          frequency,
          dayOfMonth: schedule.dayOfMonth,
          ...(schedule.month !== null && { month: schedule.month }),
          sourceCodeId: code.id,
          ...(reference.trim() !== '' && { bankReference: reference.trim() }),
          startsOn,
        }
        const so = await writes.record(contactId, {
          ...asked,
          clientKey: keyFor(asked),
        })
        setMade(`Recorded: ${standingText(so)}.`)
        onRecorded?.(so)
      }
    } catch (err) {
      const byField = fieldProblems(err)
      if (byField) setProblems(byField)
      else
        setError(
          refusal(
            err,
            'Couldn’t record it',
            line
              ? 'Not recorded: someone else matched this line meanwhile'
              : 'Changed by someone else',
          ),
        )
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogFrame
      title="Record a standing order"
      description="One the donor set up in their own bank: its payments come in as statement lines, matched to it."
      onClose={onClose}
      busy={busy}
    >
      {made ? (
        <p role="status" className="text-sm">
          {made}
        </p>
      ) : (
        <form
          aria-label="Record a standing order"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          {line ? (
            <p className="text-sm">
              Amount: {formatPence(line.amount)}, the line’s
            </p>
          ) : (
            <AmountField
              value={amount}
              onChange={(v) => {
                setAmount(v)
                edited('amount')
              }}
              problem={typed}
            />
          )}
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm">
              How often
              <select
                value={frequency}
                onChange={(e) => {
                  setFrequency(e.target.value as RegularGiftFrequency)
                  edited('startsOn', 'dayOfMonth', 'month')
                }}
                className={field}
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            {fromLine ? (
              <p className="flex flex-col gap-1 text-sm">
                <span>First payment</span>
                <span data-testid="standing-start">
                  this line, {formatDay(fromLine.startsOn)}
                </span>
              </p>
            ) : (
              <label className="flex flex-col gap-1 text-sm">
                First payment
                <input
                  type="date"
                  value={startsOn}
                  onChange={(e) => {
                    setStartsOn(e.target.value)
                    edited('startsOn', 'dayOfMonth', 'month')
                  }}
                  aria-invalid={startShown ? true : undefined}
                  aria-describedby="standing-start-problem"
                  className={field}
                />
              </label>
            )}
          </div>
          <p
            id="standing-start-problem"
            aria-live="polite"
            className={`text-xs empty:hidden ${startShown ? 'text-red-700' : 'text-neutral-600'}`}
          >
            {startShown ??
              (schedule && scheduleText({ frequency, ...schedule }))}
          </p>
          <label className="flex flex-col gap-1 text-sm">
            The donor’s reference (optional)
            <input
              value={reference}
              onChange={(e) => {
                setReference(e.target.value)
                edited('bankReference')
              }}
              maxLength={200}
              aria-invalid={problems.bankReference ? true : undefined}
              aria-describedby="standing-reference-problem"
              className={field}
            />
            <span
              id="standing-reference-problem"
              aria-live="polite"
              className="text-xs text-red-700 empty:hidden"
            >
              {problems.bankReference}
            </span>
            <span className="text-xs text-neutral-500">
              As their bank shows it on your statement. It helps find their
              payments; a payer matched once is recognised after.
            </span>
          </label>
          <CodeField
            code={code}
            onChange={(c) => {
              setCode(c)
              edited('sourceCodeId')
            }}
          />
          {problems.sourceCodeId && (
            <p aria-live="polite" className="text-xs text-red-700">
              {problems.sourceCodeId}
            </p>
          )}
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
            {busy ? 'Recording…' : 'Record'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}

/** The fields this form shows, by the server's name for each. */
const FORM_FIELDS = [
  'amount',
  'startsOn',
  'dayOfMonth',
  'month',
  'sourceCodeId',
  'bankReference',
]

/**
 * A `422 invalid` whose problems are all this form's fields, by field
 * (review soui L1); anything else is said as one line.
 */
function fieldProblems(err: unknown): Record<string, string> | null {
  if (!(err instanceof RustApiError) || err.error.kind !== 'invalid')
    return null
  const { problems } = err.error
  if (problems.some((p) => !FORM_FIELDS.includes(p.field))) return null
  return Object.fromEntries(problems.map((p) => [p.field, p.message]))
}

/** "£10.00 every month on the 5th", from the row in force today. */
export function standingText(so: StandingOrder): string {
  const t = termInForce(so.chain, today())
  return t ? `${formatPence(t.amount)} ${scheduleText(t)}` : 'Standing order'
}

const ended = (so: StandingOrder) =>
  so.status === 'cancelled' || so.status === 'failed'

/** One standing order: its terms, what's next, a missed payment, expected vs actual. */
export function StandingOrderCard({ so }: { so: StandingOrder }) {
  const canWrite = useCanWrite()
  const [ending, setEnding] = useState(false)
  const now = today()
  const term = termInForce(so.chain, now)
  const next = so.nextDueOn
  return (
    <article
      data-testid="standing-order"
      data-id={so.id}
      data-status={so.status}
      aria-label={`Standing order ${standingText(so)}`}
      className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-3 text-sm"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          data-testid="standing-order-amount"
          className="text-base font-medium"
        >
          {standingText(so)}
        </span>
        <span
          data-testid="standing-order-status"
          className={`rounded px-1.5 text-xs ${ended(so) ? 'bg-neutral-100 text-neutral-600' : 'bg-green-100 text-green-900'}`}
        >
          {ended(so) ? 'Ended' : 'Active'}
        </span>
        {term && (
          <span className="text-neutral-600">
            {term.allocations
              .map((a) =>
                term.allocations.length > 1
                  ? `${a.sourceCode ?? '?'} ${formatPence(a.amount)}`
                  : (a.sourceCode ?? '?'),
              )
              .join(' + ')}
          </span>
        )}
      </header>
      {so.missedOn && (
        <p
          role="status"
          data-testid="standing-order-missed"
          className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"
        >
          Missed: the payment due {formatDay(so.missedOn)} hasn’t come in. Still
          active until someone ends it.
        </p>
      )}
      {ended(so) && so.endedReason && (
        <p className="text-neutral-600">
          {so.endedReason}
          {so.endedAt !== null &&
            ` (${formatDay(new Date(so.endedAt).toISOString().slice(0, 10))})`}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-neutral-600">
        {so.bankReference && (
          <>
            <dt>Reference</dt>
            <dd className="font-mono">{so.bankReference}</dd>
          </>
        )}
        {next && (
          <>
            <dt>Next due</dt>
            <dd data-testid="standing-order-next">{formatDay(next)}</dd>
          </>
        )}
      </dl>
      <ExpectedRows so={so} />
      {canWrite && !ended(so) && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={small}
            onClick={() => setEnding(true)}
          >
            End standing order
          </button>
        </div>
      )}
      {ending && <EndDialog so={so} onClose={() => setEnding(false)} />}
    </article>
  )
}

/** Expected against what came in, the last 12 months (newest first). */
function ExpectedRows({ so }: { so: StandingOrder }) {
  const { slug } = useTenant()
  const now = today()
  const rows = so.expected.filter((r) => r.dueOn <= now).reverse()
  return (
    <details>
      <summary className="cursor-pointer text-xs font-medium text-neutral-500">
        Expected vs actual (last 12 months)
      </summary>
      {rows.length === 0 ? (
        <p className="text-xs text-neutral-500">Nothing was due yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table
            data-testid="standing-order-expected"
            className="mt-1 w-full text-left text-xs"
          >
            <thead>
              <tr className="text-neutral-500">
                <th className="py-1 pr-3 font-normal">Due</th>
                <th className="py-1 pr-3 text-right font-normal">Expected</th>
                <th className="py-1 pr-3 font-normal">What happened</th>
                <th className="py-1 font-normal">Gift</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.period}
                  data-period={r.period}
                  data-status={r.status}
                  className="border-t border-neutral-100"
                >
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {formatDay(r.dueOn)}
                  </td>
                  <td className="py-1 pr-3 text-right">
                    {formatPence(r.expected)}
                  </td>
                  <td
                    className={`py-1 pr-3 ${r.status === 'collected' ? 'text-green-800' : r.status === 'missing' ? 'text-red-700' : 'text-neutral-600'}`}
                  >
                    {STANDING_EXPECTED_LABELS[r.status]}
                    {r.amount !== null &&
                      r.amount !== r.expected &&
                      ` (${formatPence(r.amount)})`}
                  </td>
                  <td className="py-1">
                    {r.giftId && (
                      <Link
                        to="/t/$slug/gifts/$giftId"
                        params={{ slug, giftId: r.giftId }}
                        className="underline"
                      >
                        Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  )
}

/** End it (the donor stopped it, or staff decided after a miss): asked first. */
function EndDialog({
  so,
  onClose,
}: {
  so: StandingOrder
  onClose: () => void
}) {
  const writes = useStandingOrderWrites()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await writes.end(so, reason.trim() === '' ? undefined : reason.trim())
      onClose()
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t end it',
          'Someone else changed this standing order just now: it shows as it is now. Try again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogFrame
      title="End standing order"
      description={`${standingText(so)}: nothing is expected from today. Payments already matched stay.`}
      onClose={onClose}
      busy={busy}
    >
      <form
        aria-label="End standing order"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1 text-sm">
          Why (optional)
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="The donor stopped it"
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
          disabled={busy}
          className={`${primary} self-start`}
        >
          {busy ? 'Ending…' : 'End it'}
        </button>
      </form>
    </DialogFrame>
  )
}

/** Standing orders with a missed payment (g2q2: staff decide): for the home page. */
export function MissedStandingOrders() {
  const { slug } = useTenant()
  const { data: missed, error, refetch } = useMissedStandingOrders()
  if (error)
    return (
      <section
        aria-labelledby="missed-standing-orders"
        className="flex flex-col gap-2"
      >
        <h2 id="missed-standing-orders" className="text-lg font-medium">
          Standing orders with a missed payment
        </h2>
        <p role="alert" className="text-sm text-red-700">
          The list couldn’t load.{' '}
          <button
            type="button"
            className={small}
            onClick={() => void refetch()}
          >
            Try again
          </button>
        </p>
      </section>
    )
  if (!missed || missed.length === 0) return null
  return (
    <section
      aria-labelledby="missed-standing-orders"
      className="flex flex-col gap-2"
    >
      <h2 id="missed-standing-orders" className="text-lg font-medium">
        Standing orders with a missed payment
      </h2>
      <ul
        data-testid="missed-standing-orders"
        className="flex flex-col gap-1 text-sm"
      >
        {missed.map((m) => (
          <li key={m.id} className="flex flex-wrap gap-x-2">
            <Link
              to="/t/$slug/contacts/$contactId"
              params={{ slug, contactId: m.contactId }}
              className="underline"
            >
              {m.contactName ?? 'A contact'}
            </Link>
            <span className="text-neutral-600">
              {m.amount !== null && formatPence(m.amount)}
              {m.frequency && ` ${m.frequency}`} · due {formatDay(m.missedOn)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
