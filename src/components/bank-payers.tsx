import { useState } from 'react'
import { useForgetPayers, usePayers } from '../lib/data'
import { refusal } from '../lib/gifts'
import { useCanWrite } from '../lib/tenant'
import { ConfirmDialog } from './confirm-dialog'

/**
 * The payer names and references this contact's matched statement lines
 * carried, per bank account (g1q8): what makes the next statement suggest
 * them. Staff and admins only (they come from statement lines, which
 * viewers never see). "Forget these payer details" drops them all; a line
 * matched to the contact afterwards is remembered again.
 */
export function BankPayers({ contactId }: { contactId: string }) {
  const canWrite = useCanWrite()
  const payers = usePayers(contactId, canWrite)
  const forget = useForgetPayers(contactId)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!canWrite || !payers.data || payers.data.length === 0) return null
  return (
    <section aria-label="Bank payer details" className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">Bank payer details</h2>
      <p className="text-xs text-neutral-500">
        How their payments read on your statements: new lines that read the same
        are suggested as theirs.
      </p>
      <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 text-sm">
        {payers.data.map((p) => (
          <li
            key={`${p.accountId}:${p.payer}:${p.reference}`}
            className="flex flex-wrap gap-x-3 px-3 py-2"
          >
            <span className="font-medium">{p.payer || '(no payer)'}</span>
            {p.reference && (
              <span className="text-neutral-600">{p.reference}</span>
            )}
            <span className="text-xs text-neutral-500">{p.accountName}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="self-start rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        {busy ? 'Forgetting…' : 'Forget these payer details'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={asking}
        title="Forget these payer details?"
        description="New statement lines stop being suggested as theirs by payer name. Their gifts and the statement lines stay as they are. A line matched to them later is remembered again."
        confirm="Forget"
        cancel="Cancel"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          setBusy(true)
          setError(null)
          forget()
            .catch((err: unknown) =>
              setError(refusal(err, 'Could not forget the payer details', '')),
            )
            .finally(() => setBusy(false))
        }}
      />
    </section>
  )
}
