import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useBankAccounts, useBatchWrites, useBatches } from '../lib/data'
import type { PayingInBatch } from '../lib/data'
import { formatDay, formatPence, refusal } from '../lib/gifts'
import { batchState } from '../components/bank'
import { useCanWrite } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/bank/batches/')({
  component: BatchesPage,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'

/**
 * Paying-in batches (bank transfers 6b, ADR 0027 decision 6): cash and
 * cheques paid in together on one slip. Open ones first, then the newest
 * closed, each with its gifts' total. Staff and admins open one on a
 * bank account; every member reads.
 */
function BatchesPage() {
  const canWrite = useCanWrite()
  const batches = useBatches()
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold">Paying-in batches</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Cash and cheques paid in together on one paying-in slip. Record the
          gifts into an open batch, then close it with the slip’s total.
        </p>
      </div>
      {canWrite && <OpenBatch />}
      {batches.error ? (
        <p role="alert" className="text-sm text-red-700">
          The batches couldn’t load.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void batches.refetch()}
          >
            Try again
          </button>
        </p>
      ) : batches.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : batches.data.length === 0 ? (
        <p className="text-sm text-neutral-600">No paying-in batches yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-200 rounded border border-neutral-200">
          {batches.data.map((b) => (
            <li key={b.id}>
              <BatchRow batch={b} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function BatchRow({ batch: b }: { batch: PayingInBatch }) {
  const { slug } = Route.useParams()
  return (
    <Link
      to="/t/$slug/bank/batches/$batchId"
      params={{ slug, batchId: b.id }}
      className="flex flex-col gap-1 px-3 py-2 text-sm hover:bg-neutral-50 sm:flex-row sm:items-baseline sm:justify-between"
    >
      <span className="flex flex-col">
        <span className="font-medium">
          {b.accountName}
          {b.slipNumber && `, slip ${b.slipNumber}`}
        </span>
        <span className="text-xs text-neutral-600" data-testid="batch-state">
          {batchState(b)}
          {b.bankedOn && `; paid in ${formatDay(b.bankedOn)}`}
        </span>
      </span>
      <span className="text-neutral-700">
        {b.giftCount} {b.giftCount === 1 ? 'gift' : 'gifts'},{' '}
        {formatPence(b.giftsTotal)}
      </span>
    </Link>
  )
}

/** Open a batch on an active bank account; then go to it. */
function OpenBatch() {
  const { slug } = Route.useParams()
  const navigate = useNavigate()
  const accounts = useBankAccounts()
  const writes = useBatchWrites()
  const active = accounts.data?.filter((a) => a.active) ?? []
  const [accountId, setAccountId] = useState('')
  const [slip, setSlip] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = accountId || active.at(0)?.id || ''
  if (accounts.data === undefined) return null
  if (active.length === 0)
    return (
      <p className="text-sm text-neutral-600">
        To open a batch, an admin first adds the bank account in Settings › Bank
        accounts.
      </p>
    )

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const b = await writes.open(chosen, slip)
      await navigate({
        to: '/t/$slug/bank/batches/$batchId',
        params: { slug, batchId: b.id },
      })
    } catch (err) {
      setError(refusal(err, 'Could not open the batch', ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label="Open a batch"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-2 rounded border border-neutral-200 p-3 sm:flex-row sm:items-end"
    >
      <label className="flex flex-col gap-1 text-sm">
        Bank account
        <select
          value={chosen}
          onChange={(e) => setAccountId(e.target.value)}
          className={`${field} w-64 max-w-full`}
        >
          {active.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Slip number <span className="text-xs text-neutral-500">(optional)</span>
        <input
          value={slip}
          onChange={(e) => setSlip(e.target.value)}
          className={`${field} w-40`}
        />
      </label>
      <button type="submit" disabled={busy || !chosen} className={button}>
        {busy ? 'Opening…' : 'Open a batch'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  )
}
