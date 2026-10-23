import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { formatDay, refusal } from '../lib/gifts'
import {
  METHOD_LABELS,
  SCOPE_LABELS,
  describeDeclaration,
  useDeclarations,
} from '../lib/giftaid'
import type { Declaration } from '../lib/giftaid'
import { useCanWrite, useTenant } from '../lib/tenant'
import { ConfirmDialog } from './confirm-dialog'
import { localToday } from './source-code-picker'

const AT = new Intl.DateTimeFormat([], {
  dateStyle: 'short',
  timeStyle: 'short',
})
const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const small =
  'rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50'

/**
 * A contact's Gift Aid declarations (cash gifts step 5, g1q2): whether a
 * gift made today would be covered (derived from the chain, rule 1), then
 * each declaration as made, newest first: scope, date, how it was made,
 * the wording, and the name and address it was made under (the snapshot),
 * with its warnings. "Record cancellation" ends every declaration in force
 * on a date; "Mark made in error" voids one that should never have been
 * recorded, with a reason, after a confirm. Declarations themselves are
 * never edited.
 */
export function ContactGiftAid({ contactId }: { contactId: Id<'contacts'> }) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const data = useDeclarations(tenant._id, contactId)
  const members = useQuery(api.platform.tenants.members, {
    tenantId: tenant._id,
  })
  const name = (userId: Id<'users'> | undefined) =>
    members?.find((m) => m.userId === userId)?.name ?? 'system'
  const [cancelling, setCancelling] = useState(false)
  if (data === undefined)
    return (
      <Panel>
        <p className="text-sm text-neutral-500">Loading…</p>
      </Panel>
    )
  const { declarations, currentId } = data
  const current = declarations.find((d) => d._id === currentId)
  // Something a cancellation could still end.
  const cancellable = declarations.some(
    (d) => d.voidedAt === undefined && d.cancelledFrom === undefined,
  )
  return (
    <Panel>
      <p data-testid="giftaid-coverage" className="text-sm">
        {current
          ? `✓ A gift made today is covered by the ${describeDeclaration(current)}.`
          : 'No declaration covers a gift made today.'}
      </p>
      {declarations.length === 0 ? (
        <p className="text-sm text-neutral-500">No declarations.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {declarations.map((d) => (
            <DeclarationCard
              key={d._id}
              declaration={d}
              current={d._id === currentId}
              name={name}
            />
          ))}
        </ul>
      )}
      {canWrite &&
        cancellable &&
        (cancelling ? (
          <CancellationForm
            contactId={contactId}
            onDone={() => setCancelling(false)}
          />
        ) : (
          <button
            type="button"
            className={`${small} self-start`}
            onClick={() => setCancelling(true)}
          >
            Record cancellation
          </button>
        ))}
    </Panel>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="contact-giftaid" className="flex flex-col gap-3">
      <h2 id="contact-giftaid" className="text-lg font-medium">
        Gift Aid
      </h2>
      {children}
    </section>
  )
}

function DeclarationCard({
  declaration: d,
  current,
  name,
}: {
  declaration: Declaration
  current: boolean
  name: (userId: Id<'users'> | undefined) => string
}) {
  const canWrite = useCanWrite()
  const voided = d.voidedAt !== undefined
  const snapshot = [
    [d.firstName, d.lastName].filter(Boolean).join(' '),
    d.addressLine1,
    d.postcode,
  ].filter(Boolean)
  const [voiding, setVoiding] = useState(false)
  return (
    <li
      data-testid="declaration"
      className={`flex flex-col gap-1 rounded border p-2 text-sm ${voided ? 'border-neutral-200 bg-neutral-50 text-neutral-500' : 'border-neutral-200 bg-white'}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`font-medium ${voided ? 'line-through' : ''}`}>
          {SCOPE_LABELS[d.scope]}
        </span>
        <span className="text-neutral-600">made {formatDay(d.madeOn)}</span>
        {current && (
          <span className="rounded bg-green-100 px-1 text-xs text-green-800">
            current
          </span>
        )}
        {d.cancelledFrom !== undefined && !voided && (
          <span className="rounded bg-neutral-200 px-1 text-xs">
            cancelled from {formatDay(d.cancelledFrom)}
          </span>
        )}
        {voided && (
          <span className="rounded bg-red-100 px-1 text-xs text-red-800">
            made in error
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-2 text-xs">
        <dt className="text-neutral-500">Method</dt>
        <dd>{METHOD_LABELS[d.method]}</dd>
        <dt className="text-neutral-500">Wording</dt>
        <dd>{d.wordingVersion}</dd>
        <dt className="text-neutral-500">Made as</dt>
        <dd>{snapshot.length ? snapshot.join(', ') : '—'}</dd>
        <dt className="text-neutral-500">Entered by</dt>
        <dd>{name(d.enteredBy)}</dd>
        {d.cancellationNote && (
          <>
            <dt className="text-neutral-500">Cancellation</dt>
            <dd>{d.cancellationNote}</dd>
          </>
        )}
        {voided && (
          <>
            <dt className="text-neutral-500">Made in error</dt>
            <dd>
              {d.voidReason} ({name(d.voidedBy)}, {AT.format(d.voidedAt)})
            </dd>
          </>
        )}
      </dl>
      {d.warnings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {d.warnings.map((w) => (
            <li
              key={`${w.anchor}:${w.label}`}
              className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900"
            >
              <span className="font-medium">{w.label}:</span> {w.message}
            </li>
          ))}
        </ul>
      )}
      {canWrite &&
        !voided &&
        (voiding ? (
          <VoidForm id={d._id} onDone={() => setVoiding(false)} />
        ) : (
          <button
            type="button"
            className={`${small} self-start`}
            onClick={() => setVoiding(true)}
          >
            Mark made in error
          </button>
        ))}
    </li>
  )
}

/**
 * The cancellation's date (from when the donor's declarations stop
 * applying) and an optional note. Ends every declaration in force then.
 */
function CancellationForm({
  contactId,
  onDone,
}: {
  contactId: Id<'contacts'>
  onDone: () => void
}) {
  const tenant = useTenant()
  const record = useMutation(api.giftaid.mutations.recordCancellation)
  const [cancelledFrom, setCancelledFrom] = useState(localToday())
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await record({
        tenantId: tenant._id,
        contactId,
        cancelledFrom,
        note: note.trim() || undefined,
      })
      onDone()
    } catch (err) {
      setError(
        refusal(
          err,
          'Could not record the cancellation',
          'The declarations changed just now: check them, then try again',
        ),
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-label="Record cancellation"
      className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-2"
    >
      <label className="flex flex-col gap-1 text-sm">
        Cancelled from
        <input
          type="date"
          required
          value={cancelledFrom}
          onChange={(e) => setCancelledFrom(e.target.value)}
          className={`${field} w-44`}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Note (optional)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={field}
        />
      </label>
      <p className="text-xs text-neutral-500">
        Gifts on or after this date won’t be covered by any declaration in force
        then.
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={small} disabled={saving}>
          Save cancellation
        </button>
        <button
          type="button"
          className={small}
          disabled={saving}
          onClick={onDone}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * Why the declaration was made in error (required), then a confirm: a
 * void can't be undone, only followed by a new declaration.
 */
function VoidForm({
  id,
  onDone,
}: {
  id: Id<'giftAidDeclarations'>
  onDone: () => void
}) {
  const tenant = useTenant()
  const voidDeclaration = useMutation(api.giftaid.mutations.voidDeclaration)
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function run() {
    setError(null)
    setSaving(true)
    try {
      await voidDeclaration({ tenantId: tenant._id, id, reason })
      onDone()
    } catch (err) {
      setError(
        refusal(
          err,
          'Could not mark the declaration made in error',
          'The declaration changed just now: check it, then try again',
        ),
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!reason.trim()) {
          setError('Say why the declaration was made in error')
          return
        }
        setConfirming(true)
      }}
      aria-label="Mark made in error"
      className="flex flex-col gap-2"
    >
      <label className="flex flex-col gap-1 text-xs">
        Why was it made in error?
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={field}
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={small} disabled={saving}>
          Mark made in error
        </button>
        <button
          type="button"
          className={small}
          disabled={saving}
          onClick={onDone}
        >
          Cancel
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Mark this declaration made in error?"
        description="It will never have covered any gift, past or future. This can't be undone: record a new declaration if it was right after all."
        confirm="Mark made in error"
        cancel="Cancel"
        onConfirm={() => {
          setConfirming(false)
          void run()
        }}
        onCancel={() => setConfirming(false)}
      />
    </form>
  )
}
