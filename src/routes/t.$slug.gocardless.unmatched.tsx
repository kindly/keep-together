import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { ReadRefused } from '../components/claims-ui'
import {
  CodeField,
  DialogFrame,
  primary,
  small,
} from '../components/direct-debit'
import type { PickedCode } from '../components/direct-debit'
import { DonorSearch } from '../components/gift-form'
import { useMatchPayment, useUnmatchedPayments } from '../lib/data'
import type { UnmatchedPayment } from '../lib/data'
import { PAYMENT_LABELS, isCollected } from '../lib/domain/direct-debit'
import type { DonorChoice } from '../lib/gift-form'
import { formatDay, formatPence, refusal } from '../lib/gifts'
import { useCanWrite, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/gocardless/unmatched')({
  component: UnmatchedPayments,
})

/**
 * Unmatched payments (GoCardless round 2): payments GoCardless reported
 * that nobody here could be tied to a donor (no gift yet), newest
 * first. Staff and admins match each to a contact and a code, which
 * makes its gift with GoCardless's amount, date and status; viewers see
 * the list.
 */
function UnmatchedPayments() {
  const list = useUnmatchedPayments()
  const canWrite = useCanWrite()
  // The payment by id: the dialog reads its row from the list, so a list
  // read again (after a 409) gives it the current version.
  const [matching, setMatching] = useState<string | null>(null)
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Unmatched payments</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Payments GoCardless reported that couldn’t be tied to a donor here.
          Match each to its contact to record its gift.
        </p>
      </header>
      {list.error ? (
        <ReadRefused
          error={list.error}
          retry={list.refetch}
          failed="The unmatched payments couldn’t load."
        />
      ) : list.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : list.data.length === 0 ? (
        <p data-testid="unmatched-empty" className="text-sm text-neutral-500">
          Nothing to match.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            data-testid="unmatched-payments"
            className="w-full text-left text-sm"
          >
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th className="py-2 pr-3 font-normal">Charge date</th>
                <th className="py-2 pr-3 text-right font-normal">Amount</th>
                <th className="py-2 pr-3 font-normal">Status</th>
                <th className="py-2 pr-3 font-normal">GoCardless</th>
                <th className="py-2 font-normal" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr
                  key={p.id}
                  data-payment={p.paymentId}
                  className="border-b border-neutral-100"
                >
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {formatDay(p.chargeDate)}
                  </td>
                  <td
                    className={`py-1 pr-3 text-right ${isCollected(p.status) ? '' : 'text-neutral-500 line-through'}`}
                  >
                    {formatPence(p.amount)}
                  </td>
                  <td className="py-1 pr-3">
                    {PAYMENT_LABELS[p.status]}
                    {p.reason && ` (${p.reason})`}
                  </td>
                  <td className="py-1 pr-3 font-mono text-xs">
                    {p.paymentId}
                    {p.mandateId && ` · ${p.mandateId}`}
                  </td>
                  <td className="py-1 text-right">
                    {canWrite && (
                      <button
                        type="button"
                        className={small}
                        onClick={() => setMatching(p.id)}
                      >
                        Match to contact
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {matching && list.data && (
        <MatchDialog
          id={matching}
          payment={list.data.find((p) => p.id === matching)}
          onClose={() => setMatching(null)}
        />
      )}
    </main>
  )
}

/** Find the contact, pick the code: the payment's gift is made. */
function MatchDialog({
  id,
  payment: listed,
  onClose,
}: {
  id: string
  /** As the list now has it; gone once matched (by anyone). */
  payment: UnmatchedPayment | undefined
  onClose: () => void
}) {
  // The row as first opened, for the description once it has gone.
  const [opened] = useState(listed)
  const { slug } = useTenant()
  const match = useMatchPayment()
  const [donor, setDonor] = useState<Extract<
    DonorChoice,
    { kind: 'existing' }
  > | null>(null)
  const [code, setCode] = useState<PickedCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [giftId, setGiftId] = useState<string | null>(null)
  const payment = listed ?? opened
  const ready = listed !== undefined && donor !== null && code !== null && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      setGiftId(await match(listed, donor.id, code.id))
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
      description={`${formatPence(payment.amount)} on ${formatDay(payment.chargeDate)} (${payment.paymentId}). Its gift takes GoCardless’s amount, date and status.`}
      onClose={onClose}
      busy={busy}
    >
      {giftId ? (
        <p role="status" className="text-sm">
          Matched to {donor?.displayName}.{' '}
          <Link
            to="/t/$slug/gifts/$giftId"
            params={{ slug, giftId }}
            className="underline"
          >
            Open the gift
          </Link>
        </p>
      ) : listed === undefined ? (
        <p role="status" data-testid="match-gone" className="text-sm">
          Someone else has matched this payment already: it is no longer listed.
        </p>
      ) : (
        <form
          aria-label="Match to contact"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
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
                onPick={(d) => d.kind === 'existing' && setDonor(d)}
              />
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
            {busy ? 'Matching…' : 'Match'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}
