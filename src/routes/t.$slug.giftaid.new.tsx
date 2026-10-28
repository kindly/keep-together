import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  Figure,
  LinesTable,
  ReadRefused,
  claimRefusal,
  useStepUp,
} from '../components/claims-ui'
import { localToday } from '../components/source-code-picker'
import { useClaimPreview, useCreateClaims } from '../lib/data'
import type { ClaimPreview } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { formatDay, formatPence } from '../lib/gifts'
import { useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/giftaid/new')({
  component: NewClaim,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const primary =
  'rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'
const secondary =
  'rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50'

/**
 * New claim (G3): an end date (today by default), then the server's
 * preview of a claim up to it: the gifts it would claim and their
 * reclaim, the adjustments due, how many claims it makes (1,000 gifts
 * each), and every gift left out with its reasons and a link to fix it.
 * "Refresh" reads it again after a fix; "Create claim" sends the totals
 * shown, and the server refuses if they've changed since.
 */
function NewClaim() {
  const [dateText, setDateText] = useState(localToday)
  const [periodEnd, setPeriodEnd] = useState(localToday)
  const preview = useClaimPreview(periodEnd)

  function show(e: FormEvent) {
    e.preventDefault()
    if (dateText === periodEnd) void preview.refetch()
    else setPeriodEnd(dateText)
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">New Gift Aid claim</h1>
        <p className="text-sm text-neutral-600">
          Claims every eligible gift received up to the end date.
        </p>
      </header>
      <form
        onSubmit={show}
        aria-label="Claim period"
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          End date
          <input
            type="date"
            required
            value={dateText}
            max={localToday()}
            onChange={(e) => setDateText(e.target.value)}
            className={`${field} w-48`}
          />
        </label>
        <button type="submit" className={secondary}>
          Preview
        </button>
      </form>
      {preview.error ? (
        <ReadRefused error={preview.error} retry={preview.refetch} />
      ) : preview.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <Preview
          // A new date starts afresh: no refusal carried over.
          key={preview.data.periodEnd}
          preview={preview.data}
          fetching={preview.fetching}
          refresh={preview.refetch}
        />
      )}
    </main>
  )
}

function Preview({
  preview,
  fetching,
  refresh,
}: {
  preview: ClaimPreview
  fetching: boolean
  refresh: () => Promise<unknown>
}) {
  const { slug } = useTenant()
  const navigate = useNavigate()
  const create = useCreateClaims()
  const stepUp = useStepUp()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { totals } = preview
  const empty = totals.lines === 0 && preview.adjustments.length === 0

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      await stepUp.run(async () => {
        const claims = await create(preview)
        if (claims.length === 1)
          await navigate({
            to: '/t/$slug/giftaid/$claimId',
            params: { slug, claimId: claims[0].id },
          })
        else await navigate({ to: '/t/$slug/giftaid', params: { slug } })
      })
    } catch (err) {
      setError(claimRefusal(err, 'Could not create the claim'))
      // What is eligible moved on: show it as it is now.
      if (
        err instanceof RustApiError &&
        err.error.kind === 'rejected' &&
        err.error.reason === 'preview_changed'
      )
        void refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Preview"
      data-period-end={preview.periodEnd}
      className="flex flex-col gap-6"
    >
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <Figure label="Gifts" testId="preview-lines">
          {totals.lines}
        </Figure>
        <Figure label="Donations">{formatPence(totals.donations)}</Figure>
        <Figure label="Gift Aid (25%)" testId="preview-reclaim">
          {formatPence(totals.reclaim)}
        </Figure>
        {totals.adjustment > 0n && (
          <>
            <Figure label="Paid back">−{formatPence(totals.adjustment)}</Figure>
            <Figure label="Net">{formatPence(totals.net)}</Figure>
          </>
        )}
      </dl>
      <p className="text-sm text-neutral-600">
        {empty
          ? `No gift can be claimed up to ${formatDay(preview.periodEnd)}.`
          : preview.claims > 1
            ? `This makes ${preview.claims} claims, oldest gifts first: HMRC takes at most 1,000 gifts per claim.`
            : 'This makes one claim, a draft until you mark it ready.'}{' '}
        Gifts received before {formatDay(preview.claimableFrom)} are past HMRC’s
        four-year limit
        {preview.tooOld > 0 &&
          ` (${preview.tooOld} unclaimed ${preview.tooOld === 1 ? 'gift' : 'gifts'})`}
        .
      </p>

      {stepUp.form}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={primary}
          disabled={busy || fetching || empty}
          onClick={() => void submit()}
        >
          {preview.claims > 1
            ? `Create ${preview.claims} claims`
            : 'Create claim'}
        </button>
        <button
          type="button"
          className={secondary}
          disabled={fetching}
          onClick={() => void refresh()}
        >
          {fetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {preview.adjustments.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Paid back to HMRC</h2>
          <p className="text-sm text-neutral-600">
            Gifts an earlier claim took, voided since: the tax on them comes off
            this claim.
          </p>
          <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white text-sm">
            {preview.adjustments.map((a) => (
              <li key={a.giftId} className="flex flex-wrap gap-x-3 px-3 py-2">
                <Link
                  to="/t/$slug/gifts/$giftId"
                  params={{ slug, giftId: a.giftId }}
                  className="underline"
                >
                  Gift
                </Link>
                <span>{formatPence(a.amount)}</span>
                <span className="text-neutral-600">{a.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview.excluded.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Left out">
          <h2 className="font-medium">Left out ({preview.excluded.length})</h2>
          <p className="text-sm text-neutral-600">
            Fix the contact or the gift, then Refresh.
          </p>
          <ul
            data-testid="excluded"
            className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white text-sm"
          >
            {preview.excluded.map((x) => (
              <li
                key={x.giftId}
                data-gift={x.giftId}
                className="flex flex-col gap-1 px-3 py-2"
              >
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <Link
                    to="/t/$slug/contacts/$contactId"
                    params={{ slug, contactId: x.contactId }}
                    className="font-medium underline"
                  >
                    {x.contactName || 'Unnamed contact'}
                  </Link>
                  <Link
                    to="/t/$slug/gifts/$giftId"
                    params={{ slug, giftId: x.giftId }}
                    className="underline"
                  >
                    {formatPence(x.amount)} on {formatDay(x.receivedOn)}
                  </Link>
                </span>
                <ul className="list-disc pl-5 text-neutral-700">
                  {x.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview.lines.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer font-medium">
            Gifts to claim ({preview.lines.length})
          </summary>
          <LinesTable lines={preview.lines} />
        </details>
      )}
    </section>
  )
}
