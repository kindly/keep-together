import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { batchLabel } from '../components/bank'
import { useBatch, useBatchWrites } from '../lib/data'
import type { BatchGift, PayingInBatch } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { STATUS_LABELS, isReceived } from '../lib/domain/gift-status'
import {
  METHOD_LABELS,
  formatDay,
  formatPence,
  parsePounds,
  penceToInput,
  refusal,
} from '../lib/gifts'
import { useCanWrite } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/bank/batches/$batchId')({
  component: BatchPage,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'
const quiet =
  'self-start rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50'

/**
 * One paying-in batch (bank transfers 6b): its account, slip, the date it
 * was paid in, its cash and cheques and what they add up to against the
 * slip's total (a difference is shown, never forced). While open, staff
 * record gifts into it (the record-gift page, with this batch chosen) and
 * close it with the slip's total; a closed one can be reopened until its
 * statement line is matched (reconcile, step 4). Never optimistic: the
 * totals are the server's, refetched on every change.
 */
function BatchPage() {
  const { slug, batchId } = Route.useParams()
  const page = useBatch(batchId)
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <Link
        to="/t/$slug/bank/batches"
        params={{ slug }}
        className="text-sm text-neutral-600 underline"
      >
        Paying-in batches
      </Link>
      {page.error ? (
        <p role="alert" className="text-sm text-red-700">
          {page.error instanceof RustApiError &&
          page.error.error.kind === 'not_found'
            ? 'No such batch.'
            : 'The batch couldn’t load.'}
        </p>
      ) : page.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <Batch batch={page.data.batch} gifts={page.data.gifts} />
      )}
    </main>
  )
}

function Batch({
  batch: b,
  gifts,
}: {
  batch: PayingInBatch
  gifts: Array<BatchGift>
}) {
  const { slug } = Route.useParams()
  const canWrite = useCanWrite()
  const difference = b.total !== null ? b.total - b.giftsTotal : null
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">{batchLabel(b)}</h1>
        <p className="text-sm text-neutral-600" data-testid="batch-state">
          {b.line
            ? `Matched to the statement line of ${formatDay(b.line.postedOn)} (${formatPence(b.line.amount)}): its cheques have cleared.`
            : b.status === 'open'
              ? 'Open: record its cash and cheques, then close it with the slip’s total.'
              : 'Closed: waiting to be matched to its statement line, which clears its cheques.'}
        </p>
      </div>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-neutral-500">Gifts</dt>
        <dd data-testid="batch-gifts-total">
          {b.giftCount}, {formatPence(b.giftsTotal)}
        </dd>
        {b.total !== null && (
          <>
            <dt className="text-neutral-500">Slip’s total</dt>
            <dd>{formatPence(b.total)}</dd>
          </>
        )}
        {b.bankedOn && (
          <>
            <dt className="text-neutral-500">Paid in</dt>
            <dd>{formatDay(b.bankedOn)}</dd>
          </>
        )}
      </dl>
      {difference !== null && difference !== 0n && (
        <p
          role="status"
          data-testid="batch-difference"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
        >
          The slip says{' '}
          {formatPence(difference < 0n ? -difference : difference)}{' '}
          {difference > 0n ? 'more' : 'less'} than the gifts recorded in this
          batch: check for a gift left out or entered twice.
        </p>
      )}
      {canWrite && !b.line && <BatchActions batch={b} />}
      <section aria-label="Gifts in this batch" className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 className="font-medium">Gifts in this batch</h2>
          {canWrite && b.status === 'open' && (
            <Link
              to="/t/$slug/gifts/new"
              params={{ slug }}
              search={{ batch: b.id }}
              className="text-sm underline"
            >
              Record cash or a cheque into it
            </Link>
          )}
        </div>
        {gifts.length === 0 ? (
          <p className="text-sm text-neutral-600">None yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
            {gifts.map((g) => (
              <li key={g.id}>
                <Link
                  to="/t/$slug/gifts/$giftId"
                  params={{ slug, giftId: g.id }}
                  className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm hover:bg-neutral-50"
                >
                  <span
                    className={
                      isReceived(g.status) || g.status === 'pending'
                        ? ''
                        : 'text-neutral-500 line-through'
                    }
                  >
                    {formatPence(g.amount)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {g.contactName}
                  </span>
                  <span className="text-xs text-neutral-600">
                    {METHOD_LABELS[g.method]}
                    {g.status !== 'completed' &&
                      `, ${g.method === 'cheque' && g.status === 'failed' ? 'bounced' : STATUS_LABELS[g.status]}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

/**
 * Close an open batch with the slip's total and date (the total starts
 * at the gifts' sum); reopen a closed one that isn't matched. Stale:
 * someone else changed it, so the page refetches and says so.
 */
function BatchActions({ batch: b }: { batch: PayingInBatch }) {
  const writes = useBatchWrites()
  const [closing, setClosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (closing) heading.current?.focus()
  }, [closing])

  async function attempt(f: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await f()
      setClosing(false)
    } catch (err) {
      setError(
        refusal(
          err,
          'Could not change the batch',
          'Someone else changed this batch just now: it has been read again, so check it and try again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  if (b.status === 'closed')
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className={quiet}
          disabled={busy}
          onClick={() => void attempt(() => writes.reopen(b.id, b.version))}
        >
          {busy ? 'Reopening…' : 'Reopen to add a gift'}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    )
  if (!closing)
    return (
      <button type="button" className={button} onClick={() => setClosing(true)}>
        Close the batch
      </button>
    )
  return (
    <CloseForm
      batch={b}
      busy={busy}
      error={error}
      heading={heading}
      onCancel={() => setClosing(false)}
      onClose={(bankedOn, total) =>
        void attempt(() => writes.close(b.id, b.version, bankedOn, total))
      }
    />
  )
}

function CloseForm({
  batch: b,
  busy,
  error,
  heading,
  onCancel,
  onClose,
}: {
  batch: PayingInBatch
  busy: boolean
  error: string | null
  heading: React.RefObject<HTMLHeadingElement | null>
  onCancel: () => void
  onClose: (bankedOn: string, total: bigint) => void
}) {
  const [total, setTotal] = useState(() => penceToInput(b.giftsTotal))
  const [bankedOn, setBankedOn] = useState(
    () => b.bankedOn ?? new Date().toISOString().slice(0, 10),
  )
  const pence = parsePounds(total)
  const totalProblem =
    pence === null || pence <= 0n ? 'Enter the slip’s total, over £0' : null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (pence === null || totalProblem || !bankedOn) return
    onClose(bankedOn, pence)
  }

  return (
    <form
      aria-label="Close the batch"
      onSubmit={submit}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <h2 ref={heading} tabIndex={-1} className="font-medium outline-none">
        Close the batch
      </h2>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Slip’s total (£)
          <input
            value={total}
            inputMode="decimal"
            onChange={(e) => setTotal(e.target.value)}
            aria-invalid={totalProblem ? true : undefined}
            aria-describedby={totalProblem ? 'batch-total-problem' : undefined}
            className={`${field} w-32`}
          />
          {totalProblem && (
            <span id="batch-total-problem" className="text-xs text-red-700">
              {totalProblem}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Paid in on
          <input
            type="date"
            required
            value={bankedOn}
            onChange={(e) => setBankedOn(e.target.value)}
            className={`${field} w-44`}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className={button}
          disabled={busy || totalProblem !== null || !bankedOn}
        >
          {busy ? 'Closing…' : 'Close it'}
        </button>
        <button
          type="button"
          className={quiet}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
