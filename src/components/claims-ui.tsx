import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { StepUpForm } from './auth-steps'
import { needsStepUp } from '../lib/auth-errors'
import { useAuthState } from '../lib/data'
import type { ClaimLine, ClaimStatus } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { formatDay, formatPence, refusal } from '../lib/gifts'
import { useTenant } from '../lib/tenant'

// The pieces the Gift Aid pages share: every claims route is admin only
// and wants a sign-in within the hour, reads included, so each page may
// have to confirm it's you before it shows anything (G3).

export const STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  submitted: 'Submitted',
  paid: 'Paid',
  rejected: 'Rejected',
  deleted: 'Deleted',
}

const STATUS_STYLES: Record<ClaimStatus, string> = {
  draft: 'bg-neutral-100 text-neutral-700',
  ready: 'bg-sky-100 text-sky-900',
  submitted: 'bg-amber-100 text-amber-900',
  paid: 'bg-green-100 text-green-900',
  rejected: 'bg-red-100 text-red-800',
  deleted: 'bg-neutral-100 text-neutral-500',
}

export function StatusBadge({ status }: { status: ClaimStatus }) {
  return (
    <span
      data-testid="claim-status"
      className={`rounded px-1.5 text-sm font-normal ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

/** "3 Mar 2023 – 28 Oct 2026"; up to the end alone with no gifts in it. */
export function claimPeriod(c: { earliestDate: string; periodEnd: string }) {
  return c.earliestDate
    ? `${formatDay(c.earliestDate)} – ${formatDay(c.periodEnd)}`
    : `up to ${formatDay(c.periodEnd)}`
}

/** A refused claims write as one plain line. */
export function claimRefusal(err: unknown, fallback: string): string {
  return refusal(
    err,
    fallback,
    'Someone else changed this claim just now: it has been read again. Check it, then try again',
  )
}

/**
 * A write that may need a step-up first. `run(f)` runs it; on
 * `step_up_required` it shows "Confirm it's you" (`form`) and stays
 * pending until then: once confirmed it runs `f` again and settles as
 * that run does, so the caller's own catch and finally see the retry's
 * refusal (preview_changed, voided_gifts…) and its busy state lasts
 * through it. Cancel settles it with nothing done. Render `form` outside
 * any other `<form>`: it is one itself.
 */
export function useStepUp() {
  const auth = useAuthState()
  const [pending, setPending] = useState<{
    confirm: () => void
    cancel: () => void
  } | null>(null)
  function run(f: () => Promise<void>): Promise<void> {
    return f().catch((err: unknown) => {
      if (!needsStepUp(err)) throw err
      return new Promise<void>((resolve, reject) =>
        setPending({
          confirm: () => {
            setPending(null)
            run(f).then(resolve, reject)
          },
          cancel: () => {
            setPending(null)
            resolve()
          },
        }),
      )
    })
  }
  const form = pending && (
    <StepUpForm
      method={auth?.method ?? null}
      onCancel={pending.cancel}
      // The retry's outcome goes to the caller of `run`, not this form
      // (it is gone by then).
      onDone={() => {
        pending.confirm()
        return Promise.resolve()
      }}
    />
  )
  return { run, form }
}

/**
 * What a page shows when its read was refused: "Confirm it's you" for a
 * step-up (then reads again), else the reason in a line.
 */
export function ReadRefused({
  error,
  retry,
}: {
  error: unknown
  retry: () => Promise<unknown>
}) {
  const auth = useAuthState()
  if (needsStepUp(error))
    return (
      <StepUpForm
        method={auth?.method ?? null}
        onCancel={() => history.back()}
        onDone={async () => {
          await retry()
        }}
      />
    )
  const message =
    error instanceof RustApiError && error.error.kind === 'forbidden'
      ? 'Only admins can see Gift Aid claims.'
      : claimRefusal(error, 'Gift Aid claims couldn’t load.')
  return (
    <p role="alert" className="text-sm text-red-700">
      {message}{' '}
      <button type="button" className="underline" onClick={() => void retry()}>
        Retry
      </button>
    </p>
  )
}

/** A term and its value, in the claim pages' totals. */
export function Figure({
  label,
  children,
  testId,
}: {
  label: string
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd data-testid={testId} className="text-lg font-medium">
        {children}
      </dd>
    </div>
  )
}

/** A claim's lines as sent to HMRC: the donor as snapshotted, the gift. */
export function LinesTable({ lines }: { lines: Array<ClaimLine> }) {
  const { slug } = useTenant()
  return (
    <div className="overflow-x-auto">
      <table data-testid="claim-lines" className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-neutral-500">
            <th className="py-2 pr-3 font-normal">Date</th>
            <th className="py-2 pr-3 font-normal">Donor</th>
            <th className="py-2 pr-3 font-normal">House</th>
            <th className="py-2 pr-3 font-normal">Postcode</th>
            <th className="py-2 pr-3 text-right font-normal">Amount</th>
            <th className="py-2 text-right font-normal">Gift Aid</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr
              key={l.giftId}
              data-gift={l.giftId}
              className="border-b border-neutral-100"
            >
              <td className="py-1 pr-3 whitespace-nowrap">
                <Link
                  to="/t/$slug/gifts/$giftId"
                  params={{ slug, giftId: l.giftId }}
                  className="underline"
                >
                  {formatDay(l.receivedOn)}
                </Link>
              </td>
              <td className="py-1 pr-3">
                <Link
                  to="/t/$slug/contacts/$contactId"
                  params={{ slug, contactId: l.contactId }}
                  className="hover:underline"
                >
                  {[l.title, l.firstName, l.lastName].filter(Boolean).join(' ')}
                </Link>
              </td>
              <td className="py-1 pr-3">{l.house}</td>
              <td className="py-1 pr-3 whitespace-nowrap">
                {l.overseas ? 'Overseas' : l.postcode}
              </td>
              <td className="py-1 pr-3 text-right">{formatPence(l.amount)}</td>
              <td className="py-1 text-right">{formatPence(l.reclaim)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
