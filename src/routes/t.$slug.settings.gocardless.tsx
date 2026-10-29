import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useStepUp } from '../components/claims-ui'
import { ConfirmDialog } from '../components/confirm-dialog'
import { useGoCardlessAdmin, useGoCardlessStatus } from '../lib/data'
import type { GoCardlessStatus } from '../lib/data'
import { refusal } from '../lib/gifts'
import { useIsAdmin } from '../lib/tenant'

/** Where GoCardless's OAuth sent the admin back (`GET gocardless/callback`). */
type Outcome = 'connected' | 'denied' | 'taken' | 'failed' | 'forbidden'
const OUTCOMES: ReadonlyArray<Outcome> = [
  'connected',
  'denied',
  'taken',
  'failed',
  'forbidden',
]

export const Route = createFileRoute('/t/$slug/settings/gocardless')({
  component: GoCardlessSettings,
  validateSearch: (s: Record<string, unknown>): { gocardless?: Outcome } =>
    OUTCOMES.includes(s.gocardless as Outcome)
      ? { gocardless: s.gocardless as Outcome }
      : {},
})

/** What each way back from GoCardless's consent page says. */
export const OUTCOME_TEXT: Record<Outcome, string> = {
  connected: 'Connected to GoCardless.',
  denied: 'GoCardless wasn’t connected: the request was turned down there.',
  taken:
    'That GoCardless account is already connected to another group here. Connect a different account.',
  failed: 'Connecting didn’t finish: GoCardless didn’t answer. Try again.',
  forbidden: 'Only an admin who has just signed in can connect GoCardless.',
}

/** What each mode means, in a line for the admin. */
export const MODE_TEXT: Record<GoCardlessStatus['mode'], string> = {
  off: 'Direct Debit is switched off on this server.',
  fake: 'This server uses a stand-in for GoCardless: no real money moves and no donor is emailed. Staging runs on it until there are GoCardless sandbox keys.',
  sandbox:
    'GoCardless’s sandbox: test accounts and test money only, nothing is really collected.',
  live: 'GoCardless live: real Direct Debits and real money.',
}

const AT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/**
 * Settings › GoCardless (D3): connect the group's own GoCardless account
 * (GoCardless's consent page, then back here), whether it is connected,
 * disconnect, and webhook events that couldn't be handled. Admin only,
 * as every write here wants a sign-in within the hour.
 */
function GoCardlessSettings() {
  const admin = useIsAdmin()
  const { slug } = Route.useParams()
  const { gocardless: outcome } = Route.useSearch()
  const status = useGoCardlessStatus()
  const writes = useGoCardlessAdmin()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  if (!admin)
    return (
      <p className="text-sm text-neutral-600">
        Connecting GoCardless is for the group’s admins.
      </p>
    )

  async function act(f: () => Promise<unknown>, failed: string) {
    setBusy(true)
    setError(null)
    try {
      await stepUp.run(async () => {
        await f()
      })
    } catch (err) {
      setError(refusal(err, failed, failed))
    } finally {
      setBusy(false)
    }
  }

  const connect = () =>
    act(async () => {
      const url = await writes.connect()
      window.location.assign(url)
      // Leaving the page: stay busy until it goes.
      await new Promise(() => {})
    }, 'Couldn’t start connecting')

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">GoCardless</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Direct Debits and one-off bank payments go through the group’s own
          GoCardless account: donors’ money goes straight to it.
        </p>
      </div>
      {outcome && (
        <p
          role="status"
          data-testid="gocardless-outcome"
          className={`rounded border px-2 py-1 text-sm ${outcome === 'connected' ? 'border-green-300 bg-green-50 text-green-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
        >
          {OUTCOME_TEXT[outcome]}
        </p>
      )}
      {status === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <p data-testid="gocardless-mode" className="text-sm text-neutral-700">
            {MODE_TEXT[status.mode]}
          </p>
          {status.enabled && (
            <>
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex gap-2">
                  <dt className="text-neutral-500">Status</dt>
                  <dd data-testid="gocardless-connected">
                    {status.connected ? 'Connected' : 'Not connected'}
                  </dd>
                </div>
                {status.connected && status.organisationId && (
                  <div className="flex gap-2">
                    <dt className="text-neutral-500">Account</dt>
                    <dd className="font-mono">{status.organisationId}</dd>
                  </div>
                )}
                {status.connected && status.connectedAt !== null && (
                  <div className="flex gap-2">
                    <dt className="text-neutral-500">Since</dt>
                    <dd>{AT.format(status.connectedAt)}</dd>
                  </div>
                )}
              </dl>
              {!status.connected && (
                <p className="text-sm text-neutral-600">
                  Not connected: nobody can set up a Direct Debit or take a
                  payment until an admin connects the group’s GoCardless
                  account. Regular gifts already set up stay as they are.
                </p>
              )}
              {status.failedEvents > 0 && (
                <div
                  role="status"
                  className="flex flex-wrap items-baseline gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
                >
                  <span data-testid="gocardless-failed-events">
                    {status.failedEvents === 1
                      ? '1 message from GoCardless couldn’t be handled.'
                      : `${status.failedEvents} messages from GoCardless couldn’t be handled.`}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    className="underline disabled:opacity-50"
                    onClick={() =>
                      void act(writes.retryEvents, 'Couldn’t try them again')
                    }
                  >
                    Try again
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void connect()}
                  className="rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  {status.connected
                    ? 'Connect a different account'
                    : 'Connect GoCardless'}
                </button>
                {status.connected && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setAsking(true)}
                    className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                )}
              </div>
              <Link
                to="/t/$slug/gocardless/unmatched"
                params={{ slug }}
                className="self-start text-sm underline"
              >
                Unmatched payments
              </Link>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={asking}
        title="Disconnect GoCardless?"
        description="Nobody here can set up a Direct Debit or take a payment until it is connected again. GoCardless keeps collecting the Direct Debits already set up; what it reports meanwhile is kept for when you reconnect."
        confirm="Disconnect"
        cancel="Stay connected"
        confirmDisabled={busy}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          void act(writes.disconnect, 'Couldn’t disconnect')
        }}
      />
      {stepUp.form}
    </section>
  )
}
