import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTermsWrites, useUnknownSubscriptions } from '../lib/data'
import type { RegularGift, UnknownSubscription } from '../lib/data'
import { useRequestKey } from '../lib/request-key'
import { formatDay, formatPence, refusal } from '../lib/gifts'
import { useCanWrite, useTenant } from '../lib/tenant'
import {
  CodeField,
  DialogFrame,
  amountText,
  primary,
  small,
} from './direct-debit'
import type { PickedCode } from './direct-debit'

/**
 * Subscriptions set up elsewhere (ADR 0026, g2q6): GoCardless
 * subscriptions nobody here set up, on mandates we know. Their payments
 * are one-off gifts until staff adopt one as a regular gift (from its
 * next payment, at GoCardless's terms); leaving it changes nothing.
 * Nothing shows when there are none.
 */
export function UnknownSubscriptions() {
  const { slug } = useTenant()
  const list = useUnknownSubscriptions()
  const canWrite = useCanWrite()
  // By id: the dialog reads the row from the list as it now is.
  const [adopting, setAdopting] = useState<string | null>(null)
  const section = (
    <section
      aria-labelledby="unknown-subscriptions"
      className="flex flex-col gap-2"
    >
      <h2 id="unknown-subscriptions" className="text-lg font-medium">
        Subscriptions set up elsewhere
      </h2>
      <p className="text-sm text-neutral-600">
        Set up in GoCardless itself, on a donor’s Direct Debit we know. Their
        payments are recorded as one-off gifts. Adopt one to follow it as a
        regular gift from its next payment, or leave it as it is.
      </p>
      <div className="overflow-x-auto">
        <table
          data-testid="unknown-subscriptions"
          className="w-full text-left text-sm"
        >
          <thead>
            <tr className="border-b border-neutral-200 text-neutral-500">
              <th className="py-2 pr-3 font-normal">GoCardless</th>
              <th className="py-2 pr-3 font-normal">Donor</th>
              <th className="py-2 pr-3 text-right font-normal">Payments</th>
              <th className="py-2 pr-3 font-normal">Latest</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {(list ?? []).map((s) => (
              <tr
                key={s.subscriptionId}
                data-subscription={s.subscriptionId}
                className="border-b border-neutral-100"
              >
                <td className="py-1 pr-3 font-mono text-xs">
                  {s.subscriptionId}
                </td>
                <td className="py-1 pr-3">
                  {s.contactId && (
                    <Link
                      to="/t/$slug/contacts/$contactId"
                      params={{ slug, contactId: s.contactId }}
                      className="underline"
                    >
                      Contact
                    </Link>
                  )}
                </td>
                <td className="py-1 pr-3 text-right">{s.payments}</td>
                <td className="py-1 pr-3">
                  {formatPence(s.lastAmount)} on {formatDay(s.lastChargeDate)}
                </td>
                <td className="py-1 text-right">
                  {canWrite && (
                    <button
                      type="button"
                      className={small}
                      onClick={() => setAdopting(s.subscriptionId)}
                    >
                      Adopt
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
  // The dialog outlives its row: once adopted, the subscription leaves
  // the list (maybe the last one), and its answer must still show.
  return (
    <>
      {list?.length ? section : null}
      {adopting && (
        <AdoptDialog
          listed={list?.find((s) => s.subscriptionId === adopting)}
          onClose={() => setAdopting(null)}
        />
      )}
    </>
  )
}

/** Adopt: the code the whole amount goes to, then the regular gift. */
function AdoptDialog({
  listed,
  onClose,
}: {
  /** As the list now has it; gone once adopted (by anyone). */
  listed: UnknownSubscription | undefined
  onClose: () => void
}) {
  // The row as first opened, for the description once it has gone.
  const [opened] = useState(listed)
  const subscription = listed ?? opened
  const { slug } = useTenant()
  const writes = useTermsWrites()
  const keyFor = useRequestKey()
  const [code, setCode] = useState<PickedCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<RegularGift | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!code || !listed) return
    setBusy(true)
    setError(null)
    try {
      setMade(
        await writes.adopt(listed.subscriptionId, {
          sourceCodeId: code.id,
          clientKey: keyFor({ sourceCodeId: code.id }),
        }),
      )
    } catch (err) {
      setError(
        refusal(err, 'Couldn’t adopt it', 'Changed by someone else just now'),
      )
    } finally {
      setBusy(false)
    }
  }
  if (!subscription) return null
  return (
    <DialogFrame
      title="Adopt this subscription"
      description={`${subscription.subscriptionId}: ${subscription.payments} payments so far, the latest ${formatPence(subscription.lastAmount)}. It becomes a regular gift at GoCardless’s terms from its next payment; nothing is sent to GoCardless.`}
      onClose={onClose}
      busy={busy}
    >
      {made ? (
        <p role="status" className="text-sm">
          Adopted: {amountText(made)}.{' '}
          <Link
            to="/t/$slug/contacts/$contactId"
            params={{ slug, contactId: made.contactId }}
            className="underline"
          >
            Open the contact
          </Link>
        </p>
      ) : // Gone while our own adopt is in flight is ours landing.
      listed === undefined && !busy ? (
        <p role="status" data-testid="adopt-gone" className="text-sm">
          Someone else has adopted this subscription already: it is no longer
          listed.
        </p>
      ) : (
        <form
          aria-label="Adopt this subscription"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          <CodeField code={code} onChange={setCode} />
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!code || !listed || busy}
            className={`${primary} self-start`}
          >
            {busy ? 'Adopting…' : 'Adopt'}
          </button>
        </form>
      )}
    </DialogFrame>
  )
}
