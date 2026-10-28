import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ConfirmDialog } from '../components/confirm-dialog'
import {
  Figure,
  LinesTable,
  ReadRefused,
  StatusBadge,
  claimPeriod,
  claimRefusal,
  useStepUp,
} from '../components/claims-ui'
import { localToday } from '../components/source-code-picker'
import { downloadClaim, useClaim, useClaimStep } from '../lib/data'
import type { Claim, ClaimDownload, ClaimStep } from '../lib/data'
import { formatDay, formatPence, parsePounds, penceToInput } from '../lib/gifts'
import { useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/giftaid/$claimId')({
  component: ClaimPage,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const primary =
  'rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'
const secondary =
  'rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50'

function ClaimPage() {
  const tenant = useTenant()
  const { claimId } = Route.useParams()
  const claim = useClaim(claimId)
  if (claim.error)
    return (
      <main className="mx-auto max-w-5xl p-6">
        <ReadRefused error={claim.error} retry={claim.refetch} />
      </main>
    )
  if (claim.data === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (claim.data === null)
    return (
      <main className="mx-auto max-w-lg p-6">
        <p>No such claim.</p>
        <Link
          to="/t/$slug/giftaid"
          params={{ slug: tenant.slug }}
          className="underline"
        >
          Gift Aid claims
        </Link>
      </main>
    )
  // Keyed so a form in progress never carries to another claim.
  return <ClaimView key={`${tenant._id}:${claimId}`} claim={claim.data} />
}

/** The step forms that ask for details first. */
type Asking = 'submitted' | 'paid' | 'rejected'

/**
 * One claim (G3): its totals, lines and adjustments, what has happened
 * to it, and the next steps its status allows: a draft is marked ready
 * or deleted; a ready claim is downloaded, marked submitted (date and
 * HMRC's reference) or rejected; a submitted one is marked paid (amount
 * and date) or rejected. Every change waits for the server and shows
 * the claim it read back; a refusal is shown as the server words it.
 */
function ClaimView({ claim }: { claim: Claim }) {
  const { slug } = useTenant()
  const navigate = useNavigate()
  const step = useClaimStep(claim.id)
  const stepUp = useStepUp()
  const [asking, setAsking] = useState<Asking | null>(null)
  const [confirming, setConfirming] = useState<'ready' | 'deleted' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { totals, status } = claim
  const downloadable = status !== 'draft' && status !== 'deleted'

  async function go(s: ClaimStep, expected: number) {
    setError(null)
    setBusy(true)
    try {
      await stepUp.run(async () => {
        const now = await step(expected, s)
        setAsking(null)
        if (now === null)
          await navigate({ to: '/t/$slug/giftaid', params: { slug } })
      })
    } catch (err) {
      setError(claimRefusal(err, 'Could not change the claim'))
    } finally {
      setBusy(false)
    }
  }

  async function download(what: ClaimDownload) {
    setError(null)
    try {
      await stepUp.run(() => downloadClaim(slug, claim.id, what))
    } catch (err) {
      setError(claimRefusal(err, 'Could not download the claim'))
    }
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link
          to="/t/$slug/giftaid"
          params={{ slug }}
          className="text-sm text-neutral-600 hover:underline"
        >
          ← Gift Aid claims
        </Link>
        <h1
          data-status-version={claim.statusVersion}
          className="flex flex-wrap items-baseline gap-2 text-xl font-semibold"
        >
          Gift Aid claim {claim.number} <StatusBadge status={status} />
        </h1>
        <p className="text-sm text-neutral-600">Gifts {claimPeriod(claim)}</p>
      </header>

      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <Figure label="Gifts">{totals.lines}</Figure>
        <Figure label="Donations">{formatPence(totals.donations)}</Figure>
        <Figure label="Gift Aid (25%)" testId="claim-reclaim">
          {formatPence(totals.reclaim)}
        </Figure>
        {totals.adjustment > 0n && (
          <Figure label="Paid back">−{formatPence(totals.adjustment)}</Figure>
        )}
        <Figure label="Due from HMRC" testId="claim-net">
          {formatPence(totals.net)}
        </Figure>
      </dl>

      <dl
        data-testid="claim-progress"
        className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm"
      >
        {claim.submittedOn && (
          <>
            <dt className="text-neutral-500">Submitted</dt>
            <dd>
              {formatDay(claim.submittedOn)}
              {claim.hmrcReference && `, HMRC reference ${claim.hmrcReference}`}
            </dd>
          </>
        )}
        {claim.paidOn && claim.paidAmount !== null && (
          <>
            <dt className="text-neutral-500">Paid</dt>
            <dd>
              {formatPence(claim.paidAmount)} on {formatDay(claim.paidOn)}
            </dd>
          </>
        )}
        {claim.rejectedReason && (
          <>
            <dt className="text-neutral-500">Rejected</dt>
            <dd>{claim.rejectedReason}</dd>
          </>
        )}
      </dl>

      {claim.voidedGifts.length > 0 && (
        <p
          role="status"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
        >
          {claim.voidedGifts.length === 1
            ? '1 gift in this claim was voided since it was made'
            : `${claim.voidedGifts.length} gifts in this claim were voided since it was made`}
          {status === 'draft'
            ? ': delete this draft and make a new claim.'
            : ': the next claim pays the tax on it back to HMRC.'}
        </p>
      )}

      {stepUp.form}

      <Steps
        claim={claim}
        busy={busy}
        asking={asking}
        setAsking={(a) => {
          setError(null)
          setAsking(a)
        }}
        confirm={(c) => {
          setError(null)
          setConfirming(c)
        }}
        go={(s) => void go(s, claim.statusVersion)}
      />
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <section aria-label="Downloads" className="flex flex-col gap-2">
        <h2 className="font-medium">For HMRC</h2>
        {downloadable ? (
          <>
            {status === 'rejected' && (
              <p className="text-sm text-neutral-600">
                Rejected: these files are superseded, kept for the record.
              </p>
            )}
            <p className="text-sm text-neutral-600">
              Upload the schedule to HMRC’s Charities Online. The XML is the
              claim as HMRC’s own format, for checking; it isn’t sent.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={secondary}
                onClick={() => void download('excel')}
              >
                Schedule (Excel)
              </button>
              <button
                type="button"
                className={secondary}
                onClick={() => void download('libreoffice')}
              >
                Schedule (LibreOffice)
              </button>
              <button
                type="button"
                className={secondary}
                onClick={() => void download('xml')}
              >
                Claim XML
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-neutral-600">
            Mark the claim ready to download its schedule for HMRC.
          </p>
        )}
      </section>

      {claim.adjustments.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Paid back to HMRC</h2>
          <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white text-sm">
            {claim.adjustments.map((a) => (
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

      {claim.lines.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Gifts ({claim.lines.length})</h2>
          <LinesTable lines={claim.lines} />
        </section>
      )}

      <ConfirmDialog
        open={confirming !== null}
        {...(confirming === 'deleted'
          ? {
              title: `Delete draft claim ${claim.number}?`,
              description:
                'Its gifts can be claimed again in a new claim. The draft is kept in the history, not in the list.',
              confirm: 'Delete draft',
            }
          : {
              title: `Mark claim ${claim.number} ready?`,
              description:
                'Ready means it may go to HMRC: its schedule can be downloaded, and it can no longer be deleted (only rejected).',
              confirm: 'Mark ready',
            })}
        cancel="Cancel"
        onConfirm={() => {
          if (!confirming) return
          const next = confirming
          setConfirming(null)
          void go({ status: next }, claim.statusVersion)
        }}
        onCancel={() => setConfirming(null)}
      />
    </main>
  )
}

/** The buttons and forms for the next steps the claim's status allows. */
function Steps({
  claim,
  busy,
  asking,
  setAsking,
  confirm,
  go,
}: {
  claim: Claim
  busy: boolean
  asking: Asking | null
  setAsking: (a: Asking | null) => void
  confirm: (c: 'ready' | 'deleted') => void
  go: (s: ClaimStep) => void
}) {
  const { status } = claim
  if (asking === 'submitted')
    return <SubmittedForm busy={busy} go={go} cancel={() => setAsking(null)} />
  if (asking === 'paid')
    return (
      <PaidForm
        claim={claim}
        busy={busy}
        go={go}
        cancel={() => setAsking(null)}
      />
    )
  if (asking === 'rejected')
    return <RejectForm busy={busy} go={go} cancel={() => setAsking(null)} />
  if (status === 'draft')
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primary}
          disabled={busy}
          onClick={() => confirm('ready')}
        >
          Mark ready
        </button>
        <button
          type="button"
          className={secondary}
          disabled={busy}
          onClick={() => confirm('deleted')}
        >
          Delete draft
        </button>
      </div>
    )
  if (status === 'ready' || status === 'submitted')
    return (
      <div className="flex flex-wrap gap-2">
        {status === 'ready' ? (
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() => setAsking('submitted')}
          >
            Mark submitted
          </button>
        ) : (
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() => setAsking('paid')}
          >
            Mark paid
          </button>
        )}
        <button
          type="button"
          className={secondary}
          disabled={busy}
          onClick={() => setAsking('rejected')}
        >
          Reject
        </button>
      </div>
    )
  return null
}

function StepForm({
  label,
  submit,
  busy,
  onSubmit,
  cancel,
  children,
}: {
  label: string
  submit: string
  busy: boolean
  onSubmit: () => void
  cancel: () => void
  children: ReactNode
}) {
  return (
    <form
      aria-label={label}
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-3"
    >
      {children}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={busy}>
          {submit}
        </button>
        <button
          type="button"
          className={secondary}
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function SubmittedForm({
  busy,
  go,
  cancel,
}: {
  busy: boolean
  go: (s: ClaimStep) => void
  cancel: () => void
}) {
  const [on, setOn] = useState(localToday)
  const [reference, setReference] = useState('')
  return (
    <StepForm
      label="Mark submitted"
      submit="Mark submitted"
      busy={busy}
      cancel={cancel}
      onSubmit={() =>
        go({
          status: 'submitted',
          submittedOn: on,
          hmrcReference: reference.trim(),
        })
      }
    >
      <label className="flex flex-col gap-1 text-sm">
        Submitted on
        <input
          type="date"
          required
          value={on}
          max={localToday()}
          onChange={(e) => setOn(e.target.value)}
          className={`${field} w-48`}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        HMRC reference
        <input
          required
          autoFocus
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="From Charities Online’s confirmation"
          className={`${field} w-72`}
        />
      </label>
    </StepForm>
  )
}

function PaidForm({
  claim,
  busy,
  go,
  cancel,
}: {
  claim: Claim
  busy: boolean
  go: (s: ClaimStep) => void
  cancel: () => void
}) {
  const [on, setOn] = useState(localToday)
  const [amountText, setAmountText] = useState(() =>
    penceToInput(claim.totals.net),
  )
  const [error, setError] = useState<string | null>(null)
  return (
    <StepForm
      label="Mark paid"
      submit="Mark paid"
      busy={busy}
      cancel={cancel}
      onSubmit={() => {
        const amount = parsePounds(amountText)
        if (amount === null) {
          setError('Enter the amount in pounds, like 656.25')
          return
        }
        setError(null)
        go({ status: 'paid', paidOn: on, paidAmount: amount })
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Amount HMRC paid (£)
        <input
          inputMode="decimal"
          required
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          className={`${field} w-48`}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Paid on
        <input
          type="date"
          required
          value={on}
          max={localToday()}
          onChange={(e) => setOn(e.target.value)}
          className={`${field} w-48`}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </StepForm>
  )
}

function RejectForm({
  busy,
  go,
  cancel,
}: {
  busy: boolean
  go: (s: ClaimStep) => void
  cancel: () => void
}) {
  const [reason, setReason] = useState('')
  return (
    <StepForm
      label="Reject claim"
      submit="Reject claim"
      busy={busy}
      cancel={cancel}
      onSubmit={() => go({ status: 'rejected', reason: reason.trim() })}
    >
      <p className="text-sm text-neutral-600">
        Its gifts can be claimed again in a new claim.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Why HMRC rejected it
        <textarea
          required
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${field} w-full max-w-lg`}
        />
      </label>
    </StepForm>
  )
}
